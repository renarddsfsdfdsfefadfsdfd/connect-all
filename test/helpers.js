'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpDir(prefix = 'ca') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeout = 8000, interval = 50, label = 'condition' } = {}) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await sleep(interval);
  }
  throw new Error('timeout waiting for ' + label + (lastErr ? ': ' + lastErr.message : ''));
}

const fakeEncryptor = {
  available: () => true,
  encrypt: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
  decrypt: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
};

function fakeLLM(contentOrError) {
  const http = require('http');
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch (_) {}
      captured.push({ url: req.url, headers: req.headers, body: parsed });
      if (typeof contentOrError === 'function') {
        const custom = contentOrError(parsed);
        if (custom && custom.status) {
          res.writeHead(custom.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(custom.body || { error: 'fake error' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: parsed && parsed.model, choices: [{ message: { content: custom } }], usage: { prompt_tokens: 10 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: parsed && parsed.model,
          choices: [{ message: { content: contentOrError } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, captured, url: 'http://127.0.0.1:' + server.address().port + '/v1' });
    });
  });
}

module.exports = { tmpDir, rmrf, sleep, waitFor, fakeEncryptor, fakeLLM };
