#!/usr/bin/env node
'use strict';
/*
 * Showcase: pair two real app instances, seed chat/calendar/CI data, and
 * capture every window (chat, calendar, CI, settings, widget, server).
 * Screenshots land in docs/screenshots.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createRelay } = require('../server/ca-server');

const ROOT = path.dirname(__dirname);
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const TMP = path.join(ROOT, 'test/.tmp/showcase');
const OUT = path.join(ROOT, 'docs/screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

async function targets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  return res.json();
}
async function connect(port, match, timeout = 20000) {
  const started = Date.now();
  let page = null;
  while (Date.now() - started < timeout) {
    try {
      const list = await targets(port);
      page = list.find((t) => t.type === 'page' && t.url.includes(match));
      if (page) break;
    } catch (_) {}
    await sleep(300);
  }
  if (!page) throw new Error('no target ' + match + ' on ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { id++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  const waitFor = async (expr, label, timeoutMs = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { if (await evaluate(expr)) return true; } catch (_) {}
      await sleep(250);
    }
    throw new Error('timeout: ' + label);
  };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };
  return { evaluate, waitFor, shot, close: () => ws.close(), send };
}

function launch(name, port) {
  const dir = path.join(TMP, name);
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(TMP, name + '.log'), 'w');
  const env = { ...process.env, CA_USER_DATA: dir, CA_DEBUG: '1', CA_ACTIVE_APP: 'chat' };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(ELECTRON, ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=' + port, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ROOT], { env, stdio: ['ignore', log, log] });
}
function kill(child) { try { child.kill('SIGKILL'); } catch (_) {} }

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
function demoIcs() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86400000);
  const weekend = new Date(today.getTime() + 3 * 86400000);
  const dt = (d, h, m) => ymd(d) + 'T' + pad(h) + pad(m) + '00';
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Connect All//Demo//EN',
    'X-WR-CALNAME:我们',
    'BEGIN:VEVENT',
    'UID:demo-1',
    'DTSTART:' + dt(today, 19, 30),
    'DTEND:' + dt(today, 21, 30),
    'SUMMARY:一起看《花样年华》',
    'LOCATION:电影院 6 号厅',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:demo-2',
    'DTSTART:' + dt(today, 14, 0),
    'DTEND:' + dt(today, 15, 0),
    'SUMMARY:组会（不要迟到）',
    'LOCATION:教学楼 201',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:demo-3',
    'DTSTART;VALUE=DATE:' + ymd(tomorrow),
    'DTEND;VALUE=DATE:' + ymd(new Date(tomorrow.getTime() + 86400000)),
    'SUMMARY:周末见面（全天）',
    'LOCATION:车站',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:demo-4',
    'DTSTART:' + dt(weekend, 10, 0),
    'DTEND:' + dt(weekend, 11, 0),
    'RRULE:FREQ=WEEKLY;COUNT=4',
    'SUMMARY:周末视频会议',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  const relay = createRelay({ port: 0, host: '127.0.0.1', dataDir: path.join(TMP, 'relay'), quiet: true });
  const addr = await relay.listen();
  const base = 'http://127.0.0.1:' + addr.port;
  const A = launch('a', 9341);
  const B = launch('b', 9342);
  let ca, cb, cw, cs;
  try {
    ca = await connect(9341, 'index.html');
    cb = await connect(9342, 'index.html');
    for (const c of [ca, cb]) await c.evaluate(`window.ca.server.set(${JSON.stringify({ url: base, mode: 'relay' })})`);
    await ca.evaluate(`window.ca.pairing.start('LOVE42')`);
    await cb.evaluate(`window.ca.pairing.start('LOVE42')`);
    await ca.waitFor(`window.ca.pairing.status().then(s => s.state === 'verify')`, 'A verify');
    await cb.waitFor(`window.ca.pairing.status().then(s => s.state === 'verify')`, 'B verify');
    await ca.evaluate(`window.ca.pairing.confirm()`);
    await cb.evaluate(`window.ca.pairing.confirm()`);
    await ca.waitFor(`window.ca.snapshot().then(s => s.link.online)`, 'A online');
    await cb.waitFor(`window.ca.snapshot().then(s => s.link.online)`, 'B online');
    await ca.evaluate(`window.ca.settings.setDevice('阿岚')`);
    await cb.evaluate(`window.ca.settings.setDevice('阿舟')`);
    await sleep(1200);
    console.log('paired');

    const chat = [
      ['a', '今晚一起看电影？'],
      ['b', '好呀，八点。我买票。'],
      ['b', '你上次说周末过来，还算数吗？'],
      ['a', '当然算数，我周五前把车票订好。'],
      ['b', '记得帮我带那家奶茶。'],
      ['a', '我答应你，三分糖。'],
      ['b', '那你几点到？'],
    ];
    for (const [who, text] of chat) {
      const c = who === 'a' ? ca : cb;
      await c.evaluate(`window.ca.chat.send(${JSON.stringify(text)})`);
      await sleep(220);
    }
    await sleep(1200);
    console.log('chat seeded');

    const ics = demoIcs();
    await ca.evaluate(`window.ca.calendar.importText(${JSON.stringify(ics)}, '我们')`);
    await sleep(1500);
    await ca.evaluate(`window.ca.calendar.share(true)`);
    await cb.waitFor(`window.ca.snapshot().then(s => s.calendar.partner.count > 0)`, 'partner calendar', 12000);
    console.log('calendar shared');

    await ca.evaluate(`window.ca.ci.configure({ enabled: true, provider: 'deepseek', model: 'deepseek-chat', intervalMin: 60 })`);
    await ca.evaluate(`window.ca.ci.run()`);
    await ca.waitFor(`window.ca.snapshot().then(s => s.ci.summaries.length > 0)`, 'CI summary', 12000);
    console.log('CI seeded');

    // Chat
    await ca.evaluate(`CA.closeApp('calendar'); CA.openApp('chat')`);
    await sleep(600);
    await ca.evaluate(`window.ca.chat.markRead()`);
    await sleep(500);
    await ca.evaluate(`(() => { const el = document.querySelector('.chat-log'); if (el) el.scrollTop = el.scrollHeight; return true; })()`);
    await sleep(300);
    await ca.shot(path.join(OUT, 'chat.png'));

    // Calendar on B (partner view)
    await cb.evaluate(`CA.closeApp('chat'); CA.openApp('calendar')`);
    await sleep(1800);
    await cb.shot(path.join(OUT, 'calendar.png'));

    // CI on A
    await ca.evaluate(`CA.closeApp('chat'); CA.openApp('ci')`);
    await sleep(800);
    await ca.shot(path.join(OUT, 'intelligence.png'));

    // Settings pairing + CI
    await ca.evaluate(`CA.closeApp('ci'); CA.openApp('settings')`);
    await sleep(700);
    await ca.evaluate(`(() => { const b = Array.from(document.querySelectorAll('.settings-nav button')).find(x => x.textContent.includes('牵手')); b && b.click(); })()`);
    await sleep(600);
    await ca.shot(path.join(OUT, 'settings-pairing.png'));
    await ca.evaluate(`(() => { const b = Array.from(document.querySelectorAll('.settings-nav button')).find(x => x.textContent.includes('连接智能')); b && b.click(); })()`);
    await sleep(500);
    await ca.shot(path.join(OUT, 'settings-intelligence.png'));
    await ca.evaluate(`CA.closeApp('settings')`);

    // Widget
    await ca.evaluate(`window.ca.widget.show()`);
    await sleep(1400);
    try {
      cw = await connect(9341, 'widget.html');
      await sleep(600);
      await cw.shot(path.join(OUT, 'widget.png'));
      console.log('widget captured');
    } catch (err) {
      console.warn('widget capture failed', err.message);
    }

    // Server window
    await ca.evaluate(`window.ca.window.openServer()`);
    await sleep(1600);
    try {
      cs = await connect(9341, 'server.html');
      await sleep(600);
      await cs.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('测试连接')); if (b) b.click(); return true; })()`);
      await sleep(1500);
      await cs.shot(path.join(OUT, 'server.png'));
      console.log('server window captured');
    } catch (err) {
      console.warn('server capture failed', err.message);
    }

    console.log('showcase done ->', OUT);
  } catch (err) {
    console.error('SHOWCASE FAIL:', err.message);
    for (const name of ['a', 'b']) {
      try { console.error('\n--- ' + name + ' ---\n' + fs.readFileSync(path.join(TMP, name + '.log'), 'utf8').split('\n').filter((l) => l.includes('[renderer]')).slice(-20).join('\n')); } catch (_) {}
    }
    process.exitCode = 1;
  } finally {
    for (const c of [ca, cb, cw, cs]) { try { c && c.close(); } catch (_) {} }
    kill(A); kill(B);
    await relay.close();
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
