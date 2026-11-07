'use strict';
/* Connect All — renderer shell: desktop, menu bar, windows, event bus. */

window.CA_APPS = window.CA_APPS || {};

window.CA = {
  snap: null,
  lang: 'zh',
  apps: {},
  windows: new Map(),
  activeApp: '',
  layout: {},
  lastEvent: null,
  z: 30,
  booted: false,
};

(function () {
  const { $, h, icon, toast } = UI;
  const CA = window.CA;
  const BOOT_T0 = performance.now();
  let bootFinished = false;
  let bootSkip = false;

  function finishBoot(force) {
    const el = document.getElementById('boot-screen');
    if (!el || bootFinished) return;
    if (!force && !bootSkip && performance.now() - BOOT_T0 < 1200) {
      setTimeout(() => finishBoot(false), Math.max(0, 1200 - (performance.now() - BOOT_T0)));
      return;
    }
    bootFinished = true;
    el.classList.add('boot-exit');
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 360);
  }

  function armBootScreen() {
    const el = document.getElementById('boot-screen');
    if (!el) return;
    el.addEventListener('click', () => {
      bootSkip = true;
      if (CA.booted) finishBoot(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !bootFinished) {
        bootSkip = true;
        if (CA.booted) finishBoot(false);
      }
    });
    // Never leave a dead splash screen if startup fails.
    setTimeout(() => { if (!CA.booted) finishBoot(true); }, 12000);
  }

  const DEFAULT_LAYOUT = {
    chat: { x: 96, y: 16, w: 560, h: 548, minW: 420, minH: 360 },
    calendar: { x: 668, y: 16, w: 500, h: 548, minW: 500, minH: 420 },
    video: { x: 120, y: 34, w: 720, h: 566, minW: 520, minH: 430 },
    ci: { x: 150, y: 30, w: 660, h: 600, minW: 480, minH: 420 },
    settings: { x: 120, y: 24, w: 780, h: 636, minW: 620, minH: 480 },
  };

  function loadLayout() {
    try {
      return JSON.parse(localStorage.getItem('ca.layout') || '{}') || {};
    } catch (_) {
      return {};
    }
  }
  function saveLayout() {
    try {
      localStorage.setItem('ca.layout', JSON.stringify(CA.layout));
    } catch (_) {}
  }

  function platformClass() {
    const p = window.ca.env.platform;
    document.body.classList.add('platform-' + p);
    if (p === 'darwin') document.body.classList.add('darwin');
    if (p === 'win32') document.body.classList.add('win32');
  }

  function startClock() {
    const tick = () => {
      const node = $('#clock');
      if (!node) return;
      const d = new Date();
      node.textContent =
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      const statusClock = $('#st-clock');
      if (statusClock) {
        statusClock.textContent =
          d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
          String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }
    };
    tick();
    setInterval(tick, 15000);
  }

  /* ------------------------------------------------------------------ */
  /* Menu bar                                                            */
  /* ------------------------------------------------------------------ */

  function menuItem(label, action, shortcut) {
    return h(
      'button',
      {
        class: 'menu-entry',
        on: { click: () => { closeMenus(); action(); } },
      },
      h('span', { text: label }),
      shortcut ? h('span', { class: 'shortcut', text: shortcut }) : null
    );
  }

  function menuGroup(label, entries) {
    const group = h('div', { class: 'menu-group', style: { position: 'relative', height: '100%' } });
    const button = h('button', { class: 'menu-item', text: label });
    const panel = h('div', { class: 'menu-panel' });
    for (const entry of entries) {
      if (!entry) continue;
      if (entry.sep) panel.appendChild(h('div', { class: 'menu-sep' }));
      else panel.appendChild(menuItem(entry.label, entry.action, entry.shortcut));
    }
    group.appendChild(button);
    group.appendChild(panel);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = panel.classList.contains('open');
      closeMenus();
      if (!wasOpen) {
        panel.classList.add('open');
        button.classList.add('open');
      }
    });
    group.addEventListener('mouseenter', () => {
      if (document.querySelector('.menu-panel.open') && !panel.classList.contains('open')) {
        closeMenus();
        panel.classList.add('open');
        button.classList.add('open');
      }
    });
    return group;
  }

  function closeMenus() {
    for (const p of document.querySelectorAll('.menu-panel.open')) p.classList.remove('open');
    for (const b of document.querySelectorAll('.menu-item.open')) b.classList.remove('open');
  }

  function buildMenubar() {
    const menus = $('#menus');
    UI.clear(menus);
    const mod = window.ca.env.platform === 'darwin' ? '⌘' : 'Ctrl+';
    const items = [
      menuGroup(T('nav.file'), [
        { label: T('nav.import_calendar'), action: () => CA.openApp('calendar') },
        { label: T('nav.export_chat'), action: () => exportChat() },
        { sep: true },
        { label: T('nav.open_data'), action: () => window.ca.openPath(CA.snap.app.paths.data) },
        { label: T('nav.snapshot'), action: () => refreshSnapshot(true) },
        { sep: true },
        { label: T('nav.quit'), action: () => window.ca.quit(), shortcut: mod + 'Q' },
      ]),
      menuGroup(T('nav.connect'), [
        { label: T('nav.chat'), action: () => CA.openApp('chat'), shortcut: mod + '1' },
        { label: T('nav.video'), action: () => CA.openApp('video'), shortcut: mod + '2' },
        { label: T('nav.calendar'), action: () => CA.openApp('calendar'), shortcut: mod + '3' },
        { label: T('nav.ci'), action: () => CA.openApp('ci'), shortcut: mod + '4' },
        { sep: true },
        { label: T('nav.server'), action: () => window.ca.window.openServer(), shortcut: mod + '5' },
        { label: T('nav.settings'), action: () => CA.openApp('settings') },
        { sep: true },
        { label: T('nav.show_widget'), action: () => toggleWidget() },
      ]),
      menuGroup(T('nav.view'), [
        { label: T('nav.snapshot'), action: () => refreshSnapshot(true) },
        { label: T('nav.open_data'), action: () => window.ca.openPath(CA.snap.app.paths.data) },
        { sep: true },
        { label: T('nav.widget'), action: () => toggleWidget() },
      ]),
      menuGroup(T('nav.help'), [
        { label: T('nav.about'), action: () => window.ca.about() },
        { label: T('nav.open_data'), action: () => window.ca.openPath(CA.snap.app.paths.data) },
      ]),
    ];
    items.forEach((i) => menus.appendChild(i));

    const right = $('#menubar-right');
    UI.clear(right);
    const linkChip = h(
      'button',
      { class: 'led-chip', id: 'chip-link', title: T('nav.server'), on: { click: () => window.ca.window.openServer() } },
      h('span', { class: 'led', id: 'chip-link-led' }),
      h('span', { id: 'chip-link-text', text: T('status.offline') })
    );
    const ciChip = h(
      'button',
      { class: 'led-chip', id: 'chip-ci', title: T('nav.ci'), on: { click: () => CA.openApp('ci') } },
      h('span', { class: 'led', id: 'chip-ci-led' }),
      h('span', { id: 'chip-ci-text', text: 'CI' })
    );
    const peerChip = h(
      'button',
      { class: 'led-chip', id: 'chip-peer', title: T('nav.chat'), on: { click: () => CA.openApp('chat') } },
      h('span', { class: 'led', id: 'chip-peer-led' }),
      h('span', { id: 'chip-peer-text', text: T('status.unpaired') })
    );
    const langBtn = h('button', {
      class: 'lang-btn',
      id: 'lang-btn',
      text: CA.lang === 'zh' ? '中 / EN' : 'EN / 中',
      on: { click: switchLang },
    });
    const clock = h('span', { class: 'menubar-clock', id: 'clock', text: '--:--' });
    right.append(linkChip, ciChip, peerChip, langBtn, clock);
  }

  async function switchLang() {
    const next = CA.lang === 'zh' ? 'en' : 'zh';
    await window.ca.setLang(next);
  }

  function exportChat() {
    window.ca.chat
      .export()
      .then((res) => {
        if (res && res.ok) toast(T('chat.export_done', { path: res.path }), 'ok');
      })
      .catch((err) => toast(T('toast.error', { err: err.message }), 'err'));
  }

  function toggleWidget() {
    window.ca.widget
      .toggle()
      .then((res) => toast(res.visible ? T('toast.widget_on') : T('toast.widget_off')))
      .catch((err) => toast(err.message, 'err'));
  }

  /* ------------------------------------------------------------------ */
  /* Desktop rail                                                        */
  /* ------------------------------------------------------------------ */

  function buildRail() {
    const rail = $('#icons');
    UI.clear(rail);
    const list = [
      { key: 'chat', icon: 'chat', label: T('nav.chat'), unread: true },
      { key: 'video', icon: 'video', label: T('nav.video') },
      { key: 'calendar', icon: 'calendar', label: T('nav.calendar') },
      { key: 'ci', icon: 'ci', label: T('nav.ci') },
      { key: 'settings', icon: 'settings', label: T('nav.settings') },
      { sep: true },
      { key: 'server', icon: 'server', label: T('nav.server'), action: () => window.ca.window.openServer() },
      { key: 'widget', icon: 'widget', label: T('nav.widget'), action: () => toggleWidget() },
    ];
    for (const item of list) {
      if (item.sep) {
        rail.appendChild(h('div', { class: 'rail-sep' }));
        continue;
      }
      const btn = h(
        'button',
        {
          class: 'desk-icon',
          title: item.label,
          dataset: { app: item.key },
          on: {
            click: () => {
              for (const el of rail.querySelectorAll('.desk-icon.selected')) el.classList.remove('selected');
              btn.classList.add('selected');
              if (item.action) item.action();
              else CA.openApp(item.key);
            },
            dblclick: () => (item.action ? item.action() : CA.openApp(item.key)),
          },
        },
        h('span', { html: window.icon(item.icon, 36) }),
        h('span', { class: 'label', text: item.label })
      );
      if (item.unread) {
        const dot = h('span', { class: 'badge-dot hidden', dataset: { unread: item.key } });
        btn.appendChild(dot);
      }
      rail.appendChild(btn);
    }
  }

  function updateRailBadges() {
    const badge = document.querySelector('[data-unread="chat"]');
    if (!badge) return;
    const unread = (CA.snap && CA.snap.chat.unread) || 0;
    badge.classList.toggle('hidden', unread <= 0);
    badge.title = unread + ' ' + T('chat.unread');
  }

  /* ------------------------------------------------------------------ */
  /* Status bar                                                          */
  /* ------------------------------------------------------------------ */

  function buildStatusbar() {
    const bar = $('#statusbar');
    UI.clear(bar);
    bar.append(
      h('span', { class: 'cell' }, h('span', { class: 'led', id: 'st-link-led' }), h('span', { id: 'st-link', text: 'OFFLINE' })),
      h('span', { class: 'cell sep', id: 'st-via', text: '—' }),
      h('span', { class: 'cell sep' }, h('span', { class: 'led', id: 'st-server-led' }), h('span', { id: 'st-server', text: 'SERVER' })),
      h('span', { class: 'cell sep' }, h('span', { class: 'led', id: 'st-ci-led' }), h('span', { id: 'st-ci', text: 'CI' })),
      h('span', { class: 'cell sep', id: 'st-pair', text: 'UNPAIRED' }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'cell', id: 'st-ticker', text: '' }),
      h('span', { class: 'cell sep', id: 'st-unread', text: 'UNREAD 0' }),
      h('span', { class: 'cell sep', id: 'st-queue', text: 'QUEUE 0' }),
      h('span', { class: 'cell sep', id: 'st-clock', text: '—' })
    );
    updateStatusbar();
  }

  function setLed(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('on', 'warn', 'bad', 'blink');
    if (state) el.classList.add(state);
  }

  function updateMenubarChips() {
    if (!CA.snap) return;
    const link = CA.snap.link || {};
    const linkOn = Boolean(link.online);
    setLed('chip-link-led', linkOn ? (link.via === 'lan' ? 'on' : 'on') : 'bad');
    const text = document.getElementById('chip-link-text');
    if (text) text.textContent = linkOn ? (link.via === 'lan' ? 'LAN' : 'RELAY') : 'OFFLINE';
    const ciOn = CA.snap.ci && CA.snap.ci.config && CA.snap.ci.config.enabled;
    setLed('chip-ci-led', ciOn ? 'on' : '');
    const peer = CA.snap.app.pairing.peer;
    setLed('chip-peer-led', linkOn ? 'on' : peer ? 'warn' : '');
    const peerText = document.getElementById('chip-peer-text');
    if (peerText) peerText.textContent = peer ? peer.name : T('status.unpaired');
  }

  function updateStatusbar() {
    if (!CA.snap) return;
    const link = CA.snap.link || {};
    const server = CA.snap.server || {};
    const ci = CA.snap.ci || {};
    const paired = CA.snap.app.pairing.paired;
    setLed('st-link-led', link.online ? 'on' : 'bad');
    const stLink = document.getElementById('st-link');
    if (stLink) stLink.textContent = link.online ? T('status.link') + ' OK' : T('status.offline');
    const stVia = document.getElementById('st-via');
    if (stVia) stVia.textContent = link.via ? link.via.toUpperCase() : '—';
    setLed('st-server-led', server.url ? (server.backup && server.backup.lastBackupError ? 'warn' : 'on') : '');
    const stServer = document.getElementById('st-server');
    if (stServer) stServer.textContent = server.localRelay && server.localRelay.running ? T('status.local_relay') + ':' + server.localRelay.port : server.url ? T('status.server') : T('status.server') + ' —';
    setLed('st-ci-led', ci.config && ci.config.enabled ? (ci.status && ci.status.running ? 'warn blink' : 'on') : '');
    const stCi = document.getElementById('st-ci');
    if (stCi) {
      let label = T('status.ci') + ' OFF';
      if (ci.config && ci.config.enabled) {
        if (ci.status && ci.status.nextRunAt) label = T('status.ci') + ' ' + UI.fmtClock(ci.status.nextRunAt);
        else label = T('status.ci') + ' ON';
      }
      stCi.textContent = label;
    }
    const stPair = document.getElementById('st-pair');
    if (stPair) stPair.textContent = paired ? T('status.paired') : T('status.unpaired');
    const stUnread = document.getElementById('st-unread');
    if (stUnread) stUnread.textContent = 'UNREAD ' + ((CA.snap.chat && CA.snap.chat.unread) || 0);
    const stQueue = document.getElementById('st-queue');
    if (stQueue) stQueue.textContent = 'QUEUE ' + ((link.queue) || 0);
    const ticker = document.getElementById('st-ticker');
    if (ticker) ticker.textContent = CA.ticker || (server.backup && server.backup.lastBackupAt ? T('set.backup_last', { t: UI.fmtRelative(server.backup.lastBackupAt) }) : '');
    updateRailBadges();
    updateMenubarChips();
    document.title = (CA.snap.chat.unread ? '(' + CA.snap.chat.unread + ') ' : '') + 'Connect All';
  }

  function setTicker(text) {
    CA.ticker = text;
    const node = document.getElementById('st-ticker');
    if (node) node.textContent = text;
  }

  /* ------------------------------------------------------------------ */
  /* Windows                                                             */
  /* ------------------------------------------------------------------ */

  function desktopRect() {
    const desktop = $('#desktop');
    return { width: desktop.clientWidth, height: desktop.clientHeight };
  }

  function clampRect(rect) {
    const area = desktopRect();
    const width = Math.min(rect.w, Math.max(320, area.width - 8));
    const height = Math.min(rect.h, Math.max(220, area.height - 8));
    return {
      x: Math.max(4, Math.min(rect.x, area.width - width - 8)),
      y: Math.max(4, Math.min(rect.y, area.height - height - 8)),
      w: width,
      h: height,
    };
  }

  function makeTitlebar(rec, def) {
    const close = h('button', {
      class: 'tb-box tb-close',
      title: T('common.close'),
      on: {
        click: (e) => {
          e.stopPropagation();
          closeApp(rec.key);
        },
      },
    });
    const zoom = h('button', {
      class: 'tb-box tb-zoom',
      title: 'Zoom',
      on: {
        click: (e) => {
          e.stopPropagation();
          toggleZoom(rec);
        },
      },
    });
    const title = h('span', { class: 'title', text: T(def.titleKey) });
    const bar = h('div', { class: 'titlebar' }, close, title, zoom);
    bar.addEventListener('pointerdown', (e) => startDrag(e, rec));
    bar.addEventListener('dblclick', () => toggleZoom(rec));
    return bar;
  }

  function openApp(key, opts = {}) {
    const def = CA.apps[key];
    if (!def) return null;
    if (CA.windows.has(key)) {
      const rec = CA.windows.get(key);
      if (opts.tab && rec.app && rec.app.setTab) rec.app.setTab(opts.tab);
      focusWindow(rec);
      return rec;
    }
    const saved = CA.layout[key] || {};
    const rect = clampRect({
      x: saved.x !== undefined ? saved.x : def.layout.x,
      y: saved.y !== undefined ? saved.y : def.layout.y,
      w: saved.w || def.layout.w,
      h: saved.h || def.layout.h,
    });
    const body = h('div', { class: 'window-body' });
    const footer = h('div', { class: 'window-footer' });
    const win = h('div', { class: 'ca-window active', dataset: { app: key }, style: { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px', zIndex: ++CA.z } });
    const rec = { key, def, el: win, body, footer, rect, zoomed: false, restore: null, app: null };
    win.appendChild(makeTitlebar(rec, def));
    win.appendChild(body);
    win.appendChild(footer);
    const resizer = h('div', { class: 'resize-handle' });
    win.appendChild(resizer);
    resizer.addEventListener('pointerdown', (e) => startResize(e, rec));
    win.addEventListener('pointerdown', () => focusWindow(rec));
    win.querySelector('.titlebar').addEventListener('pointerdown', () => focusWindow(rec));
    $('#windows').appendChild(win);
    CA.windows.set(key, rec);
    rec.app = def;
    try {
      if (def.mount) def.mount({ body, footer, win, rec, opts });
    } catch (err) {
      console.error('mount failed', key, err);
      body.appendChild(UI.empty('!', T('common.error'), String(err.message || err)));
    }
    if (def.footer) setFooter(key, def.footer(CA.snap));
    focusWindow(rec);
    updateStatusbar();
    return rec;
  }

  function setFooter(key, nodes) {
    const rec = CA.windows.get(key);
    if (!rec) return;
    UI.clear(rec.footer);
    if (!nodes) return;
    (Array.isArray(nodes) ? nodes : [nodes]).forEach((n) => n && rec.footer.appendChild(n));
  }

  function focusWindow(rec) {
    for (const other of CA.windows.values()) {
      other.el.classList.remove('active');
      other.el.classList.add('inactive');
    }
    rec.el.classList.remove('inactive');
    rec.el.classList.add('active');
    rec.el.style.zIndex = ++CA.z;
    CA.activeApp = rec.key;
    if (rec.app && rec.app.focus) rec.app.focus();
  }

  function closeApp(key) {
    const rec = CA.windows.get(key);
    if (!rec) return;
    if (rec.app && rec.app.destroy) {
      try {
        rec.app.destroy();
      } catch (_) {}
    }
    rec.el.remove();
    CA.windows.delete(key);
    if (CA.activeApp === key) {
      const last = Array.from(CA.windows.keys()).pop();
      CA.activeApp = last || '';
      if (last) focusWindow(CA.windows.get(last));
    }
  }

  function toggleZoom(rec) {
    const area = desktopRect();
    if (!rec.zoomed) {
      rec.restore = { x: rec.el.offsetLeft, y: rec.el.offsetTop, w: rec.el.offsetWidth, h: rec.el.offsetHeight };
      rec.el.style.left = '6px';
      rec.el.style.top = '6px';
      rec.el.style.width = area.width - 12 + 'px';
      rec.el.style.height = area.height - 12 + 'px';
      rec.zoomed = true;
    } else if (rec.restore) {
      rec.el.style.left = rec.restore.x + 'px';
      rec.el.style.top = rec.restore.y + 'px';
      rec.el.style.width = rec.restore.w + 'px';
      rec.el.style.height = rec.restore.h + 'px';
      rec.zoomed = false;
      rememberRect(rec);
    }
  }

  function rememberRect(rec) {
    CA.layout[rec.key] = {
      x: rec.el.offsetLeft,
      y: rec.el.offsetTop,
      w: rec.el.offsetWidth,
      h: rec.el.offsetHeight,
    };
    saveLayout();
  }

  function startDrag(e, rec) {
    if (e.button !== 0) return;
    if (e.target.closest('.tb-box')) return;
    focusWindow(rec);
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = rec.el.offsetLeft;
    const origY = rec.el.offsetTop;
    const area = desktopRect();
    const maxX = area.width - rec.el.offsetWidth - 4;
    const maxY = area.height - rec.el.offsetHeight - 4;
    const move = (ev) => {
      const x = UI.clamp(origX + ev.clientX - startX, 4, Math.max(4, maxX));
      const y = UI.clamp(origY + ev.clientY - startY, 4, Math.max(4, maxY));
      rec.el.style.left = x + 'px';
      rec.el.style.top = y + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      rememberRect(rec);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startResize(e, rec) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    focusWindow(rec);
    const startX = e.clientX;
    const startY = e.clientY;
    const origW = rec.el.offsetWidth;
    const origH = rec.el.offsetHeight;
    const minW = rec.def.layout.minW || 380;
    const minH = rec.def.layout.minH || 260;
    const area = desktopRect();
    const maxW = area.width - rec.el.offsetLeft - 4;
    const maxH = area.height - rec.el.offsetTop - 4;
    const move = (ev) => {
      rec.el.style.width = UI.clamp(origW + ev.clientX - startX, minW, Math.max(minW, maxW)) + 'px';
      rec.el.style.height = UI.clamp(origH + ev.clientY - startY, minH, Math.max(minH, maxH)) + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      rememberRect(rec);
      rec.app && rec.app.resize && rec.app.resize();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function dispatchToApps(evt) {
    for (const rec of CA.windows.values()) {
      if (rec.app && rec.app.event) {
        try {
          rec.app.event(evt);
        } catch (err) {
          console.error('app event failed', rec.key, err);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Snapshot + events                                                   */
  /* ------------------------------------------------------------------ */

  async function refreshSnapshot(announce) {
    try {
      CA.snap = await window.ca.snapshot();
      CA.lang = CA.snap.lang || CA.lang;
      window.CA_LANG = CA.lang;
      updateStatusbar();
      dispatchToApps({ type: 'snapshot', payload: CA.snap });
      if (announce) toast(T('toast.synced'));
    } catch (err) {
      toast(T('toast.error', { err: err.message }), 'err');
    }
  }

  function handleEvent(evt) {
    if (!evt || !evt.type) return;
    CA.lastEvent = evt;
    if (evt.type === 'signal') {
      window.__CA_SIGNALS = window.__CA_SIGNALS || [];
      window.__CA_SIGNALS.push({ at: Date.now(), type: evt.payload && evt.payload.type, callId: evt.payload && evt.payload.callId });
      if (window.__CA_SIGNALS.length > 200) window.__CA_SIGNALS.shift();
    }
    if (CA.snap && evt.type === 'lang' && evt.payload && evt.payload.lang && evt.payload.lang !== CA.lang) {
      try { sessionStorage.setItem('ca.reloadApp', CA.activeApp || ''); } catch (_) {}
      window.ca.reload();
      return;
    }
    if (CA.snap) {
      switch (evt.type) {
        case 'chat-message': {
          const msg = evt.payload.message;
          if (msg) {
            const list = CA.snap.chat.messages;
            if (!list.some((m) => m.id === msg.id)) {
              list.push(msg);
              if (list.length > 400) list.splice(0, list.length - 400);
            }
            CA.snap.chat.unread = evt.payload.unread != null ? evt.payload.unread : CA.snap.chat.unread;
          }
          break;
        }
        case 'chat-read':
          CA.snap.chat.unread = 0;
          break;
        case 'chat-update':
          CA.snap.chat.unread = evt.payload.unread != null ? evt.payload.unread : CA.snap.chat.unread;
          if (evt.payload.id && evt.payload.state) {
            const m = (CA.snap.chat.messages || []).find((x) => x.id === evt.payload.id);
            if (m) m.state = evt.payload.state;
          }
          break;
        case 'presence':
          CA.snap.presence = evt.payload;
          if (evt.payload && evt.payload.peer && evt.payload.peer.deviceName && CA.snap.app.pairing.peer) {
            CA.snap.app.pairing.peer.name = evt.payload.peer.deviceName;
          }
          break;
        case 'link':
          CA.snap.link = evt.payload;
          break;
        case 'calendar':
          CA.snap.calendar = evt.payload;
          break;
        case 'ci-status':
          CA.snap.ci.status = evt.payload;
          break;
        case 'ci-config':
          CA.snap.ci.config = evt.payload;
          break;
        case 'ci-summary':
          CA.snap.ci.summaries = [evt.payload, ...(CA.snap.ci.summaries || [])].slice(0, 40);
          break;
        case 'backup':
          CA.snap.server.backup = evt.payload;
          break;
        case 'server':
          Object.assign(CA.snap.server, evt.payload, { backup: CA.snap.server.backup });
          break;
        case 'paired':
        case 'unpaired':
        case 'snapshot-changed':
          refreshSnapshot(false);
          break;
        case 'pairing':
          break;
        default:
          break;
      }
    }
    if (evt.type === 'navigate' && evt.payload && evt.payload.app) {
      CA.openApp(evt.payload.app);
      return;
    }
    if (evt.type === 'chat-message' && CA.snap) {
      setTicker((evt.payload.message.from === 'peer' ? (CA.snap.app.pairing.peer ? CA.snap.app.pairing.peer.name : 'TA') : T('chat.you')) + ': ' + evt.payload.message.text.slice(0, 60));
      if (CA.activeApp !== 'chat' && evt.payload.message.from === 'peer') UI.toast(evt.payload.message.text.slice(0, 80));
    }
    if (evt.type === 'ci-summary') {
      setTicker(T('status.ci') + ': ' + evt.payload.summary.headline);
      UI.toast(T('status.ci') + ' · ' + evt.payload.summary.headline, 'ok');
    }
    if (evt.type === 'backup-done') setTicker(T('set.backup_done', { kb: Math.round((evt.payload.bytes || 0) / 1024) }));
    if (evt.type === 'backup-error') setTicker(T('set.backup_error', { err: evt.payload.message }));
    updateStatusbar();
    dispatchToApps(evt);
  }

  /* ------------------------------------------------------------------ */
  /* Keyboard                                                            */
  /* ------------------------------------------------------------------ */

  function bindKeys() {
    window.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        const map = { '1': 'chat', '2': 'video', '3': 'calendar', '4': 'ci' };
        CA.openApp(map[e.key]);
      } else if (mod && e.key === ',') {
        e.preventDefault();
        CA.openApp('settings');
      } else if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        CA.openApp('chat', { search: true });
      } else if (e.key === 'Escape') {
        closeMenus();
        UI.closeTopDialog(null);
      }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-group')) closeMenus();
    });
    window.addEventListener('resize', () => {
      for (const rec of CA.windows.values()) {
        const r = { x: rec.el.offsetLeft, y: rec.el.offsetTop, w: rec.el.offsetWidth, h: rec.el.offsetHeight };
        const c = clampRect(r);
        rec.el.style.left = c.x + 'px';
        rec.el.style.top = c.y + 'px';
        rec.el.style.width = c.w + 'px';
        rec.el.style.height = c.h + 'px';
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    armBootScreen();
    platformClass();
    CA.layout = loadLayout();
    CA.apps = window.CA_APPS;
    try {
      CA.snap = await window.ca.snapshot();
    } catch (err) {
      finishBoot(true);
      document.body.appendChild(UI.empty('!', 'Connect All', 'Failed to start: ' + err.message));
      return;
    }
    const query = new URLSearchParams(location.search);
    const lang = query.get('lang') || CA.snap.lang || 'zh';
    CA.lang = ['zh', 'en'].includes(lang) ? lang : 'zh';
    window.CA_LANG = CA.lang;
    buildMenubar();
    buildRail();
    buildStatusbar();
    startClock();
    bindKeys();
    window.ca.onEvent(handleEvent);
    updateStatusbar();
    const envApp = (CA.snap && window.ca.env.activeApp) || '';
    const reloadApp = sessionStorage.getItem('ca.reloadApp');
    sessionStorage.removeItem('ca.reloadApp');
    if (envApp) {
      CA.openApp(envApp);
    } else if (reloadApp && CA.apps[reloadApp]) {
      CA.openApp(reloadApp);
    } else {
      CA.openApp('chat');
      if (window.innerWidth >= 1050) CA.openApp('calendar');
    }
    CA.booted = true;
    finishBoot(false);
    // Re-check the clock alignment / CI countdown once a minute.
    setInterval(() => updateStatusbar(), 30000);
    if (location.hash === '#test') window.__CA_READY__ = true;
  }

  CA.openApp = openApp;
  CA.closeApp = closeApp;
  CA.refreshSnapshot = refreshSnapshot;

  window.CA_UI = {
    openApp,
    closeApp,
    focusWindow,
    refreshSnapshot,
    setFooter,
    closeMenus,
    setTicker,
    toggleWidget,
    exportChat,
    getWindow: (key) => CA.windows.get(key),
    updateStatusbar,
  };

  window.addEventListener('DOMContentLoaded', boot);
})();
