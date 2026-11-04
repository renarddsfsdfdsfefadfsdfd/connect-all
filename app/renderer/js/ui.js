'use strict';
/* Connect All — DOM helpers, classic dialogs, formatting. */

window.UI = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'html') el.innerHTML = value;
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
        else if (key === 'on' && typeof value === 'object') {
          for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
        } else if (key === 'value') el.value = value;
        else if (key === 'checked') el.checked = Boolean(value);
        else if (key === 'disabled') el.disabled = Boolean(value);
        else if (key === 'selected') el.selected = Boolean(value);
        else if (key === 'title') el.title = value;
        else el.setAttribute(key, value);
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
    return el;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function svgIcon(name, size = 16, cls = '') {
    const span = document.createElement('span');
    span.className = 'icon-inline';
    span.innerHTML = window.icon(name, size, cls);
    return span.firstChild;
  }

  function fmtClock(ts = Date.now()) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function fmtTime(ts = Date.now()) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }
  function fmtDate(ts, lang = CA_LANG) {
    try {
      return new Date(ts).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) {
      return new Date(ts).toLocaleDateString();
    }
  }
  function fmtDateTime(ts, lang = CA_LANG) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_) {
      return new Date(ts).toLocaleString();
    }
  }
  function fmtDay(ts, lang = CA_LANG) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return T('chat.today');
    try {
      return d.toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch (_) {
      return d.toDateString();
    }
  }
  function fmtMonthYear(d, lang = CA_LANG) {
    try {
      return d.toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'long' });
    } catch (_) {
      return d.getFullYear() + '-' + (d.getMonth() + 1);
    }
  }
  function weekdayNames(lang = CA_LANG, short = true) {
    const base = lang === 'en' ? 'en-US' : 'zh-CN';
    const fmt = new Intl.DateTimeFormat(base, { weekday: short ? 'short' : 'long' });
    // 2024-01-01 was a Monday
    const out = [];
    for (let i = 0; i < 7; i++) out.push(fmt.format(new Date(2024, 0, 1 + i)));
    return out;
  }
  function fmtRelative(ts, lang = CA_LANG) {
    if (!ts) return T('common.never');
    const diff = Date.now() - ts;
    if (diff < 45 * 1000) return T('common.just_now');
    if (diff < 3600 * 1000) return T('common.ago', { t: T('common.minutes', { n: Math.round(diff / 60000) }) });
    if (diff < 86400 * 1000) return T('common.ago', { t: T('common.hours', { n: Math.round(diff / 3600000) }) });
    return T('common.ago', { t: T('common.days', { n: Math.round(diff / 86400000) }) });
  }
  function fmtIn(ts, lang = CA_LANG) {
    const diff = ts - Date.now();
    if (diff <= 0) return T('common.now');
    if (diff < 3600 * 1000) return T('common.in', { t: T('common.minutes', { n: Math.max(1, Math.round(diff / 60000)) }) });
    if (diff < 86400 * 1000) return T('common.in', { t: T('common.hours', { n: Math.round(diff / 3600000) }) });
    return T('common.in', { t: T('common.days', { n: Math.round(diff / 86400000) }) });
  }
  function fmtDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function fmtBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function initials(name) {
    const s = String(name || '?').trim();
    if (!s) return '?';
    if (/[\u4e00-\u9fa5]/.test(s)) return s.slice(-2);
    return s
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || '')
      .join('')
      .toUpperCase();
  }
  function shortId(id) {
    const s = String(id || '');
    if (s.length <= 12) return s;
    return s.slice(0, 6) + '…' + s.slice(-4);
  }
  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }
  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }
  function throttle(fn, ms) {
    let last = 0;
    return (...args) => {
      const now = Date.now();
      if (now - last < ms) return;
      last = now;
      return fn(...args);
    };
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- toasts ---------- */
  function toast(message, kind = '') {
    const layer = $('#toasts');
    if (!layer) return;
    const edge = h('span', { class: 'bar' });
    const node = h('div', { class: 'toast ' + kind }, edge, h('div', { text: String(message) }));
    layer.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 180);
    }, kind === 'err' ? 5200 : 3400);
  }

  /* ---------- dialogs ---------- */
  const dialogStack = [];
  function closeTopDialog(result) {
    const top = dialogStack.pop();
    if (!top) return;
    top.el.remove();
    if (top.backdrop) top.backdrop.remove();
    if (!dialogStack.length) $('#dialogs').classList.remove('open');
    if (top.resolve) top.resolve(result);
  }
  function showDialog({ title, body, actions, width, onKey }) {
    const layer = $('#dialogs');
    const bodyNode = typeof body === 'string' ? h('div', { html: body }) : body;
    const actionRow = h('div', { class: 'dialog-actions' });
    const box = h(
      'div',
      { class: 'dialog', style: width ? { width: width + 'px' } : {} },
      h(
        'div',
        { class: 'titlebar' },
        h('span', { class: 'title', text: title }),
        h('button', { class: 'tb-box tb-close', title: T('common.close'), on: { click: () => closeTopDialog(null) } })
      ),
      h('div', { class: 'dialog-body' }, bodyNode),
      actionRow
    );
    const entry = { el: box, resolve: null };
    const promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    dialogStack.push(entry);
    layer.appendChild(box);
    layer.classList.add('open');
    const buttons = (actions && actions.length ? actions : [{ label: T('common.ok'), value: true, primary: true }]).map((a) => {
      const btn = h('button', {
        class: 'btn ' + (a.primary ? 'default' : '') + ' ' + (a.danger ? 'danger' : ''),
        text: a.label,
        on: {
          click: () => {
            if (a.validate && !a.validate()) return;
            closeTopDialog(a.value !== undefined ? a.value : true);
          },
        },
      });
      return btn;
    });
    buttons.forEach((b) => actionRow.appendChild(b));
    const backdrop = h('div', { class: 'dialog-backdrop', on: { click: () => closeTopDialog(null) } });
    layer.insertBefore(backdrop, box);
    entry.backdrop = backdrop;
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeTopDialog(null);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.shiftKey) {
        const primary = buttons.find((b) => b.classList.contains('default'));
        if (primary) primary.click();
      }
      if (onKey) onKey(e, closeTopDialog);
    });
    setTimeout(() => {
      const focusable = box.querySelector('input, textarea, select, button.default');
      if (focusable) focusable.focus();
    }, 30);
    return promise;
  }
  function confirmDialog({ title, message, confirmLabel, danger }) {
    return showDialog({
      title,
      body: h('p', { text: message }),
      actions: [
        { label: T('common.cancel'), value: false },
        { label: confirmLabel || T('dialog.confirm'), value: true, primary: !danger, danger },
      ],
    });
  }
  function promptDialog({ title, label, value = '', placeholder = '', multiline = false, confirmLabel }) {
    const input = multiline
      ? h('textarea', { class: 'textarea', rows: 6, placeholder, value })
      : h('input', { class: 'input', placeholder, value });
    const body = h('label', { class: 'field' }, h('span', { text: label }), input);
    return showDialog({
      title,
      body,
      width: multiline ? 560 : 460,
      actions: [
        { label: T('common.cancel'), value: false },
        {
          label: confirmLabel || T('common.ok'),
          primary: true,
          validate: () => {
            if (!input.value.trim()) {
              toast(T('dialog.input_required'), 'err');
              return false;
            }
            return true;
          },
          value: true,
        },
      ],
    }).then((res) => (res === true ? input.value.trim() : null));
  }

  function presenceLed(state) {
    const el = h('span', { class: 'led' });
    if (state === 'online' || state === 'in_call' || state === 'watching' || state === 'listening') el.classList.add('on');
    else if (state === 'on_the_way' || state === 'away') el.classList.add('warn');
    else if (state === 'offline') el.classList.remove('on');
    if (state === 'focus') el.classList.add('bad');
    return el;
  }

  function presenceLabel(state) {
    const key = 'presence.' + (state || 'unknown');
    const label = T(key);
    return label === key ? T('presence.unknown') : label;
  }

  function led(on, kind = '') {
    return h('span', { class: 'led ' + (on ? 'on' : '') + ' ' + kind });
  }

  function copyText(text) {
    return window.ca.copy(String(text || '')).then(() => {
      toast(T('common.copied'), 'ok');
      return true;
    });
  }

  function tag(text, cls = '') {
    return h('span', { class: 'tag ' + cls, text });
  }

  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', { text: label }), input, hint ? h('span', { class: 'hint', text: hint }) : null);
  }

  function checkbox(label, checked, onChange) {
    const input = h('input', { type: 'checkbox', checked, on: { change: () => onChange && onChange(input.checked) } });
    return h('label', { class: 'check' }, input, h('span', { class: 'box' }), h('span', { text: label }));
  }

  function empty(glyph, title, desc, action) {
    const glyphNode = typeof glyph === 'string' ? h('div', { class: 'glyph', text: glyph }) : h('div', { class: 'glyph' }, glyph);
    return h(
      'div',
      { class: 'empty' },
      glyphNode,
      h('div', { class: 'title', text: title }),
      h('div', { class: 'desc', text: desc }),
      action || null
    );
  }

  function avatar(name, size = 32) {
    const el = h('div', { class: 'avatar', style: { width: size + 'px', height: size + 'px', fontSize: Math.max(9, size / 2.4) + 'px' } });
    el.textContent = initials(name);
    return el;
  }

  return {
    $,
    $$,
    h,
    clear,
    icon: svgIcon,
    fmtClock,
    fmtTime,
    fmtDate,
    fmtDateTime,
    fmtDay,
    fmtMonthYear,
    weekdayNames,
    fmtRelative,
    fmtIn,
    fmtDuration,
    fmtBytes,
    initials,
    shortId,
    clamp,
    debounce,
    throttle,
    escapeHtml,
    toast,
    showDialog,
    confirmDialog,
    promptDialog,
    closeTopDialog,
    presenceLed,
    presenceLabel,
    led,
    copyText,
    tag,
    field,
    checkbox,
    empty,
    avatar,
  };
})();
