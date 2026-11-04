#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createRelay } = require('../server/ca-server');
const ROOT = path.dirname(__dirname);
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const TMP = path.join(ROOT, 'test/.tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
async function cdp(port) {
  let page;
  for (let i = 0; i < 80; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = l.find(t => t.type === 'page' && t.url.includes('index.html')); if (page) break; } catch (_) {}
    await sleep(250);
  }
  if (!page) throw new Error('no page ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { id++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || ''));
    return r.result?.result?.value;
  };
  return { ev, send, close: () => ws.close() };
}
function launch(name, port) {
  const dir = path.join(TMP, name); rmrf(dir); fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(TMP, name + '.log'), 'w');
  const env = { ...process.env, CA_USER_DATA: dir, CA_DEBUG: '1', CA_ACTIVE_APP: 'chat' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['--no-sandbox','--disable-gpu','--remote-debugging-port='+port,'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',ROOT], { env, stdio: ['ignore', log, log] });
  return child;
}
async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const relay = createRelay({ port: 0, host: '127.0.0.1', dataDir: path.join(TMP, 'relay-dbg'), quiet: true });
  const addr = await relay.listen(); const base = 'http://127.0.0.1:' + addr.port;
  const A = launch('dbg-a', 9311); const B = launch('dbg-b', 9312);
  let ca, cb;
  try {
    ca = await cdp(9311); cb = await cdp(9312);
    for (const c of [ca, cb]) await c.ev(`window.ca.server.set(${JSON.stringify({url:base,mode:'relay'})})`);
    await ca.ev(`window.ca.pairing.start('DBG42A')`); await cb.ev(`window.ca.pairing.start('DBG42A')`);
    for (const [c,n] of [[ca,'A'],[cb,'B']]) {
      for (let i=0;i<80;i++){ const st = await c.ev(`window.ca.pairing.status()`); if (st.state==='verify') break; await sleep(250); }
    }
    await ca.ev(`window.ca.pairing.confirm()`); await cb.ev(`window.ca.pairing.confirm()`);
    for (const c of [ca,cb]) { for (let i=0;i<80;i++){ const s=await c.ev(`window.ca.snapshot()`); if (s.link.online) break; await sleep(250);} }
    console.log('paired & online');
    await ca.ev(`CA.openApp('video')`); await cb.ev(`CA.openApp('video')`);
    await sleep(800);
    console.log('A video mounted:', await ca.ev(`!!document.querySelector('.video-idle .btn')`), 'B:', await cb.ev(`!!document.querySelector('.video-idle .btn')`));
    console.log('B lastEvent before:', await cb.ev(`CA.lastEvent && CA.lastEvent.type`));
    // signal transport test
    await ca.ev(`window.ca.video.signal({callId:'probe',type:'probe',data:{x:1}})`);
    await sleep(1200);
    console.log('B lastEvent after probe:', await cb.ev(`CA.lastEvent && CA.lastEvent.type + ':' + (CA.lastEvent.payload && CA.lastEvent.payload.type)`));
    console.log('B video events? incoming hidden:', await cb.ev(`document.querySelector('.incoming-call') ? document.querySelector('.incoming-call').classList.contains('hidden') : 'no-el'`));
    // click call
    await ca.ev(`document.querySelector('.video-idle .btn').click()`);
    await sleep(3500);
    console.log('A idle big:', await ca.ev(`document.querySelector('.video-idle .big') && document.querySelector('.video-idle .big').textContent`));
    console.log('A call btn:', await ca.ev(`document.querySelector('.video-controls .btn.primary') && document.querySelector('.video-controls .btn.primary').textContent`));
    console.log('A lastEvent:', await ca.ev(`CA.lastEvent && CA.lastEvent.type + ':' + (CA.lastEvent.payload && CA.lastEvent.payload.type)`));
    console.log('B lastEvent:', await cb.ev(`CA.lastEvent && CA.lastEvent.type + ':' + JSON.stringify(CA.lastEvent.payload)`));
    console.log('B incoming hidden:', await cb.ev(`document.querySelector('.incoming-call').classList.contains('hidden')`));
    console.log('B incoming title:', await cb.ev(`document.querySelector('.incoming-call .title') && document.querySelector('.incoming-call .title').textContent`));
    for (const name of ['dbg-a','dbg-b']) {
      const txt = fs.readFileSync(path.join(TMP,name+'.log'),'utf8');
      const lines = txt.split('\n').filter(l => l.includes('[renderer]') || l.includes('[ca]') || l.includes('Uncaught') || l.includes('signal'));
      console.log('\n---',name,'---\n'+lines.slice(-25).join('\n'));
    }
  } finally {
    if (ca) ca.close(); if (cb) cb.close();
    A.kill('SIGTERM'); B.kill('SIGTERM');
    await sleep(500);
    A.kill('SIGKILL'); B.kill('SIGKILL');
    await relay.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
