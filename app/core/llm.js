'use strict';
/*
 * Connect All — model access.
 *
 * Both DeepSeek and Doubao (Volcengine Ark) expose an OpenAI-compatible
 * /chat/completions endpoint, so one small client covers both and also any
 * self-hosted compatible endpoint.
 *
 * The API key never leaves the main process: the renderer only ever sees a
 * masked hint, and requests are issued here.
 */

const { jsonRequest } = require('./http');

const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat（通用）' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner（推理）' },
      { id: 'deepseek-flash', label: 'DeepSeek Flash（快速）' },
    ],
  },
  doubao: {
    id: 'doubao',
    name: 'Doubao / 豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyUrl: 'https://console.volcengine.com/ark',
    models: [
      { id: 'doubao-seed-1-6-250615', label: 'Doubao Seed 1.6' },
      { id: 'doubao-seed-1-6-flash-250715', label: 'Doubao Seed 1.6 Flash' },
      { id: 'doubao-1-5-pro-32k-250115', label: 'Doubao 1.5 Pro 32k' },
      { id: 'doubao-pro-32k', label: 'Doubao Pro 32k' },
    ],
  },
};

function providerList() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    keyUrl: p.keyUrl,
    models: p.models,
  }));
}

function defaultBaseUrl(provider) {
  return (PROVIDERS[provider] && PROVIDERS[provider].baseUrl) || '';
}

function normalizeBaseUrl(baseUrl, provider) {
  let base = String(baseUrl || '').trim() || defaultBaseUrl(provider);
  base = base.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  return base + '/chat/completions';
}

function friendlyError(err) {
  const msg = String((err && err.message) || err || 'unknown error');
  const status = err && err.status;
  if (status === 401 || status === 403) return 'API Key 无效或没有权限 / Invalid API key or permission denied';
  if (status === 404) return '模型或接口地址不存在 / Model or endpoint not found';
  if (status === 402 || status === 429) return '额度不足或请求过于频繁 / Quota exhausted or rate limited';
  if (/timeout/i.test(msg)) return '请求超时 / Request timed out';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/i.test(msg)) return '网络不可达 / Network unreachable';
  if (/certificate|self.signed/i.test(msg)) return 'TLS 证书校验失败 / TLS certificate verification failed';
  return msg.slice(0, 300);
}

/**
 * One chat completion. Returns {content, usage, model, latencyMs}.
 */
async function chatCompletion({
  provider = 'deepseek',
  baseUrl = '',
  apiKey,
  model,
  messages,
  temperature = 0.3,
  maxTokens = 1600,
  timeout = 60000,
  retries = 1,
  insecure = false,
}) {
  if (!apiKey) throw Object.assign(new Error('missing API key'), { code: 'NO_KEY' });
  if (!model) throw new Error('missing model');
  if (!Array.isArray(messages) || !messages.length) throw new Error('missing messages');
  const url = normalizeBaseUrl(baseUrl, provider);
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  let attempt = 0;
  let lastErr = null;
  while (attempt <= retries) {
    attempt += 1;
    const started = Date.now();
    try {
      const res = await jsonRequest(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
        },
        body,
        timeout,
        insecure,
      });
      const choice = res && res.choices && res.choices[0];
      let content = choice && choice.message ? choice.message.content : '';
      if (Array.isArray(content)) {
        content = content.map((part) => (typeof part === 'string' ? part : part && part.text ? part.text : '')).join('');
      }
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('empty completion');
      }
      return {
        content: content.trim(),
        usage: res.usage || null,
        model: res.model || model,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      lastErr = err;
      const status = err && err.status;
      const retriable = !status || status === 408 || status === 429 || status >= 500;
      if (attempt > retries || !retriable) break;
      await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  const out = new Error(friendlyError(lastErr));
  out.cause = lastErr;
  out.status = lastErr && lastErr.status;
  throw out;
}

/** Reachability + credentials check used by Settings. */
async function testConnection(opts) {
  const started = Date.now();
  try {
    const res = await chatCompletion({
      ...opts,
      messages: [
        { role: 'system', content: 'Reply with exactly: OK' },
        { role: 'user', content: 'ping' },
      ],
      maxTokens: 12,
      temperature: 0,
      timeout: 20000,
      retries: 0,
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      model: res.model,
      sample: res.content.slice(0, 80),
      usage: res.usage,
    };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - started, code: err.code || '' };
  }
}

/** Extract the first JSON object from model output (tolerates code fences). */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = s.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

module.exports = {
  PROVIDERS,
  providerList,
  defaultBaseUrl,
  normalizeBaseUrl,
  chatCompletion,
  testConnection,
  extractJson,
  friendlyError,
};
