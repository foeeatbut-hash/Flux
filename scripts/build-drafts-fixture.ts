import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Отдельная неизменяемая сборка не перезагружает страницу посреди проверки.
build({
  configFile: false, root: process.cwd(), base: './',
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify('fixture'), __FLUX_E3_FAKE__: 'false' },
  build: {
    outDir: '.cache/drafts-ui', emptyOutDir: true,
    rollupOptions: { input: path.resolve('scripts/fixtures/drafts-panel.html') },
  },
}).catch(error => { console.error(error); process.exitCode = 1; });
