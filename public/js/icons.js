// Один набір плоских іконок: 24×24, лише контур, товщина 1.6, currentColor.
// Ніяких емодзі в інтерфейсі — вони різні на кожній ОС і ламають ритм рядка.
const P = {
  dashboard: ['M4 19V11', 'M10 19V5', 'M16 19v-6', 'M22 19H2'],
  analytics: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M20 21l-4.2-4.2'],
  finance: ['M3 7h18v10H3z', 'M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3', 'M6.5 12h.01', 'M17.5 12h.01'],
  target: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'M12 11.2a.8.8 0 1 0 0 1.6'],
  gauge: ['M12 20a8 8 0 1 1 8-8', 'M12 12l4-3'],
  shield: ['M12 3l7 3v5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z'],
  shieldCheck: ['M12 3l7 3v5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z', 'M9 12l2 2 4-4'],
  settings: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6', 'M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-4l-.4 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L6 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5c.07-.3.1-.7.1-1z'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8', 'M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5'],
  users: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7', 'M3 20c0-3 2.7-5 6-5s6 2 6 5', 'M16 5.2a3.5 3.5 0 0 1 0 6.6', 'M18 15c2 .7 3 2.4 3 5'],
  phone: ['M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1', 'M11 18h2'],
  device: ['M5 4h14v16H5z', 'M9 20h6'],
  sim: ['M6 3h8l4 4v14H6z', 'M9 13h6v5H9z', 'M9 13v5', 'M15 13v5'],
  globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M3 12h18', 'M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3'],
  mail: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
  swap: ['M4 8h13l-3-3', 'M20 16H7l3 3'],
  film: ['M4 5h16v14H4z', 'M4 9h16', 'M4 15h16', 'M9 5v14', 'M15 5v14'],
  layers: ['M12 3l8 4.5-8 4.5-8-4.5z', 'M4 12.5l8 4.5 8-4.5', 'M4 17l8 4.5 8-4.5'],
  check: ['M4 6h16v14H4z', 'M8.5 13l2.5 2.5 4.5-5'],
  send: ['M21 4L3 11l7 3 3 7z', 'M10 14l4-4'],
  handshake: ['M3 12l4-4 3 2 4-2 3 2 4-2', 'M7 8v6a2 2 0 0 0 2 2h1', 'M17 8v6a2 2 0 0 1-2 2h-1'],
  tag: ['M4 12V5h7l8 8-7 7z', 'M8.5 8.5h.01'],
  trending: ['M4 17l5-5 3 3 6-6', 'M15 9h4v4'],
  link: ['M10 13a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11 6.3', 'M14 11a4 4 0 0 0-5.7 0L5.7 13.6a4 4 0 0 0 5.7 5.7L13 17.7'],
  coins: ['M9 12a5 3.2 0 1 0 0-6.4 5 3.2 0 0 0 0 6.4', 'M4 8.8v3c0 1.8 2.2 3.2 5 3.2s5-1.4 5-3.2v-3', 'M10 16.8v1.4c0 1.8 2.2 3.2 5 3.2s5-1.4 5-3.2v-3c0-1.8-2.2-3.2-5-3.2'],
  receipt: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9.5 8h5', 'M9.5 12h5'],
  ruler: ['M3 14.5L14.5 3 21 9.5 9.5 21z', 'M8 9l2 2', 'M11 6l2 2', 'M5 12l2 2'],
  wallet: ['M4 7h13a3 3 0 0 1 3 3v7a2 2 0 0 1-2 2H4z', 'M4 7V5h11', 'M16.5 13h.01'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 7.5V12l3 2'],
  bell: ['M18 16H6l1.2-2V10a4.8 4.8 0 0 1 9.6 0v4z', 'M10.5 19a1.8 1.8 0 0 0 3 0'],
  pointer: ['M6 4l11 7-4.5 1.2L15 18l-2.2 1-2.5-5.6L6 16z'],
  lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3', 'M12 14.5v2'],
  idCard: ['M3 6h18v12H3z', 'M8.5 12a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6', 'M6 15.5c.5-1.2 1.4-1.8 2.5-1.8s2 .6 2.5 1.8', 'M14 10h4', 'M14 13.5h4'],
  hand: ['M9 11V5.5a1.5 1.5 0 0 1 3 0V11', 'M12 11V4.5a1.5 1.5 0 0 1 3 0V11', 'M15 11V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6H11a6 6 0 0 1-5-3l-2-3.5a1.6 1.6 0 0 1 2.6-1.8L9 15'],
  folder: ['M3 6h6l2 2.5h10V19H3z'],
  fileText: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h4'],
  script: ['M4 5.5a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V16H5.5A1.5 1.5 0 0 1 4 14.5z', 'M7.5 8.5h9', 'M7.5 11.5h5.5'],
  flag: ['M6 3v18', 'M6 4.5h11l-2 3.5 2 3.5H6'],
  book: ['M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M17 7h2v13h-2'],
  ban: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M6 6l12 12'],
  calendar: ['M4 6h16v15H4z', 'M4 10h16', 'M8.5 3.5v4', 'M15.5 3.5v4'],
  award: ['M12 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10', 'M9 13.5L8 21l4-2 4 2-1-7.5'],
  alert: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17h.01'],
  calculator: ['M5 3h14v18H5z', 'M8 7h8', 'M8.5 11.5h.01', 'M12 11.5h.01', 'M15.5 11.5h.01', 'M8.5 15.5h.01', 'M12 15.5h.01', 'M15.5 15.5h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  download: ['M12 4v10', 'M8 11l4 3 4-3', 'M5 19h14'],
  upload: ['M12 15V5', 'M8 8l4-3 4 3', 'M5 19h14'],
  edit: ['M4 20h4L19 9a2 2 0 0 0-3-3L5 16z', 'M15 6l3 3'],
  trash: ['M5 7h14', 'M9 7V4h6v3', 'M7 7l1 14h8l1-14', 'M11 11v6', 'M13 11v6'],
  eye: ['M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5'],
  key: ['M15 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10', 'M11.5 12.5L4 20v-2.5', 'M6.5 18l2-2'],
  undo: ['M4 9h10a5 5 0 0 1 0 10H8', 'M8 5L4 9l4 4'],
  redo: ['M20 9H10a5 5 0 0 0 0 10h6', 'M16 5l4 4-4 4'],
  zoomIn: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M20 21l-4.2-4.2', 'M11 8v6', 'M8 11h6'],
  zoomOut: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M20 21l-4.2-4.2', 'M8 11h6'],
  heading: ['M5 6h14', 'M5 12h9', 'M5 18h5'],
  dropdown: ['M4 7h16v10H4z', 'M9 11.5l3 3 3-3'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  message: ['M4 5h16v11H9l-4 4z'],
  play: ['M7 4l13 8-13 8z'],
  pause: ['M7 4h4v16H7z', 'M13 4h4v16h-4z'],
  paperclip: ['M8 13.5l6.5-6.5a3.5 3.5 0 0 1 5 5L11 20.5a5 5 0 0 1-7-7L13.5 4'],
  logout: ['M10 4H5v16h5', 'M15 8l4 4-4 4', 'M19 12H9'],
  sun: ['M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9', 'M12 2v2.5', 'M12 19.5V22', 'M4.2 4.2l1.8 1.8', 'M18 18l1.8 1.8', 'M2 12h2.5', 'M19.5 12H22', 'M4.2 19.8L6 18', 'M18 6l1.8-1.8'],
  moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M20 21l-4.2-4.2'],
  filter: ['M4 5h16l-6 7v6l-4 2v-8z'],
  sort: ['M7 4v14', 'M4 15l3 3 3-3', 'M17 20V6', 'M14 9l3-3 3 3'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  chevronLeft: ['M14 6l-6 6 6 6'],
  chevronRight: ['M10 6l6 6-6 6'],
  chevronDown: ['M6 10l6 6 6-6'],
  history: ['M4 12a8 8 0 1 0 2.5-5.8', 'M4 5v4h4', 'M12 8v4.5l3 1.8'],
  dot: ['M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4'],
  sparkles: ['M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z', 'M5 16l.7 2.3L8 19l-2.3.7L5 22l-.7-2.3L2 19l2.3-.7z', 'M18 15l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z'],
  more: ['M12 6.2a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8', 'M12 11.1a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8', 'M12 16a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8'],
  table: ['M4 5h16v14H4z', 'M4 10h16', 'M4 15h16', 'M10 5v14', 'M16 5v14'],
  checkSquare: ['M5 5h14v14H5z', 'M8.5 12l2.2 2.2L16 9.5'],
  checkCircle: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M8.3 12.3l2.3 2.3L16 9'],
  chevronUp: ['M6 14l6-6 6 6'],
  bold: ['M7.5 5h5a3 3 0 0 1 0 6h-5z', 'M7.5 11h5.5a3.2 3.2 0 0 1 0 6.4H7.5z'],
  italic: ['M10.5 5h6', 'M7.5 19h6', 'M13.5 5l-4 14'],
  underline: ['M6.5 4.5v6.5a5.5 5.5 0 0 0 11 0V4.5', 'M4.5 20h15'],
  textColor: ['M6 17l4.5-12 4.5 12', 'M7.6 13h5.8', 'M4 21h16'],
  pin: ['M9 4h6', 'M12 4v5', 'M8 9h8l1 4H7z', 'M12 13v7'],
  grip: [
    'M9 6.2a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8', 'M9 11.1a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8', 'M9 16a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8',
    'M15 6.2a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8', 'M15 11.1a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8', 'M15 16a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8',
  ],
  mic: ['M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z', 'M6 11a6 6 0 0 0 12 0', 'M12 17v4', 'M9 21h6'],
  repeat: ['M17 2l4 4-4 4', 'M3 11V9a4 4 0 0 1 4-4h14', 'M7 22l-4-4 4-4', 'M21 13v2a4 4 0 0 1-4 4H3'],
};

// Синоніми, щоб у сутностях писати змістовну назву, а не найближчу форму.
const ALIAS = {
  accounts: 'phone', devices: 'device', sims: 'sim', proxies: 'globe', mail_accounts: 'mail',
  resource_assignments: 'swap', creatives: 'film', creative_versions: 'layers', tasks: 'check',
  posts: 'send', partners: 'handshake', offers: 'tag', offer_rates_history: 'trending',
  tracking_links: 'link', conversions: 'coins', expenses: 'receipt', salary_rules: 'ruler',
  payouts: 'wallet', kpi_targets: 'gauge', account_events: 'clock', notifications: 'bell',
  audit_log: 'shieldCheck', clicks: 'pointer', credentials: 'lock', credential_grants: 'idCard',
  access_requests: 'hand', prospect_lists: 'folder', leads: 'target', touches: 'mail',
  message_templates: 'fileText', lead_statuses: 'flag', dictionaries: 'book', suppression_list: 'ban',
  kpi_plans: 'gauge', channel_limits: 'flag', work_calendar: 'calendar', ramp_up_plans: 'trending',
  bonus_rules: 'award', quality_flags: 'alert', services: 'calculator', cost_rates: 'ruler',
  users: 'user', teams: 'users', roles: 'shield', profile: 'settings', plans: 'gauge',
  prospecting: 'target', finance: 'finance', analytics: 'analytics', dashboard: 'dashboard',
};

export function icon(name, size = 16) {
  const key = P[name] ? name : (P[ALIAS[name]] ? ALIAS[name] : 'dot');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of P[key]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// Кнопка «іконка + підпис» з однаковим ритмом у всьому інтерфейсі.
export function withIcon(name, label, size = 15) {
  const span = document.createElement('span');
  span.className = 'with-icon';
  span.append(icon(name, size));
  if (label) span.append(document.createTextNode(label));
  return span;
}
