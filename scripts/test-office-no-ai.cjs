'use strict';

const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const run = (args) => spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
});

const renderer = run([resolve(__dirname, 'test-office-no-ai.mjs')]);
if (renderer.error) throw renderer.error;
if (renderer.status !== 0) process.exit(renderer.status ?? 1);

const gateway = run(['--import', 'tsx', resolve(__dirname, 'test-office-host-policy.ts')]);
if (gateway.error) throw gateway.error;
process.exitCode = gateway.status ?? 1;
