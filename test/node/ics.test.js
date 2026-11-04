'use strict';
const { test, assert } = require('../harness');
const ics = require('../../app/core/ics');

const WEEKLY = `BEGIN:VCALENDAR
VERSION:2.0
X-WR-CALNAME:Demo
BEGIN:VEVENT
UID:w1
DTSTART;TZID=Asia/Shanghai:20261102T090000
DTEND;TZID=Asia/Shanghai:20261102T100000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5
EXDATE;TZID=Asia/Shanghai:20261104T090000
SUMMARY:Recurring
END:VEVENT
BEGIN:VEVENT
UID:w1
RECURRENCE-ID;TZID=Asia/Shanghai:20261109T090000
DTSTART;TZID=Asia/Shanghai:20261109T140000
DTEND;TZID=Asia/Shanghai:20261109T150000
SUMMARY:Moved
END:VEVENT
END:VCALENDAR`;

test('ICS parses TZID, all-day, duration, folding and escaped text', () => {
  const text = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART;TZID=Asia/Shanghai:20261030T090000\r\nDTEND;TZID=Asia/Shanghai:20261030T103000\r\nSUMMARY:上海会议，\r\n 重要\r\nLOCATION:图书馆\\, 3楼\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:e2\r\nDTSTART;VALUE=DATE:20261030\r\nDTEND;VALUE=DATE:20261101\r\nSUMMARY:All day\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:e3\r\nDTSTART:20261030T120000Z\r\nDURATION:PT1H30M\r\nSUMMARY:Duration\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const parsed = ics.parseCalendar(text, { id: 'c1', name: 'Demo' });
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.meta.name, 'Demo');
  const ev1 = parsed.events.find((e) => e.uid === 'e1');
  assert.equal(ev1.summary, '上海会议，重要');
  assert.equal(ev1.location, '图书馆, 3楼');
  assert.equal(ev1.start, Date.parse('2026-10-30T01:00:00Z'));
  const ev2 = parsed.events.find((e) => e.uid === 'e2');
  assert.ok(ev2.allDay);
  const ev3 = parsed.events.find((e) => e.uid === 'e3');
  assert.equal(ev3.end - ev3.start, 90 * 60000);
});

test('weekly recurrence honours EXDATE, COUNT and RECURRENCE-ID override', () => {
  const parsed = ics.parseCalendar(WEEKLY, {});
  const occ = ics.expandCalendar(parsed.events, Date.parse('2026-11-01T00:00:00Z'), Date.parse('2026-12-01T00:00:00Z'));
  assert.deepEqual(
    occ.map((o) => new Date(o.start).toISOString()),
    [
      '2026-11-02T01:00:00.000Z',
      '2026-11-09T06:00:00.000Z',
      '2026-11-11T01:00:00.000Z',
      '2026-11-16T01:00:00.000Z',
    ]
  );
  const moved = occ.find((o) => o.start === Date.parse('2026-11-09T06:00:00Z'));
  assert.equal(moved.summary, 'Moved');
  assert.ok(moved.overridden);
  assert.ok(!occ.some((o) => o.start === Date.parse('2026-11-04T01:00:00Z')), 'EXDATE removed');
});

test('monthly recurrence skips months without the 31st', () => {
  const text = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:m1\nDTSTART:20260131T080000Z\nDTEND:20260131T090000Z\nRRULE:FREQ=MONTHLY;COUNT=4\nSUMMARY:31st\nEND:VEVENT\nEND:VCALENDAR`;
  const parsed = ics.parseCalendar(text, {});
  const days = ics.expandCalendar(parsed.events, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-08-01T00:00:00Z')).map((o) => new Date(o.start).toISOString().slice(0, 10));
  assert.deepEqual(days, ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
});

test('weekly recurrence keeps wall clock across DST', () => {
  const text = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:d1\nDTSTART;TZID=America/New_York:20260301T090000\nDTEND;TZID=America/New_York:20260301T100000\nRRULE:FREQ=WEEKLY;COUNT=4\nSUMMARY:DST\nEND:VEVENT\nEND:VCALENDAR`;
  const parsed = ics.parseCalendar(text, {});
  const stamps = ics.expandCalendar(parsed.events, Date.parse('2026-02-01T00:00:00Z'), Date.parse('2026-05-01T00:00:00Z')).map((o) => new Date(o.start).toISOString());
  assert.equal(stamps[0], '2026-03-01T14:00:00.000Z');
  assert.equal(stamps[1], '2026-03-08T13:00:00.000Z');
  assert.equal(stamps[2], '2026-03-15T13:00:00.000Z');
  assert.equal(stamps[3], '2026-03-22T13:00:00.000Z');
});

test('ICS export round-trips timed and all-day events', () => {
  const events = [
    { uid: 'a', summary: 'Timed, with comma', start: Date.parse('2026-11-04T11:00:00Z'), end: Date.parse('2026-11-04T12:00:00Z'), allDay: false, class: 'PUBLIC' },
    { uid: 'b', summary: 'All day', start: new Date(2026, 10, 5).getTime(), end: new Date(2026, 10, 6).getTime(), allDay: true, class: 'PRIVATE' },
  ];
  const text = ics.formatIcsForShare(events, { name: 'Share' });
  const parsed = ics.parseCalendar(text, {});
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events.find((e) => e.uid === 'a').summary, 'Timed, with comma');
  assert.ok(parsed.events.find((e) => e.uid === 'b').allDay);
  assert.equal(parsed.events.find((e) => e.uid === 'b').class, 'PRIVATE');
});

test('unsupported or broken ICS does not throw', () => {
  assert.deepEqual(ics.parseCalendar('not a calendar', {}).events, []);
  const noEnd = ics.parseCalendar('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART:20260101T100000Z\nSUMMARY:No end\nEND:VEVENT\nEND:VCALENDAR', {});
  assert.equal(noEnd.events[0].end - noEnd.events[0].start, 3600000);
});
