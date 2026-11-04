'use strict';
/* Connect All — Settings window: pairing, server, CI, video, notifications, privacy. */

(function () {
  const { h, icon, toast } = UI;

  let refs = null;
  let activeTab = 'general';
  const pair = {
    tab: 'server',
    status: { state: 'idle' },
    code: '',
    invite: '',
    reply: '',
    serverTest: null,
  };
  let ciTest = null;
  let serverTest = null;
  let serverDraft = null;

  const TABS = [
    { id: 'general', label: 'set.general' },
    { id: 'pairing', label: 'set.pairing' },
    { id: 'server', label: 'set.server' },
    { id: 'ci', label: 'set.ci' },
    { id: 'video', label: 'set.video' },
    { id: 'notify', label: 'set.notify' },
    { id: 'privacy', label: 'set.privacy' },
    { id: 'about', label: 'set.about' },
  ];

  const mod = () => (window.ca.env.platform === 'darwin' ? '⌘' : 'Ctrl+');

  function section(title, lede, ...children) {
    return h(
      'div',
      { class: 'settings-section' },
      h('h2', { text: title }),
      lede ? h('p', { class: 'lede', text: lede }) : null,
      ...children
    );
  }

  function renderNav() {
    if (!refs) return;
    UI.clear(refs.nav);
    for (const tab of TABS) {
      refs.nav.appendChild(
        h('button', {
          class: activeTab === tab.id ? 'active' : '',
          on: { click: () => switchTab(tab.id) },
        }, h('span', { text: T(tab.label) }))
      );
    }
    refs.nav.appendChild(h('div', { class: 'nav-sep' }));
    refs.nav.appendChild(
      h('button', { on: { click: () => window.ca.window.openServer() } }, h('span', { text: T('set.open_server_window') }))
    );
  }

  function switchTab(tab) {
    activeTab = tab;
    renderNav();
    renderContent();
  }

  function renderContent() {
    if (!refs) return;
    UI.clear(refs.content);
    let node;
    if (activeTab === 'general') node = buildGeneral();
    else if (activeTab === 'pairing') node = buildPairing();
    else if (activeTab === 'server') node = buildServer();
    else if (activeTab === 'ci') node = buildCi();
    else if (activeTab === 'video') node = buildVideo();
    else if (activeTab === 'notify') node = buildNotify();
    else if (activeTab === 'privacy') node = buildPrivacy();
    else node = buildAbout();
    refs.content.appendChild(node);
  }

  /* ---------------- general ---------------- */

  function buildGeneral() {
    const snap = CA.snap;
    const device = snap.app.device;
    const langField = h(
      'div',
      { class: 'seg' },
      h('button', {
        class: 'seg-btn ' + (CA.lang === 'zh' ? 'active' : ''),
        text: '中文',
        on: {
          click: async () => {
            sessionStorage.setItem('ca.reloadApp', 'settings');
            await window.ca.setLang('zh');
            location.reload();
          },
        },
      }),
      h('button', {
        class: 'seg-btn ' + (CA.lang === 'en' ? 'active' : ''),
        text: 'English',
        on: {
          click: async () => {
            sessionStorage.setItem('ca.reloadApp', 'settings');
            await window.ca.setLang('en');
            location.reload();
          },
        },
      })
    );
    const login = UI.checkbox(T('common.enable'), false, async (checked) => {
      await window.ca.settings.loginItemSet(checked);
    });
    window.ca.settings.loginItemGet().then((res) => {
      const input = login.querySelector('input');
      if (input) input.checked = Boolean(res && res.openAtLogin);
    });
    return section(
      T('set.general'),
      T('set.general_lede'),
      h(
        'div',
        { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', { text: T('set.language') }), langField),
        h('label', { class: 'field' }, h('span', { text: T('set.launch_login') }), login)
      ),
      h('div', { class: 'section-label', style: { marginTop: '16px' }, text: T('set.device') }),
      h(
        'dl',
        { class: 'kv' },
        h('dt', { text: T('set.device_name') }),
        h('dd', {},
          h('div', { class: 'row' },
            h('input', { class: 'input', id: 'device-name-input', value: device.name, maxlength: '40', style: { maxWidth: '220px' } }),
            h('button', { class: 'btn small', text: T('common.save'), on: { click: async () => {
              try {
                await window.ca.settings.setDevice(document.getElementById('device-name-input').value);
                await CA_UI.refreshSnapshot();
                toast(T('set.saved'), 'ok');
                renderContent();
              } catch (err) {
                toast(T('set.error', { err: err.message }), 'err');
              }
            } } })
          )
        ),
        h('dt', { text: T('set.device_id') }),
        h('dd', { class: 'mono', text: device.id }),
        h('dt', { text: T('set.platform') }),
        h('dd', { text: device.platform }),
        h('dt', { text: T('set.version') }),
        h('dd', { text: snap.app.version + ' · Connect All' }),
        h('dt', { text: T('set.data_path') }),
        h('dd', { class: 'mono tiny', text: snap.app.paths.data })
      ),
      h(
        'div',
        { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'btn', text: T('set.open_data'), on: { click: () => window.ca.openPath(snap.app.paths.data) } }),
        h('button', { class: 'btn', text: T('cal.widget_show'), on: { click: () => window.ca.widget.show().then(() => toast(T('toast.widget_on'), 'ok')) } }),
        h('button', { class: 'btn', text: T('set.open_server_window'), on: { click: () => window.ca.window.openServer() } })
      ),
      h('div', { class: 'inline-note', style: { marginTop: '14px' }, text: T('set.general_note') })
    );
  }

  /* ---------------- pairing ---------------- */

  function needServerHint() {
    if (CA.snap.server.url) return null;
    return h(
      'div',
      { class: 'inline-note warn' },
      h('span', { text: T('set.pair_need_server') }),
      h('button', {
        class: 'btn small',
        style: { marginLeft: '8px' },
        text: T('nav.server'),
        on: { click: () => switchTab('server') },
      })
    );
  }

  function pairingTabBar() {
    return h(
      'div',
      { class: 'tabbar' },
      h('button', {
        class: pair.tab === 'server' ? 'active' : '',
        text: T('set.pair_tab_server'),
        on: { click: () => { pair.tab = 'server'; renderContent(); } },
      }),
      h('button', {
        class: pair.tab === 'offline' ? 'active' : '',
        text: T('set.pair_tab_offline'),
        on: { click: () => { pair.tab = 'offline'; renderContent(); } },
      })
    );
  }

  function buildPairing() {
    const snap = CA.snap;
    if (snap.app.pairing.paired) {
      const peer = snap.app.pairing.peer;
      return section(
        T('set.pairing'),
        T('set.sas_hint'),
        h('div', { class: 'inline-note green' }, h('b', { text: T('set.paired_with', { name: peer ? peer.name : '' }) })),
        h('div', { class: 'panel', style: { marginTop: '10px' } },
          h('div', { class: 'panel-head' }, h('span', { text: T('set.peer_device') }), h('span', { class: 'mono', text: peer ? UI.shortId(peer.id) : '' })),
          h('div', { class: 'panel-body' },
            h('dl', { class: 'kv' },
              h('dt', { text: T('set.platform') }), h('dd', { text: peer ? peer.platform : '—' }),
              h('dt', { text: T('set.paired_at_label') }), h('dd', { text: UI.fmtDateTime(peer ? peer.pairedAt : 0) }),
              h('dt', { text: T('set.sas') }), h('dd', { class: 'sas-digits', text: snap.app.pairing.sas || '—' }),
              h('dt', { text: T('status.link') }), h('dd', { text: snap.link.online ? (snap.link.via === 'lan' ? 'LAN' : 'RELAY') : T('common.offline') })
            ),
            h('div', { class: 'row', style: { marginTop: '10px' } },
              h('button', { class: 'btn', text: T('set.unpair'), on: { click: unpair } })
            )
          )
        )
      );
    }
    const status = pair.status || { state: 'idle' };
    const box = h('div', { class: 'col' });
    if (pair.tab === 'server') {
      box.append(
        needServerHint() || h('div', {}),
        h('div', { class: 'inline-note', text: T('set.pair_server_hint') }),
        h('div', { class: 'form-line', style: { marginTop: '10px' } },
          h('button', { class: 'btn primary', text: T('set.pair_generate'), on: { click: () => startPairCode('') } }),
          h('span', { class: 'muted small', text: '—' }),
          h('input', { class: 'input', id: 'pair-code-input', placeholder: 'XXXXXX', maxlength: '8', style: { width: '120px', textTransform: 'uppercase', letterSpacing: '3px', fontFamily: 'var(--mono)' } }),
          h('button', { class: 'btn', text: T('set.pair_join'), on: { click: () => startPairCode(document.getElementById('pair-code-input').value) } })
        ),
        h('div', { style: { marginTop: '12px' } }, pairStatusBox())
      );
    } else {
      box.append(
        h('div', { class: 'inline-note', text: T('set.invite_create_hint') }),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'btn primary', text: T('set.invite_create'), on: { click: createInvite } })
        ),
        pair.invite
          ? h('div', { class: 'mt8' },
              h('div', { class: 'section-label', text: T('set.invite_create') }),
              h('textarea', { class: 'textarea', rows: 3, readonly: 'readonly', value: pair.invite }),
              h('div', { class: 'row', style: { marginTop: '4px' } },
                h('button', { class: 'btn small', text: T('common.copy'), on: { click: () => UI.copyText(pair.invite) } }),
                h('button', { class: 'btn small', text: T('set.invite_accept'), on: { click: acceptInvitePrompt } })
              )
            )
          : null,
        pair.reply
          ? h('div', { class: 'mt12' },
              h('div', { class: 'inline-note green', text: T('set.invite_reply') }),
              h('textarea', { class: 'textarea', rows: 3, readonly: 'readonly', value: pair.reply }),
              h('div', { class: 'row', style: { marginTop: '4px' } },
                h('button', { class: 'btn small', text: T('common.copy'), on: { click: () => UI.copyText(pair.reply) } }),
                h('button', { class: 'btn small', text: T('set.invite_reply_paste'), on: { click: acceptReplyPrompt } })
              )
            )
          : null,
        pair.status && pair.status.peer
          ? h('div', { class: 'panel', style: { marginTop: '12px' } },
              h('div', { class: 'panel-head' }, h('span', { text: T('presence.manual') })),
              h('div', { class: 'panel-body' }, pairStatusBox())
            )
          : null
      );
    }
    return section(T('set.pairing'), T('set.pair_need_server'), pairingTabBar(), box);
  }

  function pairStatusBox() {
    const status = pair.status || {};
    if (!status.state || status.state === 'idle') return h('div', { class: 'hint', text: T('set.pair_server_hint') });
    if (status.state === 'waiting') {
      return h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('span', { text: T('set.pair_waiting') }), h('span', { class: 'mono', text: status.expiresAt ? UI.fmtIn(status.expiresAt) : '' })),
        h('div', { class: 'panel-body' },
          h('div', { class: 'big-code', text: status.code || '—' }),
          h('div', { class: 'row', style: { marginTop: '8px' } },
            h('button', { class: 'btn small', text: T('common.copy'), on: { click: () => UI.copyText(status.code || '') } }),
            h('button', { class: 'btn small', text: T('set.pair_cancel'), on: { click: cancelPair } })
          )
        )
      );
    }
    if (status.state === 'verify') {
      return h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('span', { text: status.peer ? status.peer.name : '—' }), h('span', { class: 'mono', text: T('set.sas') })),
        h('div', { class: 'panel-body' },
          h('div', { class: 'sas-digits', text: status.sas || '—' }),
          h('div', { class: 'hint', text: T('set.pair_verify') }),
          h('div', { class: 'row', style: { marginTop: '10px' } },
            h('button', { class: 'btn primary', text: T('set.pair_confirm'), on: { click: confirmPair } }),
            h('button', { class: 'btn', text: T('set.pair_cancel'), on: { click: cancelPair } })
          )
        )
      );
    }
    if (status.state === 'reply') {
      return h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('span', { text: status.peer ? status.peer.name : '—' }), h('span', { class: 'mono', text: T('set.sas') })),
        h('div', { class: 'panel-body' },
          h('div', { class: 'sas-digits', text: status.sas || '—' }),
          h('div', { class: 'hint', text: T('set.invite_reply') }),
          h('div', { class: 'row', style: { marginTop: '10px' } },
            h('button', { class: 'btn primary', text: T('set.invite_finish'), on: { click: confirmPair } }),
            h('button', { class: 'btn', text: T('set.pair_cancel'), on: { click: cancelPair } })
          )
        )
      );
    }
    if (status.state === 'expired') {
      return h('div', { class: 'inline-note warn', text: T('set.pair_expired') });
    }
    if (status.state === 'error') {
      return h('div', { class: 'inline-note danger', text: T('common.error') });
    }
    return h('div', { class: 'hint', text: status.state });
  }

  async function startPairCode(code) {
    try {
      pair.status = await window.ca.pairing.start(code || '');
      pair.code = pair.status.code || '';
      renderContent();
    } catch (err) {
      toast(T('set.pair_error', { err: err.message }), 'err');
    }
  }
  async function confirmPair() {
    try {
      await window.ca.pairing.confirm();
      await CA_UI.refreshSnapshot();
      pair.status = { state: 'idle' };
      pair.invite = '';
      pair.reply = '';
      renderNav();
      renderContent();
      toast(T('set.pair_success'), 'ok');
    } catch (err) {
      toast(T('set.pair_error', { err: err.message }), 'err');
    }
  }
  async function cancelPair() {
    await window.ca.pairing.cancel().catch(() => {});
    pair.status = { state: 'idle' };
    pair.invite = '';
    pair.reply = '';
    renderContent();
  }
  async function createInvite() {
    try {
      const res = await window.ca.pairing.createInvite();
      pair.invite = res.invite;
      pair.status = res.status;
      renderContent();
    } catch (err) {
      toast(T('set.pair_error', { err: err.message }), 'err');
    }
  }
  async function acceptInvitePrompt() {
    const text = await UI.promptDialog({ title: T('set.invite_paste'), label: T('set.invite_paste'), multiline: true });
    if (!text) return;
    try {
      pair.status = await window.ca.pairing.acceptInvite(text);
      pair.reply = pair.status.reply;
      renderContent();
    } catch (err) {
      toast(T('set.pair_error', { err: err.message }), 'err');
    }
  }
  async function acceptReplyPrompt() {
    const text = await UI.promptDialog({ title: T('set.invite_reply_paste'), label: T('set.invite_reply_paste'), multiline: true });
    if (!text) return;
    try {
      pair.status = await window.ca.pairing.acceptReply(text);
      renderContent();
    } catch (err) {
      toast(T('set.pair_error', { err: err.message }), 'err');
    }
  }

  async function unpair() {
    if (!(await UI.confirmDialog({ title: T('set.unpair'), message: T('set.unpair_confirm'), danger: true, confirmLabel: T('set.unpair') }))) return;
    await window.ca.pairing.unpair();
    await CA_UI.refreshSnapshot();
    renderContent();
    toast(T('set.unpaired'));
  }

  /* ---------------- server ---------------- */

  function buildServer() {
    const snap = CA.snap;
    const cfg = serverDraft || {
      url: snap.server.url || '',
      insecure: Boolean(snap.server.insecure),
      mode: snap.server.mode || 'auto',
      port: snap.server.localRelay.port || 8787,
      turnUrl: (snap.settings.transport.turn && snap.settings.transport.turn.url) || '',
      turnUser: (snap.settings.transport.turn && snap.settings.transport.turn.username) || '',
      turnPass: (snap.settings.transport.turn && snap.settings.transport.turn.password) || '',
    };
    serverDraft = cfg;
    const urlInput = h('input', { class: 'input', value: cfg.url, placeholder: 'https://ca.example.com', spellcheck: 'false' });
    const insecure = UI.checkbox(T('set.insecure'), cfg.insecure, (v) => (cfg.insecure = v));
    const mode = h(
      'select',
      { class: 'select' },
      ['auto', 'relay', 'lan', 'offline'].map((m) =>
        h('option', { value: m, selected: cfg.mode === m, text: T('set.transport_' + m) })
      )
    );
    const portInput = h('input', { class: 'input', type: 'number', value: String(cfg.port || 8787), style: { width: '90px' }, min: '1', max: '65535' });
    const testResult = h('span', { class: 'hint', text: '' });
    const saveBtn = h('button', {
      class: 'btn primary',
      text: T('common.save'),
      on: {
        click: async () => {
          try {
            cfg.url = urlInput.value.trim();
            cfg.mode = mode.value;
            await window.ca.server.set({ url: cfg.url, insecure: cfg.insecure, mode: cfg.mode });
            await CA_UI.refreshSnapshot();
            toast(T('set.server_saved'), 'ok');
            testResult.textContent = '';
          } catch (err) {
            toast(T('set.error', { err: err.message }), 'err');
          }
        },
      },
    });
    const testBtn = h('button', {
      class: 'btn',
      text: T('set.test_server'),
      on: {
        click: async () => {
          testResult.textContent = T('common.testing');
          const res = await window.ca.server.test(urlInput.value.trim(), insecure.querySelector('input').checked);
          serverTest = res;
          testResult.textContent = res.ok ? T('set.server_ok', { ms: res.latencyMs, version: res.version || '?' }) : T('set.server_fail', { err: res.error });
          testResult.style.color = res.ok ? 'var(--green)' : 'var(--red)';
        },
      },
    });
    const localRunning = snap.server.localRelay && snap.server.localRelay.running;
    const localPort = snap.server.localRelay && snap.server.localRelay.port;
    const localBox = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('span', { text: T('set.local_relay') }), h('span', { class: 'mono', text: localRunning ? T('set.local_running', { port: localPort }) : T('common.disabled') })),
      h('div', { class: 'panel-body' },
        h('div', { class: 'hint', text: T('set.local_relay_hint') }),
        h('div', { class: 'row', style: { marginTop: '6px' } },
          h('span', { class: 'small', text: T('set.port', {}) || 'Port' }),
          portInput,
          localRunning
            ? h('button', { class: 'btn', text: T('set.local_stop'), on: { click: async () => { await window.ca.server.localStop(); await CA_UI.refreshSnapshot(); renderContent(); } } })
            : h('button', { class: 'btn', text: T('set.local_start'), on: { click: async () => {
                try {
                  const res = await window.ca.server.localStart(Number(portInput.value) || 8787);
                  if (!urlInput.value) urlInput.value = res.url;
                  cfg.port = res.port;
                  await CA_UI.refreshSnapshot();
                  renderContent();
                } catch (err) {
                  toast(err.message, 'err');
                }
              } } }),
          localRunning
            ? h('button', { class: 'btn', text: T('set.use_local'), on: { click: () => { urlInput.value = 'http://127.0.0.1:' + localPort; } } })
            : null
        )
      )
    );
    const backup = snap.server.backup || {};
    const backupBox = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('span', { text: T('set.backup') }),
        h('span', { class: 'mono', text: backup.lastBackupAt ? T('set.backup_last', { t: UI.fmtRelative(backup.lastBackupAt) }) : T('set.backup_never') })
      ),
      h('div', { class: 'panel-body' },
        h('div', { class: 'hint', text: T('set.backup_hint') }),
        h('div', { class: 'row wrap', style: { marginTop: '6px' } },
          h('button', { class: 'btn primary', text: T('set.backup_now'), on: { click: doBackup } }),
          h('button', { class: 'btn', text: T('set.backup_restore'), on: { click: doRestore } }),
          h('button', { class: 'btn', text: T('set.backup_list'), on: { click: showBackups } })
        ),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          UI.checkbox(T('set.backup_auto'), backup.autoBackup !== false, async (v) => {
            await window.ca.server.set({ autoBackup: v });
            await CA_UI.refreshSnapshot();
          }),
          h('span', { class: 'small muted', text: T('set.backup_interval') }),
          h('input', { class: 'input', type: 'number', value: String(backup.intervalMin || 60), min: '15', style: { width: '80px' }, on: { change: async (e) => {
            await window.ca.server.set({ backupIntervalMin: Number(e.target.value) || 60 });
            await CA_UI.refreshSnapshot();
          } } })
        ),
        backup.lastBackupError ? h('div', { class: 'inline-note danger', style: { marginTop: '8px' }, text: backup.lastBackupError }) : null,
        backup.roomShort ? h('div', { class: 'hint mono', text: 'ROOM ' + backup.roomShort }) : null
      )
    );
    return section(T('set.server'),
      T('set.server_url_hint'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field full' }, h('span', { text: T('set.server_url') }), urlInput),
        h('label', { class: 'field' }, h('span', { text: T('set.transport') }), mode),
        h('label', { class: 'field' }, h('span', { text: T('set.insecure') }), insecure, h('span', { class: 'hint', text: T('set.insecure_hint') }))
      ),
      h('div', { class: 'row', style: { marginTop: '8px' } }, saveBtn, testBtn, testResult),
      h('div', { style: { marginTop: '12px' } }, localBox, backupBox),
      h('div', { class: 'section-label', style: { marginTop: '14px' }, text: T('set.ice') }),
      h('div', { class: 'hint', text: T('set.ice_hint') }),
      h('div', { class: 'form-grid', style: { marginTop: '6px' } },
        h('label', { class: 'field full' }, h('span', { text: T('set.turn_url') }), h('input', { class: 'input', id: 'turn-url', value: cfg.turnUrl, placeholder: 'turn:turn.example.com:3478' })),
        h('label', { class: 'field' }, h('span', { text: T('set.turn_user') }), h('input', { class: 'input', id: 'turn-user', value: cfg.turnUser })),
        h('label', { class: 'field' }, h('span', { text: T('set.turn_pass') }), h('input', { class: 'input', id: 'turn-pass', type: 'password', value: cfg.turnPass }))
      ),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn small', text: T('common.save'), on: { click: async () => {
          try {
            await window.ca.settings.setTransport({
              mode: mode.value,
              turn: { url: document.getElementById('turn-url').value, username: document.getElementById('turn-user').value, password: document.getElementById('turn-pass').value },
            });
            await CA_UI.refreshSnapshot();
            toast(T('set.saved'), 'ok');
          } catch (err) {
            toast(err.message, 'err');
          }
        } } })
      )
    );
  }

  async function doBackup() {
    try {
      const res = await window.ca.server.backupNow();
      if (res.ok) toast(T('set.backup_done', { kb: Math.round(res.bytes / 1024) }), 'ok');
      else toast(T('set.backup_error', { err: res.error }), 'err');
      await CA_UI.refreshSnapshot();
      renderContent();
    } catch (err) {
      toast(T('set.backup_error', { err: err.message }), 'err');
    }
  }

  async function doRestore() {
    try {
      const res = await window.ca.server.backupRestore();
      if (res.ok) {
        toast(T('set.backup_restore_done', { ci: res.ciAdded, chat: res.chatAdded }), 'ok');
        await CA_UI.refreshSnapshot();
      } else {
        toast(T('set.backup_error', { err: res.error }), 'err');
      }
    } catch (err) {
      toast(T('set.backup_error', { err: err.message }), 'err');
    }
  }

  async function showBackups() {
    const res = await window.ca.server.backupList();
    const body = h('div', {});
    if (!res.ok) {
      body.appendChild(h('div', { class: 'inline-note danger', text: res.error }));
    } else {
      body.appendChild(h('div', { class: 'hint', text: T('server.used', { used: UI.fmtBytes(res.used), quota: UI.fmtBytes(res.quota) }) }));
      const list = h('div', { class: 'scroll', style: { maxHeight: '280px', marginTop: '8px' } });
      if (!res.files.length) list.appendChild(h('div', { class: 'hint', text: T('server.no_backup') }));
      for (const f of (res.files || []).sort((a, b) => b.mtime - a.mtime)) {
        list.appendChild(h('div', { class: 'row', style: { borderBottom: '1px dotted #999', padding: '3px 0' } },
          h('span', { class: 'mono small', text: f.name }),
          h('span', { class: 'hint', text: UI.fmtBytes(f.size) }),
          h('span', { class: 'hint', text: UI.fmtDateTime(f.mtime) })
        ));
      }
      body.appendChild(list);
    }
    UI.showDialog({ title: T('set.backup_list'), body, width: 640, actions: [{ label: T('common.close'), primary: true }] });
  }

  /* ---------------- CI ---------------- */

  function buildCi() {
    const cfg = CA.snap.ci.config;
    const status = CA.snap.ci.status || {};
    const providerSel = h('select', { class: 'select' }, (cfg.providers || []).map((p) => h('option', { value: p.id, selected: p.id === cfg.provider, text: p.name })));
    const presetModels = (cfg.providers || []).find((p) => p.id === cfg.provider);
    const modelInput = h('input', { class: 'input', value: cfg.model, list: 'ci-models', placeholder: T('ci.model_custom') });
    const datalist = h('datalist', { id: 'ci-models' }, (presetModels ? presetModels.models : []).map((m) => h('option', { value: m.id, label: m.label })));
    const baseUrlInput = h('input', { class: 'input', value: cfg.baseUrl || '', placeholder: 'https://api.deepseek.com/v1' });
    const keyInput = h('input', { class: 'input', type: 'password', placeholder: cfg.hasKey ? T('ci.api_key_saved', { hint: cfg.keyHint }) : 'sk-…' });
    const enabled = UI.checkbox(T('ci.enable'), cfg.enabled, async (v) => {
      await window.ca.ci.configure({ enabled: v });
      await CA_UI.refreshSnapshot();
    });
    const includeCal = UI.checkbox(T('ci.include_calendar'), cfg.includeCalendar, async (v) => {
      await window.ca.ci.configure({ includeCalendar: v });
    });
    const notify = UI.checkbox(T('ci.notify'), cfg.notify, async (v) => {
      await window.ca.ci.configure({ notify: v });
    });
    const interval = h('select', { class: 'select' }, [30, 60, 120, 240].map((n) => h('option', { value: String(n), selected: Number(cfg.intervalMin) === n, text: T('common.minutes', { n }) })));
    const retention = h('select', { class: 'select' },
      h('option', { value: '0', selected: Number(cfg.retentionDays) === 0, text: T('ci.retention_forever') }),
      [30, 90, 180, 365].map((n) => h('option', { value: String(n), selected: Number(cfg.retentionDays) === n, text: T('ci.retention_days', { n }) }))
    );
    const langSel = h('select', { class: 'select' },
      h('option', { value: 'auto', selected: cfg.lang === 'auto', text: T('ci.lang_auto') }),
      h('option', { value: 'zh', selected: cfg.lang === 'zh', text: '中文' }),
      h('option', { value: 'en', selected: cfg.lang === 'en', text: 'English' })
    );
    const promptInput = h('textarea', { class: 'textarea', rows: 3, value: cfg.customPrompt || '', placeholder: T('ci.custom_prompt_hint') });
    const testLine = h('span', { class: 'hint', text: ciTest ? (ciTest.ok ? T('ci.test_ok', { ms: ciTest.latencyMs, model: ciTest.model }) : T('ci.test_fail', { err: ciTest.error })) : '' });
    if (ciTest) testLine.style.color = ciTest.ok ? 'var(--green)' : 'var(--red)';
    const collect = () => ({
      provider: providerSel.value,
      baseUrl: baseUrlInput.value.trim(),
      model: modelInput.value.trim(),
      intervalMin: Number(interval.value),
      retentionDays: Number(retention.value),
      lang: langSel.value,
      includeCalendar: includeCal.querySelector('input').checked,
      notify: notify.querySelector('input').checked,
      customPrompt: promptInput.value,
    });
    const save = async () => {
      try {
        const patch = collect();
        if (keyInput.value.trim()) patch.apiKey = keyInput.value.trim();
        await window.ca.ci.configure(patch);
        keyInput.value = '';
        await CA_UI.refreshSnapshot();
        toast(T('set.saved'), 'ok');
        renderContent();
      } catch (err) {
        toast(T('set.error', { err: err.message }), 'err');
      }
    };
    const test = async () => {
      testLine.textContent = T('common.testing');
      ciTest = await window.ca.ci.test({
        provider: providerSel.value,
        baseUrl: baseUrlInput.value.trim(),
        model: modelInput.value.trim(),
        apiKey: keyInput.value.trim() || undefined,
      });
      testLine.textContent = ciTest.ok ? T('ci.test_ok', { ms: ciTest.latencyMs, model: ciTest.model }) : T('ci.test_fail', { err: ciTest.error });
      testLine.style.color = ciTest.ok ? 'var(--green)' : 'var(--red)';
    };
    const providerChange = () => {
      const p = (cfg.providers || []).find((x) => x.id === providerSel.value);
      if (!p) return;
      baseUrlInput.value = p.baseUrl;
      if (p.models && p.models[0]) modelInput.value = p.models[0].id;
      UI.clear(datalist);
      (p.models || []).forEach((m) => datalist.appendChild(h('option', { value: m.id, label: m.label })));
      datalist.id = 'ci-models';
    };
    providerSel.addEventListener('change', providerChange);
    return section(T('set.ci'), T('ci.enable_desc'),
      h('div', { class: 'inline-note', text: '🔒 ' + T('ci.local_only') }),
      h('div', { class: 'panel', style: { marginTop: '10px' } },
        h('div', { class: 'panel-head' },
          h('span', { text: T('ci.enable') }),
          h('span', { class: 'mono', text: status.enabled ? T('common.enabled') : T('common.disabled') })
        ),
        h('div', { class: 'panel-body' },
          enabled,
          h('div', { class: 'form-grid', style: { marginTop: '10px' } },
            h('label', { class: 'field' }, h('span', { text: T('ci.provider') }), providerSel),
            h('label', { class: 'field' }, h('span', { text: T('ci.model') }), modelInput, datalist),
            h('label', { class: 'field full' }, h('span', { text: T('ci.base_url') }), baseUrlInput),
            h('label', { class: 'field full' }, h('span', { text: T('ci.api_key') }), keyInput, h('span', { class: 'hint', text: T('ci.api_key_hint') + ' · ' + T('ci.model_hint') })),
            h('label', { class: 'field' }, h('span', { text: T('ci.interval') }), interval),
            h('label', { class: 'field' }, h('span', { text: T('ci.retention') }), retention),
            h('label', { class: 'field' }, h('span', { text: T('ci.lang') }), langSel)
          ),
          h('div', { class: 'row', style: { marginTop: '10px' } }, includeCal, notify),
          h('label', { class: 'field', style: { marginTop: '10px' } }, h('span', { text: T('ci.custom_prompt') }), promptInput),
          h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn primary', text: T('common.save'), on: { click: save } }), h('button', { class: 'btn', text: T('set.test_server'), on: { click: test } }), testLine),
          h('div', { class: 'row', style: { marginTop: '10px' } },
            h('button', { class: 'btn', text: T('ci.run_now'), on: { click: async () => {
              try {
                const res = await window.ca.ci.run();
                if (res.ok && res.skipped) toast(T('ci.run_skipped'));
                else if (res.ok) toast(T('ci.run_done', { headline: res.summary.summary.headline }), 'ok');
                else toast(T('ci.run_error', { err: res.error }), 'err');
                await CA_UI.refreshSnapshot();
              } catch (err) {
                toast(T('ci.run_error', { err: err.message }), 'err');
              }
            } } }),
            h('button', { class: 'btn', text: T('ci.open_settings'), on: { click: () => CA_UI.openApp('ci') } })
          ),
          h('div', { class: 'hint', style: { marginTop: '8px' }, text: T('ci.privacy_line') })
        )
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('span', { text: T('ci.storage') })),
        h('div', { class: 'panel-body' },
          h('div', { class: 'mono small', text: CA.snap.ci.config.storage }),
          h('div', { class: 'row', style: { marginTop: '6px' } },
            h('button', { class: 'btn small', text: T('set.open_data'), on: { click: () => window.ca.openPath(CA.snap.app.paths.ci) } }),
            h('span', { class: 'hint', text: T('ci.count') + ' ' + status.count + ' · ' + UI.fmtBytes(status.storageBytes) })
          )
        )
      )
    );
  }

  /* ---------------- video ---------------- */

  function buildVideo() {
    const v = CA.snap.settings.video;
    const quality = h('select', { class: 'select' }, ['auto', 'saver', 'hd'].map((q) => h('option', { value: q, selected: v.quality === q, text: T('video.quality_' + q) })));
    const side = h('select', { class: 'select' },
      h('option', { value: 'left', selected: v.stripSide === 'left', text: T('set.side_left') }),
      h('option', { value: 'right', selected: v.stripSide === 'right', text: T('set.side_right') })
    );
    const split = h('input', { class: 'input', type: 'number', min: '15', max: '40', value: String(Math.round((v.splitRatio || 0.2) * 100)), style: { width: '80px' } });
    const camera = h('select', { class: 'select' }, h('option', { value: '', text: T('set.default') }));
    const mic = h('select', { class: 'select' }, h('option', { value: '', text: T('set.default') }));
    const stateLine = h('div', { class: 'hint', text: '' });
    window.ca.video.mediaAccess().then(() => navigator.mediaDevices.enumerateDevices()).then((list) => {
      for (const d of list.filter((x) => x.kind === 'videoinput')) camera.appendChild(h('option', { value: d.deviceId, selected: d.deviceId === v.cameraId, text: d.label || 'Camera' }));
      for (const d of list.filter((x) => x.kind === 'audioinput')) mic.appendChild(h('option', { value: d.deviceId, selected: d.deviceId === v.micId, text: d.label || 'Microphone' }));
    }).catch((err) => {
      stateLine.textContent = T('video.permission_denied');
      stateLine.style.color = 'var(--red)';
    });
    const save = async () => {
      try {
        await window.ca.settings.setVideo({
          quality: quality.value,
          stripSide: side.value,
          splitRatio: UI.clamp(Number(split.value) / 100, 0.15, 0.4),
          cameraId: camera.value,
          micId: mic.value,
          mirrorSelf: mirror.querySelector('input').checked,
        });
        await CA_UI.refreshSnapshot();
        toast(T('set.saved'), 'ok');
      } catch (err) {
        toast(T('set.error', { err: err.message }), 'err');
      }
    };
    const mirror = UI.checkbox(T('set.video_mirror'), v.mirrorSelf !== false, () => {});
    return section(T('set.video'), T('video.start_hint'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', { text: T('set.video_quality') }), quality),
        h('label', { class: 'field' }, h('span', { text: T('set.video_side') }), side),
        h('label', { class: 'field' }, h('span', { text: T('set.video_split') }), split),
        h('label', { class: 'field' }, h('span', { text: T('set.camera') }), camera),
        h('label', { class: 'field' }, h('span', { text: T('set.mic') }), mic),
        h('div', { class: 'field' }, h('span', { text: '—' }), mirror)
      ),
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', text: T('common.save'), on: { click: save } })),
      stateLine,
      h('div', { class: 'inline-note', style: { marginTop: '12px' }, text: T('video.share_audio_hint') })
    );
  }

  /* ---------------- notifications ---------------- */

  function buildNotify() {
    const n = CA.snap.settings.notify;
    const quiet = n.quietHours || {};
    const saveFlag = (key, value) => window.ca.settings.setNotify({ [key]: value }).catch((e) => toast(e.message, 'err'));
    return section(T('set.notify'), T('set.notify_lede'),
      h('div', { class: 'settings-list' },
        UI.checkbox(T('set.notify_messages'), n.messages !== false, (v) => saveFlag('messages', v)),
        UI.checkbox(T('set.notify_presence'), n.presence !== false, (v) => saveFlag('presence', v)),
        UI.checkbox(T('set.notify_ci'), n.ci !== false, (v) => saveFlag('ci', v))
      ),
      h('div', { class: 'section-label', style: { marginTop: '14px' }, text: T('set.quiet') }),
      h('div', { class: 'row wrap' },
        UI.checkbox(T('set.quiet_enable'), quiet.enabled, (v) => window.ca.settings.setNotify({ quietHours: { enabled: v } })),
        h('span', { class: 'small', text: T('set.quiet_from') }),
        h('input', { class: 'input', type: 'time', value: quiet.from || '23:30', style: { width: '110px' }, on: { change: (e) => window.ca.settings.setNotify({ quietHours: { from: e.target.value } }) } }),
        h('span', { class: 'small', text: T('set.quiet_to') }),
        h('input', { class: 'input', type: 'time', value: quiet.to || '07:30', style: { width: '110px' }, on: { change: (e) => window.ca.settings.setNotify({ quietHours: { to: e.target.value } }) } })
      )
    );
  }

  /* ---------------- privacy ---------------- */

  function buildPrivacy() {
    const chat = CA.snap.chat.stats;
    const ci = CA.snap.ci.status || {};
    return section(T('set.privacy'), T('set.privacy_note'),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('span', { text: T('set.retention') }), h('span', { class: 'mono', text: chat.count + ' MSG' })),
        h('div', { class: 'panel-body' },
          h('div', { class: 'form-line' },
            h('label', { class: 'field', style: { maxWidth: '180px' } },
              h('span', { text: T('set.retention') }),
              h('select', { class: 'select', on: { change: async (e) => {
                await window.ca.settings.setPrivacy({ chatRetentionDays: Number(e.target.value) });
                await CA_UI.refreshSnapshot();
                toast(T('set.saved'), 'ok');
              } } },
                h('option', { value: '0', selected: !CA.snap.settings.privacy.chatRetentionDays, text: T('set.retention_forever') }),
                [30, 90, 365].map((n) => h('option', { value: String(n), selected: CA.snap.settings.privacy.chatRetentionDays === n, text: T('ci.retention_days', { n }) }))
              )
            )
          ),
          h('div', { class: 'row', style: { marginTop: '8px' } },
            h('button', { class: 'btn', text: T('set.export_chat'), on: { click: () => CA_UI.exportChat() } }),
            h('button', { class: 'btn', text: T('set.export_ci'), on: { click: exportCi } }),
            h('button', { class: 'btn danger', text: T('set.clear_chat'), on: { click: async () => {
              if (!(await UI.confirmDialog({ title: T('set.clear_chat'), message: T('chat.clear_confirm'), danger: true, confirmLabel: T('dialog.delete') }))) return;
              await window.ca.chat.clear();
              await CA_UI.refreshSnapshot();
              toast(T('common.done'), 'ok');
            } } }),
            h('button', { class: 'btn danger', text: T('set.clear_ci'), on: { click: async () => {
              if (!(await UI.confirmDialog({ title: T('set.clear_ci'), message: T('ci.clear_confirm'), danger: true, confirmLabel: T('dialog.delete') }))) return;
              await window.ca.ci.clear();
              await CA_UI.refreshSnapshot();
              toast(T('common.done'), 'ok');
            } } })
          ),
          h('div', { class: 'hint', style: { marginTop: '8px' }, text: T('ci.privacy_line') })
        )
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('span', { text: 'DATA' })),
        h('div', { class: 'panel-body' },
          h('dl', { class: 'kv' },
            h('dt', { text: T('ci.count') }), h('dd', { text: String(ci.count || 0) }),
            h('dt', { text: T('ci.bytes') }), h('dd', { text: UI.fmtBytes(ci.storageBytes || 0) }),
            h('dt', { text: T('set.data_path') }), h('dd', { class: 'mono tiny', text: CA.snap.app.paths.data })
          ),
          h('div', { class: 'row', style: { marginTop: '8px' } },
            h('button', { class: 'btn small', text: T('set.open_data'), on: { click: () => window.ca.openPath(CA.snap.app.paths.data) } })
          )
        )
      ),
      h('div', { class: 'section-label', style: { marginTop: '16px' }, text: T('set.danger_zone') }),
      h('div', { class: 'inline-note danger', text: T('set.unpair_confirm') })
    );
  }

  async function exportCi() {
    const data = await window.ca.ci.export();
    const text = JSON.stringify(data, null, 2);
    UI.showDialog({
      title: T('set.export_ci'),
      body: h('textarea', { class: 'textarea', rows: 14, readonly: 'readonly', value: text }),
      width: 640,
      actions: [
        { label: T('common.close'), value: false },
        { label: T('common.copy'), value: true, primary: true },
      ],
    }).then((res) => {
      if (res) UI.copyText(text);
    });
  }

  /* ---------------- about ---------------- */

  function buildAbout() {
    const snap = CA.snap;
    return section('Connect All', T('set.about_text'),
      h('div', { class: 'server-hero', style: { marginTop: '6px' } },
        h('div', { class: 'glyph-box', html: window.icon('link', 28) }),
        h('div', {},
          h('h1', { text: 'Connect All (CA)' }),
          h('p', { text: 'Chat · Video · Calendar · Connect Intelligence' })
        )
      ),
      h('dl', { class: 'kv', style: { marginTop: '14px' } },
        h('dt', { text: T('set.version') }), h('dd', { text: snap.app.version }),
        h('dt', { text: T('set.platform') }), h('dd', { text: snap.app.device.platform }),
        h('dt', { text: T('set.device_id') }), h('dd', { class: 'mono', text: snap.app.device.id }),
        h('dt', { text: T('set.data_path') }), h('dd', { class: 'mono tiny', text: snap.app.paths.data }),
        h('dt', { text: T('set.sas') }), h('dd', { class: 'mono', text: snap.app.pairing.paired ? snap.app.pairing.sas : '—' })
      ),
      h('div', { class: 'inline-note', style: { marginTop: '14px' }, text: T('set.credits') }),
      h('div', { class: 'inline-note', style: { marginTop: '8px' }, text: T('ci.privacy_line') }),
      h('div', { class: 'row', style: { marginTop: '14px' } },
        h('button', { class: 'btn', text: T('nav.about'), on: { click: () => window.ca.about() } }),
        h('button', { class: 'btn', text: T('set.open_data'), on: { click: () => window.ca.openPath(snap.app.paths.data) } }),
        h('button', { class: 'btn', text: T('set.open_server_window'), on: { click: () => window.ca.window.openServer() } })
      )
    );
  }

  /* ---------------- shell ---------------- */

  function mount({ body, opts }) {
    const nav = h('aside', { class: 'settings-nav' });
    const content = h('div', { class: 'settings-content scroll' });
    body.appendChild(h('div', { class: 'settings-app' }, h('div', { class: 'settings-main' }, nav, content)));
    refs = { nav, content, body };
    if (opts && opts.tab) activeTab = opts.tab;
    renderNav();
    renderContent();
    CA_UI.setFooter('settings', [
      h('span', { text: 'CONNECT ALL ' + (CA.snap.app.version || '') }),
      h('span', { text: '·' }),
      h('span', { text: CA.snap.app.device.platform }),
      h('span', { class: 'grow' }),
      h('span', { class: 'mono tiny', text: '…/' + CA.snap.app.paths.data.split('/').slice(-2).join('/') }),
    ]);
    window.ca.pairing.status().then((s) => {
      if (s && s.state && s.state !== 'idle') {
        pair.status = s;
        if (activeTab === 'pairing') renderContent();
      }
    }).catch(() => {});
  }

  function event(evt) {
    if (!refs) return;
    if (evt.type === 'pairing') {
      pair.status = evt.payload || pair.status;
      if (pair.status.code) pair.code = pair.status.code;
      if (activeTab === 'pairing') renderContent();
    } else if (evt.type === 'paired') {
      CA_UI.refreshSnapshot().then(() => {
        if (activeTab === 'pairing') renderContent();
      });
    } else if (evt.type === 'snapshot') {
      if (activeTab === 'pairing' || activeTab === 'server') renderContent();
    } else if (evt.type === 'ci-status' || evt.type === 'ci-config') {
      if (activeTab === 'ci') renderContent();
    } else if (evt.type === 'backup') {
      if (activeTab === 'server') renderContent();
    }
  }

  function setTab(tab) {
    if (tab) {
      activeTab = tab;
      if (refs) {
        renderNav();
        renderContent();
      }
    }
  }

  window.CA_APPS.settings = {
    titleKey: 'set.title',
    layout: { x: 120, y: 24, w: 780, h: 636, minW: 620, minH: 480 },
    mount,
    event,
    setTab,
    resize: () => {},
  };
})();
