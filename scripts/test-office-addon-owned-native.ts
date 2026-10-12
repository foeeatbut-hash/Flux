/** Start the owned disposable-server runner for the Office browser integration. */
import { spawn } from 'node:child_process';
import path from 'node:path';

const child = spawn(
  process.execPath,
  ['--import', 'tsx', path.resolve('scripts/test-guide-server.ts'), '--office-addon-native'],
  { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
);

child.once('error', (error) => {
  console.error(`Could not start the owned Office fixture runner: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
