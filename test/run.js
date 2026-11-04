'use strict';
/* Test runner: node test/run.js [--node-only] */
const fs = require('fs');
const path = require('path');
const { run } = require('./harness');

const dir = path.join(__dirname, 'node');
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(dir, f));

console.log('Connect All core tests (' + files.length + ' files)\n');
run(files).then(({ failed }) => {
  if (failed) process.exit(1);
});
