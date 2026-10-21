const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API = '/api/v1';
const SVG = 'http://www.w3.org/2000/svg';
const sidebar = $('#sidebar');
const scrim = $('#scrim');
const modal = $('#modal');
const toastHost = $('#toasts');
let lastFocus = null;
let dashboardSnapshot = null;
let latestSettings = null;
let activeRange = '24h';
let shownEvents = new Set();
let eventsInitiallyLoaded = false;
let refreshBusy = false;
let refreshAgain = false;

function page(name, updateHash = true) {
  if (!['overview', 'history', 'sites', 'settings'].includes(name)) name = 'overview';
  $$('[data-page]').forEach((element) => { element.hidden = element.dataset.page !== name; });
  $$('[data-view]').forEach((element) => {
    element.toggleAttribute('aria-current', element.dataset.view === name);
  });
  if (updateHash) history.replaceState(null, '', `#${name}`);
  closeMenu();
  scrollTo(0, 0);
}

function closeMenu() {
  sidebar.classList.remove('open');
  scrim.classList.remove('show');
  document.body.style.overflow = '';
}

function toast(title, message, type = '') {
  const existing = $$('[data-key]', toastHost).find((item) => item.dataset.key === title);
  existing?.remove();
  while (toastHost.children.length > 2) toastHost.firstElementChild.remove();
  const article = document.createElement('article');
  article.className = type;
  article.dataset.key = title;
  const content = document.createElement('div');
  const heading = document.createElement('strong');
  const detail = document.createElement('small');
  const dismiss = document.createElement('button');
  heading.textContent = title;
  detail.textContent = message;
  dismiss.type = 'button';
  dismiss.textContent = '×';
  dismiss.setAttribute('aria-label', 'Dismiss notification');
  dismiss.onclick = () => article.remove();
  content.append(heading, detail);
  article.append(content, dismiss);
  toastHost.append(article);
  setTimeout(() => article.remove(), 6500);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API}${path}`, {
    ...options, headers, cache: 'no-store', credentials: 'same-origin',
  });
  if (!response.ok) {
    let message = `Station service returned ${response.status}.`;
    try { message = (await response.json()).message || message; } catch { /* Use the status text. */ }
    throw new Error(message);
  }
  return response;
}

async function getJson(path) {
  return (await api(path)).json();
}

async function postJson(path, body) {
  return (await api(path, { method: 'POST', body: JSON.stringify(body) })).json();
}

function closeModal() {
  modal.hidden = true;
  document.body.style.overflow = '';
  lastFocus?.focus();
}

function openModal() {
  lastFocus = document.activeElement;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  $('.modal-head button').focus();
  refreshAlerts();
}

function formatTime(value, unavailable = 'Unavailable') {
  if (!value) return unavailable;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? unavailable : new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium', timeStyle: 'medium',
  }).format(date);
}

function formatRelative(value) {
  if (!value) return 'No contact recorded';
  const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (!Number.isFinite(elapsed)) return 'Unavailable';
  if (elapsed < 60) return `${elapsed} seconds ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)} minutes ago`;
  return `${Math.floor(elapsed / 3600)} hours ago`;
}

function showMeasurement(element, value, unit, digits = 1) {
  element.replaceChildren();
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    element.append('—');
    const small = document.createElement('small');
    small.textContent = 'unavailable';
    element.append(small);
    return;
  }
  element.append(Number(value.toFixed(digits)).toString());
  const small = document.createElement('small');
  small.textContent = unit;
  element.append(small);
}

function sensorState(id, value) {
  const element = $(`#${id}`);
  element.textContent = value;
  element.dataset.state = value.toLowerCase().replace(/[^a-z]+/g, '-');
}

function renderDelivery(latest) {
  const fields = ['delivery-queue', 'delivery-dropped', 'delivery-retries', 'delivery-last-success'];
  const unavailable = latest ? 'Not reported by this firmware' : 'Waiting for telemetry';
  const delivery = latest?.delivery;
  if (!delivery || !Number.isInteger(delivery.event_queue_depth) ||
      !Number.isSafeInteger(delivery.event_queue_discarded) ||
      !Number.isSafeInteger(delivery.event_retry_count)) {
    fields.forEach((id) => { $(`#${id}`).textContent = unavailable; });
    $('#delivery-observed-at').textContent = latest?.received_at
      ? `Delivery counters were not present in the snapshot received ${formatTime(latest.received_at)}.`
      : 'Delivery counters are not yet available.';
    return;
  }
  $('#delivery-queue').textContent = String(delivery.event_queue_depth);
  $('#delivery-dropped').textContent = delivery.event_queue_discarded.toLocaleString();
  $('#delivery-retries').textContent = delivery.event_retry_count.toLocaleString();
  $('#delivery-last-success').textContent = Number.isSafeInteger(delivery.last_success_uptime_ms)
    ? `${Math.floor(delivery.last_success_uptime_ms / 1000).toLocaleString()} s`
    : 'No accepted upload recorded this boot';
  $('#delivery-observed-at').textContent = latest.received_at
    ? `Counters reflect the device snapshot received ${formatTime(latest.received_at)}. Queue contents are held in device RAM and may be lost on reboot.`
    : 'Delivery counters are from the latest device snapshot.';
}

function updateNetworkState(snapshot) {
  const deviceOnline = snapshot?.device?.online === true;
  const receivedAt = snapshot?.latest?.received_at;
  const isStale = snapshot?.telemetry_stale === true || !receivedAt || Date.now() - Date.parse(receivedAt) > 15_000;
  const browserOffline = navigator.onLine === false;
  let state = 'offline';
  let message = 'No telemetry has reached the server.';
  let shortMessage = 'Offline';
  if (browserOffline) {
    state = 'stale';
    message = 'This browser is offline. The timestamped data below is the last data received by the server.';
    shortMessage = 'Browser offline';
  } else if (!deviceOnline) {
    state = 'offline';
    message = 'The station has not contacted the server recently. Readings are not live.';
    shortMessage = 'Station offline';
  } else if (isStale) {
    state = 'stale';
    message = 'The device is reachable, but its last sensor observation is more than 15 seconds old.';
    shortMessage = 'Readings stale';
  } else {
    state = 'current';
    message = `Receiving device data. Last contact ${formatRelative(snapshot.device.last_seen_at)}.`;
    shortMessage = 'Receiving data';
  }
  $('#live-banner').dataset.state = state;
  $('#live-banner').textContent = message;
  $('#mobileStatus').dataset.state = state;
  $('#mobileStatus').textContent = shortMessage;
  $('#netDot').classList.toggle('off', state !== 'current');
  $('#netStatus').textContent = shortMessage;
  $('#site-status').dataset.state = state;
  $('#site-status').textContent = state === 'current' ? 'Contacting server' : shortMessage;
}

function renderOverview(snapshot) {
  dashboardSnapshot = snapshot;
  updateNetworkState(snapshot);
  const device = snapshot.device || {};
  const latest = snapshot.latest;
  $('#station-location').textContent = `Monitoring station · ${device.id || 'unconfigured'}`;
  $('#site-device-id').textContent = device.id || 'Unconfigured';
  $('#site-last-seen').textContent = device.last_seen_at
    ? `${formatRelative(device.last_seen_at)} · ${formatTime(device.last_seen_at)}` : 'No contact recorded';
  $('#last-updated').textContent = latest ? formatTime(latest.received_at) : 'Waiting for first upload';
  $('#last-observed').textContent = latest
    ? `Device observation: ${formatTime(latest.observed_at, `uptime ${Math.floor(latest.observed_uptime_ms / 1000)} s`)}`
    : 'Observation time unavailable';
  renderDelivery(latest);

  if (!latest) {
    ['soil-state','tilt-state','rain-state','air-state'].forEach((id) => sensorState(id, 'Unavailable'));
    showMeasurement($('#soil-reading'), null, '');
    showMeasurement($('#tilt-reading'), null, '');
    showMeasurement($('#rain-reading'), null, '');
    showMeasurement($('#air-reading'), null, '');
    $('#site-coordinates').textContent = 'Coordinates unavailable.';
    $('#site-gps-status').textContent = 'Unavailable';
    $('#site-satellites').textContent = 'Unavailable';
    $('#site-baseline').textContent = 'Unavailable';
    $('#site-test-mode').textContent = 'Off or unavailable';
    $('#map-empty').hidden = false;
    $('#map-empty').textContent = 'Station coordinates are not available yet.';
    $('#map-marker').hidden = true;
    renderMaintenance(null);
    return;
  }

  const readings = latest.readings || {};
  const health = latest.health || {};
  const gps = latest.gps || {};
  const soilWetness = readings.soil_wetness_pct;
  showMeasurement($('#soil-reading'), soilWetness, '%', 1);
  sensorState('soil-state', soilWetness === null || soilWetness === undefined
    ? (readings.soil_adc_raw === null ? 'Unavailable' : 'Uncalibrated') : (health.soil || 'Unknown'));
  $('#soil-detail').textContent = readings.soil_adc_raw === null || readings.soil_adc_raw === undefined
    ? 'Raw ADC reading unavailable.' : `Raw ADC ${readings.soil_adc_raw} · ${soilWetness == null ? 'wetness calibration required' : 'calibrated relative wetness'}`;

  const tiltValid = health.mpu === 'ONLINE' && health.baseline_calibrated && typeof readings.relative_tilt_deg === 'number';
  showMeasurement($('#tilt-reading'), tiltValid ? readings.relative_tilt_deg : null, '°', 2);
  sensorState('tilt-state', health.mpu !== 'ONLINE' ? (health.mpu || 'Unavailable')
    : !health.baseline_calibrated ? 'Uncalibrated' : tiltValid ? 'Calibrated' : 'Unavailable');
  $('#tilt-detail').textContent = tiltValid ? 'Angle relative to the stored baseline.'
    : 'Valid MPU data and a calibrated baseline are required.';

  const rainWetness = readings.rain_wetness_pct;
  showMeasurement($('#rain-reading'), rainWetness, '%', 1);
  sensorState('rain-state', rainWetness === null || rainWetness === undefined
    ? (readings.rain_adc_raw === null ? 'Unavailable' : 'Uncalibrated') : (health.rain || 'Unknown'));
  $('#rain-detail').textContent = readings.rain_adc_raw === null || readings.rain_adc_raw === undefined
    ? 'Raw rain-plate ADC reading unavailable.' : `Raw ADC ${readings.rain_adc_raw} · relative plate wetness only`;

  showMeasurement($('#air-reading'), readings.temperature_c, '°C', 1);
  sensorState('air-state', health.dht11 || 'Unknown');
  $('#air-detail').textContent = typeof readings.humidity_pct === 'number'
    ? `Relative humidity ${readings.humidity_pct}% · DHT11.` : 'Humidity reading unavailable.';

  $('#site-baseline').textContent = health.baseline_calibrated ? 'Calibrated' : 'Required';
  $('#site-test-mode').textContent = health.test_mode ? 'Enabled for this boot' : 'Off';
  $('#site-gps-status').textContent = gps.status || 'Unavailable';
  $('#site-satellites').textContent = Number.isInteger(gps.satellites) && gps.satellites >= 0
    ? String(gps.satellites) : 'Unavailable';
  if (typeof gps.latitude === 'number' && typeof gps.longitude === 'number' && gps.status !== 'UNAVAILABLE') {
    $('#site-coordinates').textContent = `${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)} · ${gps.status} · monitoring station`;
    $('#map-empty').hidden = true;
    $('#map-marker').hidden = false;
    $('#map-marker').href = `https://www.google.com/maps?q=${encodeURIComponent(`${gps.latitude},${gps.longitude}`)}`;
    $('#map-marker').setAttribute('aria-label', `Open station coordinates ${gps.latitude.toFixed(4)}, ${gps.longitude.toFixed(4)} in maps`);
  } else {
    $('#site-coordinates').textContent = 'Coordinates unavailable.';
    $('#map-empty').hidden = false;
    $('#map-empty').textContent = 'Station coordinates are not available yet.';
    $('#map-marker').hidden = true;
  }
  renderMaintenance(latest);
}

function timeRange(readings, key) {
  const values = readings.map((row) => ({ at: row.received_at, value: key(row) }))
    .filter((sample) => Number.isFinite(sample.value) && sample.at);
  if (!values.length) return 'No calibrated samples in this period.';
  const low = Math.min(...values.map((sample) => sample.value));
  const high = Math.max(...values.map((sample) => sample.value));
  return `${values.length} samples · ${low.toFixed(1)}–${high.toFixed(1)} · ${formatTime(values[0].at, '')} to ${formatTime(values.at(-1).at, '')}`;
}

function renderTrend(svgId, rangeId, rows, pick, colour) {
  const svg = $(`#${svgId}`);
  svg.replaceChildren();
  for (const y of [12, 34, 56, 78]) {
    const grid = document.createElementNS(SVG, 'line');
    grid.setAttribute('x1', '0'); grid.setAttribute('x2', '300');
    grid.setAttribute('y1', String(y)); grid.setAttribute('y2', String(y));
    grid.setAttribute('stroke', '#e4ebe7'); grid.setAttribute('stroke-width', '1');
    svg.append(grid);
  }
  const series = rows.map((row, index) => ({ index, value: pick(row) }));
  const values = series.map((sample) => sample.value).filter(Number.isFinite);
  if (!values.length) {
    $('#'+rangeId).textContent = 'No calibrated samples in this period.';
    return;
  }
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = Math.max(0.1, maximum - minimum);
  const paths = [];
  let current = [];
  for (const sample of series) {
    if (!Number.isFinite(sample.value)) {
      if (current.length) paths.push(current);
      current = [];
      continue;
    }
    const denominator = Math.max(1, series.length - 1);
    current.push(`${(sample.index / denominator * 292 + 4).toFixed(1)},${(80 - (sample.value - minimum) / span * 66).toFixed(1)}`);
  }
  if (current.length) paths.push(current);
  for (const coordinates of paths) {
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('points', coordinates.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', colour);
    line.setAttribute('stroke-width', '2.5');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    svg.append(line);
  }
  $('#'+rangeId).textContent = timeRange(rows, pick);
}

function readingsRangeUrl(range) { return `/readings?range=${encodeURIComponent(range)}&limit=500`; }

function renderChart(readings) {
  const rows = readings || [];
  renderTrend('soil-chart', 'soil-chart-range', rows,
    (row) => row.readings?.soil_wetness_pct, '#a96c00');
  renderTrend('tilt-chart', 'tilt-chart-range', rows,
    (row) => row.health?.baseline_calibrated && row.health?.mpu === 'ONLINE'
      ? row.readings?.relative_tilt_deg : null, '#1c8b4b');
  renderTrend('air-chart', 'air-chart-range', rows,
    (row) => row.readings?.temperature_c, '#df454b');
}

function textCell(value) { return value === null || value === undefined ? '—' : String(value); }

function renderHistory(readings) {
  const body = $('#history-rows');
  body.replaceChildren();
  const rows = [...(readings || [])].reverse().slice(0, 100);
  $('#history-status').textContent = rows.length
    ? `Showing ${rows.length} of up to 500 readings stored for the selected period.`
    : 'No sensor readings have been recorded for this period.';
  if (!rows.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = 7; cell.textContent = 'No readings have arrived.'; row.append(cell); body.append(row); return;
  }
  for (const sample of rows) {
    const row = document.createElement('tr');
    const readings = sample.readings || {}; const health = sample.health || {};
    const values = [formatTime(sample.received_at), formatTime(sample.observed_at,
      `uptime ${Math.floor((sample.observed_uptime_ms || 0) / 1000)} s`),
    `${textCell(readings.soil_adc_raw)} ADC / ${textCell(readings.soil_wetness_pct)}%`,
    `${textCell(readings.rain_adc_raw)} ADC / ${textCell(readings.rain_wetness_pct)}%`,
    readings.relative_tilt_deg == null || !health.baseline_calibrated ? '—' : `${Number(readings.relative_tilt_deg).toFixed(2)}°`,
    readings.temperature_c == null ? '—' : `${Number(readings.temperature_c).toFixed(1)}°C`,
    `MPU ${textCell(health.mpu)} · Soil ${textCell(health.soil)} · Rain ${textCell(health.rain)} · DHT11 ${textCell(health.dht11)}`];
    values.forEach((value) => { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); });
    body.append(row);
  }
}

function makeButton(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = className; button.textContent = label;
  button.onclick = handler;
  return button;
}

function renderAlerts(alerts) {
  const holder = $('#alert-list'); holder.replaceChildren();
  const events = alerts || [];
  const activeCount = events.filter((event) => !event.event?.resolved).length;
  const badge = $('#alertCount');
  badge.hidden = activeCount === 0;
  badge.textContent = String(activeCount);
  if (!events.length) { holder.textContent = 'No experimental events have been recorded.'; return; }
  for (const event of events) {
    const card = document.createElement('article');
    const time = document.createElement('time');
    const content = document.createElement('div');
    const title = document.createElement('strong');
    const details = document.createElement('p');
    const status = document.createElement('span');
    time.dateTime = event.occurred_at || event.received_at || '';
    time.textContent = formatTime(event.occurred_at || event.received_at,
      `uptime ${event.observed_uptime_s || 0} s`);
    title.textContent = `${event.event?.simulated ? 'SIMULATED · ' : ''}${event.event?.severity || 'EVENT'} · ${event.event?.sensor || 'sensor'}`;
    details.textContent = `${event.event?.value ?? '—'} measured · ${event.event?.threshold ?? '—'} threshold · ${event.event?.duration_s ?? '—'} seconds · GPS ${event.event?.gps_status || 'UNAVAILABLE'} · ${event.event?.resolved ? 'resolved' : 'active'}`;
    status.className = `tag ${event.event?.resolved ? '' : 'watch'}`;
    status.textContent = event.acknowledged ? `Acknowledged${event.acknowledged_by ? ` by ${event.acknowledged_by}` : ''}` : 'Not acknowledged';
    content.append(title, details, status);
    if (!event.acknowledged) {
      content.append(makeButton('Acknowledge', 'secondary ack-button', async () => {
        try {
          await postJson('/alerts/ack', { event_id: event.event_id });
          toast('Event acknowledged', 'The sensor condition keeps its current state.');
          await refreshAlerts();
        } catch (error) { toast('Acknowledgment failed', error.message, 'watch'); }
      }));
    }
    if (event.event?.latitude != null && event.event?.longitude != null && event.event?.gps_status !== 'UNAVAILABLE') {
      const coordinates = document.createElement('small');
      coordinates.textContent = `Monitoring station · ${event.event.latitude.toFixed(6)}, ${event.event.longitude.toFixed(6)} · fix age ${event.event.fix_age_s ?? 'unknown'} s`;
      content.append(coordinates);
    }
    card.append(time, content); holder.append(card);
    const eventKey = `${event.event_id}:${event.revision}`;
    if (eventsInitiallyLoaded && !shownEvents.has(eventKey)) {
      toast(`New experimental ${event.event?.severity || 'sensor'} event`, `${event.event?.sensor || 'Station'} · ${event.event?.resolved ? 'resolved' : 'active'}`, 'watch');
    }
    shownEvents.add(eventKey);
  }
  eventsInitiallyLoaded = true;
}

async function refreshAlerts() {
  const result = await getJson('/alerts?limit=100');
  renderAlerts(result.alerts);
}

function renderMaintenance(snapshot) {
  const calibration = snapshot?.calibration;
  const settings = snapshot?.settings;
  latestSettings = settings || null;
  $('#calibration-detail').textContent = calibration
    ? `${calibration.baseline_valid ? 'Baseline calibrated' : 'Baseline required'} · ${calibration.calibrating ? 'Calibration running' : calibration.reason || 'No active calibration'} · Gyro bias ${Array.isArray(calibration.gyro_bias_dps) ? calibration.gyro_bias_dps.map((value) => Number(value).toFixed(2)).join(', ') : 'unavailable'} °/s`
    : 'Station calibration data is unavailable.';
  $('#testModeToggle').checked = settings?.test_mode === true;
  if (settings?.tilt_threshold && settings?.tilt_duration_s) {
    ['caution','warning','critical'].forEach((key, index) => {
      $(`#${key}`).value = settings.tilt_threshold[index];
      $(`#${key}-s`).value = settings.tilt_duration_s[index];
    });
  }
  const sensor = Number($('#adc-sensor').value);
  const isSoil = sensor === 0;
  const endpoint = isSoil ? calibration?.soil : calibration?.rain;
  const wetness = isSoil ? snapshot?.readings?.soil_wetness_pct : snapshot?.readings?.rain_wetness_pct;
  const threshold = settings?.adc_threshold?.[sensor];
  $('#adc-calibration').textContent = endpoint
    ? `${endpoint.valid ? 'Calibrated' : 'Dry/wet endpoints required'} · dry ${endpoint.dry} · wet ${endpoint.wet} · current ${wetness == null ? 'unavailable' : `${Number(wetness).toFixed(1)}% wetness`}`
    : 'Station calibration data is unavailable.';
  if (settings) {
    $('#adc-threshold').value = threshold ?? 80;
    $('#adc-seconds').value = settings.adc_duration_s?.[sensor] ?? 10;
    $('#adc-enabled').checked = settings.adc_enabled?.[sensor] === true;
  }
}

function renderCommands(commands) {
  const holder = $('#command-list'); holder.replaceChildren();
  if (!commands?.length) { holder.textContent = 'No maintenance commands recorded.'; return; }
  for (const command of commands) {
    const row = document.createElement('p');
    row.textContent = `${command.kind.replaceAll('_', ' ')} · ${command.state} · created ${formatTime(command.created_at)}${command.result_message ? ` · ${command.result_message}` : ''}`;
    holder.append(row);
  }
}

async function refreshSettings() {
  const [result] = await Promise.all([getJson('/commands?limit=25')]);
  renderCommands(result.commands);
}

async function refresh() {
  if (refreshBusy) { refreshAgain = true; return; }
  refreshBusy = true;
  try {
    const snapshot = await getJson('/dashboard');
    renderOverview(snapshot);
    const [history, alerts] = await Promise.all([
      getJson(readingsRangeUrl(activeRange)), getJson('/alerts?limit=100'),
    ]);
    renderChart(history.readings);
    renderHistory(history.readings);
    renderAlerts(alerts.alerts);
    if (location.hash === '#settings') await refreshSettings();
  } catch (error) {
    $('#live-banner').dataset.state = 'offline';
    $('#live-banner').textContent = `Station service unavailable: ${error.message}`;
    $('#mobileStatus').dataset.state = 'offline';
    $('#mobileStatus').textContent = 'Service unavailable';
    $('#netDot').classList.add('off');
    $('#netStatus').textContent = 'Service unavailable';
  } finally {
    refreshBusy = false;
    if (refreshAgain) { refreshAgain = false; queueMicrotask(refresh); }
  }
}

async function queueCommand(kind, fields = {}) {
  const feedback = $('#command-feedback');
  feedback.dataset.state = 'loading';
  feedback.textContent = 'Sending a time-limited command to the station…';
  try {
    const result = await postJson('/commands', { kind, ...fields });
    feedback.dataset.state = 'current';
    feedback.textContent = `Command queued. It expires in ${result.expires_in} seconds and applies only to this station session.`;
    toast('Command queued', 'The station will report when it has applied the change.');
    await refreshSettings();
  } catch (error) {
    feedback.dataset.state = 'offline';
    feedback.textContent = `Command not queued: ${error.message}`;
  }
}

function bindControls() {
  $('#menuButton').onclick = () => { sidebar.classList.add('open'); scrim.classList.add('show'); document.body.style.overflow = 'hidden'; };
  $('#collapseButton').onclick = () => {
    document.documentElement.classList.toggle('collapsed');
    localStorage.setItem('slide-collapse', document.documentElement.classList.contains('collapsed'));
  };
  document.documentElement.classList.toggle('collapsed', localStorage.getItem('slide-collapse') === 'true');
  scrim.onclick = closeMenu;
  $$('[data-view]').forEach((element) => element.addEventListener('click', (event) => {
    event.preventDefault(); page(element.dataset.view); if (element.dataset.view === 'settings') refreshSettings();
  }));
  addEventListener('hashchange', () => page(location.hash.slice(1), false));
  page(location.hash.slice(1) || 'overview', false);
  $('#alertsButton').onclick = openModal;
  $$('[data-close]').forEach((element) => { element.onclick = closeModal; });
  addEventListener('keydown', (event) => { if (event.key === 'Escape') modal.hidden ? closeMenu() : closeModal(); });
  $$('.periods button').forEach((button) => button.addEventListener('click', () => {
    $$('.periods button').forEach((item) => { item.classList.remove('active'); item.setAttribute('aria-pressed', 'false'); });
    button.classList.add('active'); button.setAttribute('aria-pressed', 'true');
    activeRange = button.dataset.range; $('#historyRange').value = activeRange; refresh();
  }));
  $('#historyRange').onchange = (event) => { activeRange = event.target.value; refresh(); };
  $('#adc-sensor').onchange = () => renderMaintenance(dashboardSnapshot?.latest);
  $('#calibrate-mpu').onclick = () => {
    if (confirm('Leave the MPU firmly mounted and completely stationary for about 10 seconds. Start baseline calibration?'))
      queueCommand('calibrate_mpu');
  };
  $('#testModeToggle').onchange = (event) => {
    if (event.target.checked && !dashboardSnapshot?.latest?.health?.baseline_calibrated) {
      event.target.checked = false;
      $('#command-feedback').textContent = 'Calibrate a stable MPU baseline before enabling TEST MODE.';
      return;
    }
    const enabled = event.target.checked;
    if (enabled && !confirm('Enable experimental tilt events for this boot? TEST MODE will turn off after an ESP32 restart.')) {
      event.target.checked = false; return;
    }
    queueCommand('set_test_mode', { enabled });
  };
  $('#save-tilt').onclick = () => queueCommand('set_tilt_thresholds', {
    caution: Number($('#caution').value), warning: Number($('#warning').value), critical: Number($('#critical').value),
    caution_s: Number($('#caution-s').value), warning_s: Number($('#warning-s').value), critical_s: Number($('#critical-s').value),
  });
  $('#record-dry').onclick = () => queueCommand('record_adc_endpoint', { sensor: Number($('#adc-sensor').value), wet: false });
  $('#record-wet').onclick = () => queueCommand('record_adc_endpoint', { sensor: Number($('#adc-sensor').value), wet: true });
  $('#save-adc').onclick = () => queueCommand('set_adc_settings', {
    sensor: Number($('#adc-sensor').value), threshold: Number($('#adc-threshold').value),
    seconds: Number($('#adc-seconds').value), enabled: $('#adc-enabled').checked,
  });
  $('#exportCsv').onclick = async (event) => {
    event.preventDefault();
    try {
      const response = await api(`/readings.csv?range=${encodeURIComponent(activeRange)}&limit=500`);
      const blob = await response.blob(); const link = document.createElement('a');
      link.href = URL.createObjectURL(blob); link.download = 'slide-readings.csv';
      link.click(); URL.revokeObjectURL(link.href);
    } catch (error) { toast('Export unavailable', error.message, 'watch'); }
  };
  addEventListener('online', () => { if (dashboardSnapshot) updateNetworkState(dashboardSnapshot); refresh(); });
  addEventListener('offline', () => { if (dashboardSnapshot) updateNetworkState(dashboardSnapshot); });
}

bindControls();
if ('serviceWorker' in navigator) addEventListener('load', () => {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
});
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
