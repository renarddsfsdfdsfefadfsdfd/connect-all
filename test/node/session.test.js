'use strict';
const path = require('path');
const { test, assert } = require('../harness');
const { tmpDir, rmrf, waitFor, fakeEncryptor, sleep } = require('../helpers');
const { Session } = require('../../app/core/session');
const { createRelay } = require('../../server/ca-server');

function makeSession(name, dir) {
  const s = new Session({
    userDataDir: dir,
    deviceName: name,
    encryptor: fakeEncryptor,
    platform: 'test',
    appVersion: 'test',
    getIdleSeconds: () => 0,
  });
  s.init();
  return s;
}

test('two sessions pair, chat, share a calendar, summarize and restore a backup', async () => {
  const dirA = tmpDir('ca-session-a');
  const dirB = tmpDir('ca-session-b');
  const relayDir = tmpDir('ca-session-relay');
  const relay = createRelay({ port: 0, host: '127.0.0.1', dataDir: relayDir, quiet: true });
  const addr = await relay.listen();
  const base = 'http://127.0.0.1:' + addr.port;
  let A;
  let B;
  try {
    A = makeSession('Alice', dirA);
    B = makeSession('Bob', dirB);
    A.setServer({ url: base, mode: 'relay' });
    B.setServer({ url: base, mode: 'relay' });
    const code = 'TEST42';
    await A.pairingStartServer(code);
    await B.pairingStartServer(code);
    await waitFor(() => A.pairingStatus().state === 'verify' && B.pairingStatus().state === 'verify', { label: 'pair verify' });
    assert.equal(A.pairingStatus().sas, B.pairingStatus().sas);
    A.pairingConfirm();
    B.pairingConfirm();
    await waitFor(() => A.linkState().online && B.linkState().online, { label: 'relay online' });
    assert.ok(A.identity.isPaired && B.identity.isPaired);
    assert.equal(A.identity.sas(), B.identity.sas());

    A.sendChat('今晚一起看电影？');
    await waitFor(() => B.chat.list({ limit: 5 }).some((m) => m.text.includes('看电影')), { label: 'B chat' });
    B.sendChat('好呀，八点');
    await waitFor(() => A.chat.list({ limit: 5 }).some((m) => m.text.includes('八点')), { label: 'A chat' });
    await waitFor(() => A.chat.list({ limit: 5 }).filter((m) => m.from === 'me').every((m) => m.state === 'delivered'), { label: 'acks' });

    const ics = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:s1\nDTSTART:20261110T060000Z\nDTEND:20261110T080000Z\nSUMMARY:一起看电影\nLOCATION:天河影院\nEND:VEVENT\nEND:VCALENDAR`;
    A.calendarImportText(ics, 'Date night');
    A.shareCalendar('manual');
    await waitFor(() => B.calendar.partnerSummary().count > 0, { label: 'calendar share' });
    const partnerEvents = B.calendarEvents(Date.parse('2026-11-10T00:00:00Z'), Date.parse('2026-11-11T00:00:00Z')).partner;
    assert.ok(partnerEvents.some((e) => e.summary === '一起看电影' && e.location === '天河影院'));

    A.ciConfigure({ enabled: true, provider: 'deepseek', model: 'deepseek-chat' });
    const ciResult = await A.ciRun();
    assert.ok(ciResult.ok);
    assert.equal(ciResult.source, 'local');
    assert.ok(A.ci.list().length >= 1);

    const backup = await A.backupNow();
    assert.ok(backup.ok, 'backup ok');
    const list = await A.backupList();
    assert.ok(list.ok && list.files.length >= 1);
    A.ciClear();
    A.clearChat();
    assert.equal(A.ci.list().length, 0);
    assert.equal(A.chat.list({ limit: 10 }).length, 0);
    const restored = await A.backupRestore();
    assert.ok(restored.ok);
    assert.ok(A.ci.list().length >= 1);
    assert.ok(A.chat.list({ limit: 10 }).length >= 2);

    const snapshot = A.snapshot();
    assert.ok(snapshot.app.pairing.peer.name === 'Bob');
    assert.ok(snapshot.calendar.sources.length === 1);
    A.unpair();
    assert.ok(!A.identity.isPaired);
  } finally {
    try {
      A && A.destroy();
      B && B.destroy();
    } catch (_) {}
    await relay.close();
    rmrf(dirA);
    rmrf(dirB);
    rmrf(relayDir);
  }
});

test('offline invitation pair derives the same SAS without a server', () => {
  const dirA = tmpDir('ca-off-a');
  const dirB = tmpDir('ca-off-b');
  let A;
  let B;
  try {
    A = makeSession('Alice', dirA);
    B = makeSession('Bob', dirB);
    const { invite } = A.pairingCreateInvite();
    const bStatus = B.pairingAcceptInvite(invite);
    assert.ok(bStatus.reply);
    const aStatus = A.pairingAcceptReply(bStatus.reply);
    assert.equal(aStatus.sas, bStatus.sas);
    A.pairingConfirm();
    B.pairingConfirm();
    assert.ok(A.identity.isPaired && B.identity.isPaired);
    assert.equal(A.identity.sas(), B.identity.sas());
  } finally {
    try {
      A && A.destroy();
      B && B.destroy();
    } catch (_) {}
    rmrf(dirA);
    rmrf(dirB);
  }
});
