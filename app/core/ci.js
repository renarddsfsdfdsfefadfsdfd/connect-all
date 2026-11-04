'use strict';
/*
 * Connect Intelligence (CI) — the opt-in hourly memory keeper.
 *
 * Every hour it reads the couple's messages from the local log, extracts the
 * things that turn into arguments when forgotten (open questions, promises,
 * plans, mood), and writes a short summary to disk. It never uploads anything
 * unless the user separately enables encrypted backup.
 *
 * Works with an API key (DeepSeek / Doubao) and without one: the built-in
 * heuristic summarizer needs no network and no model.
 */

const { EventEmitter } = require('events');
const path = require('path');
const { JsonlLog } = require('./store');
const { chatCompletion, extractJson, testConnection, PROVIDERS, providerList, defaultBaseUrl } = require('./llm');
const ca = require('./crypto');

const MAX_SUMMARIES = 2000;
const MIN_INTERVAL_MIN = 5;
const MAX_MESSAGES = 400;
const MAX_TRANSCRIPT_CHARS = 24000;

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function cleanArray(value, max, fn) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (out.length >= max) break;
    const cleaned = fn(item);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function fmtClock(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function fmtDateTime(ms, lang) {
  const d = new Date(ms);
  if (lang === 'en') return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function normalizeSummary(raw, { lang, source, model, provider, messageCount, window, latencyMs, error }) {
  const zh = lang !== 'en';
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v, n) => clip(v, n);
  const summary = {
    headline: str(raw && raw.headline, zh ? 60 : 90) || (zh ? '这一小时没有需要特别记住的事' : 'Nothing urgent this hour'),
    topics: cleanArray(raw && raw.topics, 4, (t) => {
      if (!t) return null;
      const title = str(t.title || t.topic, 40);
      if (!title) return null;
      return { title, detail: str(t.detail || t.summary, 160) };
    }),
    promises: cleanArray(raw && raw.promises, 5, (p) => {
      if (!p) return null;
      const what = str(p.what || p.text, 100);
      if (!what) return null;
      return { who: str(p.who, 20), what, by: str(p.by || p.due || p.when, 40) };
    }),
    unanswered: cleanArray(raw && raw.unanswered, 5, (u) => {
      if (!u) return null;
      const question = str(u.question, 140);
      if (!question) return null;
      return { question, askedBy: str(u.askedBy || u.by, 20), since: str(u.since, 40) };
    }),
    plans: cleanArray(raw && raw.plans, 4, (p) => {
      if (!p) return null;
      const what = str(p.what || p.plan, 90);
      if (!what) return null;
      return { what, when: str(p.when || p.time, 60) };
    }),
    mood: {
      label: str(raw && raw.mood && raw.mood.label, 20) || (zh ? '平稳' : 'Steady'),
      note: str(raw && raw.mood && raw.mood.note, 100),
    },
    risks: cleanArray(raw && raw.risks, 3, (r) => {
      if (!r) return null;
      const issue = str(r.issue || r.risk, 100);
      if (!issue) return null;
      return { issue, suggestion: str(r.suggestion || r.fix, 120) };
    }),
    nextActions: cleanArray(raw && raw.nextActions, 3, (a) => str(a, 100)),
  };
  return {
    id: 'ci_' + Date.now().toString(36) + '_' + ca.randomId(3),
    createdAt: Date.now(),
    window,
    lang: zh ? 'zh' : 'en',
    source,
    provider: provider || '',
    model: model || '',
    messageCount,
    latencyMs: latencyMs || 0,
    error: error || '',
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* Prompt building                                                     */
/* ------------------------------------------------------------------ */

function systemPrompt(lang) {
  const zh = lang !== 'en';
  if (zh) {
    return `你是 Connect Intelligence（连接智能），只为这一对异地情侣工作。你读到的是他们最近一段时间的聊天记录，可能附带日程。

你的任务不是写日记，而是找出「如果被忘记就会变成争吵」的信息：还没被回答的问题、说过的承诺、约定的时间、情绪变化。

规则：
1. 只依据给出的记录，禁止猜测或补全。没有就返回空数组。
2. 谁说的就记谁：「我」是当前设备的主人，「TA」是对方。
3. 具体、克制、不评判任何一方，不写建议口吻的说教。
4. 只输出一个 JSON 对象，不要 markdown，不要解释，不要前后缀。

JSON 字段：
{
  "headline": "一句话，≤40字",
  "topics": [{"title":"≤12字","detail":"≤60字"}],
  "promises": [{"who":"我|TA|双方","what":"≤50字","by":"时间或空字符串"}],
  "unanswered": [{"question":"≤60字","askedBy":"我|TA","since":"时间"}],
  "plans": [{"what":"≤40字","when":"时间"}],
  "mood": {"label":"平稳|开心|低落|紧张|疲惫","note":"≤40字"},
  "risks": [{"issue":"≤40字","suggestion":"≤50字"}],
  "nextActions": ["≤40字"]
}
数量上限：topics 4、promises 5、unanswered 5、plans 4、risks 3、nextActions 3。`;
  }
  return `You are Connect Intelligence, a private assistant for one long-distance couple. You read their recent chat log (and calendar) and surface what would cause a fight if forgotten: unanswered questions, promises, agreed times, mood shifts.

Rules:
1. Use only the provided log. Never invent. Empty arrays are fine.
2. Attribute correctly: "Me" is the owner of this device, "Partner" is the other person.
3. Be specific, calm, non-judgmental. No lecturing.
4. Output exactly one JSON object. No markdown, no prose.

Schema:
{
  "headline": "one sentence, <=90 chars",
  "topics": [{"title":"<=30 chars","detail":"<=160 chars"}],
  "promises": [{"who":"Me|Partner|Both","what":"<=120 chars","by":"time or empty"}],
  "unanswered": [{"question":"<=160 chars","askedBy":"Me|Partner","since":"time"}],
  "plans": [{"what":"<=100 chars","when":"time"}],
  "mood": {"label":"Steady|Happy|Low|Tense|Tired","note":"<=100 chars"},
  "risks": [{"issue":"<=100 chars","suggestion":"<=140 chars"}],
  "nextActions": ["<=120 chars"]
}
Caps: topics 4, promises 5, unanswered 5, plans 4, risks 3, nextActions 3.`;
}

function buildTranscript(messages, lang) {
  const zh = lang !== 'en';
  const lines = [];
  const recent = messages.slice(-MAX_MESSAGES);
  for (const m of recent) {
    const who = m.from === 'me' ? (zh ? '我' : 'Me') : zh ? 'TA' : 'Partner';
    const text = String(m.text || '').replace(/\s+/g, ' ').slice(0, 500);
    if (!text) continue;
    lines.push('[' + fmtClock(m.at) + '] ' + who + ': ' + text);
  }
  let text = lines.join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) text = text.slice(-MAX_TRANSCRIPT_CHARS);
  if (messages.length > recent.length) {
    text = (zh ? '[更早的消息已省略]\n' : '[earlier messages omitted]\n') + text;
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* Local heuristic fallback (no network, no key)                       */
/* ------------------------------------------------------------------ */

const CATEGORIES = [
  {
    id: 'schedule',
    zh: '见面与安排',
    en: 'Meeting plans',
    re: /(见面|碰面|出发|到站|机票|车票|高铁|飞机|周末|假期|请个假|来找你|去找你|visit|flight|train|weekend|holiday|trip|meet up)/i,
  },
  {
    id: 'food',
    zh: '吃饭',
    en: 'Food',
    re: /(吃饭|吃啥|吃什么|外卖|火锅|奶茶|咖啡|早餐|午饭|晚饭|dinner|lunch|food|coffee|milk tea)/i,
  },
  {
    id: 'media',
    zh: '一起玩',
    en: 'Together time',
    re: /(电影|影院|电视剧|动漫|游戏|一起看|一起听|歌单|music|movie|series|game|watch|listen)/i,
  },
  {
    id: 'work',
    zh: '工作与学业',
    en: 'Work & study',
    re: /(工作|加班|上班|考试|论文|作业|会议|deadline|work|overtime|exam|thesis|meeting|class)/i,
  },
  {
    id: 'feelings',
    zh: '情绪与想念',
    en: 'Feelings',
    re: /(想你|想我|喜欢|爱你|爱你|开心|难过|生气|吵架|委屈|烦|累|miss you|love you|happy|sad|angry|tired|upset)/i,
  },
  {
    id: 'daily',
    zh: '日常',
    en: 'Daily life',
    re: /(起床|睡觉|晚安|早安|洗澡|回家|在干嘛|good night|good morning|sleep|home|what are you doing)/i,
  },
];

const POSITIVE_RE = /(😊|😄|🥰|😍|😘|😁|😆|❤️|💕|开心|喜欢|想你|爱你|太好了|期待|幸福|happy|love|miss you|great|nice)/gi;
const NEGATIVE_RE = /(😭|😢|😡|😤|😞|😔|😩|😫|🥺|😣|难过|生气|吵架|委屈|烦|累|不想|算了|sad|angry|upset|tired|annoyed|cry)/gi;
const PROMISE_RE = /(我会|我答应|答应你|说好|讲好|我保证|一定会|我买|我带|我订|我发你|明天给你|下次给|等我|记得|别忘|i will|i'll|i promise|i'll get|i'll book|i'll send|i'll call|remember|don't forget)/i;
const TIME_RE = /(今天|今晚|明天|明晚|后天|周末|周一|周二|周三|周四|周五|周六|周日|下周|下个月|月底|早上|中午|下午|晚上|\d{1,2}[点:：]\d{0,2}|today|tonight|tomorrow|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?:am|pm))/i;
const QUESTION_RE = /(？|\?|吗$|呢$|好不好|行不行|要不要|怎么样|什么时候|几点|在哪|你来吗|你愿意|可以吗|what time|where|when|do you|are you|can you|will you|how about)/i;
const NON_ANSWER_RE = /(我想想|再看看|再说|不确定|不知道|看情况|可能|到时候|有点忙|再说吧|maybe|not sure|we.ll see|i.ll think|kind of busy)/i;

function localSummary(messages, { lang, now = Date.now() }) {
  const zh = lang !== 'en';
  const msgs = messages.filter((m) => m && m.text && m.from !== 'system');
  const unanswered = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!QUESTION_RE.test(m.text)) continue;
    let answered = false;
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].from !== m.from) {
        // "我想想 / 再说 / 看情况" is a reply, not an answer.
        if (!NON_ANSWER_RE.test(msgs[j].text)) answered = true;
        break;
      }
    }
    if (!answered) {
      unanswered.push({
        question: clip(m.text, 140),
        askedBy: m.from === 'me' ? (zh ? '我' : 'Me') : zh ? 'TA' : 'Partner',
        since: fmtClock(m.at),
      });
      if (unanswered.length >= 5) break;
    }
  }

  const promises = [];
  for (const m of msgs) {
    if (!PROMISE_RE.test(m.text)) continue;
    const time = (m.text.match(TIME_RE) || [])[0] || '';
    const what = clip(m.text, 100);
    if (promises.some((p) => p.what === what)) continue;
    promises.push({ who: m.from === 'me' ? (zh ? '我' : 'Me') : zh ? 'TA' : 'Partner', what, by: time });
    if (promises.length >= 5) break;
  }

  const plans = [];
  for (const m of msgs) {
    if (!TIME_RE.test(m.text)) continue;
    if (QUESTION_RE.test(m.text)) continue;
    if (!/(一起|见面|看|吃|去|来|call|watch|meet|eat|go|come)/i.test(m.text)) continue;
    const what = clip(m.text, 90);
    if (plans.some((p) => p.what === what)) continue;
    plans.push({ what, when: (m.text.match(TIME_RE) || [])[0] || '' });
    if (plans.length >= 4) break;
  }

  const topics = [];
  for (const cat of CATEGORIES) {
    const hits = msgs.filter((m) => cat.re.test(m.text));
    if (!hits.length) continue;
    topics.push({
      title: zh ? cat.zh : cat.en,
      detail: (zh ? '聊了 ' : 'Talked about ') + hits.length + (zh ? ' 条，例如：' : ' msgs, e.g. ') + clip(hits[hits.length - 1].text, zh ? 60 : 100),
    });
    if (topics.length >= 4) break;
  }

  let score = 0;
  let moodNote = '';
  for (const m of msgs) {
    const pos = (m.text.match(POSITIVE_RE) || []).length;
    const neg = (m.text.match(NEGATIVE_RE) || []).length;
    score += pos - neg;
    if (pos || neg) moodNote = clip(m.text, 80);
  }
  const moodLabel = score > 1 ? (zh ? '开心' : 'Happy') : score < -1 ? (zh ? '低落' : 'Low') : zh ? '平稳' : 'Steady';

  const risks = [];
  if (unanswered.length) {
    risks.push({
      issue: (zh ? unanswered.length + ' 个问题还没有回复' : unanswered.length + ' question(s) still unanswered'),
      suggestion: zh ? '先回最近的那条，避免对方以为被忽略' : 'Answer the most recent one first, before it reads as being ignored',
    });
  }
  const last = msgs[msgs.length - 1];
  if (last && last.from === 'peer' && NEGATIVE_RE.test(last.text) && !unanswered.length) {
    risks.push({
      issue: zh ? 'TA 最后一条情绪偏低' : 'Partner ended on a low note',
      suggestion: zh ? '先接住情绪，再讨论事情' : 'Acknowledge the feeling before solving anything',
    });
  }
  const promisesWithoutTime = promises.filter((p) => !p.by).length;
  if (promisesWithoutTime) {
    risks.push({
      issue: zh ? promisesWithoutTime + ' 个承诺没有明确时间' : promisesWithoutTime + ' promise(s) without a time',
      suggestion: zh ? '补一句具体时间，能省掉一次争论' : 'Add a concrete time; it prevents one argument',
    });
  }

  const nextActions = [];
  if (unanswered.length) nextActions.push((zh ? '回复：' : 'Reply to: ') + clip(unanswered[0].question, 60));
  if (promises.length) nextActions.push((zh ? '确认承诺：' : 'Confirm: ') + clip(promises[0].what, 60));
  if (plans.length) nextActions.push((zh ? '把计划写进日历：' : 'Add to calendar: ') + clip(plans[0].what, 50));

  let headline;
  if (unanswered.length) headline = zh ? unanswered.length + ' 个问题还没回答' : unanswered.length + ' unanswered question(s)';
  else if (plans.length) headline = zh ? '约了：' + clip(plans[0].what, 26) : 'Plans: ' + clip(plans[0].what, 40);
  else if (promises.length) headline = zh ? promises.length + ' 个承诺待兑现' : promises.length + ' promise(s) to keep';
  else if (msgs.length) headline = zh ? '聊了 ' + msgs.length + ' 条，整体平稳' : msgs.length + ' messages, nothing urgent';
  else headline = zh ? '这段时间没有聊天' : 'No messages in this window';

  return {
    headline,
    topics,
    promises,
    unanswered,
    plans,
    mood: { label: moodLabel, note: moodNote },
    risks,
    nextActions,
  };
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

class ConnectIntelligence extends EventEmitter {
  constructor({ store, secrets, paths, logger = () => {}, getContext, lang = 'zh' }) {
    super();
    this.store = store;
    this.secrets = secrets;
    this.paths = paths;
    this.logger = logger;
    this.getContext = getContext || (() => ({ messages: [], events: [] }));
    this.lang = lang;
    this.log = new JsonlLog(paths.ci, { maxEntries: MAX_SUMMARIES, maxBytes: 16 * 1024 * 1024 });
    this.summaries = this.log.readAll().filter((s) => s && s.summary);
    this.running = false;
    this.timer = null;
    this.nextRunAt = 0;
    this._lastManualAt = 0;
    this._prune();
  }

  get config() {
    return this.store.get().ci;
  }

  setLang(lang) {
    this.lang = lang;
  }

  effectiveLang() {
    const lang = this.config.lang || 'auto';
    return lang === 'auto' ? this.lang || 'zh' : lang;
  }

  hasKey() {
    return this.secrets.has('ci.apiKey');
  }

  keyHint() {
    const key = this.secrets.get('ci.apiKey');
    if (!key) return '';
    return key.length > 8 ? key.slice(0, 4) + '••••' + key.slice(-4) : '••••';
  }

  publicConfig() {
    const c = this.config;
    return {
      enabled: Boolean(c.enabled),
      provider: c.provider || 'deepseek',
      baseUrl: c.baseUrl || defaultBaseUrl(c.provider),
      model: c.model || 'deepseek-chat',
      intervalMin: c.intervalMin || 60,
      retentionDays: c.retentionDays || 90,
      lang: c.lang || 'auto',
      notify: c.notify !== false,
      includeCalendar: c.includeCalendar !== false,
      includeStatus: Boolean(c.includeStatus),
      customPrompt: c.customPrompt || '',
      hasKey: this.hasKey(),
      keyHint: this.keyHint(),
      providers: providerList(),
      storage: this.paths.ci,
      localOnly: true,
    };
  }

  configure(patch = {}) {
    const c = this.store.get().ci;
    const allowed = [
      'enabled',
      'provider',
      'baseUrl',
      'model',
      'intervalMin',
      'retentionDays',
      'lang',
      'notify',
      'includeCalendar',
      'includeStatus',
      'customPrompt',
    ];
    for (const key of allowed) {
      if (patch[key] !== undefined) c[key] = patch[key];
    }
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === null || patch.apiKey === '') this.secrets.delete('ci.apiKey');
      else this.secrets.set('ci.apiKey', String(patch.apiKey).trim());
    }
    if (c.intervalMin < MIN_INTERVAL_MIN) c.intervalMin = MIN_INTERVAL_MIN;
    if (c.retentionDays < 0) c.retentionDays = 0;
    this.store.saveSoon(0);
    this._prune();
    if (this.config.enabled) this.start();
    else this.stop();
    this.emitStatus();
    return this.publicConfig();
  }

  async testCredentials({ provider, baseUrl, apiKey, model } = {}) {
    const key = apiKey ? String(apiKey).trim() : this.secrets.get('ci.apiKey');
    if (!key) return { ok: false, error: '尚未填写 API Key / API key not set' };
    const p = provider || this.config.provider || 'deepseek';
    return testConnection({
      provider: p,
      baseUrl: baseUrl || this.config.baseUrl,
      apiKey: key,
      model: model || this.config.model,
      insecure: false,
    });
  }

  start() {
    this.stop();
    if (!this.config.enabled) {
      this.emitStatus();
      return;
    }
    this._scheduleNext();
    const last = this.config.lastRunAt || 0;
    const interval = (this.config.intervalMin || 60) * 60000;
    if (last && Date.now() - last > interval * 1.5) {
      // Machine was asleep/closed: one catch-up run shortly after launch.
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.runNow({ manual: false, catchUp: true }).catch(() => {});
      }, 20000);
      if (this.timer.unref) this.timer.unref();
      this.nextRunAt = Date.now() + 20000;
    }
    this.emitStatus();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = 0;
  }

  _scheduleNext() {
    if (this.timer) clearTimeout(this.timer);
    const intervalMs = Math.max(MIN_INTERVAL_MIN, this.config.intervalMin || 60) * 60000;
    const now = Date.now();
    const next = Math.ceil((now + 2000) / intervalMs) * intervalMs;
    this.nextRunAt = next;
    this.timer = setTimeout(() => {
      this.runNow({ manual: false }).catch(() => {});
    }, Math.max(1000, next - now));
    if (this.timer.unref) this.timer.unref();
  }

  status() {
    const c = this.config;
    return {
      enabled: Boolean(c.enabled),
      running: this.running,
      nextRunAt: c.enabled ? this.nextRunAt : 0,
      lastRunAt: c.lastRunAt || 0,
      lastMessageCount: c.lastMessageCount || 0,
      lastError: c.lastError || '',
      intervalMin: c.intervalMin || 60,
      provider: c.provider || 'deepseek',
      model: c.model || '',
      hasKey: this.hasKey(),
      count: this.summaries.length,
      storageBytes: this.log.sizeBytes,
      storagePath: this.paths.ci,
      retentionDays: c.retentionDays || 90,
    };
  }

  emitStatus() {
    this.emit('status', this.status());
  }

  recentContext(count = 3) {
    return this.summaries.slice(-count).map((s) => ({
      createdAt: s.createdAt,
      headline: s.summary.headline,
      promises: s.summary.promises,
      unanswered: s.summary.unanswered,
      nextActions: s.summary.nextActions,
    }));
  }

  list({ limit = 100, search = '' } = {}) {
    let items = this.summaries.slice();
    if (search) {
      const q = String(search).toLowerCase();
      items = items.filter((s) => JSON.stringify(s).toLowerCase().includes(q));
    }
    items.reverse();
    return items.slice(0, limit);
  }

  get(id) {
    return this.summaries.find((s) => s.id === id) || null;
  }

  delete(id) {
    const before = this.summaries.length;
    this.summaries = this.summaries.filter((s) => s.id !== id);
    if (this.summaries.length !== before) {
      this._rewrite();
      this.emitStatus();
      return true;
    }
    return false;
  }

  clear() {
    this.summaries = [];
    this._rewrite();
    this.emitStatus();
  }

  importSummaries(list) {
    let added = 0;
    const existing = new Set(this.summaries.map((s) => s.id));
    for (const rec of Array.isArray(list) ? list : []) {
      if (!rec || !rec.id || !rec.summary || existing.has(rec.id)) continue;
      this.summaries.push(rec);
      existing.add(rec.id);
      added++;
    }
    if (added) {
      this.summaries.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      this._prune();
      this._rewrite();
      this.emitStatus();
    }
    return added;
  }

  exportAll() {
    return {
      exportedAt: Date.now(),
      format: 'connect-all-ci-v1',
      summaries: this.summaries,
    };
  }

  stats() {
    return {
      count: this.summaries.length,
      bytes: this.log.sizeBytes,
      oldest: this.summaries.length ? this.summaries[0].createdAt : 0,
      newest: this.summaries.length ? this.summaries[this.summaries.length - 1].createdAt : 0,
    };
  }

  _prune() {
    const days = Number(this.config.retentionDays || 0);
    let changed = false;
    if (days > 0) {
      const cutoff = Date.now() - days * 86400000;
      const kept = this.summaries.filter((s) => s.createdAt >= cutoff);
      if (kept.length !== this.summaries.length) {
        this.summaries = kept;
        changed = true;
      }
    }
    if (this.summaries.length > MAX_SUMMARIES) {
      this.summaries = this.summaries.slice(-MAX_SUMMARIES);
      changed = true;
    }
    if (changed) this._rewrite();
  }

  _rewrite() {
    this.log.rewrite(this.summaries);
  }

  async runNow({ manual = true, catchUp = false } = {}) {
    if (this.running) return { ok: false, error: 'busy' };
    if (manual && Date.now() - this._lastManualAt < 5000) {
      return { ok: false, error: 'rate limited' };
    }
    if (manual) this._lastManualAt = Date.now();
    this.running = true;
    this.emitStatus();
    const lang = this.effectiveLang();
    const now = Date.now();
    const c = this.config;
    const interval = Math.max(MIN_INTERVAL_MIN, c.intervalMin || 60) * 60000;
    let from = c.lastRunAt || now - interval;
    if (from >= now) from = now - interval;
    if (catchUp) from = Math.max(from, now - 6 * 3600000);
    const window = { from, to: now };
    try {
      const ctx = this.getContext(window) || {};
      const messages = (ctx.messages || []).filter((m) => m.text && m.from !== 'system');
      if (!messages.length) {
        c.lastRunAt = now;
        c.lastRunWindow = window;
        c.lastMessageCount = 0;
        c.lastError = '';
        this.store.saveSoon(0);
        this._scheduleNext();
        this.emit('skipped', { window });
        this.emitStatus();
        return { ok: true, skipped: true };
      }

      let summaryRaw = null;
      let source = 'local';
      let model = '';
      let provider = '';
      let latencyMs = 0;
      let errorText = '';
      if (this.hasKey()) {
        provider = c.provider || 'deepseek';
        model = c.model || (PROVIDERS[provider] && PROVIDERS[provider].models[0].id) || '';
        const calendarText = this._formatCalendar(ctx.events || [], lang);
        const previous = this.recentContext(3);
        const userPrompt = this._buildUserPrompt({
          lang,
          window,
          messages,
          calendarText,
          previous,
          partnerOnline: Boolean(ctx.partnerOnline),
          customPrompt: c.customPrompt,
        });
        try {
          const res = await chatCompletion({
            provider,
            baseUrl: c.baseUrl,
            apiKey: this.secrets.get('ci.apiKey'),
            model,
            messages: [
              { role: 'system', content: systemPrompt(lang) },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.25,
            maxTokens: 1400,
            timeout: 90000,
            retries: 1,
          });
          latencyMs = res.latencyMs;
          summaryRaw = extractJson(res.content);
          if (!summaryRaw) throw new Error('模型未返回可解析的 JSON / model did not return JSON');
          source = 'llm';
          errorText = '';
        } catch (err) {
          errorText = err.message || String(err);
          this.logger('warn', 'CI model failed, using local fallback: ' + errorText);
          c.lastError = errorText;
          summaryRaw = null;
          source = 'local-fallback';
        }
      }
      if (!summaryRaw) {
        summaryRaw = localSummary(messages, { lang, now });
        if (source !== 'local-fallback') source = 'local';
      }

      const record = normalizeSummary(summaryRaw, {
        lang,
        source,
        model,
        provider,
        messageCount: messages.length,
        window,
        latencyMs,
        error: errorText,
      });
      record.firstMessageAt = messages[0].at;
      record.lastMessageAt = messages[messages.length - 1].at;
      record.preview = messages.slice(-3).map((m) => ({ from: m.from, text: clip(m.text, 120) }));
      this.summaries.push(record);
      this.log.append(record);
      this._prune();
      c.lastRunAt = now;
      c.lastRunWindow = window;
      c.lastMessageCount = messages.length;
      if (source === 'llm') c.lastError = '';
      this.store.saveSoon(0);
      this._scheduleNext();
      this.emit('summary', record);
      this.emitStatus();
      return { ok: true, summary: record, source };
    } catch (err) {
      this.logger('error', 'CI run failed: ' + err.message);
      c.lastError = err.message || String(err);
      this.store.saveSoon(0);
      this._scheduleNext();
      this.emit('error', { message: c.lastError });
      this.emitStatus();
      return { ok: false, error: c.lastError };
    } finally {
      this.running = false;
      this.emitStatus();
    }
  }

  _formatCalendar(events, lang) {
    if (!Array.isArray(events) || !events.length) return '';
    const zh = lang !== 'en';
    const lines = events.slice(0, 20).map((e) => {
      const start = fmtDateTime(e.start, lang);
      const owner = e.owner === 'peer' ? (zh ? 'TA' : 'Partner') : zh ? '我' : 'Me';
      return '- [' + owner + '] ' + start + ' ' + clip(e.summary, 60) + (e.location ? (zh ? ' @ ' : ' @ ') + clip(e.location, 40) : '');
    });
    return lines.join('\n');
  }

  _buildUserPrompt({ lang, window, messages, calendarText, previous, partnerOnline, customPrompt }) {
    const zh = lang !== 'en';
    const chunks = [];
    chunks.push(
      zh
        ? '时间窗：' + fmtDateTime(window.from, lang) + ' → ' + fmtDateTime(window.to, lang) + '（本地时间）'
        : 'Window: ' + fmtDateTime(window.from, lang) + ' → ' + fmtDateTime(window.to, lang) + ' (local time)'
    );
    chunks.push(zh ? '对方当前' + (partnerOnline ? '在线' : '不在线') + '。' : 'Partner is ' + (partnerOnline ? 'online' : 'offline') + '.');
    if (previous.length) {
      chunks.push(
        zh ? '\n【最近几次汇总，供连续性参考】' : '\n[Recent summaries, for continuity]'
      );
      for (const p of previous) {
        chunks.push(
          '- ' +
            fmtDateTime(p.createdAt, lang) +
            ' ' +
            p.headline +
            (p.unanswered && p.unanswered.length ? (zh ? '；未答：' : '; unanswered: ') + p.unanswered.map((u) => u.question).join(' / ') : '')
        );
      }
    }
    if (calendarText) {
      chunks.push(zh ? '\n【双方日程】' : '\n[Shared calendar]');
      chunks.push(calendarText);
    }
    if (customPrompt) {
      chunks.push(zh ? '\n【用户附加要求】' : '\n[User extra instruction]');
      chunks.push(clip(customPrompt, 500));
    }
    chunks.push(zh ? '\n【聊天记录】' : '\n[Chat log]');
    chunks.push(buildTranscript(messages, lang));
    chunks.push(
      zh
        ? '\n现在输出 JSON。优先写出还没被回复的问题和明确的承诺。'
        : '\nNow output the JSON. Prioritize unanswered questions and explicit promises.'
    );
    return chunks.join('\n');
  }
}

module.exports = {
  ConnectIntelligence,
  localSummary,
  systemPrompt,
  buildTranscript,
  normalizeSummary,
};
