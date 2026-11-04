'use strict';
/* Connect All — private server assistant window. */

(function () {
  const { h, icon, toast } = UI;
  let snap = null;
  let state = {
    url: '',
    insecure: false,
    mode: 'auto',
    port: 8787,
    portInput: '8787',
    test: null,
    backupUsage: null,
    log: [],
  };
  let refs = null;

  function logLine(text, kind = '') {
    state.log.push({ at: Date.now(), text, kind });
    if (state.log.length > 80) state.log.shift();
    renderLog();
  }

  function renderLog() {
    if (!refs) return;
    const box = refs.log;
    UI.clear(box);
    if (!state.log.length) {
      box.appendChild(h('div', { class: 'muted', text: T('server.log_empty') }));
      return;
    }
    for (const entry of state.log) {
      box.appendChild(h('div', { class: entry.kind === 'err' ? 'log-err' : entry.kind === 'ok' ? 'log-ok' : '', text: '[' + UI.fmtTime(entry.at) + '] ' + entry.text }));
    }
    const count = document.getElementById('log-count');
    if (count) count.textContent = state.log.length + ' ENTRIES';
    box.scrollTop = box.scrollHeight;
  }

  function renderHeader() {
    const led = document.getElementById('hdr-led');
    const text = document.getElementById('hdr-state');
    if (!led || !text) return;
    const running = state.localRunning;
    led.classList.toggle('on', Boolean(state.url));
    led.classList.toggle('warn', !state.url && running);
    text.textContent = state.url ? (state.test && state.test.ok ? T('common.connected') : T('server.configured')) : T('common.offline');
    const close = document.getElementById('close-btn');
    if (close) close.onclick = () => window.caServer.close();
  }

  function hero() {
    return h(
      'div',
      { class: 'server-hero' },
      h('div', { class: 'glyph-box', html: window.icon('server', 28) }),
      h('div', {},
        h('h1', { text: T('server.title') }),
        h('p', { text: T('server.subtitle') })
      ),
      h('span', { class: 'grow' }),
      h('span', { class: 'tag ' + (state.url ? 'green' : ''), text: state.url ? (state.test && state.test.ok ? 'HEALTHY' : 'CONFIGURED') : 'NOT SET' })
    );
  }

  function serverPanel() {
    const urlInput = h('input', { class: 'input', value: state.url, placeholder: 'https://ca.example.com', spellcheck: 'false' });
    const insecure = UI.checkbox(T('set.insecure'), state.insecure, () => {});
    const mode = h('select', { class: 'select' }, ['auto', 'relay', 'lan', 'offline'].map((m) => h('option', { value: m, selected: state.mode === m, text: T('set.transport_' + m) })));
    const testLine = h('div', { class: 'hint', id: 'test-line', text: state.test ? (state.test.ok ? T('server.test_ok', { ms: state.test.latencyMs, version: state.test.version || '?' }) : T('server.test_fail', { err: state.test.error })) : '' });
    if (state.test) testLine.style.color = state.test.ok ? 'var(--green)' : 'var(--red)';
    const portInput = h('input', { class: 'input', type: 'number', value: state.portInput, min: '1', max: '65535', style: { width: '90px' } });
    const localStatus = h('span', { class: 'server-status-line' },
      h('span', { class: 'led ' + (state.localRunning ? 'on' : '') }),
      h('span', { text: state.localRunning ? T('server.running', { port: state.localPort }) : T('server.stopped') })
    );
    const saveBtn = h('button', {
      class: 'btn primary',
      text: T('server.save_use'),
      on: {
        click: async () => {
          try {
            state.url = urlInput.value.trim();
            state.insecure = insecure.querySelector('input').checked;
            state.mode = mode.value;
            await window.caServer.set({ url: state.url, insecure: state.insecure, mode: state.mode });
            logLine(T('set.server_saved'), 'ok');
            toast(T('set.server_saved'), 'ok');
            await reload();
          } catch (err) {
            toast(T('server.test_fail', { err: err.message }), 'err');
          }
        },
      },
    });
    const testBtn = h('button', {
      class: 'btn',
      text: T('server.test'),
      on: {
        click: async () => {
          testLine.textContent = T('common.testing');
          state.test = await window.caServer.test(urlInput.value.trim(), insecure.querySelector('input').checked);
          testLine.textContent = state.test.ok ? T('server.test_ok', { ms: state.test.latencyMs, version: state.test.version || '?' }) : T('server.test_fail', { err: state.test.error });
          testLine.style.color = state.test.ok ? 'var(--green)' : 'var(--red)';
          logLine(testLine.textContent, state.test.ok ? 'ok' : 'err');
          renderHeader();
        },
      },
    });
    const localBtn = state.localRunning
      ? h('button', { class: 'btn', text: T('server.stop'), on: { click: async () => { await window.caServer.localStop(); logLine(T('server.stopped')); await reload(); } } })
      : h('button', { class: 'btn', text: T('server.start'), on: { click: async () => {
          try {
            const res = await window.caServer.localStart(Number(portInput.value) || 8787);
            logLine(T('server.running', { port: res.port }), 'ok');
            await reload();
          } catch (err) {
            toast(err.message, 'err');
            logLine(err.message, 'err');
          }
        } } });
    return h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('span', { text: T('set.server') }), h('span', { class: 'mono', text: state.url ? 'HTTP/WS' : '—' })),
      h('div', { class: 'panel-body' },
        h('label', { class: 'field' }, h('span', { text: T('set.server_url') }), urlInput, h('span', { class: 'hint', text: T('set.server_url_hint') })),
        h('div', { class: 'form-grid', style: { marginTop: '8px' } },
          h('label', { class: 'field' }, h('span', { text: T('set.transport') }), mode),
          h('label', { class: 'field' }, h('span', { text: T('set.insecure') }), insecure)
        ),
        h('div', { class: 'row', style: { marginTop: '8px' } }, saveBtn, testBtn),
        testLine,
        h('div', { class: 'section-label', style: { marginTop: '12px' }, text: T('server.local') }),
        h('div', { class: 'hint', text: T('server.local_desc', { port: state.localPort || 8787 }) }),
        h('div', { class: 'row wrap', style: { marginTop: '6px' } }, localStatus, portInput, localBtn,
          state.localRunning ? h('button', { class: 'btn small', text: T('server.use_local'), on: { click: () => { urlInput.value = 'http://127.0.0.1:' + state.localPort; } } }) : null
        ),
        h('div', { class: 'hint', style: { marginTop: '8px' }, text: T('server.hint_lan') })
      )
    );
  }

  function backupPanel() {
    const backup = (snap && snap.server.backup) || {};
    const last = backup.lastBackupAt ? T('set.backup_last', { t: UI.fmtRelative(backup.lastBackupAt) }) : T('server.no_backup');
    const usage = state.backupUsage;
    return h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('span', { text: T('server.backup') }), h('span', { class: 'mono', text: backup.lastBackupAt ? UI.fmtBytes(backup.lastBackupBytes || 0) : '0 B' })),
      h('div', { class: 'panel-body' },
        h('div', { class: 'hint', text: T('server.backup_desc') }),
        h('div', { class: 'hint', text: last }),
        usage ? h('div', { class: 'hint', text: T('server.used', { used: UI.fmtBytes(usage.used || 0), quota: UI.fmtBytes(usage.quota || 0) }) + ' · ' + T('server.files', { n: (usage.files || []).length }) }) : null,
        h('div', { class: 'row wrap', style: { marginTop: '8px' } },
          h('button', { class: 'btn primary', disabled: !state.url, text: T('server.backup_now'), on: { click: async () => {
            const res = await window.caServer.backupNow();
            if (res.ok) { logLine(T('set.backup_done', { kb: Math.round(res.bytes / 1024) }), 'ok'); toast(T('set.backup_done', { kb: Math.round(res.bytes / 1024) }), 'ok'); }
            else { logLine(T('set.backup_error', { err: res.error }), 'err'); toast(T('set.backup_error', { err: res.error }), 'err'); }
            await reload();
          } } }),
          h('button', { class: 'btn', text: T('server.backup_list'), on: { click: refreshUsage } }),
          h('button', { class: 'btn', disabled: !state.url, text: T('server.restore'), on: { click: async () => {
            const res = await window.caServer.backupRestore();
            if (res.ok) { logLine(T('set.backup_restore_done', { ci: res.ciAdded, chat: res.chatAdded }), 'ok'); toast(T('set.backup_restore_done', { ci: res.ciAdded, chat: res.chatAdded }), 'ok'); }
            else { logLine(T('set.backup_error', { err: res.error }), 'err'); toast(T('set.backup_error', { err: res.error }), 'err'); }
          } } })
        ),
        backup.lastBackupError ? h('div', { class: 'inline-note danger', style: { marginTop: '8px' }, text: backup.lastBackupError }) : null,
        backup.roomShort ? h('div', { class: 'hint mono', style: { marginTop: '6px' }, text: 'ROOM ' + backup.roomShort }) : null,
        h('div', { class: 'section-label', style: { marginTop: '12px' }, text: T('server.security') }),
        h('div', { class: 'hint', text: T('server.security_text') })
      )
    );
  }

  function guidePanel() {
    const cmd1 = 'node ca-server.js --port 8787 --data ./ca-data --quota-mb 512';
    const cmd2 = 'ca.example.com {\n  reverse_proxy 127.0.0.1:8787\n}';
    const cmd3 = `[Unit]
Description=Connect All relay
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/connect-all/ca-server.js --port 8787 --data /var/lib/connect-all
Restart=always
User=connectall

[Install]
WantedBy=multi-user.target`;
    const step = (n, text, cmd) =>
      h('div', { class: 'server-step' },
        h('span', { class: 'n', text: String(n) }),
        h('div', { class: 't' },
          h('div', { text }),
          cmd ? h('div', { class: 'code' }, cmd) : null,
          cmd ? h('button', { class: 'btn small', style: { marginTop: '3px' }, text: T('server.copy'), on: { click: () => UI.copyText(cmd) } }) : null
        )
      );
    return h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('span', { text: T('server.guide') }), h('span', { class: 'mono', text: T('server.module_hint') })),
      h('div', { class: 'panel-body' },
        step(1, T('server.step1')),
        step(2, T('server.step2'), cmd1),
        step(3, T('server.step3'), cmd2),
        step(4, T('server.step4')),
        h('div', { class: 'section-label', style: { marginTop: '12px' }, text: 'systemd' }),
        h('div', { class: 'code' }, cmd3),
        h('button', { class: 'btn small', style: { marginTop: '3px' }, text: T('server.copy'), on: { click: () => UI.copyText(cmd3) } }),
        h('div', { class: 'hint', style: { marginTop: '8px' }, text: T('server.tls') + ' · ' + T('server.security_text') })
      )
    );
  }

  function logPanel() {
    const box = h('div', { class: 'server-log scroll' });
    return h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('span', { text: T('server.log') }), h('span', { class: 'mono', id: 'log-count', text: state.log.length + ' ENTRIES' })),
      h('div', { class: 'panel-body' }, box)
    );
  }

  function render() {
    if (!refs) return;
    const content = refs.content;
    UI.clear(content);
    content.append(hero());
    content.append(
      h('div', { class: 'server-grid' },
        h('div', {}, serverPanel(), guidePanel()),
        h('div', {}, backupPanel(), logPanel())
      )
    );
    refs.log = document.querySelector('.server-log');
    renderLog();
    renderHeader();
  }

  async function refreshUsage() {
    try {
      const res = await window.caServer.backupList();
      if (res.ok) {
        state.backupUsage = res;
        const body = h('div', {});
        body.appendChild(h('div', { class: 'hint', text: T('server.used', { used: UI.fmtBytes(res.used || 0), quota: UI.fmtBytes(res.quota || 0) }) + ' · ' + T('server.files', { n: (res.files || []).length }) }));
        const list = h('div', { class: 'scroll', style: { maxHeight: '260px', marginTop: '8px' } });
        if (!(res.files || []).length) list.appendChild(h('div', { class: 'hint', text: T('server.no_backup') }));
        for (const f of (res.files || []).sort((a, b) => b.mtime - a.mtime)) {
          list.appendChild(h('div', { class: 'row', style: { borderBottom: '1px dotted #999', padding: '3px 0' } },
            h('span', { class: 'mono small', text: f.name }), h('span', { class: 'hint', text: UI.fmtBytes(f.size) }), h('span', { class: 'hint', text: UI.fmtDateTime(f.mtime) })));
        }
        body.appendChild(list);
        UI.showDialog({ title: T('server.backup'), body, width: 640, actions: [{ label: T('common.close'), primary: true }] });
        logLine(T('server.used', { used: UI.fmtBytes(res.used || 0), quota: UI.fmtBytes(res.quota || 0) }));
      } else {
        toast(res.error, 'err');
        logLine(res.error, 'err');
      }
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function reload() {
    try {
      snap = await window.caServer.snapshot();
      window.CA_LANG = snap.lang || 'zh';
      state.url = snap.server.url || '';
      state.insecure = Boolean(snap.server.insecure);
      state.mode = snap.server.mode || 'auto';
      state.portInput = String((snap.server.localRelay && snap.server.localRelay.port) || 8787);
      state.localRunning = Boolean(snap.server.localRelay && snap.server.localRelay.running);
      state.localPort = (snap.server.localRelay && snap.server.localRelay.port) || 8787;
      render();
    } catch (err) {
      console.error(err);
    }
  }

  function boot() {
    refs = { content: document.getElementById('content'), log: null };
    if (window.caServer.platform === 'darwin') document.body.classList.add('darwin');
    reload().then(() => {
      logLine('Connect All — private server assistant ready', 'ok');
      if (window.caServer && window.caServer.onEvent) {
        window.caServer.onEvent((evt) => {
          if (!evt) return;
          if (evt.type === 'server' || evt.type === 'backup' || evt.type === 'backup-done') {
            reload();
          }
          if (evt.type === 'lang') reload();
        });
      }
    });
    document.getElementById('close-btn').onclick = () => window.caServer.close();
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
