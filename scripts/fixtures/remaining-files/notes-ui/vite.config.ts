import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(fixtureDir, '../../../..');

export default defineConfig({
  root: fixtureDir,
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify('remaining-files-notes-fixture') },
  server: { host: '127.0.0.1', fs: { allow: [projectDir, fixtureDir] } },
});
