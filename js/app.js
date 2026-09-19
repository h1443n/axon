import { getDevice, hidDeviceFilters, listDevices } from './devices/registry.js';
import { openControlInterface } from './hid.js';
import {
  applyStatic,
  currentLocale,
  effectLabel,
  setLocale,
  t,
  zoneLabel,
} from './i18n.js';

const connectBtn = document.getElementById('connect-btn');
const hidBadge = document.getElementById('hid-badge');
const gate = document.getElementById('gate');
const workspace = document.getElementById('workspace');
const controls = document.getElementById('controls');
const toasts = document.getElementById('toasts');

const ui = {
  name: document.getElementById('device-name'),
  pid: document.getElementById('device-pid'),
  firmware: document.getElementById('device-fw'),
  serial: document.getElementById('device-serial'),
  batteryRow: document.getElementById('battery-row'),
  battery: document.getElementById('device-battery'),
};

let session = null;
let activeProfile = null;
let state = {
  dpiX: 1600,
  dpiY: 1600,
  linkAxes: true,
  pollRate: 1000,
  lighting: {},
  batteryPercent: null,
  batteryCharging: false,
};

function lightingState(zone) {
  if (!state.lighting[zone.id]) {
    state.lighting[zone.id] = {
      brightness: 100,
      effect: zone.effects.includes('static') ? 'static' : zone.effects[0],
      rgb: [...(zone.defaultRgb ?? [0, 255, 0])],
    };
  }
  return state.lighting[zone.id];
}

function rgbToHex(rgb) {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex) {
  const digits = hex.replace('#', '');
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ];
}

function toast(message, isError = false) {
  const node = document.createElement('div');
  node.className = `toast${isError ? ' is-error' : ''}`;
  node.textContent = message;
  toasts.append(node);
  setTimeout(() => node.remove(), 4200);
}

function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function snapDpi(value, spec) {
  const rounded = Math.round(Number(value) / spec.step) * spec.step;
  return clamp(rounded, spec.min, spec.max);
}

function percentToByte(percent) {
  return clamp(Math.round((Number(percent) / 100) * 255), 0, 255);
}

function byteToPercent(value) {
  return clamp(Math.round((Number(value) / 255) * 100), 0, 100);
}

function pidLabel(productId) {
  return `1532:${productId.toString(16).padStart(4, '0').toUpperCase()}`;
}

function catalogItem(device) {
  return `<li>${device.name} <span class="mono">${pidLabel(device.productId)}</span></li>`;
}

function renderCatalog() {
  const devices = listDevices();
  document.getElementById('catalog-list').innerHTML = devices.map(catalogItem).join('');
  const summary = document.getElementById('catalog-summary');
  if (summary) summary.textContent = t('catalogSummary', { n: devices.length });
}

function batteryText() {
  if (state.batteryPercent == null) return '—';
  if (state.batteryCharging) return t('charging', { percent: state.batteryPercent });
  return `${state.batteryPercent}%`;
}

function syncConnectButton() {
  connectBtn.textContent = session ? t('disconnect') : t('connect');
}

function applyLanguage() {
  applyStatic();
  document.querySelector('.lang-switch')?.setAttribute('aria-label', t('lang'));
  renderCatalog();
  syncConnectButton();
  ui.battery.textContent = batteryText();
  if (session && activeProfile) renderControls(activeProfile);
  if (connectBtn.disabled && !session) setBadge(t('needChromium'), true);
}

function setBadge(text, isError = false) {
  hidBadge.hidden = !text;
  hidBadge.textContent = text;
  hidBadge.classList.toggle('is-error', isError);
}

function renderControls(profile) {
  const blocks = [];
  if (profile.dpi) blocks.push(dpiCard(profile.dpi));
  if (profile.pollRate) blocks.push(pollCard(profile.pollRate));
  if (profile.lighting?.zones?.length) {
    for (const zone of profile.lighting.zones) blocks.push(lightingCard(zone));
  }
  controls.innerHTML = blocks.join('');
  bindControls(profile);
}

function dpiCard(spec) {
  const axes = spec.independentAxes
    ? `<label class="check"><input id="link-axes" type="checkbox" ${state.linkAxes ? 'checked' : ''}>${t('linkAxes')}</label>`
    : '';
  return `
    <article class="card">
      <h3>${t('dpi')}</h3>
      <div class="dpi-readout"><strong id="dpi-value">${state.dpiX}</strong><span>DPI</span></div>
      <p class="spec-line"><span>${spec.min}–${spec.max}</span><span>${spec.step}</span></p>
      <div class="field">
        <label for="dpi-x">X</label>
        <input id="dpi-x" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${state.dpiX}">
        <output id="dpi-x-out">${state.dpiX}</output>
      </div>
      <div class="field">
        <label for="dpi-y">Y</label>
        <input id="dpi-y" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${state.dpiY}" ${spec.independentAxes ? '' : 'disabled'}>
        <output id="dpi-y-out">${state.dpiY}</output>
      </div>
      ${axes}
    </article>
  `;
}

function pollCard(spec) {
  const buttons = spec.rates.map((hz) => (
    `<button type="button" data-poll="${hz}" class="${hz === state.pollRate ? 'is-active' : ''}">${t('pollHz', { hz })}</button>`
  )).join('');
  return `
    <article class="card">
      <h3>${t('pollRate')}</h3>
      <div class="seg" id="poll-seg">${buttons}</div>
    </article>
  `;
}

function lightingCard(zone) {
  const current = lightingState(zone);
  const buttons = zone.effects.map((effect) => (
    `<button type="button" data-effect="${effect}" class="${effect === current.effect ? 'is-active' : ''}">${effectLabel(effect)}</button>`
  )).join('');
  const brightness = zone.brightness
    ? `<div class="field">
        <label for="brightness-${zone.id}">%</label>
        <input id="brightness-${zone.id}" type="range" min="0" max="100" step="1" value="${current.brightness}">
        <output id="brightness-out-${zone.id}">${current.brightness}</output>
      </div>`
    : '';
  const color = zone.color === 'rgb'
    ? `<div class="field field-color">
        <label for="color-${zone.id}">RGB</label>
        <input id="color-${zone.id}" type="color" value="${rgbToHex(current.rgb)}">
      </div>`
    : '';
  return `
    <article class="card">
      <h3>${t('lighting', { zone: zoneLabel(zone) })}</h3>
      ${brightness}
      ${color}
      <div class="seg" data-zone="${zone.id}">${buttons}</div>
    </article>
  `;
}

function bindControls(profile) {
  const dpiX = document.getElementById('dpi-x');
  const dpiY = document.getElementById('dpi-y');
  const dpiXOut = document.getElementById('dpi-x-out');
  const dpiYOut = document.getElementById('dpi-y-out');
  const dpiValue = document.getElementById('dpi-value');
  const linkAxes = document.getElementById('link-axes');
  const applyDpi = debounce(async () => {
    try {
      await session.setDpi(state.dpiX, state.dpiY);
    } catch (error) {
      toast(error.message, true);
    }
  }, 140);

  const syncDpiUi = () => {
    dpiX.value = String(state.dpiX);
    dpiY.value = String(state.dpiY);
    dpiXOut.textContent = String(state.dpiX);
    dpiYOut.textContent = String(state.dpiY);
    dpiValue.textContent = String(state.dpiX);
  };

  dpiX?.addEventListener('input', () => {
    state.dpiX = snapDpi(dpiX.value, profile.dpi);
    if (!profile.dpi.independentAxes || state.linkAxes) state.dpiY = state.dpiX;
    syncDpiUi();
    applyDpi();
  });

  dpiY?.addEventListener('input', () => {
    state.dpiY = snapDpi(dpiY.value, profile.dpi);
    if (state.linkAxes) state.dpiX = state.dpiY;
    syncDpiUi();
    applyDpi();
  });

  linkAxes?.addEventListener('change', () => {
    state.linkAxes = linkAxes.checked;
    if (state.linkAxes) {
      state.dpiY = state.dpiX;
      syncDpiUi();
      applyDpi();
    }
  });

  document.getElementById('poll-seg')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-poll]');
    if (!button) return;
    const hz = Number(button.dataset.poll);
    try {
      await session.setPollRate(hz);
      state.pollRate = hz;
      for (const node of button.parentElement.querySelectorAll('button')) {
        node.classList.toggle('is-active', node === button);
      }
    } catch (error) {
      toast(error.message, true);
    }
  });

  for (const zone of profile.lighting?.zones ?? []) {
    const current = lightingState(zone);
    const applyLight = debounce(async () => {
      try {
        await session.setLighting(zone, current.effect, current.rgb ?? zone.defaultRgb ?? [0, 255, 0]);
        if (zone.brightness) await session.setBrightness(zone.ledId, percentToByte(current.brightness));
      } catch (error) {
        toast(error.message, true);
      }
    }, 120);

    const brightness = document.getElementById(`brightness-${zone.id}`);
    const brightnessOut = document.getElementById(`brightness-out-${zone.id}`);
    brightness?.addEventListener('input', () => {
      current.brightness = Number(brightness.value);
      brightnessOut.textContent = String(current.brightness);
      applyLight();
    });

    const color = document.getElementById(`color-${zone.id}`);
    color?.addEventListener('input', () => {
      current.rgb = hexToRgb(color.value);
      applyLight();
    });

    document.querySelector(`[data-zone="${zone.id}"]`)?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-effect]');
      if (!button) return;
      current.effect = button.dataset.effect;
      for (const node of button.parentElement.querySelectorAll('button')) {
        node.classList.toggle('is-active', node === button);
      }
      applyLight();
    });
  }
}

async function requestDevices() {
  try {
    return await navigator.hid.requestDevice({ filters: hidDeviceFilters() });
  } catch (error) {
    if (error.name === 'NotFoundError') {
      toast(t('emptyPicker'), true);
      return [];
    }
    throw error;
  }
}

async function connect() {
  if (session) {
    await disconnect();
    return;
  }

  const picked = await requestDevices();
  if (!picked.length) return;

  const granted = (await navigator.hid.getDevices()).filter((device) => device.vendorId === 0x1532);
  const unique = [];
  const seen = new Set();
  for (const hidDevice of [...picked, ...granted]) {
    const usages = (hidDevice.collections ?? []).map((collection) => `${collection.usagePage}:${collection.usage}`).join(',');
    const key = `${hidDevice.productId}:${usages}:${hidDevice.collections?.length ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hidDevice);
  }

  const { session: connected, firmware } = await openControlInterface(unique, getDevice);
  session = connected;
  const hidDevice = session.hidDevice;
  const profile = getDevice(hidDevice.productId);
  activeProfile = profile;
  hidDevice.addEventListener('disconnect', () => {
    toast(t('mouseGone'), true);
    disconnect(true);
  });

  ui.name.textContent = profile.name;
  ui.pid.textContent = pidLabel(profile.productId);
  ui.firmware.textContent = firmware;
  try {
    ui.serial.textContent = await session.getSerial();
  } catch {
    ui.serial.textContent = '—';
  }

  state.lighting = {};
  try {
    const dpi = await session.getDpi();
    state.dpiX = snapDpi(dpi.x, profile.dpi);
    state.dpiY = snapDpi(dpi.y, profile.dpi);
    state.linkAxes = state.dpiX === state.dpiY;
  } catch { /* keep defaults */ }
  try {
    const poll = await session.getPollRate();
    if (poll) state.pollRate = poll;
  } catch { /* keep defaults */ }
  ui.batteryRow.hidden = !profile.battery;
  ui.battery.textContent = '—';
  state.batteryPercent = null;
  state.batteryCharging = false;
  if (profile.battery) {
    try {
      const battery = await session.getBattery();
      state.batteryPercent = battery.percent;
      state.batteryCharging = battery.charging;
      ui.battery.textContent = batteryText();
    } catch { /* keep defaults */ }
  }

  for (const zone of profile.lighting?.zones ?? []) {
    const current = lightingState(zone);
    if (zone.brightness) {
      try {
        current.brightness = byteToPercent(await session.getBrightness(zone.ledId));
      } catch { /* keep defaults */ }
    }
  }

  renderControls(profile);
  gate.hidden = true;
  workspace.hidden = false;
  connectBtn.classList.remove('btn-primary');
  connectBtn.classList.add('btn-ghost');
  syncConnectButton();
  setBadge(profile.name);
}

async function disconnect(fromEvent = false) {
  if (session && !fromEvent) {
    try { await session.close(); } catch { /* already gone */ }
  }
  session = null;
  activeProfile = null;
  state.lighting = {};
  state.batteryPercent = null;
  state.batteryCharging = false;
  controls.innerHTML = '';
  workspace.hidden = true;
  gate.hidden = false;
  ui.batteryRow.hidden = true;
  ui.battery.textContent = '—';
  connectBtn.classList.add('btn-primary');
  connectBtn.classList.remove('btn-ghost');
  syncConnectButton();
  setBadge('');
}

function boot() {
  applyLanguage();
  document.querySelector('.lang-switch')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-lang]');
    if (!button || button.dataset.lang === currentLocale()) return;
    setLocale(button.dataset.lang);
    applyLanguage();
  });
  if (!('hid' in navigator)) {
    connectBtn.disabled = true;
    setBadge(t('needChromium'), true);
    toast(t('noWebHid'), true);
    return;
  }
  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    try {
      await connect();
    } catch (error) {
      toast(error.message, true);
    } finally {
      connectBtn.disabled = false;
    }
  });
}

boot();
