'use strict';
/*
 * Small HTTP/JSON client used by pairing, relay health checks and backups.
 * Self-hosted servers often use self-signed certificates, so `insecure` is a
 * deliberate, explicit opt-in per server entry (never a global default).
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function request(urlStr, { method = 'GET', headers = {}, body = null, timeout = 12000, insecure = false, maxBytes = 8 * 1024 * 1024, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (_) {
      reject(new Error('invalid url: ' + urlStr));
      return;
    }
    const secure = url.protocol === 'https:';
    if (!secure && url.protocol !== 'http:') {
      reject(new Error('unsupported protocol: ' + url.protocol));
      return;
    }
    const payload = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const opts = {
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: Object.assign(
        {
          'User-Agent': 'ConnectAll/1.0',
          Accept: 'application/json',
        },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
        headers
      ),
      timeout,
      rejectUnauthorized: !insecure,
      agent: false,
    };
    const lib = secure ? https : http;
    const req = lib.request(opts, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) {
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
          return;
        }
        const text = buf.toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

async function jsonRequest(url, opts = {}) {
  const res = await request(url, opts);
  if (res.status < 200 || res.status >= 300) {
    const msg = res.body && (res.body.error || res.body.message) ? res.body.error || res.body.message : res.text;
    const err = new Error('HTTP ' + res.status + (msg ? ': ' + String(msg).slice(0, 200) : ''));
    err.status = res.status;
    err.body = res.body;
    throw err;
  }
  return res.body;
}

module.exports = { request, jsonRequest };
