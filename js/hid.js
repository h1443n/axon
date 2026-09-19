import { t } from './i18n.js';
import {
  STATUS,
  commands,
  decodeReport,
  encodeReport,
  joinU16,
  asciiFromBytes,
  POLL_V1_HZ,
  POLL_V2_HZ,
  statusLabel,
} from './protocol.js';

const WAIT_MS = 90;
const RETRIES = 5;
const RAZER_REPORT = 90;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapRange(value, min, max, step) {
  const snapped = Math.round(Number(value) / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

function unwrapReport(dataView) {
  return new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
}

function reportByteLength(report) {
  let bits = 0;
  for (const item of report.items ?? []) {
    bits += (item.reportSize ?? 0) * (item.reportCount ?? 0);
  }
  return Math.ceil(bits / 8);
}

function sizedPayload(payload, size) {
  const buffer = new Uint8Array(size);
  buffer.set(payload.subarray(0, Math.min(payload.byteLength, size)));
  return buffer;
}

function isVendorPage(page) {
  return page === 0xFF00 || page === 0xFF01;
}

function isBootCollection(collection) {
  return collection.usagePage === 0x01 && (collection.usage === 0x01 || collection.usage === 0x02 || collection.usage === 0x06);
}

function collectReports(hidDevice, kind) {
  const reports = [];
  for (const collection of hidDevice.collections ?? []) {
    const list = kind === 'output' ? collection.outputReports : collection.featureReports;
    for (const report of list ?? []) {
      reports.push({
        reportId: report.reportId ?? 0,
        size: reportByteLength(report),
        usagePage: collection.usagePage,
        usage: collection.usage,
        kind,
      });
    }
  }
  return reports;
}

function razerSized(report) {
  return report.size >= 89 && report.size <= 128;
}

function fallbackCandidates() {
  const extras = [];
  for (const kind of ['feature', 'output']) {
    for (const reportId of [0, 1, 2, 3]) {
      for (const size of [90, 91, 89]) {
        extras.push({ reportId, size, kind, usagePage: 0xFF00 });
      }
    }
  }
  return extras;
}

function controlCandidates(hidDevice) {
  const found = [
    ...collectReports(hidDevice, 'feature'),
    ...collectReports(hidDevice, 'output'),
  ];
  const known = found.filter(razerSized);
  const pool = known.length > 0 ? known : fallbackCandidates();
  const seen = new Set();
  const candidates = [];
  for (const report of pool) {
    const size = report.size || RAZER_REPORT;
    const key = `${report.kind}:${report.reportId}:${size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...report, size });
  }
  candidates.sort((left, right) => {
    const vendor = (page) => (isVendorPage(page) ? 1 : 0);
    const feature = (kind) => (kind === 'feature' ? 1 : 0);
    return vendor(right.usagePage) - vendor(left.usagePage)
      || feature(right.kind) - feature(left.kind)
      || Math.abs(left.size - RAZER_REPORT) - Math.abs(right.size - RAZER_REPORT);
  });
  return candidates;
}

function looksLikeControl(hidDevice) {
  const collections = hidDevice.collections ?? [];
  if (!collections.length) return true;
  if (collections.some((collection) => isVendorPage(collection.usagePage))) return true;
  if (collectReports(hidDevice, 'feature').some(razerSized)) return true;
  if (collectReports(hidDevice, 'output').some(razerSized)) return true;
  if (collections.every(isBootCollection)) return false;
  return true;
}

function scoreDevice(hidDevice) {
  let score = 0;
  for (const collection of hidDevice.collections ?? []) {
    if (isVendorPage(collection.usagePage)) score += 40;
    if (isBootCollection(collection)) score -= 20;
    for (const report of collection.featureReports ?? []) {
      if (razerSized({ size: reportByteLength(report) })) score += 50;
    }
    for (const report of collection.outputReports ?? []) {
      if (razerSized({ size: reportByteLength(report) })) score += 8;
    }
  }
  return score;
}

function isWriteFailure(error) {
  return /Failed to write the report/i.test(error?.message ?? '');
}

export class RazerSession {
  constructor(hidDevice, profile) {
    this.hidDevice = hidDevice;
    this.profile = profile;
    this.chain = Promise.resolve();
    this.reportId = 0;
    this.reportSize = RAZER_REPORT;
    this.useOutput = false;
  }

  transactionId(kind) {
    const ids = this.profile.transactionId;
    if (typeof ids === 'number') return ids;
    return ids[kind] ?? ids.default ?? 0xFF;
  }

  enqueue(task) {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => {});
    return run;
  }

  async request(kind, packet) {
    return this.enqueue(() => this.sendWithRetry(kind, packet));
  }

  async sendWithRetry(kind, packet) {
    let lastError = null;
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      try {
        const response = await this.sendOnce(kind, packet);
        if (response.status === STATUS.SUCCESS || response.status === STATUS.BUSY) {
          return response;
        }
        lastError = new Error(t('commandRejected', { status: statusLabel(response.status) }));
      } catch (error) {
        lastError = error;
      }
      await sleep(WAIT_MS);
    }
    throw lastError ?? new Error(t('noReply'));
  }

  async writeReport(payload) {
    const body = sizedPayload(payload, this.reportSize);
    if (this.useOutput) {
      await this.hidDevice.sendReport(this.reportId, body);
    } else {
      await this.hidDevice.sendFeatureReport(this.reportId, body);
    }
  }

  async sendOnce(kind, packet) {
    const report = encodeReport({
      transactionId: this.transactionId(kind),
      ...packet,
    });
    await this.writeReport(report);
    await sleep(WAIT_MS);
    const raw = unwrapReport(await this.hidDevice.receiveFeatureReport(this.reportId));
    return decodeReport(raw);
  }

  async handshake() {
    const packet = encodeReport({
      transactionId: this.transactionId('info'),
      ...commands.getFirmware(),
    });
    let lastError = null;
    let sawReply = false;
    const seen = new Set();
    for (const candidate of [...controlCandidates(this.hidDevice), ...fallbackCandidates()]) {
      const key = `${candidate.kind}:${candidate.reportId}:${candidate.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.reportId = candidate.reportId;
      this.reportSize = candidate.size;
      this.useOutput = candidate.kind === 'output';
      try {
        await this.writeReport(packet);
        await sleep(WAIT_MS);
        const raw = unwrapReport(await this.hidDevice.receiveFeatureReport(this.reportId));
        const decoded = decodeReport(raw);
        sawReply = true;
        if (decoded.status !== STATUS.SUCCESS && decoded.status !== STATUS.BUSY) continue;
        const firmware = `v${decoded.args[0] ?? 0}.${decoded.args[1] ?? 0}`;
        if (firmware === 'v0.0') continue;
        return firmware;
      } catch (error) {
        lastError = error;
      }
    }
    throw (sawReply ? new Error(t('noHidReport')) : lastError) ?? new Error(t('noHidReport'));
  }

  async getFirmware() {
    const response = await this.request('info', commands.getFirmware());
    return `v${response.args[0] ?? 0}.${response.args[1] ?? 0}`;
  }

  async getSerial() {
    const response = await this.request('info', commands.getSerial());
    return asciiFromBytes(response.args) || '—';
  }

  async getDpi() {
    const response = await this.request('dpi', commands.getDpi());
    return {
      x: joinU16(response.args[1] ?? 0, response.args[2] ?? 0),
      y: joinU16(response.args[3] ?? 0, response.args[4] ?? 0),
    };
  }

  async setDpi(dpiX, dpiY) {
    const spec = this.profile.dpi;
    if (!spec) return;
    const x = snapRange(dpiX, spec.min, spec.max, spec.step);
    const y = snapRange(dpiY, spec.min, spec.max, spec.step);
    await this.request('dpi', commands.setDpi(x, y));
  }

  async getPollRate() {
    if (!this.profile.pollRate) return null;
    if (this.profile.pollRate.protocol === 'v2') {
      const response = await this.request('pollRate', commands.getPollRateV2());
      return POLL_V2_HZ[response.args[0]] ?? POLL_V2_HZ[response.args[1]] ?? null;
    }
    const response = await this.request('pollRate', commands.getPollRateV1());
    return POLL_V1_HZ[response.args[0]] ?? null;
  }

  async setPollRate(hz) {
    if (!this.profile.pollRate) return;
    if (this.profile.pollRate.protocol === 'v2') {
      await this.request('pollRate', commands.setPollRateV2(hz));
      return;
    }
    await this.request('pollRate', commands.setPollRateV1(hz));
  }

  async getBrightness(ledId) {
    const response = await this.request('lighting', commands.getExtendedBrightness(ledId));
    return response.args[2] ?? 0;
  }

  async setBrightness(ledId, brightness) {
    await this.request('lighting', commands.setExtendedBrightness(ledId, brightness));
  }

  async setLighting(zone, effect, rgb) {
    const ledId = zone.ledId;
    if (effect === 'none') {
      await this.request('lighting', commands.setExtendedNone(ledId));
      return;
    }
    if (effect === 'spectrum') {
      await this.request('lighting', commands.setExtendedSpectrum(ledId));
      return;
    }
    if (effect === 'wave') {
      await this.request('lighting', commands.setExtendedWave(ledId));
      return;
    }
    if (effect === 'breath') {
      await this.request('lighting', commands.setExtendedBreath(ledId, rgb[0], rgb[1], rgb[2]));
      return;
    }
    await this.request('lighting', commands.setExtendedStatic(ledId, rgb[0], rgb[1], rgb[2]));
  }

  async getBattery() {
    const level = await this.request('battery', commands.getBattery());
    const charge = await this.request('battery', commands.getCharging());
    const raw = level.args[1] ?? 0;
    return {
      percent: Math.round((raw / 255) * 100),
      charging: (charge.args[1] ?? 0) === 1,
    };
  }

  async close() {
    if (this.hidDevice.opened) {
      await this.hidDevice.close();
    }
  }
}

export async function openControlInterface(hidDevices, resolveProfile) {
  const errors = [];
  const opened = [];

  for (const hidDevice of hidDevices) {
    const profile = resolveProfile(hidDevice.productId);
    if (!profile) continue;
    try {
      if (!hidDevice.opened) await hidDevice.open();
      opened.push(hidDevice);
    } catch (error) {
      errors.push(error);
    }
  }

  const preferred = opened.filter(looksLikeControl);
  const queue = (preferred.length > 0 ? preferred : opened)
    .sort((left, right) => scoreDevice(right) - scoreDevice(left));

  for (const hidDevice of queue) {
    const profile = resolveProfile(hidDevice.productId);
    try {
      const session = new RazerSession(hidDevice, profile);
      const firmware = await session.handshake();
      for (const extra of opened) {
        if (extra !== hidDevice && extra.opened) {
          try { await extra.close(); } catch { /* ignore */ }
        }
      }
      return { session, firmware };
    } catch (error) {
      errors.push(error);
      if (hidDevice.opened) {
        try { await hidDevice.close(); } catch { /* ignore */ }
      }
    }
  }

  for (const hidDevice of opened) {
    if (hidDevice.opened) {
      try { await hidDevice.close(); } catch { /* ignore */ }
    }
  }

  const unknown = hidDevices.find((device) => !resolveProfile(device.productId));
  if (unknown && hidDevices.every((device) => !resolveProfile(device.productId))) {
    const pid = unknown.productId.toString(16).padStart(4, '0');
    throw new Error(t('unsupportedMouse', { pid }));
  }

  if (!queue.length || errors.some(isWriteFailure)) {
    throw new Error(t('hidWriteFailed'));
  }

  const detail = errors[0]?.message ? `: ${errors[0].message}` : '';
  throw new Error(t('noControlInterface', { detail }));
}
