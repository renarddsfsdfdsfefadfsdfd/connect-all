'use strict';
/* Connect All — Connect Calendar window (ICS import + shared month view). */

(function () {
  const { h, icon, toast } = UI;

  const state = {
    view: new Date(),
    selected: new Date(),
    events: [],
    mine: [],
    partner: [],
    sources: [],
    share: {},
    loading: false,
  };

  let refs = null;

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function mondayIndex(d) {
    return (d.getDay() + 6) % 7;
  }
  function gridStart() {
    return addDays(startOfMonth(state.view), -mondayIndex(startOfMonth(state.view)));
  }
  function gridEnd() {
    return addDays(gridStart(), 42);
  }

  function sourceName(id) {
    const src = state.sources.find((s) => s.id === id);
    return src ? src.name : '';
  }

  function eventsOn(day) {
    const from = startOfDay(day).getTime();
    const to = addDays(day, 1).getTime();
    return state.events
      .filter((ev) => ev.end > from && ev.start < to)
      .sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
  }

  async function loadMonth() {
    if (!refs) return;
    state.loading = true;
    renderGrid();
    const from = gridStart().getTime();
    const to = gridEnd().getTime();
    try {
      const res = await window.ca.calendar.events(from, to);
      state.events = res.all || [];
      state.mine = res.mine || [];
      state.partner = res.partner || [];
    } catch (err) {
      console.error('calendar load failed', err);
    } finally {
      state.loading = false;
      renderGrid();
      renderSide();
      renderHeader();
    }
  }

  function renderHeader() {
    if (!refs) return;
    UI.clear(refs.head);
    const monthLabel = UI.fmtMonthYear(state.view);
    refs.head.append(
      h('button', { class: 'btn icon', title: T('cal.month_prev'), on: { click: () => shiftMonth(-1) } }, UI.icon('arrow_left', 12)),
      h('button', { class: 'btn icon', title: T('cal.month_next'), on: { click: () => shiftMonth(1) } }, UI.icon('arrow_right', 12)),
      h('span', { class: 'month', text: monthLabel }),
      h('button', { class: 'btn small', text: T('cal.today_btn'), on: { click: goToday } }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', on: { click: openImport }, title: T('cal.add_ics') }, UI.icon('plus', 12), h('span', { text: T('cal.add_ics') })),
      h('button', { class: 'btn small', on: { click: requestPartner }, title: T('cal.request_sync') }, UI.icon('refresh', 12), h('span', { text: T('cal.request_sync') })),
      h('button', { class: 'btn small', on: { click: toggleWidget }, title: T('cal.widget') }, UI.icon('widget', 12))
    );
  }

  function renderWeekdays() {
    if (!refs) return;
    UI.clear(refs.weekdays);
    UI.weekdayNames(CA.lang, true).forEach((name, index) => {
      refs.weekdays.appendChild(h('div', { class: index >= 5 ? 'wkend' : '', text: name }));
    });
  }

  function V_showTime(show, ev, label) { return show && !ev.allDay; }

  function renderGrid() {
    if (!refs) return;
    const grid = refs.grid;
    UI.clear(grid);
    const start = gridStart();
    const today = new Date();
    const cellWidth = (grid.clientWidth || 300) / 7;
    const showTime = cellWidth > 72;
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i);
      const inMonth = day.getMonth() === state.view.getMonth();
      const isToday = sameDay(day, today);
      const selected = sameDay(day, state.selected);
      const cell = h('div', {
        class:
          'cal-cell' +
          (inMonth ? '' : ' other') +
          (day.getDay() === 0 || day.getDay() === 6 ? ' weekend' : '') +
          (isToday ? ' today' : '') +
          (selected ? ' selected' : ''),
        on: {
          click: () => {
            state.selected = day;
            if (!inMonth) {
              state.view = startOfMonth(day);
              loadMonth();
            } else {
              renderGrid();
              renderSide();
            }
          },
          dblclick: () => {
            state.selected = day;
            openImport();
          },
        },
      });
      cell.appendChild(h('div', { class: 'num' }, isToday ? h('span', { class: 'day', text: String(day.getDate()) }) : h('span', { text: String(day.getDate()) })));
      const list = eventsOn(day);
      const shown = list.slice(0, 2);
      for (const ev of shown) {
        const timeLabel = ev.allDay ? T('cal.all_day') : UI.fmtClock(ev.start);
        cell.appendChild(
          h(
            'div',
            {
              class: 'ev ' + (ev.owner === 'peer' ? 'peer' : '') + (ev.allDay ? ' allday' : ''),
              title: (ev.owner === 'peer' ? T('cal.partner') + ' · ' : '') + (ev.allDay ? T('cal.all_day') : timeLabel) + '  ' + ev.summary + (ev.location ? ' @ ' + ev.location : ''),
            },
            h('span', { class: 'evt', text: (V_showTime(showTime, ev, timeLabel) ? timeLabel + ' ' : '') + ev.summary })
          )
        );
      }
      if (list.length > shown.length) {
        cell.appendChild(h('div', { class: 'more', text: '+' + (list.length - shown.length) }));
      }
      grid.appendChild(cell);
    }
    if (state.loading) {
      refs.gridWrap.classList.add('loading');
    } else {
      refs.gridWrap.classList.remove('loading');
    }
  }

  function renderSide() {
    if (!refs) return;
    const side = refs.side;
    UI.clear(side);
    const day = state.selected;
    const list = eventsOn(day);
    side.appendChild(h('div', { class: 'side-head' }, UI.icon('calendar', 12), h('span', { text: UI.fmtDate(day) })));
    const scroll = h('div', { class: 'side-scroll scroll' });
    side.appendChild(scroll);
    if (!list.length) {
      scroll.appendChild(h('div', { class: 'hint', style: { padding: '6px 2px' }, text: T('cal.no_events') }));
    } else {
      for (const ev of list) {
        const time = ev.allDay ? T('cal.all_day') : UI.fmtClock(ev.start) + (ev.end ? '–' + UI.fmtClock(ev.end) : '');
        scroll.appendChild(
          h(
            'div',
            { class: 'cal-day-item ' + (ev.owner === 'peer' ? 'peer' : '') },
            h('div', { class: 'time', text: time }),
            h(
              'div',
              { class: 'body' },
              h('div', { class: 'name', text: ev.summary, title: ev.summary }),
              h(
                'div',
                { class: 'loc' },
                (ev.owner === 'peer' ? T('cal.partner') : T('cal.mine')) +
                  (ev.location ? ' · ' + ev.location : '') +
                  (sourceName(ev.calendarId) ? ' · ' + sourceName(ev.calendarId) : '')
              )
            )
          )
        );
      }
    }
    // Sources
    scroll.appendChild(h('div', { class: 'section-label', style: { marginTop: '10px' }, text: T('cal.sources') }));
    if (!state.sources.length) {
      scroll.appendChild(h('div', { class: 'hint', text: T('cal.empty_desc') }));
      scroll.appendChild(
        h('div', { class: 'row', style: { marginTop: '6px' } }, h('button', { class: 'btn small', text: T('cal.add_ics'), on: { click: openImport } }))
      );
    }
    for (const src of state.sources) {
      const enable = h('input', {
        type: 'checkbox',
        checked: src.enabled !== false,
        on: {
          change: async () => {
            await window.ca.calendar.toggle(src.id, enable.checked);
            await CA_UI.refreshSnapshot();
            state.sources = CA.snap.calendar.sources;
            state.share = CA.snap.calendar.share;
            loadMonth();
          },
        },
      });
      const refreshBtn = h(
        'button',
        {
          class: 'btn small',
          title: T('common.refresh'),
          on: {
            click: async () => {
              const res = await window.ca.calendar.refresh(src.id).catch((e) => ({ ok: false, error: e.message }));
              if (res.ok) toast(T('cal.refresh_done', { n: res.count || 0 }), 'ok');
              else toast(T('cal.error', { err: res.error }), 'err');
              await CA_UI.refreshSnapshot();
              loadMonth();
            },
          },
        },
        UI.icon('refresh', 11)
      );
      const del = h(
        'button',
        {
          class: 'btn small',
          title: T('common.remove'),
          on: {
            click: async () => {
              if (!(await UI.confirmDialog({ title: T('common.remove'), message: T('cal.delete_source'), danger: true, confirmLabel: T('common.remove') }))) return;
              await window.ca.calendar.remove(src.id);
              await CA_UI.refreshSnapshot();
              state.sources = CA.snap.calendar.sources;
              loadMonth();
            },
          },
        },
        UI.icon('trash', 11)
      );
      scroll.appendChild(
        h(
          'div',
          { class: 'cal-source' },
          h('label', { class: 'check' }, enable, h('span', { class: 'box' })),
          h('span', { class: 'name', title: src.name, text: src.name }),
          h('span', { class: 'meta', text: String(src.eventCount || 0) }),
          src.kind === 'ics-url' ? refreshBtn : null,
          del
        )
      );
      if (src.lastError) scroll.appendChild(h('div', { class: 'hint', style: { color: 'var(--red)' }, text: src.lastError }));
    }
    scroll.appendChild(
      h(
        'div',
        { class: 'row', style: { marginTop: '5px' } },
        h('button', { class: 'btn small', text: T('cal.import_file'), on: { click: importFile } }),
        h('button', { class: 'btn small', text: T('cal.import_url'), on: { click: importUrl } }),
        h('button', { class: 'btn small', text: T('cal.import_text'), on: { click: importPaste } })
      )
    );

    // Partner
    scroll.appendChild(h('div', { class: 'section-label', style: { marginTop: '12px' }, text: T('cal.partner_sync') }));
    const partner = (CA.snap.calendar && CA.snap.calendar.partner) || {};
    scroll.appendChild(
      h(
        'div',
        { class: 'small' },
        h('div', { class: 'row' }, h('span', { text: partner.count ? T('cal.partner_count', { n: partner.count }) : T('cal.partner_none') })),
        partner.receivedAt ? h('div', { class: 'hint', text: T('common.ago', { t: UI.fmtRelative(partner.receivedAt) }) }) : null
      )
    );
    scroll.appendChild(
      h(
        'div',
        { class: 'row', style: { marginTop: '4px' } },
        UI.checkbox(T('cal.share'), state.share.share !== false, async (checked) => {
          await window.ca.calendar.share(checked);
          await CA_UI.refreshSnapshot();
          state.share = CA.snap.calendar.share;
          renderSide();
        }),
        UI.checkbox(T('cal.hide_private'), state.share.hidePrivate !== false, async (checked) => {
          await window.ca.calendar.hidePrivate(checked);
          await CA_UI.refreshSnapshot();
          state.share = CA.snap.calendar.share;
          loadMonth();
        })
      )
    );
    if (state.share.share !== false) scroll.appendChild(h('div', { class: 'hint', text: T('cal.privacy_note') }));

    // Widget
    scroll.appendChild(h('div', { class: 'section-label', style: { marginTop: '12px' }, text: T('cal.widget') }));
    scroll.appendChild(
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn small', text: T('cal.widget_show'), on: { click: () => { window.ca.widget.show().then(() => toast(T('toast.widget_on'), 'ok')); } } }),
        h('button', { class: 'btn small', text: T('cal.widget_hide'), on: { click: () => { window.ca.widget.hide().then(() => toast(T('toast.widget_off'))); } } })
      )
    );
  }

  function shiftMonth(delta) {
    state.view = new Date(state.view.getFullYear(), state.view.getMonth() + delta, 1);
    state.selected = new Date(state.view.getFullYear(), state.view.getMonth(), 1);
    loadMonth();
  }

  function goToday() {
    const now = new Date();
    state.view = startOfMonth(now);
    state.selected = now;
    loadMonth();
  }

  function openImport() {
    const body = h(
      'div',
      { class: 'col' },
      h('div', { class: 'hint', text: T('cal.privacy_note') }),
      h(
        'div',
        { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
        h('button', { class: 'btn primary', text: T('cal.import_file'), on: { click: async () => { UI.closeTopDialog(); importFile(); } } }),
        h('button', { class: 'btn', text: T('cal.import_url'), on: { click: async () => { UI.closeTopDialog(); importUrl(); } } }),
        h('button', { class: 'btn', text: T('cal.import_text'), on: { click: async () => { UI.closeTopDialog(); importPaste(); } } })
      )
    );
    UI.showDialog({ title: T('cal.add_ics'), body, actions: [{ label: T('common.cancel'), primary: true }] });
  }

  async function importFile() {
    try {
      const res = await window.ca.calendar.importFile();
      if (res && res.ok) {
        await CA_UI.refreshSnapshot();
        state.sources = CA.snap.calendar.sources;
        state.share = CA.snap.calendar.share;
        toast(T('cal.imported', { name: res.source.name }), 'ok');
        loadMonth();
      }
    } catch (err) {
      toast(T('cal.error', { err: err.message }), 'err');
    }
  }

  async function importUrl() {
    const url = await UI.promptDialog({ title: T('cal.import_url'), label: T('cal.url_prompt'), placeholder: 'https://…' });
    if (!url) return;
    const name = await UI.promptDialog({ title: T('cal.name_prompt'), label: T('cal.name_prompt'), placeholder: 'Calendar' });
    try {
      const res = await window.ca.calendar.importUrl(url, name || '');
      await CA_UI.refreshSnapshot();
      state.sources = CA.snap.calendar.sources;
      toast(T('cal.imported', { name: res.name }), 'ok');
      loadMonth();
    } catch (err) {
      toast(T('cal.error', { err: err.message }), 'err');
    }
  }

  async function importPaste() {
    const text = await UI.promptDialog({ title: T('cal.import_text'), label: T('cal.paste_prompt'), multiline: true });
    if (!text) return;
    try {
      const res = await window.ca.calendar.importText(text, 'Pasted calendar');
      await CA_UI.refreshSnapshot();
      state.sources = CA.snap.calendar.sources;
      toast(T('cal.imported', { name: (res.source && res.source.name) || 'ICS' }), 'ok');
      loadMonth();
    } catch (err) {
      toast(T('cal.error', { err: err.message }), 'err');
    }
  }

  async function requestPartner() {
    try {
      await window.ca.calendar.requestShare();
      toast(T('common.done'), 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function toggleWidget() {
    window.ca.widget
      .toggle()
      .then((res) => toast(res.visible ? T('toast.widget_on') : T('toast.widget_off')))
      .catch((err) => toast(err.message, 'err'));
  }

  function renderAll() {
    renderHeader();
    renderWeekdays();
    renderGrid();
    renderSide();
    updateFooter();
  }

  function updateFooter() {
    if (!refs) return;
    CA_UI.setFooter('calendar', [
      h('span', { text: (state.sources.length || 0) + ' SRC' }),
      h('span', { text: '·' }),
      h('span', { text: state.mine.length + ' ' + T('cal.mine') + ' / ' + state.partner.length + ' ' + T('cal.partner') }),
      h('span', { text: '·' }),
      h('span', { text: state.share.share !== false ? T('cal.share') : T('common.disabled') }),
      h('span', { class: 'grow' }),
      h('span', { text: T('cal.privacy_note') }),
    ]);
  }

  function mount({ body }) {
    const head = h('div', { class: 'cal-head' });
    const weekdays = h('div', { class: 'cal-weekdays' });
    const grid = h('div', { class: 'cal-grid' });
    const gridWrap = h('div', { class: 'cal-grid-wrap' }, weekdays, grid);
    const side = h('div', { class: 'cal-side' });
    const main = h('div', { class: 'cal-main' }, gridWrap, side);
    body.appendChild(h('div', { class: 'cal-app' }, head, main));
    refs = { head, weekdays, grid, gridWrap, side, body };
    state.view = startOfMonth(new Date());
    state.selected = new Date();
    state.sources = (CA.snap.calendar && CA.snap.calendar.sources) || [];
    state.share = (CA.snap.calendar && CA.snap.calendar.share) || {};
    const up = (CA.snap.calendar && CA.snap.calendar.upcoming) || {};
    state.events = up.all || [];
    state.mine = up.mine || [];
    state.partner = up.partner || [];
    renderAll();
    loadMonth();
  }

  function event(evt) {
    if (!refs) return;
    switch (evt.type) {
      case 'snapshot':
        state.sources = (evt.payload.calendar.sources || []).slice();
        state.share = evt.payload.calendar.share || {};
        renderSide();
        break;
      case 'calendar':
        if (evt.payload && evt.payload.sources) {
          state.sources = evt.payload.sources;
          state.share = evt.payload.share || {};
        }
        loadMonth();
        break;
      case 'calendar-sources':
        state.sources = evt.payload.sources || [];
        state.share = evt.payload.share || {};
        renderSide();
        break;
      case 'presence':
        break;
      default:
        break;
    }
  }

  window.CA_APPS.calendar = {
    titleKey: 'cal.title',
    layout: { x: 668, y: 16, w: 500, h: 548, minW: 500, minH: 420 },
    mount,
    event,
    resize: () => renderAll(),
  };
})();
