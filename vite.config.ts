import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';
import {defineConfig} from 'vite';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig(() => {
  return {
    base: './',
    // Версия приложения из package.json — чтобы не хардкодить в UI
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR toggle via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // Рабочие копии субагентов (.claude/worktrees) — полные клоны репозитория:
      // без исключения каждая их правка перезагружала страницу в основном
      // сервере посреди проверки, и test-flow/test-layout падали на входе.
      watch: process.env.DISABLE_HMR === 'true' ? null : { ignored: ['**/.claude/**', '**/.probe/**', '**/database/**'] },
      // Интерфейс собирается сразу при старте сервера, а не по первому
      // запросу страницы: иначе первое открытие ждёт сборки больше минуты, и
      // проверки через браузер, запущенные сразу после сервера, падали на входе.
      warmup: { clientFiles: ['./src/main.tsx'] },
    },
    // Зависимости ищутся только от настоящей страницы. По умолчанию Vite
    // сканирует все *.html в корне — образцы docs/stand и index.html рабочих
    // копий субагентов, — находит «новые» зависимости уже после открытия
    // страницы и пересобирает их на ходу: страница перезагружается, а до того
    // успевает получить две копии React («Invalid hook call»).
    optimizeDeps: {
      entries: ['index.html'],
    },
  };
});
