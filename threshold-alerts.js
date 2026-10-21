export const DEFAULT_THRESHOLDS = {
  mpu: { enabled: true, caution: 3, warning: 5, critical: 10 },
  soil: { enabled: true, threshold: 3000, direction: 'above' },
  rain: { enabled: true, threshold: 3000, direction: 'above' },
};

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const ranks = ['CAUTION', 'WARNING', 'CRITICAL'];

export function validateThresholds(config) {
  if (!config?.mpu || !config.soil || !config.rain) throw new Error('Missing sensor thresholds.');
  const mpu = config.mpu;
  if (typeof mpu.enabled !== 'boolean' ||
      ![mpu.caution, mpu.warning, mpu.critical].every((n) => finite(n) && n > 0 && n <= 180) ||
      mpu.caution >= mpu.warning || mpu.warning >= mpu.critical) {
    throw new Error('MPU levels must increase from caution to critical, above 0° and up to 180°.');
  }
  for (const name of ['soil', 'rain']) {
    const rule = config[name];
    if (typeof rule.enabled !== 'boolean' || !Number.isInteger(rule.threshold) ||
        rule.threshold < 0 || rule.threshold > 4095 || !['above', 'below'].includes(rule.direction)) {
      throw new Error('ADC thresholds must be whole numbers from 0 to 4095 with an alert direction.');
    }
  }
  // Retain only supported fields when reading browser storage.
  return {
    mpu: { enabled: mpu.enabled, caution: mpu.caution, warning: mpu.warning, critical: mpu.critical },
    ...Object.fromEntries(['soil', 'rain'].map((name) => [name, {
      enabled: config[name].enabled, threshold: config[name].threshold, direction: config[name].direction,
    }])),
  };
}

export function absoluteMpuAngle(readings) {
  if (!finite(readings?.pitch_deg) || !finite(readings.roll_deg) ||
      Math.abs(readings.pitch_deg) > 180 || Math.abs(readings.roll_deg) > 180) return null;
  return Math.max(Math.abs(readings.pitch_deg), Math.abs(readings.roll_deg));
}

export function telemetryFresh(snapshot, now = Date.now()) {
  const received = Date.parse(snapshot?.latest?.received_at);
  return snapshot?.device?.online === true && snapshot.telemetry_stale !== true &&
    Number.isFinite(received) && now - received >= -5000 && now - received <= 15_000;
}

// Independent of the firmware's baseline, test mode, settings and event delivery.
export class ThresholdAlerts {
  constructor(config = DEFAULT_THRESHOLDS) {
    this.config = validateThresholds(config);
    this.events = [];
    this.active = new Map();
    this.values = { mpu: null, soil: null, rain: null };
    this.bootId = null;
    this.sequence = null;
    this.counter = 0;
    this.instanceId = Math.random().toString(36).slice(2);
  }

  resolve(sensor, reason, now) {
    const record = this.active.get(sensor);
    if (!record) return;
    Object.assign(record.event, { resolved: true, stale: false, reason });
    record.resolved_at = new Date(now).toISOString();
    record.revision++;
    this.active.delete(sensor);
  }

  configure(config, now = Date.now()) {
    const next = validateThresholds(config);
    for (const sensor of ['mpu', 'soil', 'rain']) {
      if (JSON.stringify(this.config[sensor]) !== JSON.stringify(next[sensor])) {
        this.resolve(sensor, 'Threshold settings changed', now);
      }
    }
    this.config = next;
  }

  markStale() {
    this.values = { mpu: null, soil: null, rain: null };
    for (const record of this.active.values()) record.event.stale = true;
  }

  update(snapshot, now = Date.now()) {
    if (!telemetryFresh(snapshot, now)) { this.markStale(); return []; }
    const latest = snapshot.latest, readings = latest.readings || {}, health = latest.health || {};
    if (this.bootId && this.bootId !== latest.boot_id) {
      for (const sensor of this.active.keys()) this.resolve(sensor, 'Device restarted; previous condition unknown', now);
      this.sequence = null;
    }
    if (this.bootId === latest.boot_id && finite(latest.sequence) &&
        this.sequence !== null && latest.sequence < this.sequence) {
      this.markStale(); return [];
    }
    this.bootId = latest.boot_id;
    this.sequence = finite(latest.sequence) ? latest.sequence : this.sequence;
    const adc = (sensor) => health[sensor] === 'ONLINE' && Number.isInteger(readings[`${sensor}_adc_raw`]) &&
      readings[`${sensor}_adc_raw`] >= 0 && readings[`${sensor}_adc_raw`] <= 4095 ? readings[`${sensor}_adc_raw`] : null;
    this.values = {
      mpu: health.mpu === 'ONLINE' ? absoluteMpuAngle(readings) : null,
      soil: adc('soil'), rain: adc('rain'),
    };
    const notices = [];
    for (const sensor of ['mpu', 'soil', 'rain']) {
      const rule = this.config[sensor], value = this.values[sensor];
      let record = this.active.get(sensor);
      if (!rule.enabled) { this.resolve(sensor, 'Alert disabled', now); continue; }
      if (value === null) { if (record) record.event.stale = true; continue; }
      let severity = null, threshold = rule.threshold;
      if (sensor === 'mpu') {
        for (const level of ['caution', 'warning', 'critical']) {
          if (value >= rule[level]) { severity = level.toUpperCase(); threshold = rule[level]; }
        }
      } else if (rule.direction === 'above' ? value >= threshold : value <= threshold) severity = 'CAUTION';
      if (!severity) { this.resolve(sensor, 'Fresh reading returned to the normal range', now); continue; }
      if (!record) {
        const gps = latest.gps || {};
        record = {
          source: 'browser', event_id: `browser-${this.instanceId}-${++this.counter}`, revision: 1,
          boot_id: latest.boot_id, acknowledged: false,
          occurred_at: new Date(now).toISOString(), received_at: latest.received_at,
          observed_uptime_s: Math.floor((latest.observed_uptime_ms || 0) / 1000),
          event: { sensor: sensor === 'mpu' ? 'MPU_ANGLE' : sensor.toUpperCase(), severity, value, threshold,
            direction: sensor === 'mpu' ? 'above' : rule.direction, duration_s: 0, resolved: false, stale: false,
            gps_status: gps.status || 'UNAVAILABLE', latitude: gps.latitude ?? null, longitude: gps.longitude ?? null,
            fix_age_s: gps.fix_age_s ?? null },
        };
        this.events.unshift(record);
        this.active.set(sensor, record);
        if (this.events.length > 100) {
          const index = this.events.findLastIndex((item) => item.event.resolved);
          this.events.splice(index >= 0 ? index : this.events.length - 1, 1);
        }
        notices.push(record);
      } else {
        const escalated = ranks.indexOf(severity) > ranks.indexOf(record.event.severity);
        Object.assign(record.event, { severity, value, threshold, stale: false });
        if (escalated) { record.revision++; record.acknowledged = false; notices.push(record); }
      }
    }
    return notices;
  }
}
