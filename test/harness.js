'use strict';
/* Connect All — tiny dependency-free test harness. */

const path = require('path');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const assert = {
  ok(value, message) {
    if (!value) throw new Error(message || 'expected truthy value');
  },
  equal(actual, expected, message) {
    if (actual !== expected) throw new Error((message || 'equal') + ': ' + JSON.stringify(actual) + ' !== ' + JSON.stringify(expected));
  },
  deepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error((message || 'deepEqual') + ':\n' + a + '\n!==\n' + b);
  },
  throws(fn, message) {
    let threw = false;
    try {
      fn();
    } catch (_) {
      threw = true;
    }
    if (!threw) throw new Error(message || 'expected throw');
  },
};

async function run(files) {
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const file of files) {
    require(path.resolve(file));
  }
  for (const t of tests) {
    const started = Date.now();
    try {
      await t.fn();
      passed++;
      console.log('  ✓ ' + t.name + '  (' + (Date.now() - started) + 'ms)');
    } catch (err) {
      failed++;
      failures.push({ name: t.name, err });
      console.log('  ✗ ' + t.name);
      console.log('      ' + (err && err.message ? err.message.split('\n').join('\n      ') : err));
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
  return { passed, failed };
}

module.exports = { test, assert, run };
