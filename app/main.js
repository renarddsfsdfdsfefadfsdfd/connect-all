'use strict';
/*
 * Connect All — Electron main process.
 *
 * Windows: main desktop, floating calendar widget, private-server assistant.
 * The app is a background presence app: closing the main window hides it and
 * keeps the link alive; quit from the tray or menu.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  Notification,
  shell,
  clipboard,
  dialog,
  powerMonitor,
  safeStorage,
  session: electronSession,
  desktopCapturer,
  screen,
  systemPreferences,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Session } = require('./core/session');
const { readJsonSafe, writeJsonAtomic, ensureDir } = require('./core/store');

if (process.env.CA_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.CA_USER_DATA));
}
app.setName('Connect All');
app.setAppUserModelId('com.yaolin.connectall');

const isDev = process.argv.includes('--dev') || !app.isPackaged;
const BUILD = path.join(__dirname, '..', 'build');

let mainWindow = null;
let widgetWindow = null;
let mediaAccessInFlight = null;
let serverWindow = null;
let tray = null;
let session = null;
let quitting = false;
let displaySourceId = '';
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const trustedIds = new Set();
const send = (win, channel, payload) => {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send(channel, payload);
    } catch (_) {}
  }
};
const broadcast = (channel, payload) => {
  for (const win of BrowserWindow.getAllWindows()) send(win, channel, payload);
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* Encryptor                                                           */
/* ------------------------------------------------------------------ */

function makeEncryptor() {
  return {
    available() {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch (_) {
        return false;
      }
    },
    encrypt(value) {
      return safeStorage.encryptString(String(value)).toString('base64');
    },
    decrypt(value) {
      return safeStorage.decryptString(Buffer.from(String(value), 'base64'));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

function createSession() {
  const s = new Session({
    userDataDir: app.getPath('userData'),
    deviceName: (() => { try { return os.userInfo().username || os.hostname(); } catch (_) { return os.hostname(); } })(),
    encryptor: makeEncryptor(),
    platform: process.platform,
    appVersion: app.getVersion(),
    getIdleSeconds: () => {
      try {
        return powerMonitor.getSystemIdleTime();
      } catch (_) {
        return 0;
      }
    },
  });
  s.init();
  s.on('event', (event) => {
    broadcast('ca:event', event);
    if (event.type === 'notify') handleNotification(event.payload);
    if (event.type === 'chat-message' || event.type === 'chat-update' || event.type === 'chat-read') updateTrayTooltip();
    if (event.type === 'signal' && event.payload && event.payload.type === 'call-request') {
      showMain();
      openApp('video');
      // If the video renderer was not open, the live signal is lost. Replay it
      // as a distinct event that only an idle video module will accept.
      for (const delay of [900, 2500]) {
        setTimeout(() => broadcast('ca:event', { type: 'signal-replay', payload: event.payload }), delay);
      }
    }
    if (event.type === 'calendar' || event.type === 'presence' || event.type === 'link' || event.type === 'lang') {
      pushWidgetState();
    }
    if (event.type === 'server' || event.type === 'backup' || event.type === 'backup-done') {
      send(serverWindow, 'ca:event', event);
    }
  });
  return s;
}

function quietNow() {
  const q = (session && session.store.get().notify.quietHours) || {};
  if (!q.enabled) return false;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const parse = (s, fallback) => {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
  };
  const from = parse(q.from, 23 * 60 + 30);
  const to = parse(q.to, 7 * 60);
  if (from <= to) return minutes >= from && minutes < to;
  return minutes >= from || minutes < to;
}

function handleNotification(payload) {
  if (!payload || !session) return;
  const lang = session.lang;
  const zh = lang !== 'en';
  const notifyCfg = session.store.get().notify;
  if (quietNow()) return;
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) return;
  let title = 'Connect All';
  let body = '';
  if (payload.kind === 'chat') {
    if (notifyCfg.messages === false) return;
    title = payload.name || (zh ? '对方' : 'Partner');
    body = payload.text || '';
  } else if (payload.kind === 'ci') {
    if (notifyCfg.ci === false) return;
    title = zh ? '连接智能 · 本小时汇总' : 'Connect Intelligence · hourly recap';
    body = payload.headline || '';
  } else if (payload.kind === 'presence') {
    if (notifyCfg.presence === false) return;
    title = payload.name || (zh ? '对方' : 'Partner');
    body = payload.bootAt
      ? zh
        ? '刚刚开机 / 上线了'
        : 'just came online'
      : zh
        ? '上线了'
        : 'is online';
    if (payload.place) body += ' · ' + payload.place;
  } else if (payload.kind === 'paired') {
    title = zh ? '牵手成功' : 'Paired';
    body = payload.name ? (zh ? '与 ' + payload.name + ' 建立了加密连接' : 'Encrypted link with ' + payload.name) : '';
  }
  if (!body) return;
  try {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => {
      showMain();
      send(mainWindow, 'ca:event', { type: 'navigate', payload: { app: payload.kind === 'ci' ? 'ci' : 'chat' } });
    });
    n.show();
  } catch (_) {}
}

/* ------------------------------------------------------------------ */
/* Window state                                                        */
/* ------------------------------------------------------------------ */

function loadWindowState() {
  const raw = readJsonSafe(windowStateFile(), null);
  return raw && typeof raw === 'object' ? raw : {};
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const state = loadWindowState();
    state.main = mainWindow.isMaximized() ? { maximized: true } : mainWindow.getNormalBounds();
    writeJsonAtomic(windowStateFile(), state);
  } catch (_) {}
}

function validBounds(bounds, minWidth, minHeight) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null;
  const display = screen.getDisplayMatching({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width || minWidth,
    height: bounds.height || minHeight,
  });
  if (!display) return null;
  const area = display.workArea;
  const visible =
    bounds.x + 80 > area.x &&
    bounds.x < area.x + area.width - 80 &&
    bounds.y + 40 > area.y &&
    bounds.y < area.y + area.height - 40;
  if (!visible) return null;
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(minWidth, Math.round(bounds.width || minWidth)),
    height: Math.max(minHeight, Math.round(bounds.height || minHeight)),
  };
}

/* ------------------------------------------------------------------ */
/* Main window                                                         */
/* ------------------------------------------------------------------ */

function createMainWindow() {
  const saved = loadWindowState().main || {};
  const envSize = String(process.env.CA_WINDOW_SIZE || '').match(/^(\d+)x(\d+)$/);
  const width = envSize ? Number(envSize[1]) : saved.width || 1180;
  const height = envSize ? Number(envSize[2]) : saved.height || 760;
  const bounds = !envSize && !saved.maximized ? validBounds({ ...saved, width, height }, 980, 660) : null;
  mainWindow = new BrowserWindow({
    width,
    height,
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    minWidth: 980,
    minHeight: 660,
    backgroundColor: '#c9c6c0',
    title: 'Connect All',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 12 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  trustedIds.add(mainWindow.webContents.id);
  const query = {};
  if (process.env.CA_ACTIVE_APP) query.app = process.env.CA_ACTIVE_APP;
  if (process.env.CA_LANG) query.lang = process.env.CA_LANG;
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  mainWindow.once('ready-to-show', () => {
    if (saved.maximized) mainWindow.maximize();
    mainWindow.show();
    if (process.env.CA_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
    if (process.env.CA_SNAPSHOT) captureSnapshot();
  });
  mainWindow.on('move', debounce(saveWindowState, 500));
  mainWindow.on('resize', debounce(saveWindowState, 500));
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    saveWindowState();
    mainWindow.hide();
  });
  mainWindow.on('focus', () => {
    send(mainWindow, 'ca:event', { type: 'window-focus', payload: { focused: true } });
    updateTrayTooltip();
  });
  mainWindow.on('blur', () => {
    send(mainWindow, 'ca:event', { type: 'window-focus', payload: { focused: false } });
  });
  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (isDev || process.env.CA_DEBUG) console.log('[renderer]', message);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => console.error('renderer gone', details));
  mainWindow.webContents.on('preload-error', (event, p, err) => console.error('preload error', p, err));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow.webContents.getURL()) e.preventDefault();
  });
  return mainWindow;
}

async function captureSnapshot() {
  try {
    await sleep(Number(process.env.CA_SNAPSHOT_DELAY || 1500));
    const win = mainWindow;
    if (process.env.CA_SNAPSHOT_APP) {
      send(win, 'ca:event', { type: 'navigate', payload: { app: process.env.CA_SNAPSHOT_APP } });
      await sleep(600);
    }
    const img = await win.webContents.capturePage();
    const target = path.resolve(process.env.CA_SNAPSHOT);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, img.toPNG());
    console.log('snapshot written', target);
    if (String(process.env.CA_SNAPSHOT_KEEP) === '1') return;
  } catch (err) {
    console.error('snapshot failed', err);
  }
  setTimeout(() => app.quit(), 200);
}

function showMain() {
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ------------------------------------------------------------------ */
/* Widget window                                                       */
/* ------------------------------------------------------------------ */

function defaultWidgetPosition(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - width - 24, y: area.y + 24 };
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) return widgetWindow;
  const w = session.store.get().calendar.widget;
  const width = Math.max(280, w.width || 320);
  const height = Math.max(190, w.height || 226);
  const fallback = defaultWidgetPosition(width, height);
  const pos = validBounds({ x: w.x, y: w.y, width, height }, 260, 170) || { ...fallback, width, height };
  widgetWindow = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: w.pinned !== false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-widget.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  trustedIds.add(widgetWindow.webContents.id);
  widgetWindow.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  widgetWindow.once('ready-to-show', () => {
    if (session.store.get().calendar.widget.visible !== false) widgetWindow.showInactive();
    if (process.platform === 'darwin') {
      try {
        widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch (_) {}
    }
    if (w.pinned !== false) widgetWindow.setAlwaysOnTop(true, 'floating');
  });
  widgetWindow.on('moved', debounce(() => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const b = widgetWindow.getBounds();
    session.setWidgetConfig({ x: b.x, y: b.y, width: b.width, height: b.height });
  }, 400));
  widgetWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideWidget();
  });
  widgetWindow.webContents.on('console-message', (event, level, message) => {
    if (isDev || process.env.CA_DEBUG) console.log('[widget]', message);
  });
  widgetWindow.webContents.on('preload-error', (event, p, err) => console.error('widget preload error', p, err));
  widgetWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  widgetWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== widgetWindow.webContents.getURL()) e.preventDefault();
  });
  return widgetWindow;
}

function showWidget() {
  const win = createWidgetWindow();
  session.setWidgetConfig({ visible: true });
  win.showInactive();
  pushWidgetState();
}

function hideWidget() {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
  session.setWidgetConfig({ visible: false });
}

function toggleWidget() {
  if (widgetWindow && widgetWindow.isVisible()) hideWidget();
  else showWidget();
}

function widgetState() {
  if (!session) return {};
  const w = session.store.get().calendar.widget;
  return {
    lang: session.lang,
    presence: session.presence.snapshot(),
    link: session.linkState(),
    paired: session.identity.isPaired,
    peer: session.identity.peer
      ? { name: session.identity.peer.name, platform: session.identity.peer.platform }
      : null,
    calendar: session.calendar.upcoming(3),
    widget: { ...w, alwaysOnTop: Boolean(widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isAlwaysOnTop()) },
    now: Date.now(),
  };
}

function pushWidgetState() {
  if (!widgetWindow || widgetWindow.isDestroyed() || !session) return;
  send(widgetWindow, 'ca:widget', widgetState());
}

/* ------------------------------------------------------------------ */
/* Server window                                                       */
/* ------------------------------------------------------------------ */

function createServerWindow() {
  if (serverWindow && !serverWindow.isDestroyed()) {
    serverWindow.show();
    serverWindow.focus();
    return serverWindow;
  }
  serverWindow = new BrowserWindow({
    width: 900,
    height: 780,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#c9c6c0',
    title: 'Connect All — Private Server',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 12 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-server.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  trustedIds.add(serverWindow.webContents.id);
  serverWindow.loadFile(path.join(__dirname, 'renderer', 'server.html'));
  serverWindow.once('ready-to-show', () => serverWindow.show());
  serverWindow.on('closed', () => {
    serverWindow = null;
  });
  serverWindow.webContents.on('console-message', (event, level, message) => {
    if (isDev || process.env.CA_DEBUG) console.log('[server]', message);
  });
  serverWindow.webContents.on('preload-error', (event, p, err) => console.error('server preload error', p, err));
  serverWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  serverWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== serverWindow.webContents.getURL()) e.preventDefault();
  });
  return serverWindow;
}

/* ------------------------------------------------------------------ */
/* Tray                                                                */
/* ------------------------------------------------------------------ */

function makeTrayIcon() {
  const p = path.join(BUILD, process.platform === 'darwin' ? 'trayTemplate.png' : 'icon-32.png');
  const img = nativeImage.createFromPath(p);
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function updateTrayTooltip() {
  if (!tray || !session) return;
  const unread = session.chat.unreadCount();
  const peer = session.identity.peer ? session.identity.peer.name : '';
  const online = session.linkState().online;
  tray.setToolTip(
    'Connect All' +
      (peer ? ' · ' + peer : '') +
      ' · ' +
      (online ? (session.linkState().via === 'lan' ? 'LAN' : 'Online') : 'Offline') +
      (unread ? ' · ' + unread + ' unread' : '')
  );
}

function buildTrayMenu() {
  const zh = session.lang !== 'en';
  const link = session.linkState();
  const paired = session.identity.isPaired;
  const peer = session.identity.peer ? session.identity.peer.name : '';
  return Menu.buildFromTemplate([
    { label: zh ? '打开 Connect All' : 'Open Connect All', click: showMain },
    { type: 'separator' },
    {
      label: zh ? '牵手状态：' + (paired ? peer || '已连接' : '未牵手') : 'Pairing: ' + (paired ? peer : 'not paired'),
      enabled: false,
    },
    {
      label: zh ? '连接：' + (link.online ? (link.via === 'lan' ? '局域网直连' : '私有服务器') : '离线') : 'Link: ' + (link.online ? link.via : 'offline'),
      enabled: false,
    },
    { type: 'separator' },
    { label: zh ? '聊天' : 'Chat', click: () => openApp('chat') },
    { label: zh ? '视频' : 'Video', click: () => openApp('video') },
    { label: zh ? '日历' : 'Calendar', click: () => openApp('calendar') },
    { label: zh ? '连接智能' : 'Intelligence', click: () => openApp('ci') },
    { label: zh ? '私有服务器…' : 'Private Server…', click: () => createServerWindow() },
    { type: 'separator' },
    {
      label: zh ? '显示桌面日历插件' : 'Show calendar widget',
      type: 'checkbox',
      checked: Boolean(widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()),
      click: toggleWidget,
    },
    {
      label: zh ? '开机自启' : 'Launch at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }),
    },
    { type: 'separator' },
    { label: zh ? '退出' : 'Quit', click: () => app.quit() },
  ]);
}

function createTray() {
  try {
    tray = new Tray(makeTrayIcon());
    tray.setToolTip('Connect All');
    tray.on('click', () => showMain());
    tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
    updateTrayTooltip();
  } catch (err) {
    console.error('tray failed', err);
  }
}

function openApp(name) {
  showMain();
  send(mainWindow, 'ca:event', { type: 'navigate', payload: { app: name } });
}

/* ------------------------------------------------------------------ */
/* Application menu                                                    */
/* ------------------------------------------------------------------ */

function rebuildAppMenu() {
  const zh = session && session.lang !== 'en';
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: zh ? '设置…' : 'Settings…', accelerator: 'Cmd+,', click: () => openApp('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }
  template.push(
    {
      label: zh ? '连接' : 'Connect',
      submenu: [
        { label: zh ? '聊天' : 'Chat', accelerator: 'CmdOrCtrl+1', click: () => openApp('chat') },
        { label: zh ? '视频' : 'Video', accelerator: 'CmdOrCtrl+2', click: () => openApp('video') },
        { label: zh ? '日历' : 'Calendar', accelerator: 'CmdOrCtrl+3', click: () => openApp('calendar') },
        { label: zh ? '连接智能' : 'Intelligence', accelerator: 'CmdOrCtrl+4', click: () => openApp('ci') },
        { type: 'separator' },
        { label: zh ? '私有服务器…' : 'Private Server…', accelerator: 'CmdOrCtrl+5', click: () => createServerWindow() },
        { label: zh ? '设置…' : 'Settings…', click: () => openApp('settings') },
        { type: 'separator' },
        { label: zh ? '显示日历插件' : 'Toggle Widget', click: toggleWidget },
      ],
    },
    { role: 'editMenu' },
    {
      label: zh ? '显示' : 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools', visible: isDev },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: zh ? '打开数据目录' : 'Open data folder',
          click: () => shell.openPath(app.getPath('userData')),
        },
        {
          label: zh ? '关于 Connect All' : 'About Connect All',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'Connect All',
              message: 'Connect All (CA) ' + app.getVersion(),
              detail:
                (zh ? '为异地恋做的私有桌面中枢。\n' : 'A private desktop hub for long-distance couples.\n') +
                (zh
                  ? '聊天、视频、共享日历、本地连接智能。\n所有记忆保存在本机；服务器只接触密文。'
                  : 'Chat, video, shared calendar, local Connect Intelligence.\nMemories stay on this device; the relay only sees ciphertext.'),
              buttons: ['OK'],
            });
          },
        },
      ],
    }
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* Permissions + screen share                                          */
/* ------------------------------------------------------------------ */

function setupPermissions() {
  const ses = electronSession.defaultSession;
  const allowed = (wc) => wc && trustedIds.has(wc.id);
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const ok = allowed(wc) && ['media', 'display-capture', 'notifications', 'fullscreen', 'mediaKeySystem'].includes(permission);
    callback(Boolean(ok));
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    return allowed(wc) && ['media', 'display-capture', 'notifications', 'fullscreen'].includes(permission);
  });
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        let source = sources.find((s) => s.id === displaySourceId);
        if (!source) source = sources.find((s) => s.id.startsWith('screen:')) || sources[0];
        if (!source) {
          callback({});
          return;
        }
        try {
          callback({ video: source, audio: process.platform === 'linux' ? undefined : 'loopback' });
        } catch (_) {
          callback({ video: source });
        }
      } catch (err) {
        console.error('display media handler failed', err);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function isTrustedEvent(event) {
  try {
    return trustedIds.has(event.sender.id);
  } catch (_) {
    return false;
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!isTrustedEvent(event)) throw new Error('untrusted sender');
    try {
      return await fn(payload, event);
    } catch (err) {
      throw new Error(err && err.message ? err.message : String(err));
    }
  });
}

function registerIpc() {
  const s = () => session;

  handle('ca:snapshot', () => s().snapshot());
  handle('ca:set-lang', ({ lang }) => {
    const res = s().setLang(lang);
    rebuildAppMenu();
    if (tray) tray.setContextMenu(buildTrayMenu());
    return res;
  });
  handle('ca:quit', () => app.quit());
  handle('ca:about', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Connect All',
      message: 'Connect All ' + app.getVersion(),
      detail:
        'Connect All (CA)\n' +
        'Chat · Video · Calendar · Connect Intelligence\n\n' +
        'Everything is stored locally. The private relay only stores ciphertext.\n\n' +
        '© 2026 Yaolin ZHANG\n' +
        'HKUST(GZ) · Function Hub · Sustainable Energy and Environment',
      buttons: ['OK'],
    });
  });
  handle('ca:open-external', ({ url }) => {
    const raw = String(url || '');
    if (!/^https?:\/\//i.test(raw)) throw new Error('only http(s) links');
    return shell.openExternal(raw);
  });
  handle('ca:copy', ({ text }) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
  handle('ca:open-path', ({ target }) => {
    const base = app.getPath('userData');
    const resolved = path.resolve(String(target || base));
    if (!resolved.startsWith(base) && resolved !== base) {
      if (resolved !== path.join(__dirname, '..', 'README.md')) throw new Error('outside data directory');
    }
    if (fs.existsSync(resolved)) return shell.openPath(resolved);
    return shell.openPath(base);
  });

  handle('ca:chat-send', ({ text }) => s().sendChat(text));
  handle('ca:chat-list', (opts) => s().listChat(opts || {}));
  handle('ca:chat-read', () => s().markRead());
  handle('ca:chat-typing', ({ typing }) => s().setTyping(typing));
  handle('ca:chat-search', ({ query }) => s().searchChat(query));
  handle('ca:chat-clear', () => s().clearChat());
  handle('ca:chat-export', async () => {
    const data = s().exportChat();
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export chat',
      defaultPath: path.join(app.getPath('documents'), 'connect-all-chat.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
    return { ok: true, path: res.filePath };
  });

  handle('ca:presence-set', (patch) => s().setPresence(patch || {}));
  handle('ca:presence-tick', () => {
    try {
      s().setActivity({ idleSeconds: powerMonitor.getSystemIdleTime() });
    } catch (_) {}
    return s().presence.snapshot();
  });

  handle('ca:pairing-status', () => s().pairingStatus());
  handle('ca:pairing-start', ({ code }) => s().pairingStartServer(code));
  handle('ca:pairing-create-invite', () => s().pairingCreateInvite());
  handle('ca:pairing-accept-invite', ({ text }) => s().pairingAcceptInvite(text));
  handle('ca:pairing-accept-reply', ({ text }) => s().pairingAcceptReply(text));
  handle('ca:pairing-confirm', () => s().pairingConfirm());
  handle('ca:pairing-cancel', () => s().pairingCancel());
  handle('ca:pairing-unpair', () => s().unpair());

  handle('ca:server-info', () => s().serverInfo());
  handle('ca:server-set', (payload) => s().setServer(payload || {}));
  handle('ca:server-test', ({ url, insecure }) => s().testServer(url, insecure));
  handle('ca:server-local-start', ({ port }) => s().startLocalRelay({ port }));
  handle('ca:server-local-stop', () => s().stopLocalRelay());
  handle('ca:backup-now', () => s().backupNow());
  handle('ca:backup-status', () => s().backupStatus());
  handle('ca:backup-list', () => s().backupList());
  handle('ca:backup-restore', () => s().backupRestore());

  handle('ca:calendar-import-file', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import calendar',
      properties: ['openFile'],
      filters: [{ name: 'iCalendar', extensions: ['ics', 'ical', 'ifb'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const source = s().calendarImportFile(res.filePaths[0]);
    return { ok: true, source };
  });
  handle('ca:calendar-import-url', ({ url, name }) => s().calendarImportUrl(url, name));
  handle('ca:calendar-import-text', ({ text, name }) => ({
    ok: true,
    source: s().calendarImportText(text, name),
  }));
  handle('ca:calendar-remove', ({ id }) => s().calendarRemove(id));
  handle('ca:calendar-toggle', ({ id, enabled }) => s().calendarToggle(id, enabled));
  handle('ca:calendar-refresh', ({ id }) => s().calendarRefresh(id));
  handle('ca:calendar-events', ({ from, to }) => s().calendarEvents(from, to));
  handle('ca:calendar-share', ({ enabled }) => s().calendarShare(enabled));
  handle('ca:calendar-hide-private', ({ hide }) => s().calendarSetHidePrivate(hide));
  handle('ca:calendar-request-share', () => ({ ok: s().requestCalendarShare() }));
  handle('ca:calendar-widget-set', (patch) => s().setWidgetConfig(patch || {}));

  handle('ca:widget-show', () => {
    showWidget();
    return { visible: true };
  });
  handle('ca:widget-hide', () => {
    hideWidget();
    return { visible: false };
  });
  handle('ca:widget-toggle', () => {
    toggleWidget();
    return { visible: Boolean(widgetWindow && widgetWindow.isVisible()) };
  });

  handle('ca:ci-config', () => s().ciConfig());
  handle('ca:ci-configure', (patch) => s().ciConfigure(patch || {}));
  handle('ca:ci-status', () => s().ciStatus());
  handle('ca:ci-run', () => s().ciRun());
  handle('ca:ci-list', (opts) => s().ciList(opts || {}));
  handle('ca:ci-delete', ({ id }) => s().ciDelete(id));
  handle('ca:ci-clear', () => s().ciClear());
  handle('ca:ci-export', () => s().ciExport());
  handle('ca:ci-test', (patch) => s().ciTest(patch || {}));

  handle('ca:set-device', ({ name }) => s().setDeviceName(name));
  handle('ca:set-video', (patch) => s().setVideoConfig(patch || {}));
  handle('ca:set-notify', (patch) => s().setNotifyConfig(patch || {}));
  handle('ca:set-privacy', (patch) => s().setPrivacyConfig(patch || {}));
  handle('ca:set-transport', (patch) => s().setTransportConfig(patch || {}));
  handle('ca:set-activity', (patch) => s().setActivity(patch || {}));
  handle('ca:data-stats', () => s().dataStats());

  handle('ca:video-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 260, height: 150 },
      fetchWindowIcons: false,
    });
    return sources.map((src) => ({
      id: src.id,
      name: src.name,
      thumbnail: src.thumbnail && !src.thumbnail.isEmpty() ? src.thumbnail.toDataURL() : '',
      screen: src.id.startsWith('screen:'),
    }));
  });
  handle('ca:video-set-source', ({ id }) => {
    displaySourceId = String(id || '');
    return { ok: true };
  });
  handle('ca:video-ice', () => {
    const cfg = s().store.get().transport;
    const iceServers = [];
    if (Array.isArray(cfg.iceServers)) {
      for (const item of cfg.iceServers) if (item && item.urls) iceServers.push({ urls: item.urls });
    }
    if (cfg.turn && cfg.turn.url) {
      iceServers.push({ urls: cfg.turn.url, username: cfg.turn.username || '', credential: cfg.turn.password || '' });
    }
    return { iceServers };
  });
  handle('ca:video-pick-file', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Open audio',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    return { ok: true, path: res.filePaths[0], name: path.basename(res.filePaths[0]) };
  });
  handle('ca:media-access', async () => {
    if (process.platform !== 'darwin') return { camera: 'granted', microphone: 'granted' };
    if (mediaAccessInFlight) return mediaAccessInFlight;
    mediaAccessInFlight = (async () => {
      const ask = async (kind) => {
        let current = 'unknown';
        try {
          current = (await systemPreferences.getMediaAccessStatus(kind)) || 'unknown';
        } catch (_) {}
        // Ask at most once, and only while macOS still says "not determined".
        // Calling askForMediaAccess on a denied/restricted app is what caused
        // the permission dialog to reappear on every call.
        if (current !== 'not-determined') return current;
        try {
          return (await systemPreferences.askForMediaAccess(kind)) ? 'granted' : 'denied';
        } catch (_) {
          return current;
        }
      };
      return { camera: await ask('camera'), microphone: await ask('microphone') };
    })().finally(() => {
      mediaAccessInFlight = null;
    });
    return mediaAccessInFlight;
  });

  handle('ca:open-media-settings', ({ kind } = {}) => {
    if (process.platform !== 'darwin') return { ok: false };
    const pane = kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_Camera';
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + pane);
    return { ok: true };
  });

  handle('ca:reload-window', (payload, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.reload();
    return true;
  });

  handle('ca:rtc-signal', (payload) => ({ ok: s().sendSignal(payload || {}) }));
  handle('ca:rtc-media', (payload) => ({ ok: s().sendMediaSync(payload || {}) }));

  handle('ca:widget-state', () => widgetState());
  handle('ca:widget-pin', ({ pinned }) => {
    session.setWidgetConfig({ pinned: Boolean(pinned) });
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.setAlwaysOnTop(Boolean(pinned), 'floating');
    }
    pushWidgetState();
    return { pinned: Boolean(pinned) };
  });
  handle('ca:widget-close', () => {
    hideWidget();
    return { visible: false };
  });
  handle('ca:widget-open-main', () => {
    showMain();
    openApp('calendar');
    return { ok: true };
  });

  handle('ca:window-server', () => {
    createServerWindow();
    return { ok: true };
  });
  handle('ca:window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });
  handle('ca:window-close', () => {
    if (mainWindow) mainWindow.hide();
  });
  handle('ca:window-show', () => {
    showMain();
    return { ok: true };
  });
  handle('ca:login-item-get', () => app.getLoginItemSettings());
  handle('ca:login-item-set', ({ enabled }) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
    return app.getLoginItemSettings();
  });
  handle('ca:server-window-close', () => {
    if (serverWindow) serverWindow.close();
  });
  handle('ca:server-window-snapshot', () => ({
    server: s().serverInfo(),
    lang: s().lang,
    link: s().linkState(),
    paired: s().identity.isPaired,
    peer: s().identity.peer ? { name: s().identity.peer.name, platform: s().identity.peer.platform } : null,
    device: { id: s().identity.id, name: s().identity.name, platform: s().identity.platform },
    paths: { data: s().paths.base },
    ui: s().store.get().ui,
  }));
}

/* ------------------------------------------------------------------ */
/* Tray updates                                                        */
/* ------------------------------------------------------------------ */

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
      try {
        app.dock.setIcon(nativeImage.createFromPath(path.join(BUILD, 'icon.png')));
      } catch (_) {}
    }
    setupPermissions();
    session = createSession();
    registerIpc();
    rebuildAppMenu();
    createTray();
    createMainWindow();
    if (session.store.get().calendar.widget.visible) {
      setTimeout(() => showWidget(), 900);
    }

    // Keep presence fresh: idle / lock / resume.
    setInterval(() => {
      if (session) session.tickIdle();
    }, 20000).unref?.();
    powerMonitor.on('resume', () => {
      if (!session) return;
      session.reconnectLink();
      session.tickIdle();
    });
    powerMonitor.on('lock-screen', () => {
      if (session) session.setActivity({ idleSeconds: 9999 });
    });
    powerMonitor.on('unlock-screen', () => {
      if (session) session.tickIdle();
    });
    powerMonitor.on('suspend', () => {
      if (session) session.store.saveNow();
    });

    app.on('activate', () => showMain());

    // Snapshot mode for automated UI checks.
    if (process.env.CA_SNAPSHOT_WIDGET) {
      setTimeout(async () => {
        showWidget();
        await sleep(1200);
        try {
          const img = await widgetWindow.webContents.capturePage();
          const target = path.resolve(process.env.CA_SNAPSHOT_WIDGET);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, img.toPNG());
          console.log('widget snapshot', target);
        } catch (err) {
          console.error(err);
        }
        if (String(process.env.CA_SNAPSHOT_KEEP) !== '1') app.quit();
      }, 2000);
    }
    if (process.env.CA_SNAPSHOT_SERVER) {
      setTimeout(async () => {
        createServerWindow();
        await sleep(1200);
        try {
          const img = await serverWindow.webContents.capturePage();
          const target = path.resolve(process.env.CA_SNAPSHOT_SERVER);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, img.toPNG());
          console.log('server snapshot', target);
        } catch (err) {
          console.error(err);
        }
        if (String(process.env.CA_SNAPSHOT_KEEP) !== '1') app.quit();
      }, 2000);
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    try {
      saveWindowState();
      if (session) session.destroy();
    } catch (_) {}
  });

  app.on('window-all-closed', () => {
    // Presence app: keep running in the tray.
    if (process.platform === 'darwin') return;
    if (!tray) app.quit();
  });
}
