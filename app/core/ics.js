'use strict';
/*
 * Connect All — dependency-free iCalendar (RFC 5545) reader.
 *
 * Supported on purpose: VEVENT, DTSTART/DTEND/DURATION, TZID + UTC + all-day,
 * RRULE (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY/
 * BYMONTH), EXDATE, RECURRENCE-ID overrides, unfolded lines, escaped text.
 * Unsupported and ignored: VTODO, VALARM, BYSETPOS, exotic RRULE parts.
 *
 * Timezone math uses the ICU data bundled with Node/Electron via Intl, so DST
 * transitions are handled without shipping a tz database.
 */

const MAX_OCCURRENCES = 4000;

// A few Windows timezone names seen in Outlook exports.
const WINDOWS_TZ = {
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Russian Standard Time': 'Europe/Moscow',
  'India Standard Time': 'Asia/Kolkata',
  'Singapore Standard Time': 'Asia/Singapore',
  'UTC': 'UTC',
};

function normalizeTz(tzid) {
  if (!tzid) return '';
  let tz = String(tzid).replace(/^\/+/, '');
  if (WINDOWS_TZ[tz]) return WINDOWS_TZ[tz];
  if (tz === 'UTC' || tz === 'GMT' || tz === 'Z') return 'UTC';
  return tz;
}

function isValidTimeZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

function unfold(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '');
}

function splitParams(line) {
  // Find the first colon outside double quotes.
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = [];
  let cur = '';
  inQuote = false;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
    } else if (ch === ';' && !inQuote) {
      segments.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  segments.push(cur);
  const name = segments[0].toUpperCase();
  const params = {};
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const key = seg.slice(0, eq).toUpperCase();
    let val = seg.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params, value };
}

function unescapeText(value) {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parsePropertyLines(text) {
  const components = [];
  const stack = [];
  for (const rawLine of unfold(text).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = splitParams(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;
    if (name === 'BEGIN') {
      const comp = { name: String(value).toUpperCase(), props: [], children: [] };
      if (stack.length) stack[stack.length - 1].children.push(comp);
      else components.push(comp);
      stack.push(comp);
    } else if (name === 'END') {
      if (stack.length && stack[stack.length - 1].name === String(value).toUpperCase()) stack.pop();
    } else if (stack.length) {
      stack[stack.length - 1].props.push({ name, params, value });
    }
  }
  return components;
}

function props(component, name) {
  return component.props.filter((p) => p.name === name);
}
function prop(component, name) {
  return component.props.find((p) => p.name === name) || null;
}

function tzOffsetMs(tz, epochMs) {
  const zone = tz || systemTimeZone();
  if (zone === 'UTC') return 0;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hour = Number(parts.hour) % 24;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return asUtc - epochMs;
}

/** Convert wall-clock fields in `tz` to an epoch timestamp (handles DST). */
function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, tz) {
  const zone = tz || systemTimeZone();
  if (zone === 'UTC') return Date.UTC(year, month - 1, day, hour, minute, second);
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = tzOffsetMs(zone, guess);
  let result = guess - offset;
  const offset2 = tzOffsetMs(zone, result);
  if (offset2 !== offset) result = guess - offset2;
  return result;
}

function utcToZonedParts(epochMs, tz) {
  const zone = tz || systemTimeZone();
  if (zone === 'UTC') {
    const d = new Date(epochMs);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    };
  }
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function parseDateValue(value, params = {}) {
  const raw = String(value || '').trim();
  const tzParam = normalizeTz(params.TZID || '');
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const dateOnly = !m[4];
  const fields = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] || 0),
    minute: Number(m[5] || 0),
    second: Number(m[6] || 0),
  };
  if (dateOnly) {
    return { ...fields, allDay: true, tzid: tzParam, utc: false, epoch: zonedToUtc(fields, tzParam || systemTimeZone()) };
  }
  if (m[7] === 'Z') {
    return {
      ...fields,
      allDay: false,
      tzid: 'UTC',
      utc: true,
      epoch: Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second),
    };
  }
  const tz = tzParam || systemTimeZone();
  return { ...fields, allDay: false, tzid: tzParam, utc: false, epoch: zonedToUtc(fields, tz) };
}

function parseDuration(value) {
  const m = String(value || '').trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const weeks = Number(m[2] || 0);
  const days = Number(m[3] || 0);
  const hours = Number(m[4] || 0);
  const minutes = Number(m[5] || 0);
  const seconds = Number(m[6] || 0);
  return sign * ((weeks * 7 + days) * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000;
}

function parseByDay(value) {
  const out = [];
  for (const token of String(value || '').toUpperCase().split(',')) {
    const m = token.trim().match(/^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/);
    if (m) out.push({ n: m[1] ? Number(m[1]) : 0, day: m[2] });
  }
  return out;
}

const WEEKDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_MS = 86400000;

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonths(parts, months) {
  const total = (parts.year * 12 + (parts.month - 1)) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12 + 12) % 12 + 1;
  const day = Math.min(parts.day, daysInMonth(year, month));
  return { ...parts, year, month, day };
}

function addDaysToParts(parts, days) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * DAY_MS);
  return { ...parts, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function weekdayOfParts(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function startOfWeekParts(parts, wkst) {
  const target = WEEKDAY_INDEX[wkst] != null ? WEEKDAY_INDEX[wkst] : 1;
  const diff = (weekdayOfParts(parts) - target + 7) % 7;
  return addDaysToParts(parts, -diff);
}

/**
 * Expand one VEVENT into concrete occurrences within [fromMs, toMs).
 * Returns [{start, end, allDay, overridden}].
 */
function expandEvent(event, fromMs, toMs) {
  const out = [];
  const durationMs = event.allDay
    ? Math.max(DAY_MS, (event.end - event.start))
    : Math.max(0, event.end - event.start);
  const tz = event.allDay ? event.tzid || '' : event.tzid || '';
  const baseParts = event.startParts;
  const push = (startEpoch, endEpoch, overridden, recurrenceKey) => {
    if (!Number.isFinite(startEpoch)) return;
    if (startEpoch >= toMs) return;
    if (endEpoch <= fromMs) return;
    out.push({
      start: startEpoch,
      end: endEpoch,
      allDay: event.allDay,
      overridden: Boolean(overridden),
      recurrenceKey: recurrenceKey == null ? startEpoch : recurrenceKey,
    });
  };

  if (!event.rrule || !event.rrule.freq) {
    push(event.start, event.end, false);
    return out;
  }

  const rule = event.rrule;
  const interval = Math.max(1, Number(rule.interval || 1));
  const count = rule.count ? Number(rule.count) : Infinity;
  const until = rule.untilEpoch || Infinity;
  const byDay = rule.byDay || [];
  const byMonthDay = rule.byMonthDay || [];
  const byMonth = rule.byMonth || [];
  const wkst = rule.wkst || 'MO';
  const exdates = event.exdates || new Set();
  const overrides = event.overrides || new Map();

  let generated = 0;
  let cursor = null;
  let iteration = 0;
  const guard = () => {
    iteration += 1;
    if (iteration > 20000) return false;
    return true;
  };

  const emit = (epoch, parts) => {
    if (!Number.isFinite(epoch)) return true;
    if (epoch < event.start - 1000) return true; // never before DTSTART
    if (epoch > until) return false;
    if (generated >= count) return false;
    generated += 1;
    if (epoch >= toMs) return false;
    if (exdates.has(epoch)) return true; // exception, not an occurrence
    if (overrides.has(epoch)) {
      const ov = overrides.get(epoch);
      push(ov.start, ov.end, true, epoch);
    } else {
      push(epoch, epoch + durationMs, false, epoch);
    }
    return true;
  };

  if (rule.freq === 'DAILY') {
    cursor = { ...baseParts };
    while (guard()) {
      const epoch = zonedToUtc(cursor, tz);
      if (!emit(epoch, cursor)) break;
      cursor = addDaysToParts(cursor, interval);
    }
    return out;
  }

  if (rule.freq === 'WEEKLY') {
    const days = byDay.length ? byDay.map((d) => WEEKDAY_INDEX[d.day]) : [weekdayOfParts(baseParts)];
    if (byMonth.length) {
      // BYMONTH filter on weekly rules
    }
    let week = startOfWeekParts(baseParts, wkst);
    while (guard()) {
      for (const dayIndex of days) {
        const target = WEEKDAY_INDEX[wkst] != null ? WEEKDAY_INDEX[wkst] : 1;
        const offset = (dayIndex - target + 7) % 7;
        const parts = addDaysToParts(week, offset);
        if (byMonth.length && !byMonth.includes(parts.month)) continue;
        const epoch = zonedToUtc(parts, tz);
        if (!emit(epoch, parts)) return out;
      }
      week = addDaysToParts(week, interval * 7);
      if (zonedToUtc(week, tz) > Math.min(until, toMs) + 7 * DAY_MS) break;
    }
    return out;
  }

  if (rule.freq === 'MONTHLY') {
    cursor = { ...baseParts };
    while (guard()) {
      const monthDays = byMonthDay.length ? byMonthDay : [];
      let emittedThisMonth = false;
      if (!byDay.length && !monthDays.length) {
        if (baseParts.day <= daysInMonth(cursor.year, cursor.month)) {
          const parts = { ...baseParts, year: cursor.year, month: cursor.month, day: baseParts.day };
          const epoch = zonedToUtc(parts, tz);
          if (!emit(epoch, parts)) break;
          emittedThisMonth = true;
        }
      } else {
        const dim = daysInMonth(cursor.year, cursor.month);
        const candidates = new Set();
        for (const md of monthDays) {
          const actual = md > 0 ? md : dim + md + 1;
          if (actual >= 1 && actual <= dim) candidates.add(actual);
        }
        if (byDay.length) {
          for (const d of byDay) {
            const targetIdx = WEEKDAY_INDEX[d.day];
            const matching = [];
            for (let day = 1; day <= dim; day++) {
              const wd = new Date(Date.UTC(cursor.year, cursor.month - 1, day)).getUTCDay();
              if (wd === targetIdx) matching.push(day);
            }
            if (d.n > 0) {
              if (matching[d.n - 1]) candidates.add(matching[d.n - 1]);
            } else if (d.n < 0) {
              const idx = matching.length + d.n;
              if (matching[idx]) candidates.add(matching[idx]);
            } else {
              for (const day of matching) candidates.add(day);
            }
          }
        }
        const sorted = [...candidates].sort((a, b) => a - b);
        for (const day of sorted) {
          const parts = { ...baseParts, year: cursor.year, month: cursor.month, day };
          if (byMonth.length && !byMonth.includes(parts.month)) continue;
          const epoch = zonedToUtc(parts, tz);
          if (!emit(epoch, parts)) return out;
          emittedThisMonth = true;
        }
      }
      cursor = addMonths({ ...cursor, day: 1 }, interval);
      if (zonedToUtc(cursor, tz) > Math.min(until, toMs) + 32 * DAY_MS) break;
    }
    return out;
  }

  if (rule.freq === 'YEARLY') {
    cursor = { ...baseParts };
    while (guard()) {
      const months = byMonth.length ? byMonth : [cursor.month];
      let stop = false;
      for (const month of months) {
        if (!byMonthDay.length) {
          if (baseParts.day > daysInMonth(cursor.year, month)) continue;
          const parts = { ...baseParts, year: cursor.year, month, day: baseParts.day };
          if (!emit(zonedToUtc(parts, tz), parts)) {
            stop = true;
            break;
          }
        } else {
          const dim = daysInMonth(cursor.year, month);
          for (const md of byMonthDay) {
            const day = md > 0 ? md : dim + md + 1;
            if (day < 1 || day > dim) continue;
            const parts = { ...baseParts, year: cursor.year, month, day };
            if (!emit(zonedToUtc(parts, tz), parts)) {
              stop = true;
              break;
            }
          }
        }
      }
      if (stop) break;
      cursor = { ...cursor, year: cursor.year + interval };
      if (zonedToUtc(cursor, tz) > Math.min(until, toMs) + 366 * DAY_MS) break;
    }
    return out;
  }

  return out;
}

function parseRrule(value) {
  const rule = { freq: '', interval: 1 };
  for (const part of String(value || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).toUpperCase();
    const val = part.slice(eq + 1);
    switch (key) {
      case 'FREQ':
        rule.freq = val.toUpperCase();
        break;
      case 'INTERVAL':
        rule.interval = Math.max(1, Number(val) || 1);
        break;
      case 'COUNT':
        rule.count = Number(val) || 0;
        break;
      case 'UNTIL': {
        const parsed = parseDateValue(val);
        if (parsed) rule.untilEpoch = parsed.allDay ? parsed.epoch + DAY_MS - 1 : parsed.epoch;
        break;
      }
      case 'BYDAY':
        rule.byDay = parseByDay(val);
        break;
      case 'BYMONTHDAY':
        rule.byMonthDay = val.split(',').map(Number).filter((n) => Number.isFinite(n));
        break;
      case 'BYMONTH':
        rule.byMonth = val.split(',').map(Number).filter((n) => Number.isFinite(n));
        break;
      case 'WKST':
        rule.wkst = val.toUpperCase();
        break;
      default:
        break;
    }
  }
  return rule;
}

function parseVEvent(comp, source) {
  const dtStartProp = prop(comp, 'DTSTART');
  if (!dtStartProp) return null;
  const startInfo = parseDateValue(dtStartProp.value, dtStartProp.params);
  if (!startInfo) return null;
  const dtEndProp = prop(comp, 'DTEND');
  const durationProp = prop(comp, 'DURATION');
  let endInfo = null;
  if (dtEndProp) endInfo = parseDateValue(dtEndProp.value, dtEndProp.params);
  let end;
  if (endInfo) {
    end = endInfo.epoch;
  } else if (durationProp) {
    const d = parseDuration(durationProp.value);
    end = startInfo.epoch + (d == null ? (startInfo.allDay ? DAY_MS : 3600000) : d);
  } else {
    end = startInfo.epoch + (startInfo.allDay ? DAY_MS : 3600000);
  }
  if (startInfo.allDay && endInfo && endInfo.allDay) {
    // DTEND for all-day is exclusive: already what we want.
  }
  if (end < startInfo.epoch) end = startInfo.epoch + (startInfo.allDay ? DAY_MS : 3600000);

  const get = (name) => {
    const p = prop(comp, name);
    return p ? unescapeText(p.value) : '';
  };
  const statusProp = prop(comp, 'STATUS');
  const status = statusProp ? String(statusProp.value).toUpperCase() : '';
  if (status === 'CANCELLED') return null;

  const exdates = new Set();
  for (const p of props(comp, 'EXDATE')) {
    for (const val of String(p.value).split(',')) {
      const d = parseDateValue(val, p.params);
      if (d) exdates.add(d.epoch);
    }
  }

  const rruleProp = prop(comp, 'RRULE');
  const rrule = rruleProp ? parseRrule(rruleProp.value) : null;

  const tzid = normalizeTz(dtStartProp.params.TZID || (startInfo.allDay ? '' : startInfo.tzid || ''));
  const effectiveTz = startInfo.allDay ? '' : tzid;
  const startParts = startInfo.allDay
    ? { year: startInfo.year, month: startInfo.month, day: startInfo.day, hour: 0, minute: 0, second: 0 }
    : tzid
      ? utcToZonedParts(startInfo.epoch, tzid)
      : {
          year: startInfo.year,
          month: startInfo.month,
          day: startInfo.day,
          hour: startInfo.hour,
          minute: startInfo.minute,
          second: startInfo.second,
        };

  const recIdProp = prop(comp, 'RECURRENCE-ID');
  let recurrenceId = null;
  if (recIdProp) {
    const parsed = parseDateValue(recIdProp.value, recIdProp.params);
    if (parsed) recurrenceId = parsed.epoch;
  }

  const uid = get('UID') || 'no-uid-' + startInfo.epoch + '-' + Math.random().toString(36).slice(2, 8);
  return {
    uid,
    calendarId: source && source.id ? source.id : '',
    sourceName: source && source.name ? source.name : '',
    summary: get('SUMMARY') || (source && source.name) || 'Untitled',
    description: get('DESCRIPTION'),
    location: get('LOCATION'),
    url: get('URL'),
    start: startInfo.epoch,
    end,
    allDay: startInfo.allDay,
    tzid: effectiveTz,
    startParts,
    rrule,
    exdates,
    overrides: new Map(),
    recurrenceId,
    recurring: Boolean(rrule),
    class: (get('CLASS') || 'PUBLIC').toUpperCase(),
    status,
    organizer: get('ORGANIZER'),
    created: get('DTSTAMP'),
  };
}

/**
 * Parse an ICS string into events (masters only; recurrence overrides attached).
 */
function parseCalendar(text, source = {}) {
  const components = parsePropertyLines(text);
  const calendars = components.filter((c) => c.name === 'VCALENDAR');
  const found = [];
  const events = [];
  const masters = new Map();
  const overrides = [];

  const walk = (comp) => {
    for (const child of comp.children) {
      if (child.name === 'VEVENT') found.push(child);
      else walk(child);
    }
  };
  for (const cal of calendars.length ? calendars : components) walk(cal);

  for (const vevent of found) {
    const ev = parseVEvent(vevent, source);
    if (!ev) continue;
    if (ev.recurrenceId != null) {
      overrides.push(ev);
    } else {
      events.push(ev);
      masters.set(ev.uid, ev);
    }
  }
  for (const ov of overrides) {
    const master = masters.get(ov.uid);
    if (!master) {
      // A detached instance without its master: show it as a single event.
      ov.recurring = false;
      ov.start = ov.recurrenceId;
      ov.end = ov.end;
      events.push(ov);
      continue;
    }
    const duration = Math.max(0, ov.end - ov.start);
    master.overrides.set(ov.recurrenceId, {
      start: ov.start,
      end: ov.start + duration,
      summary: ov.summary,
      location: ov.location,
      description: ov.description,
    });
  }

  let meta = { name: source.name || '', timezone: '' };
  for (const cal of calendars) {
    const nameProp = prop(cal, 'X-WR-CALNAME');
    if (nameProp) meta.name = unescapeText(nameProp.value);
    const tzProp = prop(cal, 'X-WR-TIMEZONE');
    if (tzProp) meta.timezone = normalizeTz(tzProp.value);
  }
  return { events, meta };
}

/**
 * Expand parsed events into occurrences in [from, to).
 * Applies RECURRENCE-ID overrides, sorts, and hides class=PRIVATE when asked.
 */
function expandCalendar(events, fromMs, toMs, { hidePrivate = false, max = 2000 } = {}) {
  const out = [];
  for (const ev of events) {
    if (hidePrivate && ev.class === 'PRIVATE') continue;
    const occ = expandEvent(ev, fromMs, toMs);
    for (const o of occ) {
      const override = ev.overrides && ev.overrides.get(o.recurrenceKey);
      out.push({
        id: ev.uid + '@' + o.recurrenceKey,
        uid: ev.uid,
        calendarId: ev.calendarId,
        sourceName: ev.sourceName,
        summary: override && override.summary ? override.summary : ev.summary,
        description: override && override.description != null ? override.description : ev.description,
        location: override && override.location != null ? override.location : ev.location,
        start: o.start,
        end: o.end,
        allDay: o.allDay,
        tzid: ev.tzid,
        recurring: Boolean(ev.recurring),
        class: ev.class,
        status: ev.status,
        url: ev.url,
        overridden: Boolean(o.overridden),
      });
      if (out.length >= max) break;
    }
    if (out.length >= max) break;
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

function formatIcsForShare(events, { name = 'Connect All', tzid = systemTimeZone() } = {}) {
  const fmt = (epoch) => {
    const d = new Date(epoch);
    return (
      d.getUTCFullYear() +
      String(d.getUTCMonth() + 1).padStart(2, '0') +
      String(d.getUTCDate()).padStart(2, '0') +
      'T' +
      String(d.getUTCHours()).padStart(2, '0') +
      String(d.getUTCMinutes()).padStart(2, '0') +
      String(d.getUTCSeconds()).padStart(2, '0') +
      'Z'
    );
  };
  const escape = (s) =>
    String(s || '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Connect All//CA 1.0//EN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:' + escape(name),
    'X-WR-TIMEZONE:' + tzid,
  ];
  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + escape(ev.uid || ev.id || caUid(ev)));
    lines.push('DTSTAMP:' + fmt(Date.now()));
    if (ev.allDay) {
      // All-day dates are local calendar dates, not instants: never convert to UTC.
      const dateOnly = (epoch) => {
        const d = new Date(epoch);
        return (
          d.getFullYear() +
          String(d.getMonth() + 1).padStart(2, '0') +
          String(d.getDate()).padStart(2, '0')
        );
      };
      lines.push('DTSTART;VALUE=DATE:' + dateOnly(ev.start));
      lines.push('DTEND;VALUE=DATE:' + dateOnly(ev.end));
    } else {
      lines.push('DTSTART:' + fmt(ev.start));
      lines.push('DTEND:' + fmt(ev.end));
    }
    lines.push('SUMMARY:' + escape(ev.summary));
    if (ev.location) lines.push('LOCATION:' + escape(ev.location));
    if (ev.description) lines.push('DESCRIPTION:' + escape(ev.description).slice(0, 4000));
    if (ev.class === 'PRIVATE') lines.push('CLASS:PRIVATE');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  // Fold long lines at 74 octets (roughly; UTF-8 aware).
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

function caUid(ev) {
  return 'ca-' + Buffer.from(ev.start + '-' + (ev.summary || '')).toString('base64url').slice(0, 24);
}

function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 74) return line;
  const out = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const chSize = Buffer.byteLength(ch, 'utf8');
    if (size + chSize > 72) {
      out.push(current);
      current = ' ' + ch;
      size = 1 + chSize;
    } else {
      current += ch;
      size += chSize;
    }
  }
  if (current) out.push(current);
  return out.join('\r\n');
}

module.exports = {
  parseCalendar,
  expandCalendar,
  expandEvent,
  formatIcsForShare,
  parseDateValue,
  parseDuration,
  parseRrule,
  normalizeTz,
  isValidTimeZone,
  systemTimeZone,
  zonedToUtc,
  utcToZonedParts,
  unfold,
  splitParams,
};
