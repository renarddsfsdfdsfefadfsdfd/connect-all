'use strict';
/* Connect All — Connect Chat window. */

(function () {
  const { h, icon, toast } = UI;

  const state = {
    messages: [],
    unread: 0,
    typingUntil: 0,
    typingTimer: null,
    peerName: 'Partner',
    searchOpen: false,
    lastMarked: 0,
    renderCount: 0,
  };

  let refs = null;

  function peerName() {
    const peer = CA.snap && CA.snap.app.pairing.peer;
    return peer ? peer.name : T('chat.partner');
  }

  function paired() {
    return Boolean(CA.snap && CA.snap.app.pairing.paired);
  }

  function messageState(m) {
    if (m.from !== 'me') return '';
    return '<span class="state" data-state="' + m.id + '">' + T('chat.state_' + (m.state || 'sending')) + '</span>';
  }

  function renderHeader() {
    if (!refs) return;
    const head = refs.head;
    UI.clear(head);
    const peer = CA.snap.app.pairing.peer;
    const presence = CA.snap.presence || {};
    const peerState = presence.peer ? presence.peer.state : paired() ? 'offline' : 'offline';
    const linked = CA.snap.link && CA.snap.link.online;
    head.append(
      UI.avatar(peer ? peer.name : 'CA', 32),
      h(
        'div',
        { class: 'grow' },
        h(
          'div',
          { class: 'who' },
          h('span', { text: peer ? peer.name : 'Connect Chat' }),
          paired() ? h('span', { class: 'tag inv', text: 'E2E' }) : h('span', { class: 'tag', text: T('status.unpaired') })
        ),
        h(
          'div',
          { class: 'sub' },
          paired() ? UI.presenceLed(peerState) : h('span', { class: 'led' }),
          h('span', { text: paired() ? UI.presenceLabel(peerState) : T('chat.unpaired_title') + ' · ' + T('chat.pair_cta') }),
          paired() && presence.peer && presence.peer.place ? h('span', { text: '· ' + presence.peer.place }) : null,
          paired() ? h('span', { text: linked ? '· ' + (CA.snap.link.via === 'lan' ? 'LAN' : 'RELAY') : '· ' + T('common.offline') }) : null
        )
      ),
      h(
        'div',
        { class: 'head-actions' },
        h('button', { class: 'btn small', title: T('chat.search_title'), on: { click: openSearch } }, UI.icon('search', 12), h('span', { text: T('common.search') })),
        h('button', { class: 'btn small', title: T('chat.clear'), on: { click: clearChat } }, UI.icon('trash', 12))
      )
    );
  }

  function recapNode() {
    const ci = CA.snap.ci || {};
    const summaries = ci.summaries || [];
    if (!summaries.length) return null;
    const last = summaries[0];
    if (!last || !last.summary) return null;
    const un = (last.summary.unanswered || []).length;
    const pr = (last.summary.promises || []).length;
    const text = h('div', { class: 'text' });
    text.append(
      h('b', { text: T('chat.recap_label') + ' · ' + last.summary.headline }),
      h(
        'div',
        { class: 'small muted' },
        [
          un ? T('chat.recap_unanswered', { n: un }) : null,
          pr ? T('chat.recap_promise', { n: pr }) : null,
          !un && !pr ? T('chat.recap_empty') : null,
        ]
          .filter(Boolean)
          .join(' · ')
      )
    );
    const btn = h('button', { class: 'btn small', text: T('chat.recap_open'), on: { click: () => CA_UI.openApp('ci') } });
    return h('div', { class: 'chat-recap' }, h('div', { class: 'ci-mark', text: 'CI' }), text, btn);
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function messageNode(m) {
    const mine = m.from === 'me';
    const name = mine ? T('chat.you') : peerName();
    const meta = h(
      'div',
      { class: 'msg-meta' },
      h('span', { class: 'from', text: name }),
      h('span', { text: UI.fmtClock(m.at) })
    );
    const bubble = h('div', { class: 'bubble ' + (m.state === 'queued' || m.state === 'sending' ? 'queued' : '') });
    bubble.textContent = m.text;
    if (mine) {
      const st = h('span', { class: 'state', dataset: { state: m.id }, text: T('chat.state_' + (m.state || 'sending')) });
      bubble.appendChild(st);
      if (m.state === 'sent') st.textContent = '✓';
      else if (m.state === 'delivered') st.textContent = '✓✓';
      else st.textContent = T('chat.state_' + (m.state || 'sending'));
    }
    return h('div', { class: 'msg-row ' + (mine ? 'me' : 'peer'), dataset: { id: m.id } }, h('div', { class: 'msg-stack' }, meta, bubble));
  }

  function renderMessages({ preserveScroll = false, atBottom = null } = {}) {
    if (!refs) return;
    const log = refs.log;
    const oldHeight = log.scrollHeight;
    const oldTop = log.scrollTop;
    const wasBottom = atBottom == null ? log.scrollHeight - log.scrollTop - log.clientHeight < 80 : atBottom;
    UI.clear(log);
    if (!paired()) {
      log.appendChild(
        UI.empty(
          UI.icon('link', 26),
          T('chat.unpaired_title'),
          T('chat.unpaired_desc'),
          h('button', {
            class: 'btn primary',
            text: T('chat.pair_cta'),
            on: { click: () => CA_UI.openApp('settings', { tab: 'pairing' }) },
          })
        )
      );
      return;
    }
    if (!state.messages.length) {
      log.appendChild(UI.empty(UI.icon('chat', 26), T('chat.empty_title'), T('chat.empty_desc')));
      return;
    }
    let lastDay = '';
    let unreadBoundaryId = null;
    if (state.unread > 0) {
      let seen = 0;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i].from === 'peer') {
          seen++;
          if (seen === state.unread) {
            unreadBoundaryId = state.messages[i].id;
            break;
          }
        }
      }
    }
    for (const m of state.messages) {
      const key = dayKey(m.at);
      if (key !== lastDay) {
        log.appendChild(h('div', { class: 'date-sep', text: UI.fmtDay(m.at) }));
        lastDay = key;
      }
      if (unreadBoundaryId && m.id === unreadBoundaryId) {
        log.appendChild(h('div', { class: 'unread-sep', text: T('chat.unread') }));
      }
      if (m.from === 'system') {
        log.appendChild(h('div', { class: 'msg-row system' }, h('div', { class: 'bubble', text: m.text })));
      } else {
        log.appendChild(messageNode(m));
      }
    }
    if (wasBottom) log.scrollTop = log.scrollHeight;
    else if (preserveScroll) log.scrollTop = log.scrollHeight - oldHeight + oldTop;
  }

  function renderRecap() {
    if (!refs || !refs.recap) return;
    const log = refs.log;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
    UI.clear(refs.recap);
    const node = recapNode();
    if (node) refs.recap.appendChild(node);
    refs.recap.classList.toggle('hidden', !node);
    if (atBottom) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  }

  function renderTyping() {
    if (!refs) return;
    const active = state.typingUntil > Date.now();
    refs.typing.classList.toggle('hidden', !active);
    if (active) {
      UI.clear(refs.typing);
      refs.typing.append(
        h('span', { class: 'typing-dots' }, h('i'), h('i'), h('i')),
        h('span', { text: T('chat.typing', { name: peerName() }) })
      );
      clearTimeout(state.typingTimer);
      state.typingTimer = setTimeout(() => {
        state.typingUntil = 0;
        renderTyping();
      }, 4500);
    }
  }

  function updateFooter() {
    if (!refs) return;
    const link = CA.snap.link || {};
    const nodes = [
      h('span', { class: 'tag', text: 'E2E' }),
      h('span', { text: link.online ? (link.via === 'lan' ? 'LAN' : 'RELAY') : T('common.offline') }),
      h('span', { text: '·' }),
      h('span', { text: 'QUEUE ' + (link.queue || 0) }),
      h('span', { text: '·' }),
      h('span', { text: (state.messages.length || 0) + ' MSG' }),
      h('span', { class: 'grow' }),
      h('span', { text: T('chat.subtitle') }),
    ];
    CA_UI.setFooter('chat', nodes);
  }

  function markRead() {
    if (!paired() || !state.unread) return;
    if (!document.hasFocus()) return;
    const now = Date.now();
    if (now - state.lastMarked < 1200) return;
    state.lastMarked = now;
    window.ca.chat.markRead().catch(() => {});
    state.unread = 0;
    renderMessages();
  }

  function scrollBottom() {
    if (!refs) return;
    requestAnimationFrame(() => {
      refs.log.scrollTop = refs.log.scrollHeight;
    });
  }

  function applyComposerState() {
    if (!refs) return;
    const isPaired = paired();
    refs.input.disabled = !isPaired;
    refs.input.placeholder = isPaired ? T('chat.placeholder') : T('chat.unpaired_desc');
    const sendBtn = refs.input.parentElement.querySelector('button');
    if (sendBtn) sendBtn.disabled = !isPaired;
  }

  function send() {
    if (!refs) return;
    const text = refs.input.value.trim();
    if (!text) return;
    if (!paired()) {
      toast(T('toast.pairing_required'), 'err');
      return;
    }
    refs.input.value = '';
    autoGrow();
    window.ca.chat.typing(false);
    window.ca.chat
      .send(text)
      .then(() => {
        // The session broadcasts the new message back; keep the box responsive.
      })
      .catch((err) => {
        toast(T('toast.error', { err: err.message }), 'err');
        refs.input.value = text;
        autoGrow();
      });
  }

  function autoGrow() {
    if (!refs) return;
    refs.input.style.height = 'auto';
    refs.input.style.height = Math.min(120, Math.max(38, refs.input.scrollHeight)) + 'px';
  }

  function openSearch() {
    const input = h('input', { class: 'input', placeholder: T('chat.search_placeholder') });
    const results = h('div', { class: 'scroll', style: { maxHeight: '340px', marginTop: '8px' } });
    const body = h('div', {}, input, results);
    let timer = null;
    const run = async () => {
      const q = input.value.trim();
      UI.clear(results);
      if (!q) return;
      try {
        const list = await window.ca.chat.search(q);
        if (!list.length) {
          results.appendChild(h('div', { class: 'hint', text: T('chat.no_results') }));
          return;
        }
        for (const m of list) {
          results.appendChild(
            h(
              'div',
              { class: 'panel', style: { marginBottom: '4px' } },
              h(
                'div',
                { class: 'panel-head' },
                h('span', { text: (m.from === 'me' ? T('chat.you') : peerName()) + ' · ' + UI.fmtDateTime(m.at) }),
                h('span', { class: 'mono', text: m.state || '' })
              ),
              h('div', { class: 'panel-body', style: { userSelect: 'text' }, text: m.text })
            )
          );
        }
      } catch (err) {
        results.appendChild(h('div', { class: 'hint', text: err.message }));
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 240);
    });
    UI.showDialog({
      title: T('chat.search_title'),
      body,
      actions: [{ label: T('common.close'), primary: true }],
      width: 620,
    });
    setTimeout(() => input.focus(), 40);
  }

  async function clearChat() {
    if (!(await UI.confirmDialog({ title: T('chat.clear'), message: T('chat.clear_confirm'), danger: true, confirmLabel: T('dialog.delete') }))) return;
    try {
      await window.ca.chat.clear();
      state.messages = [];
      state.unread = 0;
      renderMessages();
      updateFooter();
      toast(T('common.done'), 'ok');
    } catch (err) {
      toast(T('toast.error', { err: err.message }), 'err');
    }
  }

  function loadEarlier() {
    if (!refs || !state.messages.length) return;
    const before = state.messages[0].at;
    window.ca.chat
      .list({ limit: 200, before })
      .then((res) => {
        if (!res.messages || !res.messages.length) {
          toast(T('common.none'));
          return;
        }
        const existing = new Set(state.messages.map((m) => m.id));
        const prepend = res.messages.filter((m) => !existing.has(m.id));
        state.messages = prepend.concat(state.messages);
        renderMessages({ preserveScroll: true });
        updateFooter();
      })
      .catch(() => {});
  }

  function buildComposer() {
    const input = h('textarea', {
      placeholder: T('chat.placeholder'),
      rows: 1,
      spellcheck: 'false',
    });
    input.addEventListener('input', () => {
      autoGrow();
      if (paired()) window.ca.chat.typing(true);
      clearTimeout(buildComposer._t);
      buildComposer._t = setTimeout(() => {
        if (paired()) window.ca.chat.typing(false);
      }, 2600);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    const sendBtn = h('button', { class: 'btn primary', on: { click: send } }, UI.icon('send', 13), h('span', { text: T('chat.send') }));
    const tools = h(
      'div',
      { class: 'tools' },
      h('span', { class: 'tag', text: 'E2E · AES-256-GCM' }),
      h('span', { class: 'grow' }),
      h('span', { class: 'hint', text: 'Enter ↵ · Shift+Enter' })
    );
    const composer = h(
      'div',
      { class: 'composer' },
      h('div', { class: 'row-main' }, input, sendBtn),
      tools
    );
    return { composer, input };
  }

  function mount({ body, opts }) {
    const head = h('div', { class: 'chat-head' });
    const recap = h('div', { class: 'chat-recap-slot hidden' });
    const log = h('div', { class: 'chat-log scroll' });
    const typing = h('div', { class: 'typing-line hidden' });
    const { composer, input } = buildComposer();
    body.appendChild(h('div', { class: 'chat-app' }, head, recap, log, typing, composer));
    refs = { head, recap, log, typing, input, body };
    applyComposerState();
    state.messages = (CA.snap.chat.messages || []).slice();
    state.unread = CA.snap.chat.unread || 0;
    renderHeader();
    applyComposerState();
    renderRecap();
    renderMessages({ atBottom: true });
    updateFooter();
    if (paired() && state.unread) setTimeout(markRead, 400);
    if (opts && opts.search) setTimeout(openSearch, 300);
    log.addEventListener('scroll', () => {
      if (log.scrollTop < 10 && state.messages.length) {
        // top reached: load earlier on demand once per gesture
        if (!state._loadingEarlier) {
          state._loadingEarlier = true;
          setTimeout(() => (state._loadingEarlier = false), 1500);
          if (state.messages.length >= 100) loadEarlier();
        }
      }
      if (paired() && state.unread && log.scrollHeight - log.scrollTop - log.clientHeight < 40) markRead();
    });
    window.addEventListener('focus', markRead);
  }

  function event(evt) {
    if (!refs) return;
    switch (evt.type) {
      case 'snapshot':
        applyComposerState();
        state.messages = (evt.payload.chat.messages || []).slice();
        state.unread = evt.payload.chat.unread || 0;
        renderHeader();
        renderRecap();
        renderMessages();
        updateFooter();
        break;
      case 'chat-message': {
        const msg = evt.payload.message;
        if (!msg) break;
        if (state.messages.some((m) => m.id === msg.id)) break;
        state.messages.push(msg);
        const nearBottom = refs.log.scrollHeight - refs.log.scrollTop - refs.log.clientHeight < 90;
        if (msg.from === 'peer') {
          state.unread = evt.payload.unread != null ? evt.payload.unread : state.unread + 1;
          if (CA.activeApp === 'chat' && document.hasFocus()) setTimeout(markRead, 500);
        }
        renderMessages({ atBottom: nearBottom });
        if (nearBottom) scrollBottom();
        updateFooter();
        break;
      }
      case 'chat-update': {
        const target = state.messages.find((m) => m.id === evt.payload.id);
        if (target && evt.payload.state) target.state = evt.payload.state;
        const node = refs.log.querySelector('[data-state="' + CSS.escape(evt.payload.id || '') + '"]');
        if (node && evt.payload.state) {
          node.textContent =
            evt.payload.state === 'delivered' ? '✓✓' : evt.payload.state === 'sent' ? '✓' : T('chat.state_' + evt.payload.state);
        }
        break;
      }
      case 'chat-read':
        state.unread = 0;
        renderMessages();
        break;
      case 'chat-reload':
        window.ca.chat.list({ limit: 300 }).then((res) => {
          state.messages = res.messages;
          state.unread = res.unread;
          renderMessages();
          updateFooter();
        });
        break;
      case 'presence':
      case 'link':
        renderHeader();
        updateFooter();
        break;
      case 'peer-typing':
        if (evt.payload && evt.payload.typing) {
          state.typingUntil = Date.now() + 4000;
          renderTyping();
        } else {
          state.typingUntil = 0;
          renderTyping();
        }
        break;
      case 'ci-summary':
      case 'ci-status':
      case 'ci-config':
        renderRecap();
        break;
      case 'unpaired':
        state.messages = [];
        state.unread = 0;
        applyComposerState();
        renderHeader();
        renderMessages();
        break;
      case 'paired':
        applyComposerState();
        renderHeader();
        renderRecap();
        renderMessages();
        scrollBottom();
        break;
      default:
        break;
    }
  }

  function focus() {
    markRead();
    if (refs && refs.input) refs.input.focus();
  }

  function destroy() {
    window.removeEventListener('focus', markRead);
    refs = null;
  }

  window.CA_APPS.chat = {
    titleKey: 'chat.title',
    layout: { x: 96, y: 16, w: 560, h: 548, minW: 420, minH: 360 },
    mount,
    event,
    focus,
    destroy,
  };
})();
