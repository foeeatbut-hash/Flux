'use strict';
/**
 * Оболочка окон Flux Studio, общая с Flux: оформление и стартовая заставка берутся из самого Flux.
 *
 *  - Стили. Окно Studio подключает src/index.css целиком (токены, шрифты, fx-* и Tailwind) через studio/renderer/flux.css;
 *    собирает их Vite с тем же плагином Tailwind, что и сам Flux, — поэтому вид окон один и тот же, а не «похожий».
 *  - Заставка. Её разметка, стили и скрипт лежат в корневом index.html Flux. Здесь они достаются оттуда (а не копируются
 *    руками): правка заставки Flux сама доходит до Studio. Окно Studio запрещает встроенные скрипты и стили, поэтому
 *    они выносятся в файлы splash.css и splash.js; если разметка index.html Flux изменится так, что достать часть нельзя,
 *    сборка падает с названием части, а не выпускает окно без заставки.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

/** CSS Flux для окон Studio: <dir>/flux.css и шрифты рядом в <dir>/fonts */
async function buildFluxCss(dir, entry = path.join(root, 'studio/renderer/flux-css-entry.js')) {
  // Vite и плагин Tailwind поставляются как ES-модули
  const { build } = await import('vite');
  const tailwindcss = (await import('@tailwindcss/vite')).default;
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'flux-studio-css-'));
  try {
    await build({
      root: path.join(root, 'studio'), configFile: false, logLevel: 'error', plugins: [tailwindcss()], base: './',
      build: {
        outDir: temp, emptyOutDir: true, assetsDir: 'fonts', cssCodeSplit: false, assetsInlineLimit: 0,
        rollupOptions: { input: entry, output: { entryFileNames: 'unused.js', assetFileNames: info => (String(info.names?.[0] || info.name || '').endsWith('.css') ? 'flux.css' : 'fonts/[name][extname]') } },
      },
    });
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(temp, 'flux.css'), path.join(dir, 'flux.css'));
    fs.cpSync(path.join(temp, 'fonts'), path.join(dir, 'fonts'), { recursive: true });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function part(text, pattern, what) {
  const found = pattern.exec(text);
  if (!found) throw new Error(`index.html Flux изменился: не найдена часть «${what}» стартовой заставки. Поправьте studio/build-renderer.cjs.`);
  return found[1];
}

/** Достаёт заставку из корневого index.html; name — слово на заставке («Flux Studio»), subtitle — подпись под ним */
function splashParts({ name, subtitle, stages }) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const style = part(html, /<style>([\s\S]*?)<\/style>/, 'стили');
  const markup = part(html, /(<div id="boot-splash">[\s\S]*?<\/div>)\s*<script>/, 'разметка');
  const script = part(html, /<script>([\s\S]*?)<\/script>\s*<div id="root">/, 'скрипт');
  const favicon = part(html, /<link rel="icon" href="([^"]+)"/, 'значок вкладки');
  const patched = {
    markup: markup
      .replace(/<div class="wordmark">[^<]*<\/div>/, () => `<div class="wordmark">${name}</div>`)
      .replace(/<div class="subtitle">[^<]*<\/div>/, () => `<div class="subtitle">${subtitle}</div>`),
    // Этапы запуска Flux (сервер, миграции) к Studio не относятся: у неё свои, короткие
    script: script.replace(/var STAGES = remote \? \[[\s\S]*?\] : \[[\s\S]*?\];/, () => `var STAGES = ${JSON.stringify(stages)};`),
  };
  if (!patched.markup.includes(`>${name}<`) || !patched.markup.includes(`>${subtitle}<`)) throw new Error('index.html Flux изменился: на заставке не нашлись слово или подпись. Поправьте studio/build-renderer.cjs.');
  if (!patched.script.includes(JSON.stringify(stages))) throw new Error('index.html Flux изменился: в скрипте заставки не найден список этапов. Поправьте studio/build-renderer.cjs.');
  return { style, markup: patched.markup, script: patched.script, favicon };
}

/** Страница окна Studio: шаблон studio/renderer/index.html с подставленной заставкой и ссылками на файлы */
function writeRendererPage(dir, options) {
  const parts = splashParts(options);
  fs.writeFileSync(path.join(dir, 'splash.css'), parts.style);
  fs.writeFileSync(path.join(dir, 'splash.js'), parts.script);
  const template = fs.readFileSync(path.join(root, 'studio/renderer/index.html'), 'utf8');
  for (const token of ['<!--SPLASH-->', '<!--FAVICON-->']) if (!template.includes(token)) throw new Error(`В studio/renderer/index.html нет места ${token}.`);
  fs.writeFileSync(path.join(dir, 'index.html'), template.replace('<!--SPLASH-->', () => parts.markup).replace('<!--FAVICON-->', () => `<link rel="icon" href="${parts.favicon}">`));
}

module.exports = { buildFluxCss, writeRendererPage, splashParts };
