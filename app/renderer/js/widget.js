'use strict';
/* Connect All — floating calendar widget. */

(function () {
  const { h, icon } = UI;
  let data = null;
  let refs = null;

  function clockText() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function dateText() {
    const d = new Date();
    const base = d.toLocaleDateString(CA_LANG === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric' });
    const wd = d.toLocaleDateString(CA_LANG === 'en' ? 'en-US' : 'zh-CN', { weekday: 'short' });
    return base + ' ' + wd;
  }
  function timeText(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function dayLabel(ts) {
    const today = new Date();
    const target = new Date(ts);
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const tStart = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
    const diff = Math.round((tStart - start) / 86400000);
    if (diff === 0) return T('common.today');
    if (diff === 1) return T('widget.tomorrow');
    return target.toLocaleDateString(CA_LANG === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric' });
  }

  function renderFrame() {
    const root = document.getElementById('widget-root');
    UI.clear(root);
    const shell = h('div', { class: 'widget-shell' });
    const win = h('div', { class: 'widget-window', on: { dblclick: () => window.caWidget.openMain() } });
    const title = h('span', { class: 'title', text: T('widget.title') });
    const close = h('button', { class: 'tb-box tb-close', title: T('widget.close'), on: { click: () => window.caWidget.close() } });
    const titlebar = h('div', { class: 'titlebar' }, close, title);
    const body = h('div', { class: 'widget-body' });
    const top = h('div', { class: 'widget-top' });
    const agenda = h('div', { class: 'widget-agenda' });
    const foot = h('div', { class: 'widget-foot' });
    body.append(top, agenda, foot);
    win.append(titlebar, body);
    shell.appendChild(win);
    root.appendChild(shell);
    refs = { top, agenda, foot };
    render();
  }

  function render() {
    if (!refs || !data) return;
    const top = refs.top;
    UI.clear(top);
    const presence = data.presence || {};
    const peer = presence.peer;
    const peerState = peer ? peer.state : 'offline';
    const linked = data.link && data.link.online;
    top.append(
      h('span', { class: 'clock', text: clockText() }),
      h('span', { class: 'mono', text: dateText() }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'led ' + (linked ? 'on' : peerState === 'online' ? 'on' : '') }),
      h('span', { class: 'widget-person', text: data.peer ? peer ? data.peer.name + ' · ' + UI.presenceLabel(peerState) : data.peer.name : T('status.unpaired') })
    );
    // Agenda
    const agenda = refs.agenda;
    UI.clear(agenda);
    const cal = data.calendar || {};
    const all = (cal.all || []).filter((ev) => ev.end > Date.now() - 3600000);
    if (!all.length) {
      agenda.appendChild(
        h(
          'div',
          { class: 'widget-empty-state' },
          h('div', { class: 'glyph', html: window.icon('calendar', 22) }),
          h('div', { class: 't', text: T('widget.none') }),
          h('div', { class: 'h', text: T('widget.open') })
        )
      );
    } else {
      const shown = all.slice(0, 5);
      let lastDay = '';
      for (const ev of shown) {
        const label = dayLabel(ev.start);
        if (label !== lastDay) {
          agenda.appendChild(h('div', { class: 'widget-empty', style: { color: 'var(--ink-soft)' }, text: label }));
          lastDay = label;
        }
        agenda.appendChild(
          h(
            'div',
            { class: 'widget-day ' + (ev.owner === 'peer' ? 'peer' : ''), title: ev.summary + (ev.location ? ' @ ' + ev.location : '') },
            h('span', { class: 'time', text: ev.allDay ? T('cal.all_day') : timeText(ev.start) }),
            h('span', { class: 'name', text: (ev.owner === 'peer' ? '◌ ' : '') + ev.summary })
          )
        );
      }
      if (all.length > shown.length) {
        agenda.appendChild(h('div', { class: 'widget-empty', text: T('widget.more', { n: all.length - shown.length }) }));
      }
    }
    // Footer
    const foot = refs.foot;
    UI.clear(foot);
    const pinned = data.widget && data.widget.pinned !== false;
    foot.append(
      h('button', {
        class: 'widget-pin ' + (pinned ? 'on' : ''),
        title: T('widget.pinned'),
        text: pinned ? 'PIN' : '—',
        on: {
          click: async (e) => {
            e.stopPropagation();
            const next = !(data.widget && data.widget.pinned);
            await window.caWidget.pin(next);
            data.widget = Object.assign({}, data.widget, { pinned: next });
            render();
          },
        },
      }),
      h('span', { text: T('widget.updated', { t: UI.fmtClock(data.now || Date.now()) }) }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'led ' + (linked ? 'on' : '') }),
      h('span', { text: linked ? (data.link.via === 'lan' ? 'LAN' : 'RELAY') : T('widget.offline') })
    );
  }

  async function boot() {
    try {
      data = await window.caWidget.state();
    } catch (err) {
      document.body.textContent = 'Connect All widget failed: ' + err.message;
      return;
    }
    window.CA_LANG = (data && data.lang) || 'zh';
    renderFrame();
    setInterval(() => {
      if (!refs) return;
      const clock = refs.top.querySelector('.clock');
      if (clock) clock.textContent = clockText();
    }, 15000);
    window.caWidget.onState((next) => {
      data = next;
      window.CA_LANG = data.lang || window.CA_LANG;
      render();
    });
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
