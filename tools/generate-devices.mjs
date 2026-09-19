import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEVICES = join(ROOT, 'js', 'devices');
const OPENRAZER = join(ROOT, 'tools', 'openrazer');
const MONO_GREEN = new Set([0x006E, 0x0071, 0x0098]);
const MOUSE_PY = join(OPENRAZER, 'mouse.py');
const DRIVER_C = join(OPENRAZER, 'razermouse_driver.c');
const DRIVER_H = join(ROOT, 'tools', 'razermouse_driver.h');

const ZONES = [
  ['logo', 0x04, 'Логотип', 'logo'],
  ['scroll', 0x01, 'Колёсико', 'scroll'],
  ['left', 0x11, 'Левый бок', 'left'],
  ['right', 0x10, 'Правый бок', 'right'],
  ['backlight', 0x00, 'Корпус', 'matrix'],
];

function titleFromClass(className) {
  let name = className.startsWith('Razer') ? className.slice(5) : className;
  name = name.replaceAll('_', ' ');
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  name = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return name.replace(/\s+/g, ' ').trim();
}

function slugFromClass(className) {
  let name = className.startsWith('Razer') ? className.slice(5) : className;
  name = name.replaceAll('_', '');
  name = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2');
  name = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
  name = name.replace(/([A-Za-z])([0-9])/g, '$1-$2');
  return name.toLowerCase();
}

function identFromSlug(slug) {
  const [head, ...rest] = slug.split('-');
  return head + rest.map((part) => (/^\d+$/.test(part) ? part : part[0].toUpperCase() + part.slice(1))).join('');
}

function parseUsbIds(headerText) {
  const mapping = {};
  for (const match of headerText.matchAll(/#define\s+(USB_DEVICE_ID_RAZER_\w+)\s+(0x[0-9A-Fa-f]+)/g)) {
    mapping[match[1]] = Number.parseInt(match[2], 16);
  }
  return mapping;
}

function extractFunction(source, name) {
  const marker = `static ssize_t ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(name);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace, index + 1);
    }
  }
  throw new Error(name);
}

function parseTxidMap(body, ids) {
  const result = {};
  let pending = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const caseMatch = line.match(/^case\s+(USB_DEVICE_ID_RAZER_\w+)\s*:/);
    if (caseMatch) {
      pending.push(ids[caseMatch[1]]);
      continue;
    }
    const txid = line.match(/transaction_id\.id\s*=\s*(0x[0-9A-Fa-f]+)/);
    if (txid && pending.length) {
      const value = Number.parseInt(txid[1], 16);
      for (const pid of pending) result[pid] = value;
    }
    if (line.startsWith('break') || line.startsWith('return ')) pending = [];
  }
  return result;
}

function parsePollProtocol(body, ids) {
  const result = {};
  let pending = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const caseMatch = line.match(/^case\s+(USB_DEVICE_ID_RAZER_\w+)\s*:/);
    if (caseMatch) {
      pending.push(ids[caseMatch[1]]);
      continue;
    }
    if (line.includes('get_polling_rate2') || line.includes('set_polling_rate2')) {
      for (const pid of pending) result[pid] = 'v2';
    } else if (line.includes('get_polling_rate') || line.includes('set_polling_rate')) {
      for (const pid of pending) if (!result[pid]) result[pid] = 'v1';
    }
    if (line.startsWith('break') || (line.startsWith('return ') && line.includes('sysfs_emit'))) pending = [];
  }
  return result;
}

function parseMethodsExpr(chunk) {
  const start = chunk.search(/METHODS\s*=/);
  if (start < 0) return null;
  let index = chunk.indexOf('=', start) + 1;
  while (index < chunk.length && /\s/.test(chunk[index])) index += 1;
  let depth = 0;
  let end = index;
  let started = false;
  while (end < chunk.length) {
    const char = chunk[end];
    if (char === '[') {
      depth += 1;
      started = true;
    } else if (char === ']') {
      depth -= 1;
      if (started && depth === 0) {
        end += 1;
        break;
      }
    } else if (started && depth === 0 && char === '\n') {
      const rest = chunk.slice(end + 1);
      if (/^\s*[A-Z][A-Z0-9_]*\s*=/.test(rest)) break;
    }
    end += 1;
  }
  return chunk.slice(index, end).trim();
}

function parseClasses(text) {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const chunks = normalized.split(/\n(?=class )/);
  const parsed = [];
  const byName = {};
  for (const chunk of chunks) {
    const header = chunk.match(/^class\s+(\w+)\(([^)]+)\)\s*:/);
    if (!header) continue;
    const className = header[1];
    const bases = header[2].split(',').map((item) => item.trim());
    const doc = chunk.match(/Class for the Razer (.+)/);
    const name = doc ? doc[1].trim() : titleFromClass(className);
    const pidMatch = chunk.match(/USB_PID\s*=\s*(0x[0-9A-Fa-f]+)/);
    const dpiMatch = chunk.match(/DPI_MAX\s*=\s*(\d+)/);
    const pollMatch = chunk.match(/POLL_RATES\s*=\s*\[([^\]]+)\]/);
    const item = {
      className,
      bases,
      name,
      pid: pidMatch ? Number.parseInt(pidMatch[1], 16) : null,
      dpiMax: dpiMatch ? Number(dpiMatch[1]) : null,
      pollRates: pollMatch ? pollMatch[1].match(/\d+/g).map(Number) : null,
      methodsExpr: parseMethodsExpr(chunk),
      methods: null,
    };
    parsed.push(item);
    byName[className] = item;
  }

  function resolveMethods(item) {
    if (item.methods) return item.methods;
    if (!item.methodsExpr) {
      for (const base of item.bases) {
        if (byName[base]) {
          item.methods = resolveMethods(byName[base]);
          return item.methods;
        }
      }
      item.methods = [];
      return item.methods;
    }
    const methods = [];
    for (let part of item.methodsExpr.split(/\s*\+\s*/)) {
      part = part.trim().replace(/\\$/, '').trim();
      const inherited = part.match(/^(\w+)\.METHODS/);
      if (inherited) {
        methods.push(...resolveMethods(byName[inherited[1]]));
        continue;
      }
      methods.push(...[...part.matchAll(/'([^']+)'/g)].map((match) => match[1]));
    }
    item.methods = methods;
    return methods;
  }

  function resolveField(item, field) {
    if (item[field] != null) return item[field];
    for (const base of item.bases) {
      if (!byName[base]) continue;
      const value = resolveField(byName[base], field);
      if (value != null) {
        item[field] = value;
        return value;
      }
    }
    return null;
  }

  const mice = [];
  for (const item of parsed) {
    resolveMethods(item);
    resolveField(item, 'pid');
    resolveField(item, 'dpiMax');
    resolveField(item, 'pollRates');
    if (item.pid == null) continue;
    mice.push(item);
  }
  return mice;
}

function zoneEffects(methods, prefix) {
  const checks = {
    none: prefix === 'matrix' ? [`set_${prefix}_none`, 'set_none_effect'] : [`set_${prefix}_none`],
    static: prefix === 'matrix' ? [`set_${prefix}_static`, 'set_static_effect'] : [`set_${prefix}_static`],
    breath: [`set_${prefix}_breath_single`, `set_${prefix}_breath`, 'set_breath_single'],
    spectrum: prefix === 'matrix' ? [`set_${prefix}_spectrum`, 'set_spectrum_effect'] : [`set_${prefix}_spectrum`],
    wave: prefix === 'matrix' ? [`set_${prefix}_wave`, 'set_wave_effect'] : [`set_${prefix}_wave`],
  };
  return Object.entries(checks)
    .filter(([, names]) => names.some((name) => methods.has(name)))
    .map(([effect]) => effect);
}

function buildLighting(methods, pid) {
  const zones = [];
  for (const [zoneId, ledId, title, prefix] of ZONES) {
    const effects = zoneEffects(methods, prefix);
    if (prefix === 'matrix') {
      const hasMatrix = ['set_static_effect', 'set_wave_effect', 'set_spectrum_effect', 'set_none_effect']
        .some((name) => methods.has(name));
      if (!hasMatrix) continue;
    }
    if (!effects.length) continue;
    let brightness = false;
    if (prefix === 'logo') brightness = methods.has('get_logo_brightness') || methods.has('set_logo_brightness');
    else if (prefix === 'scroll') brightness = methods.has('get_scroll_brightness') || methods.has('set_scroll_brightness');
    else if (prefix === 'left') brightness = methods.has('get_left_brightness') || methods.has('set_left_brightness');
    else if (prefix === 'right') brightness = methods.has('get_right_brightness') || methods.has('set_right_brightness');
    else brightness = methods.has('get_brightness') || methods.has('set_brightness');
    zones.push({
      id: zoneId,
      ledId,
      name: title,
      brightness,
      color: MONO_GREEN.has(pid) ? 'mono-green' : 'rgb',
      defaultRgb: [0x00, 0xFF, 0x00],
      effects,
    });
  }
  if (!zones.length) return null;
  return { protocol: 'extended-matrix', zones };
}

function hex(value, width = 2) {
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
}

function emitProfile(mouse, txids, pollProto) {
  const pid = mouse.pid;
  const methods = new Set(mouse.methods);
  const slug = slugFromClass(mouse.className);
  const info = txids.info[pid] ?? 0xFF;
  const lighting = buildLighting(methods, pid);
  const hasXy = methods.has('get_dpi_xy') && !methods.has('get_dpi_xy_byte');
  const hasPoll = methods.has('get_poll_rate') || methods.has('set_poll_rate');
  const hasBattery = methods.has('get_battery');

  const lines = [
    'export default {',
    `  id: ${JSON.stringify(slug)},`,
    `  name: ${JSON.stringify(mouse.name)},`,
    '  vendorId: 0x1532,',
    `  productId: ${hex(pid, 4)},`,
    `  tested: true,`,
    '  transactionId: {',
    `    default: ${hex(info)},`,
    `    info: ${hex(info)},`,
  ];
  if (hasXy) lines.push(`    dpi: ${hex(txids.dpi[pid] ?? info)},`);
  if (hasPoll) lines.push(`    pollRate: ${hex(txids.poll[pid] ?? info)},`);
  if (lighting) lines.push(`    lighting: ${hex(txids.lighting[pid] ?? info)},`);
  if (hasBattery) lines.push(`    battery: ${hex(txids.battery[pid] ?? info)},`);
  lines.push('  },');

  if (hasXy && mouse.dpiMax) {
    lines.push(
      '  dpi: {',
      '    min: 100,',
      `    max: ${mouse.dpiMax},`,
      `    step: ${mouse.dpiMax >= 20000 ? 50 : 100},`,
      '    independentAxes: true,',
      '  },',
    );
  }

  if (hasPoll) {
    let protocol = pollProto[pid] ?? 'v1';
    let rates;
    if (mouse.pollRates) {
      rates = mouse.pollRates;
      if (rates.some((rate) => rate >= 2000 || rate === 250)) protocol = 'v2';
    } else if (protocol === 'v2') {
      rates = [125, 250, 500, 1000, 2000, 4000, 8000];
    } else {
      rates = [125, 500, 1000];
    }
    lines.push(
      '  pollRate: {',
      `    protocol: ${JSON.stringify(protocol)},`,
      `    rates: [${rates.join(', ')}],`,
      '  },',
    );
  }

  if (hasBattery) lines.push('  battery: true,');

  if (lighting) {
    lines.push('  lighting: {', `    protocol: ${JSON.stringify(lighting.protocol)},`, '    zones: [');
    for (const zone of lighting.zones) {
      const effects = zone.effects.map((effect) => JSON.stringify(effect)).join(', ');
      const rgb = zone.defaultRgb.map((channel) => hex(channel)).join(', ');
      lines.push(
        '      {',
        `        id: ${JSON.stringify(zone.id)},`,
        `        ledId: ${hex(zone.ledId)},`,
        `        name: ${JSON.stringify(zone.name)},`,
        `        brightness: ${zone.brightness ? 'true' : 'false'},`,
        `        color: ${JSON.stringify(zone.color)},`,
        `        defaultRgb: [${rgb}],`,
        `        effects: [${effects}],`,
        '      },',
      );
    }
    lines.push('    ],', '  },');
  }

  lines.push('};', '');
  return { source: lines.join('\n'), slug };
}

function emitRegistry(entries) {
  const ordered = [...entries].sort((a, b) => a.slug.localeCompare(b.slug));
  const lines = [];
  for (const item of ordered) lines.push(`import ${item.ident} from './${item.slug}.js';`);
  lines.push('', 'const catalog = [');
  for (const item of ordered) lines.push(`  ${item.ident},`);
  lines.push('];', '', `const byProductId = new Map(catalog.map((device) => [device.productId, device]));

export const RAZER_VENDOR_ID = 0x1532;

export function listDevices() {
  return catalog;
}

export function getDevice(productId) {
  return byProductId.get(productId) ?? null;
}

export function supportedProductIds() {
  return catalog.map((device) => device.productId);
}

export function hidDeviceFilters() {
  return [
    { vendorId: RAZER_VENDOR_ID, usagePage: 0xFF00 },
    { vendorId: RAZER_VENDOR_ID },
  ];
}
`);
  return lines.join('\n');
}

function profileFiles() {
  return readdirSync(DEVICES).filter((name) => name.endsWith('.js') && name !== 'registry.js');
}

function readProfile(filename) {
  const text = readFileSync(join(DEVICES, filename), 'utf8');
  const name = text.match(/name:\s*['"]([^'"]+)['"]/);
  const pid = text.match(/productId:\s*(0x[0-9A-Fa-f]+)/);
  const slug = filename.slice(0, -3);
  return {
    slug,
    ident: identFromSlug(slug),
    pid: pid ? Number.parseInt(pid[1], 16) : null,
    name: name ? name[1] : slug,
  };
}

function emitReadme(rows) {
  const sorted = [...rows].sort((left, right) => left.name.localeCompare(right.name) || left.pid - right.pid);
  const table = ['| Mouse | VID:PID |', '| --- | --- |'];
  for (const row of sorted) {
    const pid = row.pid.toString(16).toUpperCase().padStart(4, '0');
    table.push(`| ${row.name} | \`1532:${pid}\` |`);
  }
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const next = readme.replace(
    /## Support\n\n\| Mouse \| VID:PID \|[\s\S]*?\n\n(?=## )/,
    `## Support\n\n${table.join('\n')}\n\n`,
  );
  writeFileSync(join(ROOT, 'README.md'), next, 'utf8');
}

for (const source of [MOUSE_PY, DRIVER_C, DRIVER_H]) {
  if (!existsSync(source)) {
    throw new Error(`Put OpenRazer sources in tools/openrazer (missing ${source})`);
  }
}

const ids = parseUsbIds(readFileSync(DRIVER_H, 'utf8'));
const driver = readFileSync(DRIVER_C, 'utf8').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
const mice = parseClasses(readFileSync(MOUSE_PY, 'utf8'));
const txids = {
  info: parseTxidMap(extractFunction(driver, 'razer_attr_read_firmware_version'), ids),
  dpi: parseTxidMap(extractFunction(driver, 'razer_attr_write_dpi'), ids),
  poll: parseTxidMap(extractFunction(driver, 'razer_attr_write_poll_rate'), ids),
  lighting: parseTxidMap(extractFunction(driver, 'razer_attr_write_led_brightness'), ids),
  battery: parseTxidMap(extractFunction(driver, 'razer_attr_read_charge_level'), ids),
};
const pollProto = parsePollProtocol(extractFunction(driver, 'razer_attr_read_poll_rate'), ids);

mkdirSync(DEVICES, { recursive: true });
const byPid = new Map();
const seenSlugs = new Set();
for (const filename of profileFiles()) {
  const profile = readProfile(filename);
  if (profile.pid == null) continue;
  byPid.set(profile.pid, profile);
  seenSlugs.add(profile.slug);
}

let written = 0;
for (const mouse of mice) {
  if (byPid.has(mouse.pid)) continue;
  const { source, slug } = emitProfile(mouse, txids, pollProto);
  let uniqueSlug = slug;
  if (seenSlugs.has(uniqueSlug)) {
    uniqueSlug = `${slug}-${hex(mouse.pid, 4).slice(2).toLowerCase()}`;
  }
  seenSlugs.add(uniqueSlug);
  writeFileSync(join(DEVICES, `${uniqueSlug}.js`), source, 'utf8');
  byPid.set(mouse.pid, { slug: uniqueSlug, ident: identFromSlug(uniqueSlug), pid: mouse.pid, name: mouse.name });
  written += 1;
}

const entries = [...byPid.values()];
writeFileSync(join(DEVICES, 'registry.js'), emitRegistry(entries), 'utf8');
emitReadme(entries);
console.log(`mice=${entries.length} written=${written}`);
