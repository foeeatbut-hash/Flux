import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(fixtureDir, '../../..');
export default defineConfig({ root: fixtureDir, plugins: [react(), tailwindcss()], define: { __APP_VERSION__: JSON.stringify('fixture') }, resolve: { dedupe: ['react', 'react-dom'] }, server: { fs: { allow: [projectDir, fixtureDir] } }, optimizeDeps: { entries: [path.join(fixtureDir, 'index.html')] } });
