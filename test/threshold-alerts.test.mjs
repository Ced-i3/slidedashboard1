import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS, ThresholdAlerts, validateThresholds, telemetryFresh, absoluteMpuAngle } from '../threshold-alerts.js';

const now = Date.UTC(2026, 9, 22);
export function snapshot(readings = {}, options = {}) {
  return {
    device: { id: 'SLIDE-001', online: true }, telemetry_stale: false,
    latest: { boot_id: 'testboot1', sequence: 1, received_at: new Date(now).toISOString(), observed_uptime_ms: 100000,
      readings: { pitch_deg: 0, roll_deg: 0, soil_adc_raw: 2000, rain_adc_raw: 2000, ...readings },
      health: { mpu: 'ONLINE', soil: 'ONLINE', rain: 'ONLINE', baseline_calibrated: false, test_mode: false },
      gps: { status: 'UNAVAILABLE', latitude: null, longitude: null }, ...options },
  };
}

test('MPU alerts immediately at inclusive default boundaries without baseline or test mode', () => {
  for (const [angle, severity] of [[2.99, null], [3, 'CAUTION'], [5, 'WARNING'], [10, 'CRITICAL'], [-10, 'CRITICAL']]) {
    const engine = new ThresholdAlerts();
    assert.equal(engine.update(snapshot({ roll_deg: angle }), now)[0]?.event.severity ?? null, severity);
  }
  assert.equal(absoluteMpuAngle({ pitch_deg: -7, roll_deg: 2 }), 7);
});

test('ADC thresholds alert independently of an unavailable MPU and include equality', () => {
  const engine = new ThresholdAlerts();
  const notices = engine.update(snapshot({ pitch_deg: null, roll_deg: null, soil_adc_raw: 3000, rain_adc_raw: 4095 }), now);
  assert.deepEqual(notices.map((record) => record.event.sensor), ['SOIL', 'RAIN']);
  assert.equal(engine.values.mpu, null);
});

test('repeated readings do not duplicate alerts; escalation notifies and acknowledgment does not resolve', () => {
  const engine = new ThresholdAlerts();
  engine.update(snapshot({ pitch_deg: 3 }), now);
  const record = engine.active.get('mpu'); record.acknowledged = true;
  assert.equal(engine.update(snapshot({ pitch_deg: 4 }), now).length, 0);
  assert.equal(record.acknowledged, true);
  assert.equal(record.event.resolved, false);
  assert.equal(engine.update(snapshot({ pitch_deg: 10 }), now).length, 1);
  assert.equal(record.acknowledged, false);
  assert.equal(engine.events.length, 1);
  engine.update(snapshot({ pitch_deg: 6 }), now);
  assert.equal(record.event.severity, 'WARNING');
  engine.update(snapshot(), now);
  assert.equal(record.event.resolved, true);
  assert.equal(engine.active.size, 0);
  assert.equal(engine.update(snapshot({ pitch_deg: 3 }), now).length, 1);
});

test('stale, offline, malformed and future telemetry cannot create alerts', () => {
  const old = snapshot({ pitch_deg: 20 }); old.latest.received_at = new Date(now - 15001).toISOString();
  const offline = snapshot({ pitch_deg: 20 }); offline.device.online = false;
  const flagged = snapshot({ pitch_deg: 20 }); flagged.telemetry_stale = true;
  const future = snapshot({ pitch_deg: 20 }); future.latest.received_at = new Date(now + 5001).toISOString();
  const invalid = snapshot({ pitch_deg: 20 }); invalid.latest.received_at = 'not-a-time';
  for (const value of [null, {}, old, offline, flagged, future, invalid]) {
    assert.equal(telemetryFresh(value, now), false);
    assert.equal(new ThresholdAlerts().update(value, now).length, 0);
  }
  assert.equal(telemetryFresh(snapshot(), now + 15000), true);
});

test('stale/invalid sensor data cannot falsely clear active conditions', () => {
  const engine = new ThresholdAlerts();
  engine.update(snapshot({ pitch_deg: 12, soil_adc_raw: 3500 }), now);
  engine.update(snapshot(), now + 16000);
  assert.equal(engine.active.size, 2);
  assert.ok([...engine.active.values()].every((record) => record.event.stale));
  engine.update(snapshot({ pitch_deg: null, soil_adc_raw: null }), now);
  assert.equal(engine.active.size, 2);
  engine.update(snapshot(), now);
  assert.equal(engine.active.size, 0);
});

test('non-ONLINE sensors and invalid numeric fields are excluded separately', () => {
  for (const value of [null, NaN, Infinity, '20', 181]) {
    assert.equal(new ThresholdAlerts().update(snapshot({ roll_deg: value }), now).length, 0);
  }
  for (const value of [null, NaN, Infinity, '3500', -1, 4096, 3500.5]) {
    assert.equal(new ThresholdAlerts().update(snapshot({ soil_adc_raw: value }), now).length, 0);
  }
  const reading = snapshot({ roll_deg: 20, soil_adc_raw: 3500, rain_adc_raw: 3500 });
  reading.latest.health.mpu = 'ERROR'; reading.latest.health.soil = 'OFFLINE';
  const engine = new ThresholdAlerts();
  assert.deepEqual(engine.update(reading, now).map((record) => record.event.sensor), ['RAIN']);
});

test('ADC below direction, zero values and low thresholds resolve correctly', () => {
  const cfg = validateThresholds(DEFAULT_THRESHOLDS);
  cfg.soil = { enabled: true, threshold: 1000, direction: 'below' }; cfg.rain.threshold = 5;
  const engine = new ThresholdAlerts(cfg);
  assert.equal(engine.update(snapshot({ soil_adc_raw: 1000, rain_adc_raw: 5 }), now).length, 2);
  engine.update(snapshot({ soil_adc_raw: 1001, rain_adc_raw: 0 }), now);
  assert.equal(engine.active.size, 0);
  assert.equal(engine.update(snapshot({ soil_adc_raw: 0, rain_adc_raw: 0 }), now)[0].event.sensor, 'SOIL');
});

test('settings apply per sensor, can disable alerts and survive serialization', () => {
  const engine = new ThresholdAlerts();
  engine.update(snapshot({ pitch_deg: 10, soil_adc_raw: 3500 }), now);
  const config = validateThresholds(DEFAULT_THRESHOLDS); config.soil.enabled = false;
  const originalMpu = engine.active.get('mpu');
  engine.configure(config, now);
  assert.equal(engine.active.get('mpu'), originalMpu);
  assert.equal(engine.active.has('soil'), false);
  const restored = new ThresholdAlerts(JSON.parse(JSON.stringify(config)));
  assert.equal(restored.update(snapshot({ soil_adc_raw: 3500 }), now).length, 0);
  assert.equal(DEFAULT_THRESHOLDS.soil.enabled, true);
});

test('invalid settings are rejected before modifying existing alert state', () => {
  const engine = new ThresholdAlerts(); engine.update(snapshot({ pitch_deg: 10 }), now);
  for (const config of [null, {}, { ...DEFAULT_THRESHOLDS, mpu: { enabled: true, caution: 10, warning: 5, critical: 3 } },
    { ...DEFAULT_THRESHOLDS, soil: { enabled: true, threshold: 4096, direction: 'above' } },
    { ...DEFAULT_THRESHOLDS, rain: { enabled: true, threshold: 1000, direction: 'invalid' } }]) {
    assert.throws(() => engine.configure(config, now));
    assert.deepEqual(engine.config, DEFAULT_THRESHOLDS);
    assert.equal(engine.active.size, 1);
  }
});

test('history stays bounded without dropping live conditions', () => {
  const engine = new ThresholdAlerts();
  for (let i = 0; i < 120; ++i) {
    engine.update(snapshot({ pitch_deg: 10, soil_adc_raw: 3500, rain_adc_raw: 3500 }), now);
    engine.update(snapshot({ pitch_deg: 10, soil_adc_raw: 0, rain_adc_raw: 0 }), now);
  }
  assert.equal(engine.events.length, 100);
  assert.ok(engine.events.includes(engine.active.get('mpu')));
  assert.equal(engine.active.size, 1);
});

test('device reboot closes previous conditions as unknown and evaluates fresh values', () => {
  const engine = new ThresholdAlerts(); engine.update(snapshot({ pitch_deg: 12 }), now);
  const original = engine.active.get('mpu');
  assert.equal(engine.update(snapshot({ pitch_deg: 12 }, { boot_id: 'testboot2' }), now).length, 1);
  assert.equal(original.event.resolved, true);
  assert.match(original.event.reason, /unknown/);
});

test('out-of-order sequences cannot resolve active conditions', () => {
  const engine = new ThresholdAlerts();
  engine.update(snapshot({ pitch_deg: 12 }, { sequence: 5 }), now);
  engine.update(snapshot({}, { sequence: 4 }), now);
  assert.equal(engine.active.size, 1);
  assert.equal(engine.active.get('mpu').event.stale, true);
});
