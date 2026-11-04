'use strict';
/* Connect All — 1-bit pixel icons. All inherit currentColor. */

window.CA_ICONS = {
  chat: '<path d="M4 9h15v9H10l-5 4V9z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14 4h14v9h-6l-4 3v-3h-4V4z" fill="currentColor"/><rect x="8" y="13" width="2" height="2" fill="currentColor"/><rect x="12" y="13" width="2" height="2" fill="currentColor"/>',
  video: '<rect x="3" y="7" width="22" height="18" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="7" width="22" height="3" fill="currentColor"/><rect x="6" y="13" width="3" height="3" fill="currentColor"/><rect x="6" y="19" width="3" height="3" fill="currentColor"/><rect x="19" y="13" width="3" height="3" fill="currentColor"/><rect x="19" y="19" width="3" height="3" fill="currentColor"/><path d="M12 13l7 4-7 4v-8z" fill="currentColor"/><rect x="27" y="10" width="2" height="12" fill="currentColor"/>',
  calendar: '<path d="M4 7h24v22H4z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 11h24v3H4z" fill="currentColor"/><rect x="9" y="4" width="3" height="6" fill="currentColor"/><rect x="20" y="4" width="3" height="6" fill="currentColor"/><rect x="8" y="17" width="4" height="4" fill="currentColor"/><rect x="14" y="17" width="4" height="4" fill="currentColor"/><rect x="20" y="17" width="4" height="4" fill="none" stroke="currentColor" stroke-width="1"/>',
  ci: '<path d="M2 16c4-6 9-9 14-9s10 3 14 9c-4 6-9 9-14 9S6 22 2 16z" fill="none" stroke="currentColor" stroke-width="2"/><rect x="12" y="12" width="8" height="8" fill="currentColor"/><rect x="15" y="3" width="2" height="5" fill="currentColor"/><rect x="15" y="24" width="2" height="5" fill="currentColor"/><rect x="8" y="6" width="2" height="2" fill="currentColor"/><rect x="22" y="6" width="2" height="2" fill="currentColor"/><rect x="8" y="24" width="2" height="2" fill="currentColor"/><rect x="22" y="24" width="2" height="2" fill="currentColor"/>',
  server: '<path d="M5 6h22v8H5zM5 18h22v8H5z" fill="none" stroke="currentColor" stroke-width="2"/><rect x="8" y="9" width="9" height="2" fill="currentColor"/><rect x="8" y="21" width="9" height="2" fill="currentColor"/><rect x="21" y="10" width="3" height="3" fill="currentColor"/><rect x="21" y="22" width="3" height="3" fill="currentColor"/>',
  settings: '<circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="16" cy="16" r="3" fill="currentColor"/><rect x="14" y="1" width="4" height="6" fill="currentColor"/><rect x="14" y="25" width="4" height="6" fill="currentColor"/><rect x="1" y="14" width="6" height="4" fill="currentColor"/><rect x="25" y="14" width="6" height="4" fill="currentColor"/>',
  widget: '<path d="M3 5h26v22H3z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 9h26v3H3z" fill="currentColor"/><rect x="5" y="4" width="3" height="5" fill="currentColor"/><rect x="7" y="15" width="4" height="4" fill="currentColor"/><rect x="14" y="15" width="4" height="4" fill="currentColor"/><rect x="21" y="15" width="4" height="4" fill="none" stroke="currentColor" stroke-width="1"/><rect x="7" y="21" width="18" height="2" fill="currentColor"/>',
  link: '<path d="M12 20l-3 3a5 5 0 01-7-7l5-5a5 5 0 017 0" fill="none" stroke="currentColor" stroke-width="3"/><path d="M20 12l3-3a5 5 0 017 7l-5 5a5 5 0 01-7 0" fill="none" stroke="currentColor" stroke-width="3"/>',
  send: '<path d="M3 16L29 4 19 28l-6-9-10-3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter"/><path d="M13 19l7-7" stroke="currentColor" stroke-width="2"/>',
  search: '<circle cx="13" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="3"/><rect x="19" y="19" width="10" height="3" transform="rotate(45 19 19)" fill="currentColor"/>',
  pin: '<path d="M12 3h8l-2 8 5 5H9l5-5-2-8z" fill="none" stroke="currentColor" stroke-width="2"/><rect x="15" y="16" width="2" height="12" fill="currentColor"/>',
  plus: '<rect x="14" y="5" width="4" height="22" fill="currentColor"/><rect x="5" y="14" width="22" height="4" fill="currentColor"/>',
  close: '<rect x="7" y="7" width="4" height="4" fill="currentColor"/><rect x="11" y="11" width="4" height="4" fill="currentColor"/><rect x="15" y="15" width="4" height="4" fill="currentColor"/><rect x="19" y="19" width="4" height="4" fill="currentColor"/><rect x="19" y="7" width="4" height="4" fill="currentColor"/><rect x="15" y="11" width="4" height="4" fill="currentColor"/><rect x="11" y="15" width="4" height="4" fill="currentColor"/><rect x="7" y="19" width="4" height="4" fill="currentColor"/>',
  trash: '<path d="M6 10h20v18H6z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 7h24v3H4z" fill="currentColor"/><rect x="12" y="4" width="8" height="3" fill="currentColor"/><rect x="10" y="14" width="2" height="10" fill="currentColor"/><rect x="15" y="14" width="2" height="10" fill="currentColor"/><rect x="20" y="14" width="2" height="10" fill="currentColor"/>',
  copy: '<path d="M9 5h18v20H9z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 9v20h18" fill="none" stroke="currentColor" stroke-width="2"/>',
  check: '<path d="M5 17l7 7L28 6" fill="none" stroke="currentColor" stroke-width="4"/>',
  question: '<path d="M16 3a11 11 0 100 22 11 11 0 000-22z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 11c0-3 2-4 5-4s5 1 5 4c0 4-5 4-5 7" fill="none" stroke="currentColor" stroke-width="2"/><rect x="15" y="22" width="2" height="2" fill="currentColor"/>',
  refresh: '<path d="M26 16a10 10 0 11-3-7" fill="none" stroke="currentColor" stroke-width="3"/><path d="M26 3v8h-8" fill="none" stroke="currentColor" stroke-width="3"/>',
  arrow_left: '<path d="M20 5L8 16l12 11" fill="none" stroke="currentColor" stroke-width="3"/>',
  arrow_right: '<path d="M12 5l12 11-12 11" fill="none" stroke="currentColor" stroke-width="3"/>',
  monitor: '<path d="M3 5h26v18H3z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 27h10M16 23v4" stroke="currentColor" stroke-width="2"/>',
  mic: '<path d="M12 4h8v12a4 4 0 01-8 0V4z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 14a8 8 0 0016 0M16 22v6" fill="none" stroke="currentColor" stroke-width="2"/>',
  camera: '<path d="M3 8h18v16H3z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M21 13l8-4v14l-8-4z" fill="none" stroke="currentColor" stroke-width="2"/>',
  play: '<path d="M8 5l18 11L8 27V5z" fill="currentColor"/>',
  pause: '<rect x="8" y="5" width="5" height="22" fill="currentColor"/><rect x="19" y="5" width="5" height="22" fill="currentColor"/>',
  next: '<path d="M6 5l13 11L6 27V5z" fill="currentColor"/><rect x="22" y="5" width="4" height="22" fill="currentColor"/>',
  prev: '<path d="M26 5L13 16l13 11V5z" fill="currentColor"/><rect x="6" y="5" width="4" height="22" fill="currentColor"/>',
  music: '<rect x="11" y="4" width="3" height="18" fill="currentColor"/><rect x="22" y="7" width="3" height="15" fill="currentColor"/><path d="M11 4l14-2v4L11 8z" fill="currentColor"/><circle cx="8" cy="24" r="4" fill="currentColor"/><circle cx="19" cy="24" r="4" fill="currentColor"/>',
  logout: '<path d="M12 5H4v22h8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16h14M24 10l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/>',
  eye: '<path d="M2 16C7 9 11 6 16 6s9 3 14 10c-5 7-9 10-14 10S7 23 2 16z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="16" r="4" fill="currentColor"/>',
  folder: '<path d="M3 8h10l3 3h13v17H3z" fill="none" stroke="currentColor" stroke-width="2"/>',
  download: '<path d="M16 3v17M8 13l8 8 8-8" fill="none" stroke="currentColor" stroke-width="3"/><rect x="4" y="25" width="24" height="3" fill="currentColor"/>',
  upload: '<path d="M16 21V3M8 11l8-8 8 8" fill="none" stroke="currentColor" stroke-width="3"/><rect x="4" y="25" width="24" height="3" fill="currentColor"/>',
};

window.icon = function icon(name, size = 16, cls = '') {
  const body = window.CA_ICONS[name] || window.CA_ICONS.question;
  return (
    '<svg class="pixelated ' + cls + '" width="' + size + '" height="' + size + '" viewBox="0 0 32 32" ' +
    'fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' + body + '</svg>'
  );
};
