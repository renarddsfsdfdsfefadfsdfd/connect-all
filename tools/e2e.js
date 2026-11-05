#!/usr/bin/env node
'use strict';
/*
 * Two-instance end-to-end test.
 *
 * Starts a relay, launches two Electron instances with fake media devices,
 * pairs them through the renderer IPC, sends a chat message, starts a WebRTC
 * call, and drives the 1:4 watch split + music mode. Screenshots are written
 * to test/.tmp/shots.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRelay } = require('../server/ca-server');

const ROOT = path.dirname(__dirname);
const ELECTRON = process.env.CA_BIN || path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const PACKAGED = Boolean(process.env.CA_BIN);
const OUT = path.join(ROOT, 'test', '.tmp', 'shots');
const TMP = path.join(ROOT, 'test', '.tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

async function cdpConnect(port, timeout = 20000) {
  const started = Date.now();
  let page = null;
  while (Date.now() - started < timeout) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await res.json();
      page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) break;
    } catch (_) {}
    await sleep(300);
  }
  if (!page) throw new Error('no CDP page on ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error((d.text || 'eval failed') + ' ' + ((d.exception && d.exception.description) || ''));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const screenshot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };
  const waitFor = async (expression, label, timeoutMs = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch (_) {}
      await sleep(250);
    }
    throw new Error('timeout: ' + label);
  };
  return { evaluate, screenshot, waitFor, close: () => ws.close(), send };
}

function launch(name, port) {
  const dir = path.join(TMP, name);
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(TMP, name + '.log'), 'w');
  const env = Object.assign({}, process.env, {
    CA_USER_DATA: dir,
    CA_DEBUG: '1',
    CA_WINDOW_SIZE: '1180x760',
    CA_ACTIVE_APP: 'chat',
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=' + port,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (!PACKAGED) args.push(ROOT);
  const child = spawn(ELECTRON, args, { env, stdio: ['ignore', log, log], detached: false });
  child.__log = log;
  child.__name = name;
  return child;
}

async function stop(child) {
  try {
    child.kill('SIGTERM');
  } catch (_) {}
  await sleep(600);
  try {
    child.kill('SIGKILL');
  } catch (_) {}
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  const relay = createRelay({ port: 0, host: '127.0.0.1', dataDir: path.join(TMP, 'relay-data'), quiet: true, historyLimit: 100 });
  const addr = await relay.listen();
  const base = 'http://127.0.0.1:' + addr.port;
  console.log('relay at', base);

  const A = launch('app-a', 9301);
  const B = launch('app-b', 9302);
  let ca;
  let cb;
  try {
    ca = await cdpConnect(9301);
    cb = await cdpConnect(9302);
    console.log('CDP connected');
    // Signed apps can take a little longer to boot; do not evaluate against a
    // half-loaded renderer.
    await ca.waitFor(`!!(window.CA && CA.snap)`, 'A renderer ready', 15000);
    await cb.waitFor(`!!(window.CA && CA.snap)`, 'B renderer ready', 15000);

    // 1. configure server + pair through the same UI IPC the app uses
    for (const c of [ca, cb]) {
      await c.evaluate(`window.ca.server.set(${JSON.stringify({ url: base, mode: 'relay' })})`);
    }
    const code = 'E2E42A';
    await ca.evaluate(`window.ca.pairing.start(${JSON.stringify(code)})`);
    await cb.evaluate(`window.ca.pairing.start(${JSON.stringify(code)})`);
    await ca.waitFor(`window.ca.pairing.status().then(s => s.state === 'verify')`, 'A verify');
    await cb.waitFor(`window.ca.pairing.status().then(s => s.state === 'verify')`, 'B verify');
    console.log('pairing verify, SAS =', await ca.evaluate(`window.ca.pairing.status().then(s => s.sas)`));
    await ca.evaluate(`window.ca.pairing.confirm()`);
    await cb.evaluate(`window.ca.pairing.confirm()`);
    await ca.waitFor(`window.ca.snapshot().then(s => !!s.app.pairing.paired)`, 'A paired');
    await cb.waitFor(`window.ca.snapshot().then(s => !!s.app.pairing.paired)`, 'B paired');
    await ca.waitFor(`window.ca.snapshot().then(s => s.link.online)`, 'A link online');
    await cb.waitFor(`window.ca.snapshot().then(s => s.link.online)`, 'B link online');
    console.log('paired, link online:', await ca.evaluate(`window.ca.snapshot().then(s => s.link.via)`));

    // 2. chat round-trip
    await ca.evaluate(`window.ca.chat.send('E2E 你好，今晚看电影？')`);
    await cb.waitFor(`window.ca.chat.list({limit:5}).then(r => r.messages.some(m => m.text.includes('今晚看电影')))`, 'B receives chat');
    await cb.evaluate(`window.ca.chat.send('好呀，八点')`);
    await ca.waitFor(`window.ca.chat.list({limit:5}).then(r => r.messages.some(m => m.text.includes('八点')))`, 'A receives chat');
    console.log('chat round-trip OK');
    await ca.evaluate(`window.CA.openApp('chat')`);
    await cb.evaluate(`window.CA.openApp('chat')`);
    await sleep(600);
    await ca.screenshot(path.join(OUT, 'e2e-chat-a.png'));
    await cb.screenshot(path.join(OUT, 'e2e-chat-b.png'));

    // 3. open video windows and start a call
    await ca.evaluate(`CA.openApp('video')`);
    await cb.evaluate(`CA.openApp('video')`);
    await ca.waitFor(`!!document.querySelector('.video-idle .btn')`, 'A video idle');
    await cb.waitFor(`!!document.querySelector('.video-idle .btn')`, 'B video idle');
    await ca.evaluate(`document.querySelector('.video-idle .btn').click()`);
    await cb.waitFor(`!document.querySelector('.incoming-call').classList.contains('hidden')`, 'B incoming call', 15000);
    await cb.screenshot(path.join(OUT, 'e2e-incoming-b.png'));
    await cb.evaluate(`document.querySelector('.incoming-call .btn.primary').click()`);

    await ca.waitFor(`window.ca.snapshot().then(s => !!s.link.online)`, 'link still online', 5000);
    await ca.waitFor(
      `(() => { const v = document.querySelector('#remote-call'); return !!v && !!v.srcObject && v.videoWidth > 0; })()`,
      'A remote video frames',
      30000
    );
    await cb.waitFor(
      `(() => { const v = document.querySelector('#remote-call'); return !!v && !!v.srcObject && v.videoWidth > 0; })()`,
      'B remote video frames',
      30000
    );
    await ca.waitFor(`document.querySelector('.video-idle').classList.contains('hidden')`, 'A call active');
    console.log('WebRTC call active with video frames');
    await ca.screenshot(path.join(OUT, 'e2e-call-a.png'));
    await cb.screenshot(path.join(OUT, 'e2e-call-b.png'));

    // 4. 1:4 watch split (no screen yet) and music pane
    await ca.evaluate(`document.querySelectorAll('.video-head .seg-btn')[1].click()`);
    await ca.waitFor(`document.querySelector('.video-stage').classList.contains('mode-split')`, 'A watch split');
    await cb.waitFor(`document.querySelector('.video-stage').classList.contains('mode-split')`, 'B watch split (synced)');
    console.log('1:4 split synced through data channel');
    await sleep(2500);
    const diagWatch = await ca.evaluate(`(() => {
      const V = window.CA_VIDEO_STATE;
      const btns = Array.from(document.querySelectorAll('.video-head .seg-btn')).map(b => ({ t: b.textContent, cls: b.className, dis: b.disabled, bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color }));
      const ph = document.querySelector('.video-main .video-pane-placeholder');
      const main = document.querySelector('.video-main');
      return JSON.stringify({
        startedAt: V.startedAt, stats: V.stats, hasDur: !!V.durationTimer, hasStats: !!V.statsTimer,
        footer: document.querySelector('.window-footer') && document.querySelector('.window-footer').textContent,
        btns, stage: document.querySelector('.video-stage').className,
        main: main && { w: main.offsetWidth, h: main.offsetHeight },
        ph: ph && { cls: ph.className, display: getComputedStyle(ph).display, rect: ph.getBoundingClientRect().toJSON(), kids: ph.children.length },
        screen: (() => { const s = document.querySelector('#screen-video'); return s && { cls: s.className, has: !!s.srcObject }; })(),
        music: (() => { const m = document.querySelector('.music-pane'); return m && { cls: m.className, display: getComputedStyle(m).display }; })()
      });
    })()`);
    console.log('WATCH DIAG', diagWatch);
    await ca.screenshot(path.join(OUT, 'e2e-watch-a.png'));

    await ca.evaluate(`document.querySelectorAll('.video-head .seg-btn')[2].click()`);
    await ca.waitFor(`!!document.querySelector('.music-pane') && !document.querySelector('.music-pane').classList.contains('hidden')`, 'A music pane');
    await cb.waitFor(`document.querySelector('.video-stage').classList.contains('mode-split')`, 'B music layout');
    console.log('music mode layout OK');
    await ca.screenshot(path.join(OUT, 'e2e-music-a.png'));

    // 5. hang up
    await ca.evaluate(`document.querySelector('.video-controls .btn.primary').click()`);
    await ca.waitFor(`document.querySelector('.video-idle') && !document.querySelector('.video-idle').classList.contains('hidden')`, 'A hung up');
    console.log('hangup OK');

    // 6. verify delivery state
    const states = await ca.evaluate(`window.ca.chat.list({limit:10}).then(r => r.messages.map(m => m.state))`);
    console.log('chat states:', states.join(','));

    // 7. incoming call auto-opens a closed video window and replays the ring
    await ca.waitFor(`!!document.querySelector('.video-idle .btn')`, 'A idle again');
    await cb.evaluate(`CA.closeApp('video')`);
    await sleep(500);
    await ca.evaluate(`document.querySelector('.video-idle .btn').click()`);
    await cb.waitFor(`window.CA_VIDEO_STATE && CA_VIDEO_STATE.state === 'ringing'`, 'B auto-opened ringing', 15000);
    await cb.evaluate(`document.querySelector('.incoming-call .btn:not(.primary)').click()`);
    await ca.waitFor(`document.querySelector('.video-idle') && !document.querySelector('.video-idle').classList.contains('hidden')`, 'A idle after decline', 15000);
    console.log('incoming call auto-open OK');

    // 8. LAN-only mode (same machine discovery + direct TCP)
    await ca.evaluate(`window.ca.server.set({ url: ${JSON.stringify(base)}, mode: 'lan' })`);
    await cb.evaluate(`window.ca.server.set({ url: ${JSON.stringify(base)}, mode: 'lan' })`);
    await ca.waitFor(`window.ca.snapshot().then(s => s.link.online && s.link.via === 'lan')`, 'A lane online', 20000);
    await cb.waitFor(`window.ca.snapshot().then(s => s.link.online && s.link.via === 'lan')`, 'B lane online', 20000);
    await ca.evaluate(`window.ca.chat.send('LAN 直连测试')`);
    await cb.waitFor(`window.ca.chat.list({limit:5}).then(r => r.messages.some(m => m.text.includes('LAN 直连')))`, 'B gets LAN chat', 10000);
    console.log('LAN direct chat OK');
    await ca.screenshot(path.join(OUT, 'e2e-lan-a.png'));
    console.log('\nE2E PASS');
  } catch (err) {
    console.error('\nE2E FAIL:', err.message);
    for (const [name, c] of [['A', ca], ['B', cb]]) {
      if (!c) continue;
      try {
        const d = await c.evaluate(`(() => {
          const V = window.CA_VIDEO_STATE || {};
          const pc = V.pc;
          const t = pc ? pc.getTransceivers().map(x => ({ mid: x.mid, dir: x.direction, cur: x.currentDirection, s: !!x.sender.track, r: !!x.receiver.track })) : [];
          return JSON.stringify({
            state: V.state, callId: V.callId, mode: V.mode,
            signaling: pc && pc.signalingState, conn: pc && pc.connectionState, ice: pc && pc.iceConnectionState, gather: pc && pc.iceGatheringState,
            local: pc && pc.localDescription ? pc.localDescription.type + ':' + pc.localDescription.sdp.length : null,
            remote: pc && pc.remoteDescription ? pc.remoteDescription.type + ':' + pc.remoteDescription.sdp.length : null,
            pendingOffer: V.pendingOffer ? Object.keys(V.pendingOffer).join(',') : null,
            cand: V.pendingCandidates.length, signals: (V.signals || []).map(s => s.type).join(','),
            tracks: t,
            error: (window.__CA_VIDEO_ERROR || '')
          });
        })()`);
        console.log(name, 'diag', d);
      } catch (e) {
        console.log(name, 'diag failed', e.message);
      }
    }
    try {
      if (ca) await ca.screenshot(path.join(OUT, 'e2e-fail-a.png'));
      if (cb) await cb.screenshot(path.join(OUT, 'e2e-fail-b.png'));
    } catch (_) {}
    for (const name of ['app-a', 'app-b']) {
      try {
        console.error('\n--- ' + name + ' log ---');
        console.error(fs.readFileSync(path.join(TMP, name + '.log'), 'utf8').split('\n').slice(-40).join('\n'));
      } catch (_) {}
    }
    process.exitCode = 1;
  } finally {
    if (ca) ca.close();
    if (cb) cb.close();
    await stop(A);
    await stop(B);
    await relay.close();
    console.log('artifacts in', OUT);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
