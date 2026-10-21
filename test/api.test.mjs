import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function telemetry(sequence, observedAt = new Date().toISOString()) {
  return {
    schema_version: 1,
    device_id: 'SLIDE-TEST',
    boot_id: 'BOOTTEST1234567890',
    sequence,
    observed_uptime_ms: sequence * 5000,
    observed_at: observedAt,
    readings: {
      soil_adc_raw: 1200, rain_adc_raw: 1600,
      soil_wetness_pct: null, rain_wetness_pct: null,
      temperature_c: null, humidity_pct: null, relative_tilt_deg: null,
      accel_g: null, gyro_dps: null, pitch_deg: null, roll_deg: null,
    },
    health: {
      mpu: 'ONLINE', soil: 'ONLINE', rain: 'ONLINE', dht11: 'INITIALIZING',
      baseline_calibrated: false, test_mode: false,
    },
    gps: { status: 'UNAVAILABLE', latitude: null, longitude: null, satellites: -1, fix_age_s: null },
    calibration: {
      baseline_valid: false, calibrating: false, samples: 0, reason: 'not calibrated',
      gyro_bias_dps: [0, 0, 0],
      soil: { valid: false, dry: 0, wet: 0 },
      rain: { valid: false, dry: 0, wet: 0 },
    },
    settings: {
      test_mode: false,
      tilt_threshold: [3, 5, 10], tilt_duration_s: [10, 5, 5],
      adc_threshold: [50, 50], adc_duration_s: [10, 10], adc_enabled: [false, false],
    },
    delivery: {
      event_queue_depth: 0, event_queue_discarded: 0, event_retry_count: 0,
      last_success_uptime_ms: null,
    },
  };
}

test('public dashboard controls preserve device authentication and command lifecycle rules', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'slide-api-test-'));
  const port = await freePort();
  const deviceToken = 'test-device-token-'.padEnd(48, 'x');
  const bootId = 'BOOTTEST1234567890';
  const child = spawn(process.execPath, ['server/app.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), SLIDE_DATA_DIR: dataDir,
      SLIDE_DEVICE_ID: 'SLIDE-TEST', SLIDE_DEVICE_TOKEN: deviceToken,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let childError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { childError += chunk; });
  const base = `http://127.0.0.1:${port}`;

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`API exited during startup: ${childError}`);
      try {
        const response = await fetch(`${base}/healthz`);
        if (response.ok) { ready = true; break; }
      } catch { /* Wait for the local test server to bind. */ }
      await delay(50);
    }
    assert.equal(ready, true, `API did not start: ${childError}`);

    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Public station controls/);
    assert.doesNotMatch(pageHtml, /authGate|loginPassword|Dashboard password|Sign in to monitor/);
    assert.match(pageHtml, /Soil ADC/);
    assert.match(pageHtml, /MPU pitch \/ roll/);
    assert.match(pageHtml, /Temperature \/ humidity/);
    assert.doesNotMatch(pageHtml, /lcd-panel/);
    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') || '', /javascript/);
    const appScript = await script.text();
    assert.match(appScript, /readings\.soil_adc_raw/);
    assert.match(appScript, /readings\.pitch_deg/);
    assert.match(appScript, /readings\.humidity_pct/);
    assert.doesNotMatch(appScript, /Uncalibrated/);
    const icon = await fetch(`${base}/assets/icon-192.png`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type') || '', /image\/png/);
    assert.equal((await fetch(`${base}/README.md`)).status, 404, 'server must not expose repository files');
    assert.equal((await fetch(`${base}/server/app.mjs`)).status, 404, 'server source must not be served');

    const publicHeaders = { 'content-type': 'application/json' };
    const deviceHeaders = {
      authorization: `Bearer ${deviceToken}`, 'x-slide-device': 'SLIDE-TEST',
      'content-type': 'application/json',
    };

    const unauthorizedDevice = await fetch(`${base}/api/v1/device/verify`, {
      method: 'POST', headers: { ...deviceHeaders, authorization: 'Bearer invalid-token' },
      body: JSON.stringify({ schema_version: 1, device_id: 'SLIDE-TEST', boot_id: bootId }),
    });
    assert.equal(unauthorizedDevice.status, 401);
    assert.equal((await fetch(`${base}/api/v1/device/commands?boot_id=${bootId}`)).status, 401,
      'device command polling still requires device authentication');
    assert.equal((await fetch(`${base}/api/v1/session`)).status, 404,
      'dashboard session routes are removed');

    const verification = await fetch(`${base}/api/v1/device/verify`, {
      method: 'POST', headers: deviceHeaders,
      body: JSON.stringify({ schema_version: 1, device_id: 'SLIDE-TEST', boot_id: bootId }),
    });
    assert.equal(verification.status, 200);
    assert.equal((await verification.json()).telemetry_interval_s, 2.5);

    const sendTelemetry = async (sequence, observedAt) => fetch(`${base}/api/v1/device/telemetry`, {
      method: 'POST', headers: deviceHeaders, body: JSON.stringify(telemetry(sequence, observedAt)),
    });
    assert.equal((await sendTelemetry(1)).status, 202);
    assert.equal((await (await sendTelemetry(3)).json()).accepted, true);

    const oldDuplicate = await sendTelemetry(1);
    assert.equal(oldDuplicate.status, 202, 'an accepted sequence remains idempotent after newer readings arrive');
    assert.equal((await oldDuplicate.json()).duplicate, true);

    const unseenOutOfOrder = await sendTelemetry(2);
    assert.equal(unseenOutOfOrder.status, 409);
    assert.equal((await unseenOutOfOrder.json()).error, 'sequence_out_of_order');

    const staleObservation = new Date(Date.now() - 60_000).toISOString();
    assert.equal((await sendTelemetry(4, staleObservation)).status, 202);
    const dashboard = await fetch(`${base}/api/v1/dashboard`);
    const snapshot = await dashboard.json();
    assert.equal(dashboard.status, 200);
    assert.equal(snapshot.latest.sequence, 4);
    assert.equal(snapshot.telemetry_stale, true, 'old device observation is stale even when just received');
    assert.equal((await fetch(`${base}/api/v1/readings?range=24h`)).status, 200);

    const alert = {
      schema_version: 1, device_id: 'SLIDE-TEST', boot_id: bootId, event_id: 'EVENT-123',
      revision: 1, observed_uptime_s: 15, occurred_at: new Date().toISOString(),
      event: { severity: 'WARNING', sensor: 'TILT', value: 5, threshold: 4, duration_s: 5,
        resolved: false, simulated: false, gps_status: 'UNAVAILABLE', latitude: null,
        longitude: null, satellites: -1, fix_age_s: null },
    };
    const postedAlert = await fetch(`${base}/api/v1/device/alerts`, {
      method: 'POST', headers: deviceHeaders, body: JSON.stringify(alert),
    });
    assert.equal(postedAlert.status, 202);
    const publicAlerts = await fetch(`${base}/api/v1/alerts`);
    assert.equal(publicAlerts.status, 200);
    assert.equal((await publicAlerts.json()).alerts.length, 1);
    const acknowledged = await fetch(`${base}/api/v1/alerts/ack`, {
      method: 'POST', headers: publicHeaders, body: JSON.stringify({ event_id: alert.event_id }),
    });
    assert.equal(acknowledged.status, 200, 'any visitor can acknowledge an alert');
    assert.deepEqual(await acknowledged.json(), { acknowledged: true, changed: true });

    const extraField = await fetch(`${base}/api/v1/commands`, {
      method: 'POST', headers: publicHeaders,
      body: JSON.stringify({ kind: 'set_test_mode', enabled: true, unexpected: 1 }),
    });
    assert.equal(extraField.status, 400);

    const queued = await fetch(`${base}/api/v1/commands`, {
      method: 'POST', headers: publicHeaders,
      body: JSON.stringify({ kind: 'set_test_mode', enabled: true }),
    });
    assert.equal(queued.status, 202);
    const commandId = (await queued.json()).command_id;
    assert.equal((await fetch(`${base}/api/v1/commands?limit=25`)).status, 200,
      'maintenance command history is public');
    const poll = await fetch(`${base}/api/v1/device/commands?boot_id=${bootId}`, { headers: deviceHeaders });
    const commands = (await poll.json()).commands;
    assert.equal(poll.status, 200);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].id, commandId);

    const commandResult = {
      command_id: commandId, boot_id: bootId, result: 'succeeded', message: 'Applied',
    };
    const resultResponse = await fetch(`${base}/api/v1/device/commands/result`, {
      method: 'POST', headers: deviceHeaders, body: JSON.stringify(commandResult),
    });
    assert.equal(resultResponse.status, 200);
    assert.equal((await resultResponse.json()).duplicate, false);

    const duplicateResult = await fetch(`${base}/api/v1/device/commands/result`, {
      method: 'POST', headers: deviceHeaders, body: JSON.stringify(commandResult),
    });
    assert.equal(duplicateResult.status, 200);
    assert.equal((await duplicateResult.json()).duplicate, true);

    const conflictingResult = await fetch(`${base}/api/v1/device/commands/result`, {
      method: 'POST', headers: deviceHeaders,
      body: JSON.stringify({ ...commandResult, result: 'failed' }),
    });
    assert.equal(conflictingResult.status, 409);
    t.diagnostic('API started with isolated test credentials and a disposable SQLite database.');
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
