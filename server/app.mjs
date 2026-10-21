import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA = resolve(ROOT, process.env.SLIDE_DATA_DIR || 'data');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const DEVICE_ID = process.env.SLIDE_DEVICE_ID || '';
const DEVICE_TOKEN = process.env.SLIDE_DEVICE_TOKEN || '';
const MAX_BODY = 32 * 1024;
const TELEMETRY_STALE_MS = 15_000;
const DEVICE_OFFLINE_MS = 60_000;
const COMMAND_TTL_MS = 120_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.webmanifest', 'application/manifest+json'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'],
]);
const STATIC_FILES = new Set(['/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/sw.js']);

function fatal(message) {
  process.stderr.write(`S.L.I.D.E. startup error: ${message}\n`);
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fatal('PORT must be a valid TCP port');
if (DEVICE_ID.length < 1 || DEVICE_ID.length > 64 || !/^[A-Za-z0-9._-]+$/.test(DEVICE_ID))
  fatal('SLIDE_DEVICE_ID must be 1–64 letters, digits, dots, underscores, or hyphens');
if (Buffer.byteLength(DEVICE_TOKEN) < 32 || DEVICE_TOKEN.startsWith('replace-with-'))
  fatal('set SLIDE_DEVICE_TOKEN to a unique random secret of at least 32 bytes');

const deviceTokenHash = createHash('sha256').update(DEVICE_TOKEN).digest();
const deviceIdPattern = /^[A-Za-z0-9._-]{1,64}$/;
const bootIdPattern = /^[A-Za-z0-9_-]{8,32}$/;
const eventIdPattern = /^[A-Za-z0-9._:-]{1,64}$/;

await mkdir(DATA, { recursive: true });
const db = new DatabaseSync(resolve(DATA, 'slide.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    last_seen_at TEXT,
    last_boot_id TEXT,
    last_sequence INTEGER
  );
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id),
    boot_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    received_at TEXT NOT NULL,
    observed_at TEXT,
    observed_uptime_ms INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(device_id, boot_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS readings_recent ON readings(device_id, received_at DESC);
  CREATE TABLE IF NOT EXISTS alerts (
    device_id TEXT NOT NULL REFERENCES devices(id),
    event_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    boot_id TEXT NOT NULL,
    occurred_at TEXT,
    received_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    acknowledged_at TEXT,
    acknowledged_by TEXT,
    PRIMARY KEY(device_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS alerts_recent ON alerts(device_id, received_at DESC);
  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    target_boot_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','delivered','succeeded','failed','expired')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    delivered_at TEXT,
    completed_at TEXT,
    result_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS commands_pending
    ON commands(device_id, target_boot_id, state, created_at);
`);
db.prepare('INSERT INTO devices(id) VALUES (?) ON CONFLICT(id) DO NOTHING').run(DEVICE_ID);

const getDevice = db.prepare('SELECT * FROM devices WHERE id = ?');
const updateDevice = db.prepare(`UPDATE devices SET last_seen_at = ?, last_boot_id = ?, last_sequence = ? WHERE id = ?`);
const updateDeviceContact = db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?');
const findReading = db.prepare(`SELECT id FROM readings WHERE device_id = ? AND boot_id = ? AND sequence = ?`);
const insertReading = db.prepare(`INSERT OR IGNORE INTO readings
  (device_id,boot_id,sequence,received_at,observed_at,observed_uptime_ms,payload_json)
  VALUES (?,?,?,?,?,?,?)`);
const purgeOldReadings = db.prepare('DELETE FROM readings WHERE device_id = ? AND received_at < ?');
const findAlert = db.prepare('SELECT revision FROM alerts WHERE device_id = ? AND event_id = ?');
const insertAlert = db.prepare(`INSERT INTO alerts
  (device_id,event_id,revision,boot_id,occurred_at,received_at,payload_json)
  VALUES (?,?,?,?,?,?,?)`);
const updateAlert = db.prepare(`UPDATE alerts SET revision = ?, boot_id = ?, occurred_at = ?,
  received_at = ?, payload_json = ? WHERE device_id = ? AND event_id = ? AND revision < ?`);
const selectRecentReadings = db.prepare(`SELECT received_at,observed_at,observed_uptime_ms,payload_json
  FROM readings WHERE device_id = ? ORDER BY id DESC LIMIT ?`);
const selectAlerts = db.prepare(`SELECT event_id,revision,boot_id,occurred_at,received_at,payload_json,
  acknowledged_at,acknowledged_by FROM alerts WHERE device_id = ? ORDER BY received_at DESC LIMIT ?`);

function sha256(value) { return createHash('sha256').update(value).digest(); }

function constantTimeEqual(actual, expected) {
  const actualHash = sha256(actual);
  return timingSafeEqual(actualHash, expected);
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function validTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    return undefined;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || millis < Date.UTC(2020, 0, 1) || millis > Date.now() + 300_000)
    return undefined;
  return new Date(millis).toISOString();
}

function numberIn(value, min, max, nullable = false) {
  if (nullable && value === null) return true;
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validTriple(value, maxAbs) {
  return Array.isArray(value) && value.length === 3 && value.every((item) => numberIn(item, -maxAbs, maxAbs));
}

function invalidResponse(response, message) {
  json(response, 400, { error: 'invalid_request', message });
}

async function readJson(request, response) {
  const contentType = request.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    json(response, 415, { error: 'content_type_required', message: 'Send an application/json body.' });
    return null;
  }
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY) {
    request.resume();
    json(response, 413, { error: 'body_too_large' });
    return null;
  }
  const chunks = [];
  let length = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY) tooLarge = true;
    else if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) { json(response, 413, { error: 'body_too_large' }); return null; }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('object required');
    return value;
  } catch {
    invalidResponse(response, 'The request body must be a JSON object.');
    return null;
  }
}

function requireDevice(request, response) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(request.headers.authorization || '');
  const deviceId = request.headers['x-slide-device'] || '';
  if (!match || deviceId !== DEVICE_ID || !constantTimeEqual(match[1], deviceTokenHash)) {
    json(response, 401, { error: 'device_authentication_failed' });
    return false;
  }
  return true;
}

function validateBoot(value) { return typeof value === 'string' && bootIdPattern.test(value); }

function validateTelemetry(body) {
  const reading = body.readings;
  const health = body.health;
  const gps = body.gps;
  const delivery = body.delivery;
  const observedAt = validTime(body.observed_at);
  if (body.schema_version !== 1 || body.device_id !== DEVICE_ID || !validateBoot(body.boot_id) ||
      !Number.isSafeInteger(body.sequence) || body.sequence < 1 ||
      !Number.isSafeInteger(body.observed_uptime_ms) || body.observed_uptime_ms < 0 ||
      observedAt === undefined || !reading || !health || !gps ||
      !delivery || typeof delivery !== 'object' || Array.isArray(delivery))
    return 'Invalid device identity, sequence, timestamp, or required fields.';
  const optionalTriple = (value, maxAbs) => value === null || validTriple(value, maxAbs);
  const calibration = body.calibration;
  const settings = body.settings;
  if (!numberIn(reading.soil_adc_raw, 0, 4095, true) || !numberIn(reading.rain_adc_raw, 0, 4095, true) ||
      !numberIn(reading.temperature_c, -40, 80, true) || !numberIn(reading.humidity_pct, 0, 100, true) ||
      !numberIn(reading.relative_tilt_deg, 0, 180, true) ||
      !numberIn(reading.soil_wetness_pct, 0, 100, true) || !numberIn(reading.rain_wetness_pct, 0, 100, true) ||
      !optionalTriple(reading.accel_g, 32) || !optionalTriple(reading.gyro_dps, 2000) ||
      !numberIn(reading.pitch_deg, -180, 180, true) || !numberIn(reading.roll_deg, -180, 180, true) ||
      !['ONLINE','OFFLINE','ERROR','INITIALIZING'].includes(health.mpu) ||
      !['ONLINE','OFFLINE','ERROR','INITIALIZING'].includes(health.soil) ||
      !['ONLINE','OFFLINE','ERROR','INITIALIZING'].includes(health.rain) ||
      !['ONLINE','OFFLINE','ERROR','INITIALIZING'].includes(health.dht11) ||
      typeof health.baseline_calibrated !== 'boolean' || typeof health.test_mode !== 'boolean' ||
      !calibration || typeof calibration.baseline_valid !== 'boolean' ||
      typeof calibration.calibrating !== 'boolean' || !Number.isInteger(calibration.samples) ||
      calibration.samples < 0 || calibration.samples > 1_000_000 ||
      typeof calibration.reason !== 'string' || calibration.reason.length > 80 ||
      !validTriple(calibration.gyro_bias_dps, 1000) ||
      !['soil','rain'].every((name) => calibration[name] &&
        typeof calibration[name].valid === 'boolean' &&
        Number.isInteger(calibration[name].dry) && calibration[name].dry >= 0 && calibration[name].dry <= 4095 &&
        Number.isInteger(calibration[name].wet) && calibration[name].wet >= 0 && calibration[name].wet <= 4095) ||
      !settings || typeof settings.test_mode !== 'boolean' ||
      !Array.isArray(settings.tilt_threshold) || settings.tilt_threshold.length !== 3 ||
      !settings.tilt_threshold.every((value) => numberIn(value, 3, 90)) ||
      !Array.isArray(settings.tilt_duration_s) || settings.tilt_duration_s.length !== 3 ||
      !settings.tilt_duration_s.every((value) => Number.isInteger(value) && value >= 1 && value <= 3600) ||
      !Array.isArray(settings.adc_threshold) || settings.adc_threshold.length !== 2 ||
      !settings.adc_threshold.every((value) => numberIn(value, 1, 100)) ||
      !Array.isArray(settings.adc_duration_s) || settings.adc_duration_s.length !== 2 ||
      !settings.adc_duration_s.every((value) => Number.isInteger(value) && value >= 1 && value <= 3600) ||
      !Array.isArray(settings.adc_enabled) || settings.adc_enabled.length !== 2 ||
      !settings.adc_enabled.every((value) => typeof value === 'boolean') ||
      !['FRESH','LAST_KNOWN','UNAVAILABLE'].includes(gps.status) ||
      !numberIn(gps.latitude, -90, 90, true) || !numberIn(gps.longitude, -180, 180, true) ||
      !Number.isInteger(gps.satellites) || gps.satellites < -1 || gps.satellites > 99 ||
      !numberIn(gps.fix_age_s, 0, 2_147_483_647, true) ||
      !Number.isInteger(delivery.event_queue_depth) || delivery.event_queue_depth < 0 || delivery.event_queue_depth > 24 ||
      !Number.isSafeInteger(delivery.event_queue_discarded) || delivery.event_queue_discarded < 0 || delivery.event_queue_discarded > 4_294_967_295 ||
      !Number.isSafeInteger(delivery.event_retry_count) || delivery.event_retry_count < 0 || delivery.event_retry_count > 4_294_967_295 ||
      !(delivery.last_success_uptime_ms === null ||
        (Number.isSafeInteger(delivery.last_success_uptime_ms) && delivery.last_success_uptime_ms >= 0)))
    return 'A telemetry field is outside the supported schema or range.';
  if ((gps.latitude === null) !== (gps.longitude === null) ||
      (gps.status === 'UNAVAILABLE' && gps.latitude !== null) ||
      (gps.status !== 'UNAVAILABLE' && gps.latitude === null)) return 'GPS coordinates and status are inconsistent.';
  return null;
}

function validateEvent(body) {
  if (body.schema_version !== 1 || body.device_id !== DEVICE_ID || !validateBoot(body.boot_id) ||
      typeof body.event_id !== 'string' || !eventIdPattern.test(body.event_id) ||
      !Number.isSafeInteger(body.revision) || body.revision < 1 ||
      !Number.isSafeInteger(body.observed_uptime_s) || body.observed_uptime_s < 0 ||
      validTime(body.occurred_at) === undefined || !body.event || typeof body.event !== 'object')
    return 'Invalid event identity, revision, timestamp, or event payload.';
  const event = body.event;
  if (!['CAUTION','WARNING','CRITICAL','EQUIPMENT'].includes(event.severity) ||
      !['TILT','SOIL','RAIN','MPU_OFFLINE','MPU_ID','SIMULATED'].includes(event.sensor) ||
      !numberIn(event.value, -1_000_000, 1_000_000) || !numberIn(event.threshold, -1_000_000, 1_000_000) ||
      !Number.isInteger(event.duration_s) || event.duration_s < 0 || event.duration_s > 86_400 ||
      typeof event.resolved !== 'boolean' || typeof event.simulated !== 'boolean' ||
      !['FRESH','LAST_KNOWN','UNAVAILABLE'].includes(event.gps_status) ||
      !numberIn(event.latitude, -90, 90, true) || !numberIn(event.longitude, -180, 180, true) ||
      !Number.isInteger(event.satellites) || event.satellites < -1 || event.satellites > 99 ||
      !numberIn(event.fix_age_s, 0, 2_147_483_647, true)) return 'An event field is outside the supported schema.';
  if ((event.latitude === null) !== (event.longitude === null) ||
      (event.gps_status === 'UNAVAILABLE' && event.latitude !== null) ||
      (event.gps_status !== 'UNAVAILABLE' && event.latitude === null)) return 'Event GPS coordinates and status are inconsistent.';
  return null;
}

function readLimit(url, fallback = 100) {
  const value = Number(url.searchParams.get('limit') || fallback);
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 500)) : fallback;
}

function dashboardState() {
  const device = getDevice.get(DEVICE_ID);
  const row = selectRecentReadings.get(DEVICE_ID, 1);
  const lastSeenMs = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
  const receivedMs = row ? Date.parse(row.received_at) : 0;
  const now = Date.now();
  const observationMs = row?.observed_at ? Date.parse(row.observed_at) : NaN;
  const observationAgeS = Number.isFinite(observationMs)
    ? Math.max(0, Math.floor((now - observationMs) / 1000)) : null;
  let latest = null;
  if (row) {
    latest = JSON.parse(row.payload_json);
    latest.received_at = row.received_at;
    latest.observed_at = row.observed_at;
    latest.observed_uptime_ms = row.observed_uptime_ms;
  }
  return {
    device: {
      id: DEVICE_ID,
      last_seen_at: device.last_seen_at,
      boot_id: device.last_boot_id,
      online: lastSeenMs > 0 && now - lastSeenMs <= DEVICE_OFFLINE_MS,
      connectivity_age_s: lastSeenMs > 0 ? Math.max(0, Math.floor((now - lastSeenMs) / 1000)) : null,
    },
    latest,
    observation_age_s: observationAgeS,
    telemetry_stale: receivedMs === 0 || now - receivedMs > TELEMETRY_STALE_MS ||
      (observationAgeS !== null && observationAgeS * 1000 > TELEMETRY_STALE_MS),
  };
}

function loadReadings(url) {
  const ranges = new Map([['24h', 86_400], ['7d', 604_800], ['30d', 2_592_000]]);
  const range = url.searchParams.get('range') || '24h';
  if (!ranges.has(range)) throw new Error('unsupported_reading_range');
  const bucketSeconds = range === '24h' ? 300 : range === '7d' ? 1800 : 7200;
  const since = new Date(Date.now() - ranges.get(range) * 1000).toISOString();
  const rows = db.prepare(`WITH ranked AS (
    SELECT received_at,observed_at,observed_uptime_ms,payload_json,id,
      ROW_NUMBER() OVER (PARTITION BY CAST(strftime('%s',received_at) / ? AS INTEGER) ORDER BY id DESC) AS sample_rank
    FROM readings WHERE device_id = ? AND received_at >= ?
  ) SELECT received_at,observed_at,observed_uptime_ms,payload_json FROM ranked
    WHERE sample_rank = 1 ORDER BY received_at DESC LIMIT ?`)
    .all(bucketSeconds, DEVICE_ID, since, readLimit(url, 500)).reverse();
  return rows.map((row) => ({
    ...JSON.parse(row.payload_json), received_at: row.received_at,
    observed_at: row.observed_at, observed_uptime_ms: row.observed_uptime_ms,
  }));
}

function loadAlerts(url) {
  return selectAlerts.all(DEVICE_ID, readLimit(url, 100)).map((row) => {
    const payload = JSON.parse(row.payload_json);
    return {
    event: payload.event || payload, observed_uptime_s: payload.observed_uptime_s ?? null,
    event_id: row.event_id, revision: row.revision,
    boot_id: row.boot_id, occurred_at: row.occurred_at, received_at: row.received_at,
    acknowledged: row.acknowledged_at !== null, acknowledged_at: row.acknowledged_at,
    acknowledged_by: row.acknowledged_by,
    };
  });
}

const enqueueCommand = db.prepare(`INSERT INTO commands
  (id,device_id,target_boot_id,kind,payload_json,state,created_at,expires_at)
  VALUES (?,?,?,?,?,'queued',?,?)`);
const selectCommandDevice = db.prepare('SELECT last_seen_at,last_boot_id FROM devices WHERE id = ?');
const selectCommands = db.prepare(`SELECT id,kind,payload_json,expires_at FROM commands
  WHERE device_id=? AND target_boot_id=? AND state IN ('queued','delivered')
  ORDER BY created_at LIMIT 4`);
const markDelivered = db.prepare(`UPDATE commands SET state='delivered', delivered_at=?, attempts=attempts+1
  WHERE id=? AND state IN ('queued','delivered')`);
const commandForResult = db.prepare('SELECT state,target_boot_id,expires_at,result_message FROM commands WHERE id=? AND device_id=?');
const updateCommandResult = db.prepare(`UPDATE commands SET state=?,completed_at=?,result_message=?
  WHERE id=? AND device_id=? AND state IN ('queued','delivered')`);

function transaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original transaction error. */ }
    throw error;
  }
}

function commandPayload(body) {
  if (typeof body.kind !== 'string') return null;
  const exactKeys = (...keys) => keys.length === Object.keys(body).length &&
    keys.every((key) => Object.hasOwn(body, key));
  if (body.kind === 'calibrate_mpu' && exactKeys('kind')) return { path: '/api/calibrate/mpu', body: {} };
  if (body.kind === 'set_test_mode' && exactKeys('kind', 'enabled') && typeof body.enabled === 'boolean')
    return { path: '/api/test-mode', body: { enabled: body.enabled ? 1 : 0 } };
  if (body.kind === 'record_adc_endpoint' && exactKeys('kind', 'sensor', 'wet') && Number.isInteger(body.sensor) &&
      (body.sensor === 0 || body.sensor === 1) && typeof body.wet === 'boolean')
    return { path: '/api/calibrate/adc', body: { sensor: body.sensor, wet: body.wet ? 1 : 0 } };
  if (body.kind === 'set_tilt_thresholds' && exactKeys('kind', 'caution', 'warning', 'critical', 'caution_s', 'warning_s', 'critical_s') &&
      ['caution','warning','critical','caution_s','warning_s','critical_s'].every((key) => Number.isSafeInteger(body[key])) &&
      body.caution >= 3 && body.caution <= 89 && body.warning >= 4 && body.warning <= 90 &&
      body.critical >= 5 && body.critical <= 90 && body.caution < body.warning && body.warning < body.critical &&
      body.caution_s >= 1 && body.caution_s <= 3600 &&
      body.warning_s >= 1 && body.warning_s <= 3600 &&
      body.critical_s >= 1 && body.critical_s <= 3600)
    return { path: '/api/settings/tilt', body: Object.fromEntries(
      ['caution','warning','critical','caution_s','warning_s','critical_s'].map((key) => [key, body[key]])
    ) };
  if (body.kind === 'set_adc_settings' && exactKeys('kind', 'sensor', 'threshold', 'seconds', 'enabled') &&
      Number.isInteger(body.sensor) && (body.sensor === 0 || body.sensor === 1) &&
      Number.isSafeInteger(body.threshold) && body.threshold >= 1 && body.threshold <= 100 &&
      Number.isSafeInteger(body.seconds) && body.seconds >= 1 && body.seconds <= 3600 &&
      typeof body.enabled === 'boolean')
    return { path: '/api/settings/adc', body: { sensor: body.sensor, threshold: body.threshold,
      seconds: body.seconds, enabled: body.enabled ? 1 : 0 } };
  return null;
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  if (pathname === '/api/v1/device/verify' && request.method === 'POST') {
    if (!requireDevice(request, response)) return;
    const body = await readJson(request, response);
    if (!body) return;
    if (body.schema_version !== 1 || body.device_id !== DEVICE_ID || !validateBoot(body.boot_id)) {
      invalidResponse(response, 'Invalid device verification payload.');
      return;
    }
    json(response, 200, { verified: true, schema_version: 1, server_time: new Date().toISOString(),
      telemetry_interval_s: 5, command_poll_interval_s: 5 });
    return;
  }

  if (pathname === '/api/v1/device/telemetry' && request.method === 'POST') {
    if (!requireDevice(request, response)) return;
    const body = await readJson(request, response);
    if (!body) return;
    const error = validateTelemetry(body);
    if (error) { invalidResponse(response, error); return; }
    const receivedAt = new Date().toISOString();
    const result = transaction(() => {
      const existing = findReading.get(DEVICE_ID, body.boot_id, body.sequence);
      const existingDevice = getDevice.get(DEVICE_ID);
      if (existing) {
        if (existingDevice.last_boot_id === body.boot_id) updateDeviceContact.run(receivedAt, DEVICE_ID);
        return { duplicate: true, outOfOrder: false };
      }
      if (existingDevice.last_boot_id === body.boot_id && existingDevice.last_sequence !== null &&
          body.sequence < existingDevice.last_sequence)
        return { duplicate: false, outOfOrder: true };
      insertReading.run(DEVICE_ID, body.boot_id, body.sequence, receivedAt,
        validTime(body.observed_at), body.observed_uptime_ms, JSON.stringify(body));
      const updatedSequence = existingDevice.last_boot_id === body.boot_id
        ? Math.max(existingDevice.last_sequence || 0, body.sequence) : body.sequence;
      updateDevice.run(receivedAt, body.boot_id, updatedSequence, DEVICE_ID);
      purgeOldReadings.run(DEVICE_ID, new Date(Date.now() - RETENTION_MS).toISOString());
      return { duplicate: false, outOfOrder: false };
    });
    if (result.outOfOrder) { json(response, 409, { error: 'sequence_out_of_order' }); return; }
    json(response, 202, { accepted: true, duplicate: result.duplicate, received_at: receivedAt });
    return;
  }

  if (pathname === '/api/v1/device/alerts' && request.method === 'POST') {
    if (!requireDevice(request, response)) return;
    const body = await readJson(request, response);
    if (!body) return;
    const error = validateEvent(body);
    if (error) { invalidResponse(response, error); return; }
    const old = findAlert.get(DEVICE_ID, body.event_id);
    if (old && body.revision < old.revision) {
      json(response, 409, { error: 'event_revision_out_of_order', current_revision: old.revision });
      return;
    }
    const receivedAt = new Date().toISOString();
    const eventJson = JSON.stringify({ event: body.event, observed_uptime_s: body.observed_uptime_s });
    transaction(() => {
      if (old) updateAlert.run(body.revision, body.boot_id, validTime(body.occurred_at), receivedAt,
        eventJson, DEVICE_ID, body.event_id, body.revision);
      else insertAlert.run(DEVICE_ID, body.event_id, body.revision, body.boot_id,
        validTime(body.occurred_at), receivedAt, eventJson);
    });
    json(response, 202, { accepted: true, duplicate: Boolean(old && body.revision === old.revision),
      event_id: body.event_id, revision: body.revision, received_at: receivedAt });
    return;
  }

  if (pathname === '/api/v1/device/commands' && request.method === 'GET') {
    if (!requireDevice(request, response)) return;
    const bootId = url.searchParams.get('boot_id') || '';
    if (!validateBoot(bootId)) { invalidResponse(response, 'A valid current boot_id is required.'); return; }
    const now = new Date().toISOString();
    db.prepare(`UPDATE commands SET state='expired',completed_at=?,result_message='Command expired'
      WHERE device_id=? AND state IN ('queued','delivered') AND expires_at <= ?`).run(now, DEVICE_ID, now);
    const commands = selectCommands.all(DEVICE_ID, bootId);
    for (const command of commands) markDelivered.run(now, command.id);
    json(response, 200, { commands: commands.filter((command) => command.expires_at > now).map((command) => ({
      id: command.id, kind: command.kind, expires_at: command.expires_at, payload: JSON.parse(command.payload_json),
    })) });
    return;
  }

  if (pathname === '/api/v1/device/commands/result' && request.method === 'POST') {
    if (!requireDevice(request, response)) return;
    const body = await readJson(request, response);
    if (!body) return;
    const result = body.result;
    if (typeof body.command_id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.command_id) ||
        !validateBoot(body.boot_id) || !['succeeded','failed'].includes(result) ||
        typeof body.message !== 'string' || body.message.length > 120) {
      invalidResponse(response, 'Invalid command result.');
      return;
    }
    const command = commandForResult.get(body.command_id, DEVICE_ID);
    if (!command || command.target_boot_id !== body.boot_id) {
      json(response, 404, { error: 'command_not_found_for_boot' });
      return;
    }
    const completedAt = new Date().toISOString();
    if (['queued', 'delivered'].includes(command.state) && command.expires_at <= completedAt) {
      db.prepare(`UPDATE commands SET state='expired',completed_at=?,result_message='Command expired'
        WHERE id=? AND device_id=? AND state IN ('queued','delivered')`)
        .run(completedAt, body.command_id, DEVICE_ID);
      json(response, 409, { error: 'command_expired' });
      return;
    }
    if (['succeeded', 'failed'].includes(command.state)) {
      if (command.state === result && command.result_message === body.message)
        json(response, 200, { accepted: true, duplicate: true });
      else json(response, 409, { error: 'command_result_conflict' });
      return;
    }
    if (command.state === 'expired') { json(response, 409, { error: 'command_expired' }); return; }
    const update = updateCommandResult.run(result, completedAt, body.message, body.command_id, DEVICE_ID);
    if (!update.changes) { json(response, 409, { error: 'command_result_conflict' }); return; }
    json(response, 200, { accepted: true, duplicate: false });
    return;
  }

  if (pathname === '/api/v1/dashboard' && request.method === 'GET') {
    json(response, 200, dashboardState());
    return;
  }
  if (pathname === '/api/v1/readings' && request.method === 'GET') {
    json(response, 200, { readings: loadReadings(url) });
    return;
  }
  if (pathname === '/api/v1/alerts' && request.method === 'GET') {
    json(response, 200, { alerts: loadAlerts(url) });
    return;
  }
  if (pathname === '/api/v1/alerts/ack' && request.method === 'POST') {
    const body = await readJson(request, response);
    if (!body) return;
    if (typeof body.event_id !== 'string' || !eventIdPattern.test(body.event_id)) {
      invalidResponse(response, 'A valid event_id is required.');
      return;
    }
    const acknowledgement = db.prepare(`UPDATE alerts SET acknowledged_at=?,acknowledged_by=?
      WHERE device_id=? AND event_id=? AND acknowledged_at IS NULL`)
      .run(new Date().toISOString(), 'public visitor', DEVICE_ID, body.event_id);
    if (!acknowledgement.changes) {
      const exists = findAlert.get(DEVICE_ID, body.event_id);
      if (!exists) { json(response, 404, { error: 'event_not_found' }); return; }
    }
    json(response, 200, { acknowledged: true, changed: acknowledgement.changes === 1 });
    return;
  }
  if (pathname === '/api/v1/commands' && request.method === 'POST') {
    const body = await readJson(request, response);
    if (!body) return;
    const payload = commandPayload(body);
    if (!payload) { invalidResponse(response, 'The maintenance command or its settings are invalid.'); return; }
    const device = selectCommandDevice.get(DEVICE_ID);
    if (!device.last_seen_at || Date.now() - Date.parse(device.last_seen_at) > DEVICE_OFFLINE_MS ||
        !device.last_boot_id) {
      json(response, 409, { error: 'device_offline', message: 'The station must be online to receive a command.' });
      return;
    }
    const pending = db.prepare(`SELECT id FROM commands WHERE device_id=? AND target_boot_id=?
      AND state IN ('queued','delivered') AND expires_at>? LIMIT 1`)
      .get(DEVICE_ID, device.last_boot_id, new Date().toISOString());
    if (pending) {
      json(response, 409, { error: 'command_pending', message: 'Wait for the current maintenance command to finish.' });
      return;
    }
    const id = randomUUID();
    const createdAt = Date.now();
    enqueueCommand.run(id, DEVICE_ID, device.last_boot_id, body.kind, JSON.stringify(payload),
      new Date(createdAt).toISOString(), new Date(createdAt + COMMAND_TTL_MS).toISOString());
    json(response, 202, { accepted: true, command_id: id, state: 'queued', expires_in: COMMAND_TTL_MS / 1000 });
    return;
  }
  if (pathname === '/api/v1/commands' && request.method === 'GET') {
    json(response, 200, { commands: db.prepare(`SELECT id,kind,state,created_at,expires_at,completed_at,result_message
      FROM commands WHERE device_id=? ORDER BY created_at DESC LIMIT ?`).all(DEVICE_ID, readLimit(url, 50)) });
    return;
  }
  if (pathname === '/api/v1/readings.csv' && request.method === 'GET') {
    const rows = loadReadings(url);
    const columns = ['received_at','observed_at','observed_uptime_ms','soil_adc_raw','rain_adc_raw',
      'soil_wetness_pct','rain_wetness_pct','temperature_c','humidity_pct','relative_tilt_deg',
      'health.mpu','health.soil','health.rain','gps.status','gps.latitude','gps.longitude','gps.satellites',
      'delivery.event_queue_depth','delivery.event_queue_discarded','delivery.event_retry_count',
      'delivery.last_success_uptime_ms'];
    const cell = (value) => {
      const text = String(value ?? '');
      return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replaceAll('"','""')}"`;
    };
    const lines = [columns.map(cell).join(',')];
    for (const row of rows) lines.push(columns.map((key) => cell(key.split('.').reduce((value, part) => value?.[part], row))).join(','));
    response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="slide-readings.csv"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(lines.join('\r\n'));
    return;
  }
  json(response, 404, { error: 'route_not_found' });
}

async function serveStatic(request, response, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { json(response, 400, { error: 'invalid_path' }); return; }
  if (pathname === '/') pathname = '/index.html';
  const isAsset = /^\/assets\/[A-Za-z0-9._-]+\.(?:png|svg|ico)$/i.test(pathname);
  if (!STATIC_FILES.has(pathname) && !isAsset) { json(response, 404, { error: 'not_found' }); return; }
  const file = resolve(ROOT, `.${pathname}`);
  if (!file.startsWith(`${ROOT}${sep}`)) { json(response, 404, { error: 'not_found' }); return; }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const body = await readFile(file);
    const type = MIME.get(extname(file).toLowerCase()) || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': type, 'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
    });
    if (request.method === 'HEAD') response.end(); else response.end(body);
  } catch {
    json(response, 404, { error: 'not_found' });
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Allow': 'GET, HEAD, POST, DELETE', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (url.pathname === '/healthz' && request.method === 'GET') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (!['GET','POST','DELETE'].includes(request.method)) {
        json(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, DELETE' });
        return;
      }
      await handleApi(request, response, url);
      return;
    }
    if (!['GET','HEAD'].includes(request.method)) {
      json(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      return;
    }
    await serveStatic(request, response, url);
  } catch (error) {
    process.stderr.write(`S.L.I.D.E. request error: ${error?.stack || 'unknown error'}\n`);
    if (!response.headersSent) json(response, 500, { error: 'internal_server_error' });
    else response.destroy();
  }
});

server.requestTimeout = 10_000;
server.headersTimeout = 12_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, HOST, () => {
  process.stdout.write(`S.L.I.D.E. dashboard listening on http://${HOST}:${PORT}; device ${DEVICE_ID}; SQLite ${resolve(DATA, 'slide.sqlite')}\n`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
