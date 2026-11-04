'use strict';
/* Connect All — Connect Intelligence recaps window. */

(function () {
  const { h, icon, toast } = UI;

  let refs = null;
  let filter = 'all';
  let query = '';
  let clockTimer = null;

  function sourceTag(source) {
    if (source === 'llm') return { cls: 'ci-source-llm inv', label: T('ci.source_llm') };
    if (source === 'local-fallback') return { cls: 'ci-source-local amber', label: T('ci.source_fallback') };
    return { cls: 'ci-source-local', label: T('ci.source_local') };
  }

  function listSummary(summary) {
    const recs = (CA.snap.ci.summaries || []).filter((s) => {
      if (filter === 'llm' && s.source !== 'llm') return false;
      if (filter === 'local' && s.source === 'llm') return false;
      if (query) {
        const q = query.toLowerCase();
        return JSON.stringify(s).toLowerCase().includes(q);
      }
      return true;
    });
    return recs;
  }

  function sectionBlock(labelKey, items, render) {
    if (!items || !items.length) return null;
    return h(
      'div',
      { class: 'ci-sec' },
      h('div', { class: 'lbl', text: T(labelKey) }),
      h('ul', {}, items.map((item) => h('li', {}, render(item))))
    );
  }

  function summaryCard(rec) {
    const s = rec.summary;
    const src = sourceTag(rec.source);
    const card = h('div', { class: 'ci-card' });
    const head = h(
      'div',
      { class: 'card-head' },
      h('span', { class: 'when', text: UI.fmtDateTime(rec.createdAt) }),
      h('span', { class: 'tag', text: s.mood && s.mood.label ? s.mood.label : '—' }),
      h(
        'span',
        { class: 'src' },
        h('span', { class: 'tag ' + src.cls, text: src.label }),
        h('button', { class: 'btn small', title: T('ci.copy'), on: { click: () => copyRecap(rec) } }, UI.icon('copy', 11)),
        h('button', { class: 'btn small', title: T('ci.delete'), on: { click: () => deleteRecap(rec.id) } }, UI.icon('trash', 11))
      )
    );
    card.appendChild(head);
    card.appendChild(h('div', { class: 'headline', text: s.headline }));
    const body = h('div', { class: 'summary-body' });

    const add = (block) => { if (block) body.appendChild(block); };
    add(sectionBlock('ci.sec_topics', s.topics, (t) => h('span', {}, h('b', { text: t.title }), t.detail ? h('span', { class: 'muted', text: ' — ' + t.detail }) : null)));
    add(sectionBlock('ci.sec_unanswered', s.unanswered, (u) =>
      h('span', {}, h('span', { class: 'who', text: u.askedBy || '?' }), u.question, u.since ? h('span', { class: 'muted', text: ' · ' + u.since }) : null)
    ));
    add(sectionBlock('ci.sec_promises', s.promises, (p) =>
      h('span', {}, p.who ? h('span', { class: 'who', text: p.who }) : null, p.what, p.by ? h('span', { class: 'muted', text: ' · ' + p.by }) : null)
    ));
    add(sectionBlock('ci.sec_plans', s.plans, (p) => h('span', {}, p.what, p.when ? h('span', { class: 'muted', text: ' · ' + p.when }) : null)));
    if (s.mood && s.mood.note) {
      body.appendChild(h('div', { class: 'ci-sec' }, h('div', { class: 'lbl', text: T('ci.sec_mood') }), h('div', { class: 'small', text: s.mood.note })));
    }
    add(sectionBlock('ci.sec_risks', s.risks, (r) =>
      h('span', {}, h('b', { text: r.issue }), r.suggestion ? h('span', { class: 'muted', text: ' → ' + r.suggestion }) : null)
    ));
    add(sectionBlock('ci.sec_actions', s.nextActions, (a) => h('span', { text: a })));
    if (!body.childNodes.length) body.appendChild(h('div', { class: 'hint', text: T('ci.empty_desc') }));
    card.appendChild(body);
    return card;
  }

  async function copyRecap(rec) {
    const lines = [rec.summary.headline];
    if (rec.summary.unanswered && rec.summary.unanswered.length) lines.push(T('ci.sec_unanswered') + ': ' + rec.summary.unanswered.map((u) => u.question).join(' / '));
    if (rec.summary.promises && rec.summary.promises.length) lines.push(T('ci.sec_promises') + ': ' + rec.summary.promises.map((p) => p.what).join(' / '));
    if (rec.summary.nextActions && rec.summary.nextActions.length) lines.push(T('ci.sec_actions') + ': ' + rec.summary.nextActions.join(' / '));
    await UI.copyText(lines.join('\n'));
  }

  async function deleteRecap(id) {
    if (!(await UI.confirmDialog({ title: T('ci.delete'), message: T('ci.delete_confirm'), danger: true, confirmLabel: T('dialog.delete') }))) return;
    await window.ca.ci.remove(id);
    await CA_UI.refreshSnapshot();
    render();
  }

  function renderHeader() {
    if (!refs) return;
    const cfg = CA.snap.ci.config;
    const status = CA.snap.ci.status || {};
    const head = refs.head;
    UI.clear(head);
    const top = h('div', { class: 'top' });
    top.append(
      h('span', { class: 'title-line' }, UI.icon('ci', 14), h('span', { text: T('ci.title') })),
      h('span', { class: 'tag ' + (cfg.enabled ? 'inv' : ''), text: cfg.enabled ? T('common.enabled') : T('common.disabled') }),
      h('span', { class: 'tag', text: (cfg.provider || 'deepseek') + ' · ' + (cfg.model || '') }),
      h('span', { class: 'next', id: 'ci-next', text: cfg.enabled ? (status.nextRunAt ? T('ci.next_run', { t: UI.fmtIn(status.nextRunAt) }) : T('ci.next_run_none')) : T('ci.never_run') }),
      h('span', { class: 'actions' },
        h('button', { class: 'btn small primary', disabled: status.running, on: { click: runNow } }, UI.icon('refresh', 11), h('span', { text: status.running ? T('ci.running') : T('ci.run_now') })),
        h('button', { class: 'btn small', on: { click: () => CA_UI.openApp('settings', { tab: 'ci' }) } }, h('span', { text: T('ci.open_settings') }))
      )
    );
    head.appendChild(top);
    head.appendChild(
      h('div', { class: 'row wrap', style: { marginTop: '6px' } },
        h('span', { class: 'tag', text: T('ci.local_only') }),
        status.lastRunAt ? h('span', { class: 'hint', text: T('ci.last_run', { t: UI.fmtRelative(status.lastRunAt) }) }) : h('span', { class: 'hint', text: T('ci.never_run') }),
        status.lastError ? h('span', { class: 'tag red', title: status.lastError, text: T('common.error') }) : null
      )
    );
    const stats = h('div', { class: 'ci-stat-grid', style: { marginTop: '8px' } },
      h('div', { class: 'ci-stat' }, h('b', { text: String(status.count || 0) }), h('span', { text: T('ci.count') })),
      h('div', { class: 'ci-stat' }, h('b', { text: UI.fmtBytes(status.storageBytes || 0) }), h('span', { text: T('ci.bytes') })),
      h('div', { class: 'ci-stat' }, h('b', { text: cfg.intervalMin + 'm' }), h('span', { text: T('ci.interval') }))
    );
    head.appendChild(stats);
  }

  function renderFilters() {
    if (!refs) return;
    const bar = refs.filters;
    UI.clear(bar);
    const search = h('input', { class: 'input', value: query, placeholder: T('common.search'), style: { maxWidth: '220px' }, on: { input: (e) => { query = e.target.value; renderList(); } } });
    bar.append(
      h('div', { class: 'seg' },
        ['all', 'llm', 'local'].map((f) =>
          h('button', { class: 'seg-btn ' + (filter === f ? 'active' : ''), text: f === 'all' ? T('ci.all') : f === 'llm' ? T('ci.source_llm') : T('ci.source_local'), on: { click: () => { filter = f; renderFilters(); renderList(); } } })
        )
      ),
      search,
      h('span', { class: 'grow' }),
      h('span', { class: 'hint', text: T('ci.privacy_line') })
    );
  }

  function renderList() {
    if (!refs) return;
    const list = refs.list;
    UI.clear(list);
    const cfg = CA.snap.ci.config;
    const recs = (CA.snap.ci.summaries || []).filter((s) => {
      if (filter === 'llm' && s.source !== 'llm') return false;
      if (filter === 'local' && s.source === 'llm') return false;
      if (query) return JSON.stringify(s).toLowerCase().includes(query.toLowerCase());
      return true;
    });
    if (!cfg.enabled && !recs.length) {
      list.appendChild(
        UI.empty(
          'CI',
          T('ci.empty_title'),
          T('ci.empty_desc'),
          h('button', { class: 'btn primary', text: T('ci.enable'), on: { click: () => CA_UI.openApp('settings', { tab: 'ci' }) } })
        )
      );
      return;
    }
    if (!recs.length) {
      list.appendChild(UI.empty('CI', T('ci.empty_title'), query ? T('chat.no_results') : T('ci.empty_desc')));
      return;
    }
    for (const rec of recs) list.appendChild(summaryCard(rec));
    list.appendChild(h('div', { class: 'hint center-text', style: { padding: '6px' }, text: T('ci.local_only') }));
  }

  function render() {
    if (!refs) return;
    renderHeader();
    renderFilters();
    renderList();
    updateFooter();
  }

  function updateFooter() {
    if (!refs) return;
    const status = CA.snap.ci.status || {};
    const cfg = CA.snap.ci.config;
    CA_UI.setFooter('ci', [
      h('span', { text: 'CI · ' + (cfg.enabled ? 'ON' : 'OFF') }),
      h('span', { text: '·' }),
      h('span', { text: (status.count || 0) + ' RECAPS' }),
      h('span', { text: '·' }),
      h('span', { text: cfg.intervalMin + ' MIN' }),
      h('span', { class: 'grow' }),
      h('span', { text: T('ci.local_only') }),
    ]);
  }

  async function runNow() {
    try {
      const res = await window.ca.ci.run();
      if (!res.ok) {
        toast(res.error === 'busy' ? T('ci.running') : T('ci.run_error', { err: res.error }), 'err');
      } else if (res.skipped) {
        toast(T('ci.run_skipped'));
      } else {
        toast(T('ci.run_done', { headline: res.summary.summary.headline }), 'ok');
      }
      await CA_UI.refreshSnapshot();
      render();
    } catch (err) {
      toast(T('ci.run_error', { err: err.message }), 'err');
    }
  }

  function mount({ body }) {
    const head = h('div', { class: 'ci-head' });
    const filters = h('div', { class: 'row wrap', style: { padding: '6px 9px', borderBottom: '1px solid var(--ink)' } });
    const list = h('div', { class: 'ci-list scroll' });
    body.appendChild(h('div', { class: 'ci-app' }, head, filters, list));
    refs = { head, filters, list, body };
    render();
    clockTimer = setInterval(() => {
      if (!refs) return;
      const status = CA.snap.ci.status || {};
      const node = document.getElementById('ci-next');
      if (node && status.nextRunAt) node.textContent = T('ci.next_run', { t: UI.fmtIn(status.nextRunAt) });
    }, 30000);
  }

  function event(evt) {
    if (!refs) return;
    switch (evt.type) {
      case 'snapshot':
        render();
        break;
      case 'ci-summary':
        render();
        break;
      case 'ci-status':
      case 'ci-config':
        render();
        break;
      case 'ci-error':
        toast(T('ci.run_error', { err: evt.payload.message }), 'err');
        break;
      default:
        break;
    }
  }

  function destroy() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
    refs = null;
  }

  window.CA_APPS.ci = {
    titleKey: 'ci.title',
    layout: { x: 150, y: 30, w: 660, h: 600, minW: 480, minH: 420 },
    mount,
    event,
    destroy,
  };
})();
