import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';

const MAX_BODY = 32 * 1024;
const TELEMETRY_STALE_MS = 15_000;
const DEVICE_OFFLINE_MS = 60_000;
const COMMAND_TTL_MS = 120_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const bootIdPattern = /^[A-Za-z0-9_-]{8,32}$/;
const eventIdPattern = /^[A-Za-z0-9._:-]{1,64}$/;
const commandIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ,
  last_boot_id TEXT,
  last_sequence BIGINT
);
CREATE TABLE IF NOT EXISTS readings (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  boot_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ,
  observed_uptime_ms BIGINT NOT NULL,
  payload_json JSONB NOT NULL,
  UNIQUE (device_id, boot_id, sequence)
);
CREATE INDEX IF NOT EXISTS readings_recent ON readings(device_id, received_at DESC);
CREATE TABLE IF NOT EXISTS alerts (
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  boot_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  PRIMARY KEY (device_id, event_id)
);
CREATE INDEX IF NOT EXISTS alerts_recent ON alerts(device_id, received_at DESC);
CREATE TABLE IF NOT EXISTS commands (
  id UUID PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  target_boot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','delivered','succeeded','failed','expired')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS commands_pending
  ON commands(device_id, target_boot_id, state, created_at);
`;

let schemaReady = false;

function json(status, value, headers = {}) {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  } });
}

export function getConfig() {
  const deviceId = process.env.SLIDE_DEVICE_ID || '';
  const deviceToken = process.env.SLIDE_DEVICE_TOKEN || '';
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//i.test(databaseUrl) ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId) ||
      Buffer.byteLength(deviceToken) < 32 || deviceToken.startsWith('replace-with-')) return null;
  return { deviceId, deviceToken, databaseUrl };
}

async function ensureSchema(client, config) {
  if (schemaReady) return;
  await client.query(SCHEMA_SQL);
  await client.query('INSERT INTO devices(id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [config.deviceId]);
  schemaReady = true;
}

function sha256(value) { return createHash('sha256').update(value).digest(); }

function constantTimeEqual(actual, expected) {
  return timingSafeEqual(sha256(actual), expected);
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

function validateBoot(value) { return typeof value === 'string' && bootIdPattern.test(value); }

function validateTelemetry(body, deviceId) {
  const reading = body.readings;
  const health = body.health;
  const gps = body.gps;
  const delivery = body.delivery;
  const observedAt = validTime(body.observed_at);
  if (body.schema_version !== 1 || body.device_id !== deviceId || !validateBoot(body.boot_id) ||
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

function validateEvent(body, deviceId) {
  if (body.schema_version !== 1 || body.device_id !== deviceId || !validateBoot(body.boot_id) ||
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

function commandPayload(body) {
  if (typeof body.kind !== 'string') return null;
  const exactKeys = (...keys) => keys.length === Object.keys(body).length && keys.every((key) => Object.hasOwn(body, key));
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
      body.caution_s >= 1 && body.caution_s <= 3600 && body.warning_s >= 1 && body.warning_s <= 3600 &&
      body.critical_s >= 1 && body.critical_s <= 3600)
    return { path: '/api/settings/tilt', body: Object.fromEntries(
      ['caution','warning','critical','caution_s','warning_s','critical_s'].map((key) => [key, body[key]])
    ) };
  if (body.kind === 'set_adc_settings' && exactKeys('kind', 'sensor', 'threshold', 'seconds', 'enabled') &&
      Number.isInteger(body.sensor) && (body.sensor === 0 || body.sensor === 1) &&
      Number.isSafeInteger(body.threshold) && body.threshold >= 1 && body.threshold <= 100 &&
      Number.isSafeInteger(body.seconds) && body.seconds >= 1 && body.seconds <= 3600 && typeof body.enabled === 'boolean')
    return { path: '/api/settings/adc', body: { sensor: body.sensor, threshold: body.threshold,
      seconds: body.seconds, enabled: body.enabled ? 1 : 0 } };
  return null;
}

async function readJson(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json'))
    return { error: json(415, { error: 'content_type_required', message: 'Send an application/json body.' }) };
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY)
    return { error: json(413, { error: 'body_too_large' }) };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY) return { error: json(413, { error: 'body_too_large' }) };
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('invalid json object');
    return { body };
  } catch {
    return { error: json(400, { error: 'invalid_request', message: 'The request body must be a JSON object.' }) };
  }
}

function bearer(request) {
  return /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(request.headers.get('authorization') || '')?.[1] || '';
}

async function requireDevice(request, config) {
  const token = bearer(request);
  if (!token || request.headers.get('x-slide-device') !== config.deviceId ||
      !constantTimeEqual(token, sha256(config.deviceToken))) return false;
  return true;
}

function asIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function jsonValue(value) { return typeof value === 'string' ? JSON.parse(value) : value; }

function readLimit(url, fallback = 100) {
  const value = Number(url.searchParams.get('limit') || fallback);
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 500)) : fallback;
}

async function dashboardState(client, deviceId) {
  const deviceResult = await client.query('SELECT * FROM devices WHERE id=$1', [deviceId]);
  const readingResult = await client.query(
    'SELECT received_at,observed_at,observed_uptime_ms,payload_json FROM readings WHERE device_id=$1 ORDER BY id DESC LIMIT 1',
    [deviceId],
  );
  const device = deviceResult.rows[0];
  const row = readingResult.rows[0] || null;
  const lastSeenAt = asIso(device.last_seen_at);
  const receivedAt = row ? asIso(row.received_at) : null;
  const observedAt = row ? asIso(row.observed_at) : null;
  const now = Date.now();
  const observationMs = observedAt ? Date.parse(observedAt) : NaN;
  const observationAgeS = Number.isFinite(observationMs) ? Math.max(0, Math.floor((now - observationMs) / 1000)) : null;
  let latest = null;
  if (row) {
    latest = jsonValue(row.payload_json);
    latest.received_at = receivedAt;
    latest.observed_at = observedAt;
    latest.observed_uptime_ms = Number(row.observed_uptime_ms);
  }
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : 0;
  const receivedMs = receivedAt ? Date.parse(receivedAt) : 0;
  return {
    device: {
      id: deviceId, last_seen_at: lastSeenAt, boot_id: device.last_boot_id,
      online: lastSeenMs > 0 && now - lastSeenMs <= DEVICE_OFFLINE_MS,
      connectivity_age_s: lastSeenMs > 0 ? Math.max(0, Math.floor((now - lastSeenMs) / 1000)) : null,
    },
    latest,
    observation_age_s: observationAgeS,
    telemetry_stale: receivedMs === 0 || now - receivedMs > TELEMETRY_STALE_MS ||
      (observationAgeS !== null && observationAgeS * 1000 > TELEMETRY_STALE_MS),
  };
}

async function loadReadings(client, url, deviceId) {
  const ranges = new Map([['24h', 86_400], ['7d', 604_800], ['30d', 2_592_000]]);
  const range = url.searchParams.get('range') || '24h';
  if (!ranges.has(range)) throw new Error('unsupported_reading_range');
  const bucketSeconds = range === '24h' ? 300 : range === '7d' ? 1800 : 7200;
  const since = new Date(Date.now() - ranges.get(range) * 1000).toISOString();
  const result = await client.query(`WITH ranked AS (
    SELECT received_at,observed_at,observed_uptime_ms,payload_json,id,
      ROW_NUMBER() OVER (PARTITION BY FLOOR(EXTRACT(EPOCH FROM received_at) / $1)::BIGINT ORDER BY id DESC) AS sample_rank
    FROM readings WHERE device_id=$2 AND received_at >= $3
  ) SELECT received_at,observed_at,observed_uptime_ms,payload_json FROM ranked
    WHERE sample_rank=1 ORDER BY received_at DESC LIMIT $4`,
  [bucketSeconds, deviceId, since, readLimit(url, 500)]);
  return result.rows.map((row) => ({
    ...jsonValue(row.payload_json), received_at: asIso(row.received_at),
    observed_at: asIso(row.observed_at), observed_uptime_ms: Number(row.observed_uptime_ms),
  })).reverse();
}

async function loadAlerts(client, url, deviceId) {
  const result = await client.query(`SELECT event_id,revision,boot_id,occurred_at,received_at,payload_json,
    acknowledged_at,acknowledged_by FROM alerts WHERE device_id=$1 ORDER BY received_at DESC LIMIT $2`,
  [deviceId, readLimit(url, 100)]);
  return result.rows.map((row) => {
    const payload = jsonValue(row.payload_json);
    return {
      event: payload.event || payload, observed_uptime_s: payload.observed_uptime_s ?? null,
      event_id: row.event_id, revision: row.revision, boot_id: row.boot_id,
      occurred_at: asIso(row.occurred_at), received_at: asIso(row.received_at),
      acknowledged: row.acknowledged_at !== null, acknowledged_at: asIso(row.acknowledged_at),
      acknowledged_by: row.acknowledged_by,
    };
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

async function route(client, request, url, config) {
  const pathname = url.pathname;
  if (pathname === '/api/v1/device/verify' && request.method === 'POST') {
    if (!await requireDevice(request, config)) return json(401, { error: 'device_authentication_failed' });
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const body = parsed.body;
    if (body.schema_version !== 1 || body.device_id !== config.deviceId || !validateBoot(body.boot_id))
      return json(400, { error: 'invalid_request', message: 'Invalid device verification payload.' });
    return json(200, { verified: true, schema_version: 1, server_time: new Date().toISOString(),
      telemetry_interval_s: 2.5, command_poll_interval_s: 5 });
  }

  if (pathname === '/api/v1/device/telemetry' && request.method === 'POST') {
    if (!await requireDevice(request, config)) return json(401, { error: 'device_authentication_failed' });
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const body = parsed.body;
    const error = validateTelemetry(body, config.deviceId);
    if (error) return json(400, { error: 'invalid_request', message: error });
    const receivedAt = new Date().toISOString();
    await client.query('BEGIN');
    try {
      const deviceResult = await client.query('SELECT last_boot_id,last_sequence FROM devices WHERE id=$1 FOR UPDATE',
        [config.deviceId]);
      const existingDevice = deviceResult.rows[0];
      const existing = await client.query('SELECT id FROM readings WHERE device_id=$1 AND boot_id=$2 AND sequence=$3',
        [config.deviceId, body.boot_id, body.sequence]);
      if (existing.rows[0]) {
        if (existingDevice.last_boot_id === body.boot_id)
          await client.query('UPDATE devices SET last_seen_at=$1 WHERE id=$2', [receivedAt, config.deviceId]);
        await client.query('COMMIT');
        return json(202, { accepted: true, duplicate: true, received_at: receivedAt });
      }
      if (existingDevice.last_boot_id === body.boot_id && existingDevice.last_sequence !== null &&
          body.sequence < Number(existingDevice.last_sequence)) {
        await client.query('COMMIT');
        return json(409, { error: 'sequence_out_of_order' });
      }
      await client.query(`INSERT INTO readings
        (device_id,boot_id,sequence,received_at,observed_at,observed_uptime_ms,payload_json)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [config.deviceId, body.boot_id, body.sequence,
        receivedAt, validTime(body.observed_at), body.observed_uptime_ms, JSON.stringify(body)]);
      const updatedSequence = existingDevice.last_boot_id === body.boot_id
        ? Math.max(Number(existingDevice.last_sequence || 0), body.sequence) : body.sequence;
      await client.query('UPDATE devices SET last_seen_at=$1,last_boot_id=$2,last_sequence=$3 WHERE id=$4',
        [receivedAt, body.boot_id, updatedSequence, config.deviceId]);
      await client.query('DELETE FROM readings WHERE device_id=$1 AND received_at < $2',
        [config.deviceId, new Date(Date.now() - RETENTION_MS).toISOString()]);
      await client.query('COMMIT');
      return json(202, { accepted: true, duplicate: false, received_at: receivedAt });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  if (pathname === '/api/v1/device/alerts' && request.method === 'POST') {
    if (!await requireDevice(request, config)) return json(401, { error: 'device_authentication_failed' });
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const body = parsed.body;
    const error = validateEvent(body, config.deviceId);
    if (error) return json(400, { error: 'invalid_request', message: error });
    const receivedAt = new Date().toISOString();
    const eventJson = JSON.stringify({ event: body.event, observed_uptime_s: body.observed_uptime_s });
    const result = await client.query(`INSERT INTO alerts
      (device_id,event_id,revision,boot_id,occurred_at,received_at,payload_json)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT(device_id,event_id) DO UPDATE SET revision=EXCLUDED.revision,
        boot_id=EXCLUDED.boot_id,occurred_at=EXCLUDED.occurred_at,received_at=EXCLUDED.received_at,
        payload_json=EXCLUDED.payload_json
      WHERE alerts.revision < EXCLUDED.revision
      RETURNING revision`, [config.deviceId, body.event_id, body.revision, body.boot_id,
      validTime(body.occurred_at), receivedAt, eventJson]);
    if (result.rows.length) return json(202, { accepted: true, duplicate: false,
      event_id: body.event_id, revision: body.revision, received_at: receivedAt });
    const current = await client.query('SELECT revision FROM alerts WHERE device_id=$1 AND event_id=$2',
      [config.deviceId, body.event_id]);
    const currentRevision = current.rows[0]?.revision;
    if (currentRevision > body.revision)
      return json(409, { error: 'event_revision_out_of_order', current_revision: currentRevision });
    return json(202, { accepted: true, duplicate: true,
      event_id: body.event_id, revision: body.revision, received_at: receivedAt });
  }

  if (pathname === '/api/v1/device/commands' && request.method === 'GET') {
    if (!await requireDevice(request, config)) return json(401, { error: 'device_authentication_failed' });
    const bootId = url.searchParams.get('boot_id') || '';
    if (!validateBoot(bootId)) return json(400, { error: 'invalid_request', message: 'A valid current boot_id is required.' });
    const now = new Date().toISOString();
    await client.query(`UPDATE commands SET state='expired',completed_at=$1,result_message='Command expired'
      WHERE device_id=$2 AND state IN ('queued','delivered') AND expires_at <= $1`, [now, config.deviceId]);
    const result = await client.query(`SELECT id,kind,payload_json,expires_at FROM commands
      WHERE device_id=$1 AND target_boot_id=$2 AND state IN ('queued','delivered') AND expires_at > $3
      ORDER BY created_at LIMIT 4`, [config.deviceId, bootId, now]);
    if (result.rows.length) {
      const ids = result.rows.map((row) => row.id);
      await client.query(`UPDATE commands SET state='delivered',delivered_at=$1,attempts=attempts+1
        WHERE id=ANY($2::uuid[]) AND state IN ('queued','delivered')`, [now, ids]);
    }
    return json(200, { commands: result.rows.map((row) => ({ id: row.id, kind: row.kind,
      expires_at: asIso(row.expires_at), payload: jsonValue(row.payload_json) })) });
  }

  if (pathname === '/api/v1/device/commands/result' && request.method === 'POST') {
    if (!await requireDevice(request, config)) return json(401, { error: 'device_authentication_failed' });
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const body = parsed.body;
    const resultValue = body.result;
    if (typeof body.command_id !== 'string' || !commandIdPattern.test(body.command_id) ||
        !validateBoot(body.boot_id) || !['succeeded','failed'].includes(resultValue) ||
        typeof body.message !== 'string' || body.message.length > 120)
      return json(400, { error: 'invalid_request', message: 'Invalid command result.' });
    await client.query('BEGIN');
    try {
      const found = await client.query(`SELECT state,target_boot_id,expires_at,result_message FROM commands
        WHERE id=$1 AND device_id=$2 FOR UPDATE`, [body.command_id, config.deviceId]);
      const command = found.rows[0];
      if (!command || command.target_boot_id !== body.boot_id) {
        await client.query('COMMIT');
        return json(404, { error: 'command_not_found_for_boot' });
      }
      const completedAt = new Date().toISOString();
      if (['queued','delivered'].includes(command.state) && new Date(command.expires_at).valueOf() <= Date.now()) {
        await client.query(`UPDATE commands SET state='expired',completed_at=$1,result_message='Command expired'
          WHERE id=$2 AND device_id=$3`, [completedAt, body.command_id, config.deviceId]);
        await client.query('COMMIT');
        return json(409, { error: 'command_expired' });
      }
      if (['succeeded','failed'].includes(command.state)) {
        await client.query('COMMIT');
        if (command.state === resultValue && command.result_message === body.message)
          return json(200, { accepted: true, duplicate: true });
        return json(409, { error: 'command_result_conflict' });
      }
      if (command.state === 'expired') {
        await client.query('COMMIT');
        return json(409, { error: 'command_expired' });
      }
      await client.query(`UPDATE commands SET state=$1,completed_at=$2,result_message=$3
        WHERE id=$4 AND device_id=$5`, [resultValue, completedAt, body.message, body.command_id, config.deviceId]);
      await client.query('COMMIT');
      return json(200, { accepted: true, duplicate: false });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  if (pathname === '/api/v1/dashboard' && request.method === 'GET')
    return json(200, await dashboardState(client, config.deviceId));
  if (pathname === '/api/v1/readings' && request.method === 'GET') {
    try { return json(200, { readings: await loadReadings(client, url, config.deviceId) }); }
    catch (error) {
      if (error.message === 'unsupported_reading_range')
        return json(400, { error: 'invalid_request', message: 'Unsupported reading range.' });
      throw error;
    }
  }
  if (pathname === '/api/v1/alerts' && request.method === 'GET')
    return json(200, { alerts: await loadAlerts(client, url, config.deviceId) });
  if (pathname === '/api/v1/alerts/ack' && request.method === 'POST') {
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const eventId = parsed.body.event_id;
    if (typeof eventId !== 'string' || !eventIdPattern.test(eventId))
      return json(400, { error: 'invalid_request', message: 'A valid event_id is required.' });
    const acknowledgement = await client.query(`UPDATE alerts SET acknowledged_at=NOW(),acknowledged_by=$1
      WHERE device_id=$2 AND event_id=$3 AND acknowledged_at IS NULL`,
    ['public visitor', config.deviceId, eventId]);
    if (!acknowledgement.rowCount) {
      const exists = await client.query('SELECT 1 FROM alerts WHERE device_id=$1 AND event_id=$2',
        [config.deviceId, eventId]);
      if (!exists.rowCount) return json(404, { error: 'event_not_found' });
    }
    return json(200, { acknowledged: true, changed: acknowledgement.rowCount === 1 });
  }
  if (pathname === '/api/v1/commands' && request.method === 'POST') {
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const payload = commandPayload(parsed.body);
    if (!payload) return json(400, { error: 'invalid_request', message: 'The maintenance command or its settings are invalid.' });
    await client.query('BEGIN');
    try {
      const deviceResult = await client.query('SELECT last_seen_at,last_boot_id FROM devices WHERE id=$1 FOR UPDATE',
        [config.deviceId]);
      const device = deviceResult.rows[0];
      if (!device.last_seen_at || Date.now() - new Date(device.last_seen_at).valueOf() > DEVICE_OFFLINE_MS || !device.last_boot_id) {
        await client.query('COMMIT');
        return json(409, { error: 'device_offline', message: 'The station must be online to receive a command.' });
      }
      const now = new Date().toISOString();
      await client.query(`UPDATE commands SET state='expired',completed_at=$1,result_message='Command expired'
        WHERE device_id=$2 AND state IN ('queued','delivered') AND expires_at <= $1`, [now, config.deviceId]);
      const pending = await client.query(`SELECT id FROM commands WHERE device_id=$1 AND target_boot_id=$2
        AND state IN ('queued','delivered') AND expires_at>$3 LIMIT 1`, [config.deviceId, device.last_boot_id, now]);
      if (pending.rowCount) {
        await client.query('COMMIT');
        return json(409, { error: 'command_pending', message: 'Wait for the current maintenance command to finish.' });
      }
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + COMMAND_TTL_MS).toISOString();
      await client.query(`INSERT INTO commands
        (id,device_id,target_boot_id,kind,payload_json,state,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5::jsonb,'queued',$6,$7)`, [id, config.deviceId, device.last_boot_id,
        parsed.body.kind, JSON.stringify(payload), now, expiresAt]);
      await client.query('COMMIT');
      return json(202, { accepted: true, command_id: id, state: 'queued', expires_in: COMMAND_TTL_MS / 1000 });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  if (pathname === '/api/v1/commands' && request.method === 'GET') {
    const result = await client.query(`SELECT id,kind,state,created_at,expires_at,completed_at,result_message
      FROM commands WHERE device_id=$1 ORDER BY created_at DESC LIMIT $2`, [config.deviceId, readLimit(url, 50)]);
    return json(200, { commands: result.rows.map((row) => ({ ...row,
      created_at: asIso(row.created_at), expires_at: asIso(row.expires_at), completed_at: asIso(row.completed_at),
    })) });
  }
  if (pathname === '/api/v1/readings.csv' && request.method === 'GET') {
    const rows = await loadReadings(client, url, config.deviceId);
    const columns = ['received_at','observed_at','observed_uptime_ms','soil_adc_raw','rain_adc_raw',
      'soil_wetness_pct','rain_wetness_pct','temperature_c','humidity_pct','relative_tilt_deg',
      'health.mpu','health.soil','health.rain','gps.status','gps.latitude','gps.longitude','gps.satellites',
      'delivery.event_queue_depth','delivery.event_queue_discarded','delivery.event_retry_count',
      'delivery.last_success_uptime_ms'];
    const lines = [columns.map(csvCell).join(',')];
    for (const row of rows) lines.push(columns.map((key) =>
      csvCell(key.split('.').reduce((value, part) => value?.[part], row))).join(','));
    return new Response(lines.join('\r\n'), { status: 200, headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="slide-readings.csv"',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  }
  return json(404, { error: 'route_not_found' });
}

export async function handleApiRequest(request) {
  if (request.method === 'OPTIONS') return new Response(null, {
    status: 204, headers: { 'Allow': 'GET, POST, DELETE', 'Cache-Control': 'no-store' },
  });
  if (!['GET','POST','DELETE'].includes(request.method))
    return json(405, { error: 'method_not_allowed' }, { 'Allow': 'GET, POST, DELETE' });
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/v1/')) return json(404, { error: 'route_not_found' });
  const config = getConfig();
  if (!config) return json(503, { error: 'api_not_configured' });
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 7000,
    idleTimeoutMillis: 1000 });
  let client;
  try {
    client = await pool.connect();
    await ensureSchema(client, config);
    return await route(client, request, url, config);
  } catch (error) {
    console.error('SLIDE Vercel API request failed', { name: error?.name, code: error?.code });
    return json(503, { error: 'service_unavailable' });
  } finally {
    try {
      client?.release();
      await pool.end();
    } catch (error) {
      console.error('SLIDE Vercel database pool close failed', { name: error?.name, code: error?.code });
    }
  }
}
