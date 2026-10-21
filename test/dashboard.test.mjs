import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate as settle } from 'node:timers/promises';
import { DEFAULT_THRESHOLDS, ThresholdAlerts, validateThresholds, absoluteMpuAngle, telemetryFresh } from '../threshold-alerts.js';

class Element {
  constructor() { this.dataset = {}; this.children = []; this.hidden = false; this.checked = false; this.style = {}; this._value = ''; }
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get firstElementChild() { return this.children[0]; }
  append(...items) { for (const item of items) { if (typeof item === 'object') item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  setAttribute() {} toggleAttribute() {} addEventListener() {} focus() {}
  querySelectorAll() { return []; }
}

async function dashboard({ stored = new Map(), blockedStorage = false } = {}) {
  const elements = new Map(), calls = [], callbacks = new Map();
  const element = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let failLive = false, failHistory = false;
  const snapshot = {
    device: { id: 'SLIDE-001', online: true, last_seen_at: new Date().toISOString() }, telemetry_stale: false,
    latest: { boot_id: 'testboot1', sequence: 1, observed_uptime_ms: 1000, received_at: new Date().toISOString(),
      readings: { pitch_deg: 0, roll_deg: 0, soil_adc_raw: 2000, rain_adc_raw: 2000, temperature_c: 25, humidity_pct: 50 },
      health: { mpu: 'ONLINE', soil: 'ONLINE', rain: 'ONLINE', baseline_calibrated: false, test_mode: false },
      gps: { status: 'UNAVAILABLE', latitude: null, longitude: null } },
  };
  let api;
  const context = {
    DEFAULT_THRESHOLDS, ThresholdAlerts, validateThresholds, absoluteMpuAngle, telemetryFresh,
    document: { querySelector: element, querySelectorAll: () => [], createElement: () => new Element(), createElementNS: () => new Element(),
      body: new Element(), documentElement: new Element(), hidden: false },
    navigator: { onLine: true }, location: { hash: '#overview' }, history: { replaceState() {} }, scrollTo() {},
    addEventListener: (name, handler) => callbacks.set(name, handler),
    setTimeout: () => 1, setInterval: () => 1, clearTimeout() {}, queueMicrotask,
    sessionStorage: { getItem: () => 'test-session', removeItem() {} },
    localStorage: { getItem(key) { if (blockedStorage) throw Error('blocked'); return stored.get(key) ?? null; },
      setItem(key, value) { if (blockedStorage) throw Error('blocked'); stored.set(key, value); } },
    Headers, AbortSignal,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (failLive && url.endsWith('/dashboard')) throw Error('offline');
      if (failHistory && (url.includes('/readings?') || url.includes('/alerts?'))) throw Error('history unavailable');
      const data = url.endsWith('/dashboard') ? snapshot : url.includes('/readings?') ? { readings: [] } : { alerts: [] };
      return { status: 200, ok: true, json: async () => data };
    },
    capture(value) { api = value; },
  };
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  vm.runInNewContext(source.replace(/^import[^\n]+\n/, '') + '\ncapture({refresh, engine: () => webAlerts});', context);
  await settle(); await settle();
  return { elements, calls, stored, snapshot, context, api, element,
    failLive: () => { failLive = true; }, failHistory: () => { failHistory = true; } };
}

test('dashboard loads saved thresholds, preserves drafts through polling, and saves without firmware commands', async () => {
  const key = 'slide.browser-thresholds.v1:SLIDE-001';
  const config = validateThresholds(DEFAULT_THRESHOLDS); config.mpu.warning = 7;
  const browser = await dashboard({ stored: new Map([[key, JSON.stringify(config)]]) });
  assert.equal(browser.element('#warning').value, '7');
  browser.element('#warning').value = '8';
  await browser.api.refresh();
  assert.equal(browser.element('#warning').value, '8');
  browser.element('#save-thresholds').onclick();
  assert.equal(JSON.parse(browser.stored.get(key)).mpu.warning, 8);
  assert.ok(browser.calls.every((call) => call.options.method !== 'POST'));
  const reloaded = await dashboard({ stored: browser.stored });
  assert.equal(reloaded.element('#warning').value, '8');
});

test('live values trigger browser alerts with no baseline/test mode, independent of history failures', async () => {
  const browser = await dashboard(); browser.failHistory();
  browser.snapshot.latest.readings.roll_deg = -12;
  browser.snapshot.latest.readings.soil_adc_raw = 3500;
  await browser.api.refresh();
  assert.equal(browser.api.engine().active.size, 2);
  assert.match(browser.element('#threshold-banner').textContent, /CRITICAL/);
  browser.failLive(); await browser.api.refresh();
  assert.ok([...browser.api.engine().active.values()].every((record) => record.event.stale));
  assert.match(browser.element('#threshold-banner').textContent, /STALE/);
});

test('blocked or corrupt browser storage does not stop automatic alerts', async () => {
  const blocked = await dashboard({ blockedStorage: true });
  blocked.element('#warning').value = '8'; blocked.element('#save-thresholds').onclick();
  assert.equal(blocked.api.engine().config.mpu.warning, 8);
  assert.match(blocked.element('#threshold-feedback').textContent, /storage is unavailable/);
  const corrupt = await dashboard({ stored: new Map([['slide.browser-thresholds.v1:SLIDE-001', '{broken']]) });
  assert.equal(corrupt.element('#warning').value, '5');
  assert.match(corrupt.element('#threshold-feedback').textContent, /editable defaults/);
});

test('invalid input leaves saved criteria unchanged and reports the error', async () => {
  const browser = await dashboard();
  browser.element('#soil-threshold').value = '';
  browser.element('#save-thresholds').onclick();
  assert.equal(browser.api.engine().config.soil.threshold, 3000);
  assert.match(browser.element('#threshold-feedback').textContent, /whole numbers/);
});

test('direct signed pitch/roll and temperature/humidity displays remain available without calibration', async () => {
  const browser = await dashboard();
  Object.assign(browser.snapshot.latest.readings, { pitch_deg: -6, roll_deg: 12, temperature_c: 26, humidity_pct: 60 });
  await browser.api.refresh();
  assert.equal(browser.element('#pitch-reading').children[0], '-6');
  assert.equal(browser.element('#roll-reading').children[0], '+12');
  assert.equal(browser.element('#air-temperature').children[0], '26');
  assert.equal(browser.element('#air-humidity').children[0], '60');
  assert.equal(browser.api.engine().active.get('mpu').event.severity, 'CRITICAL');
  assert.match(browser.element('#tilt-detail').textContent, /Alert angle 12.0°/);
});
