const STORAGE_KEY = 'axon-lang';

const dictionaries = {
  en: {
    title: 'Axon — web driver for Razer mice',
    description: 'Web driver for Razer mice: DPI, polling rate, lighting.',
    brandSub: 'web driver',
    connect: 'Connect mouse',
    disconnect: 'Disconnect',
    headline: 'Razer mice in the browser',
    lede: 'Sets DPI, polling rate, and lighting, then writes it to the mouse. No desktop app.',
    checkBrowser: 'Chrome or Edge, mouse over USB',
    checkSynapse: 'Fully quit Razer Synapse, including the tray',
    checkHid: 'Connect. If it fails, Chrome is hiding the mouse control channel — close Chrome and start it with the command below (save a shortcut once)',
    chromeFixHint: 'Windows: close every Chrome window, Win+R, paste, Enter, then open this page again.',
    copyFlag: 'Copy',
    copiedFlag: 'Copied. Close Chrome and paste into Win+R.',
    copyFailed: 'Could not copy',
    emptyPicker: 'Empty HID list. Chrome is hiding the control interface. Close Chrome and start it with the command on this page.',
    hidNeedOtherInterface: 'Chrome hid the mouse control channel and only exposed the pointer. Close Chrome and start it with the command on this page.{hint}',
    support: 'Support',
    catalogSummary: 'Supported models ({n})',
    firmware: 'Firmware',
    serial: 'Serial number',
    battery: 'Battery',
    charging: '{percent}% · charging',
    repo: 'Repository',
    disclaimer: 'Not affiliated with Razer Inc.',
    dpi: 'Sensitivity',
    linkAxes: 'Link axes',
    pollRate: 'Polling rate',
    pollHz: '{hz} Hz',
    lighting: 'Lighting · {zone}',
    zoneLogo: 'Logo',
    zoneScroll: 'Scroll wheel',
    zoneLeft: 'Left side',
    zoneRight: 'Right side',
    zoneBacklight: 'Body',
    effectNone: 'Off',
    effectStatic: 'Static',
    effectBreath: 'Breathing',
    effectSpectrum: 'Spectrum',
    effectWave: 'Wave',
    needChromium: 'Chrome or Edge required',
    noWebHid: 'WebHID is not available in this browser',
    mouseGone: 'Mouse disconnected',
    commandRejected: 'Command rejected: {status}',
    noReply: 'No reply from the device',
    noHidReport: 'no matching HID report',
    unsupportedMouse: 'Mouse 1532:{pid} is not supported yet',
    noControlInterface: 'Control HID interface not found{detail}',
    lang: 'Language',
  },
  ru: {
    title: 'Axon — веб-драйвер для мышей Razer',
    description: 'Веб-драйвер для мышей Razer: DPI, опрос, подсветка.',
    brandSub: 'веб-драйвер',
    connect: 'Подключить мышь',
    disconnect: 'Отключить',
    headline: 'Мыши Razer в браузере',
    lede: 'Ставит DPI, частоту опроса и подсветку и пишет это в мышь. Без десктопной программы.',
    checkBrowser: 'Chrome или Edge, мышь по USB',
    checkSynapse: 'Razer Synapse лучше закрыть целиком, включая трей',
    checkHid: 'Жми Connect. Если не выходит — Chrome прячет канал управления мышью: закрой Chrome и запусти его командой ниже (сохрани ярлык один раз)',
    chromeFixHint: 'Windows: закрой все окна Chrome, Win+R, вставь, Enter, потом снова открой эту страницу.',
    copyFlag: 'Скопировать',
    copiedFlag: 'Скопировано. Закрой Chrome и вставь в Win+R.',
    copyFailed: 'Не скопировалось',
    support: 'Поддержка',
    catalogSummary: 'Поддерживаемые модели ({n})',
    firmware: 'Прошивка',
    serial: 'Серийный номер',
    battery: 'Заряд',
    charging: '{percent}% · зарядка',
    repo: 'Репозиторий',
    disclaimer: 'Не связан с Razer Inc.',
    dpi: 'Чувствительность',
    linkAxes: 'Связать оси',
    pollRate: 'Частота опроса',
    pollHz: '{hz} Гц',
    lighting: 'Подсветка · {zone}',
    zoneLogo: 'Логотип',
    zoneScroll: 'Колёсико',
    zoneLeft: 'Левый бок',
    zoneRight: 'Правый бок',
    zoneBacklight: 'Корпус',
    effectNone: 'Выкл',
    effectStatic: 'Статичный',
    effectBreath: 'Дыхание',
    effectSpectrum: 'Спектр',
    effectWave: 'Волна',
    needChromium: 'Нужен Chrome или Edge',
    noWebHid: 'WebHID недоступен в этом браузере',
    emptyPicker: 'Список HID пустой. Chrome прячет канал управления. Закрой Chrome и запусти его командой с этой страницы.',
    mouseGone: 'Мышь отключена',
    commandRejected: 'Команда отклонена: {status}',
    noReply: 'Нет ответа от устройства',
    noHidReport: 'нет подходящего HID-отчёта',
    unsupportedMouse: 'Мышь 1532:{pid} пока не поддерживается',
    noControlInterface: 'Не найден управляющий HID-интерфейс{detail}',
    hidNeedOtherInterface: 'Chrome спрятал канал управления мышью и отдал только указатель. Закрой Chrome и запусти его командой с этой страницы.{hint}',
    lang: 'Язык',
  },
};

const zoneKeys = {
  logo: 'zoneLogo',
  scroll: 'zoneScroll',
  left: 'zoneLeft',
  right: 'zoneRight',
  backlight: 'zoneBacklight',
};

const effectKeys = {
  none: 'effectNone',
  static: 'effectStatic',
  breath: 'effectBreath',
  spectrum: 'effectSpectrum',
  wave: 'effectWave',
};

function detectLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ru') return saved;
  } catch {
    /* ignore */
  }
  return 'en';
}

let locale = detectLocale();

export function currentLocale() {
  return locale;
}

export function setLocale(next) {
  if (next !== 'en' && next !== 'ru') return;
  locale = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
}

export function t(key, vars = {}) {
  const table = dictionaries[locale] ?? dictionaries.en;
  let text = table[key] ?? dictionaries.en[key] ?? key;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

export function zoneLabel(zone) {
  const key = zoneKeys[zone.id];
  return key ? t(key) : zone.name;
}

export function effectLabel(effect) {
  const key = effectKeys[effect];
  return key ? t(key) : effect;
}

export function applyStatic() {
  document.documentElement.lang = locale;
  document.title = t('title');
  const description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute('content', t('description'));
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-lang]')) {
    node.classList.toggle('is-active', node.dataset.lang === locale);
  }
}
