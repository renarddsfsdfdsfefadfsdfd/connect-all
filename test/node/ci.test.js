'use strict';
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../harness');
const { tmpDir, rmrf, fakeLLM, sleep } = require('../helpers');
const { JsonStore, createPaths } = require('../../app/core/store');
const { createSecretStore } = require('../../app/core/secrets');
const { ConnectIntelligence, localSummary } = require('../../app/core/ci');
const { DEFAULT_CONFIG } = require('../../app/core/defaults');

function makeCi(dir, getContext) {
  const paths = createPaths(dir);
  const store = new JsonStore(paths.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  const secrets = createSecretStore({ file: paths.secrets, encryptor: require('../helpers').fakeEncryptor });
  const ci = new ConnectIntelligence({ store, secrets, paths, lang: 'zh', getContext });
  return { ci, store, secrets, paths };
}

test('local heuristic marks non-committal replies as unanswered', () => {
  const now = Date.now();
  const summary = localSummary(
    [
      { from: 'peer', text: '周末你能来吗？', at: now - 3600e3 },
      { from: 'me', text: '我想想', at: now - 3000e3 },
      { from: 'me', text: '我答应你周五前回复', at: now - 2000e3 },
      { from: 'peer', text: '那你几点到？', at: now - 1000e3 },
    ],
    { lang: 'zh', now }
  );
  assert.ok(summary.unanswered.length >= 1);
  assert.ok(summary.promises.some((p) => p.what.includes('周五')));
  assert.ok(summary.risks.some((r) => r.issue.includes('问题')));
});

test('CI calls an OpenAI-compatible endpoint and persists a structured recap', async () => {
  const dir = tmpDir('ca-ci');
  const llm = await fakeLLM(
    JSON.stringify({
      headline: '周末待确认',
      topics: [{ title: '周末', detail: '聊到见面' }],
      promises: [{ who: '我', what: '周五前订票', by: '周五' }],
      unanswered: [{ question: '几点到？', askedBy: 'TA', since: '10:34' }],
      plans: [],
      mood: { label: '平稳', note: '' },
      risks: [],
      nextActions: ['回复时间'],
    })
  );
  try {
    const messages = [
      { from: 'peer', text: '周末来吗？', at: Date.now() - 60e3 },
      { from: 'me', text: '我周五前订票', at: Date.now() - 30e3 },
      { from: 'peer', text: '几点到？', at: Date.now() - 10e3 },
    ];
    const { ci, store, secrets, paths } = makeCi(dir, () => ({ messages, events: [] }));
    secrets.set('ci.apiKey', 'sk-test-1234');
    ci.configure({ enabled: true, provider: 'deepseek', baseUrl: llm.url, model: 'deepseek-chat', intervalMin: 60 });
    const result = await ci.runNow({ manual: true });
    assert.ok(result.ok);
    assert.equal(result.source, 'llm');
    assert.equal(result.summary.summary.headline, '周末待确认');
    assert.ok(llm.captured.length === 1);
    assert.equal(llm.captured[0].headers.authorization, 'Bearer sk-test-1234');
    assert.equal(llm.captured[0].body.model, 'deepseek-chat');
    assert.ok(llm.captured[0].body.messages[1].content.includes('几点到'));
    assert.ok(llm.captured[0].body.messages[0].content.includes('JSON'));
    assert.ok(ci.publicConfig().hasKey);
    assert.ok(!JSON.stringify(ci.publicConfig()).includes('sk-test-1234'));
    assert.equal(ci.stats().count, 1);
    // reload from disk
    const again = makeCi(dir, () => ({ messages: [], events: [] })).ci;
    assert.equal(again.stats().count, 1);
    assert.equal(again.list()[0].source, 'llm');
  } finally {
    llm.server.close();
    rmrf(dir);
  }
});

test('CI falls back to the local summarizer when the model fails', async () => {
  const dir = tmpDir('ca-ci2');
  const llm = await fakeLLM(() => ({ status: 500, body: { error: 'boom' } }));
  try {
    const messages = [
      { from: 'peer', text: '你什么时候到？', at: Date.now() - 60e3 },
      { from: 'me', text: '我答应你七点', at: Date.now() - 30e3 },
    ];
    const { ci, secrets } = makeCi(dir, () => ({ messages, events: [] }));
    secrets.set('ci.apiKey', 'sk-test');
    ci.configure({ enabled: true, provider: 'deepseek', baseUrl: llm.url, model: 'deepseek-chat' });
    const result = await ci.runNow({ manual: true });
    assert.ok(result.ok);
    assert.equal(result.source, 'local-fallback');
    assert.ok(ci.config.lastError.includes('500'));
    assert.ok(result.summary.summary.headline.length > 0);
  } finally {
    llm.server.close();
    rmrf(dir);
  }
});

test('CI runs offline without an API key and schedules the next hour', async () => {
  const dir = tmpDir('ca-ci3');
  try {
    const messages = [
      { from: 'peer', text: '在干嘛？', at: Date.now() - 60e3 },
      { from: 'me', text: '在自习', at: Date.now() - 30e3 },
    ];
    const { ci } = makeCi(dir, () => ({ messages, events: [] }));
    ci.configure({ enabled: true, intervalMin: 60 });
    assert.ok(!ci.hasKey());
    const result = await ci.runNow({ manual: true });
    assert.equal(result.source, 'local');
    const status = ci.status();
    assert.ok(status.nextRunAt > Date.now());
    assert.equal(status.count, 1);
    ci.stop();
  } finally {
    rmrf(dir);
  }
});

test('empty windows skip without spending a model call', async () => {
  const dir = tmpDir('ca-ci4');
  try {
    const { ci } = makeCi(dir, () => ({ messages: [], events: [] }));
    const result = await ci.runNow({ manual: true });
    assert.ok(result.ok);
    assert.ok(result.skipped);
    assert.equal(ci.stats().count, 0);
  } finally {
    rmrf(dir);
  }
});
