'use strict';
/**
 * Сборка Flux Studio: две программы из одного кода и с одним номером версии.
 *
 *   node studio/build.cjs developer        # FluxStudio.exe: оболочка разработчика
 *   node studio/build.cjs owner            # FluxStudio-Владелец.exe: оболочка + раздел владельца
 *   добавьте --pack, чтобы упаковать portable (на Windows; в CI)
 *
 * Версия берётся из корневого package.json — того же, что у Flux, — и нигде не
 * дублируется. Разделение сборок целиком здесь: у разработчика в пакет не
 * попадает ни один файл из studio/owner, и это проверяет
 * scripts/check-studio-bundle.ts и по карте сборки, и по тексту готового пакета.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const { buildDeveloperAssets, loadStaticValidation } = require('./build-assets.cjs');
const { buildFluxCss, writeRendererPage } = require('./build-renderer.cjs');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

const TARGETS = {
  developer: {
    entry: 'studio/entry-developer.ts', productName: 'Flux Studio', appId: 'ru.flux.studio', exe: 'FluxStudio.exe',
    description: 'Flux Studio — программа разработчика программ Flux', subtitle: 'Программа разработчика', icon: 'studio-developer',
  },
  owner: {
    entry: 'studio/entry-owner.ts', productName: 'Flux Studio — Владелец', appId: 'ru.flux.studio.owner', exe: 'FluxStudio-Владелец.exe',
    description: 'Flux Studio — сборка владельца: лицензии, выпуск обновлений Flux и подписи', subtitle: 'Сборка владельца', icon: 'studio-owner',
  },
};

/** Точка подключения редакторов: настоящий раздел, если он есть в репозитории, иначе заглушка «раздел в работе» */
function editorsEntry() {
  const real = path.join(root, 'studio/renderer/editors/index.tsx');
  return fs.existsSync(real) ? real : path.join(root, 'studio/renderer/editorsStub.tsx');
}

/**
 * Собирает пакет приложения в <outDir>/app и возвращает карту сборки основного процесса.
 * `extraMain` нужен только проверкам: он подмешивает в основной бандл лишний файл,
 * чтобы доказать, что проверка бандла разработчика умеет падать.
 */
async function buildStudio({ target, outDir, extraMain = null }) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`Неизвестная цель сборки: ${target}`);
  const app = path.join(outDir, 'app');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(app, 'renderer'), { recursive: true });

  const define = { __STUDIO_VERSION__: JSON.stringify(pkg.version), __STUDIO_BUILD__: JSON.stringify(target), __STUDIO_NAME__: JSON.stringify(spec.productName) };
  const node = { bundle: true, platform: 'node', format: 'cjs', external: ['electron'], legalComments: 'none', define, metafile: true, logLevel: 'silent' };

  const entryPoints = [path.join(root, spec.entry)];
  const mainBuild = extraMain
    ? await esbuild.build({ ...node, stdin: { contents: `require(${JSON.stringify(path.join(root, spec.entry))});require(${JSON.stringify(path.resolve(extraMain))});`, resolveDir: root, loader: 'js' }, outfile: path.join(app, 'main.cjs') })
    : await esbuild.build({ ...node, entryPoints, outfile: path.join(app, 'main.cjs') });
  const metafiles = { main: mainBuild.metafile };
  const preload = await esbuild.build({ ...node, entryPoints: [path.join(root, 'studio/shell/preload.ts')], outfile: path.join(app, 'preload.cjs') });
  metafiles.preload = preload.metafile;
  // Окну Studio, как и программе, eval запрещён: мост проверяет сообщения готовыми проверщиками, а не собирает их на лету
  const staticValidation = await loadStaticValidation(esbuild);
  const renderer = await esbuild.build({
    plugins: [{ name: 'static-bridge-validators', setup(plugin) {
      plugin.onResolve({ filter: /^\.\/schemas$/ }, args => /[\\/]modules[\\/]bridge\.ts$/.test(args.importer) ? { path: 'validators', namespace: 'bridge-validators' } : null);
      plugin.onLoad({ filter: /.*/, namespace: 'bridge-validators' }, () => ({ contents: staticValidation, loader: 'js', resolveDir: root }));
    } }],
    // Редакторы формы и кода — отдельный раздел (studio/renderer/editors); пока его нет, подставляется заглушка
    alias: { 'studio-editors': editorsEntry() },
    entryPoints: [path.join(root, 'studio/renderer/main.tsx')], outfile: path.join(app, 'renderer', 'renderer.js'), bundle: true, platform: 'browser',
    format: 'iife', jsx: 'automatic', legalComments: 'none', metafile: true, logLevel: 'silent', minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  metafiles.renderer = renderer.metafile;
  // Окно программы, рабочий поток контрольных примеров и заготовки проектов (в упакованной Studio esbuild нет)
  Object.assign(metafiles, await buildDeveloperAssets({ app, esbuild }));
  // Оформление и заставка — из самого Flux (studio/build-renderer.cjs); свои у Studio только имена токенов для разделов
  await buildFluxCss(path.join(app, 'renderer'));
  writeRendererPage(path.join(app, 'renderer'), { name: spec.productName, subtitle: spec.subtitle, stages: [[0, 'Загрузка интерфейса…'], [2, 'Подготовка Studio…']] });
  fs.copyFileSync(path.join(root, 'studio/renderer/styles.css'), path.join(app, 'renderer', 'styles.css'));
  // Значок окна и панели задач — тот же файл, что значок exe (electron-builder берёт .ico из studio/icons)
  for (const ext of ['ico', 'png']) fs.copyFileSync(path.join(root, 'studio/icons', `${spec.icon}.${ext}`), path.join(app, `icon.${ext}`));

  if (target === 'owner') {
    // Раздел владельца — отдельные файлы рядом с оболочкой. Расположение (owner/main.cjs и ../ui) то же,
    // что было у отдельной программы, поэтому пути внутри её кода не менялись.
    for (const name of ['main', 'console-preload']) {
      const built = await esbuild.build({ ...node, entryPoints: [path.join(root, `studio/owner/src/${name}.cjs`)], outfile: path.join(app, 'owner', `${name}.cjs`) });
      metafiles[`owner-${name}`] = built.metafile;
    }
    // Разделы владельца (запросы на публикацию, выпуски, сертификаты, обновления Flux): одно окно разделов (лицензии и выпуск Flux тоже здесь)
    const consoleDir = path.join(app, 'ui', 'console');
    fs.mkdirSync(consoleDir, { recursive: true });
    // Мост программ проверяет сообщения схемами Ajv; в окне eval запрещён, поэтому схемы компилируются здесь, при сборке
    const generator = path.join(outDir, 'static-validators.gen.cjs');
    await esbuild.build({ entryPoints: [path.join(root, 'studio/owner/console/static-validators.ts')], outfile: generator, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const validatorCode = require(generator).staticValidators();
    fs.rmSync(generator);
    const staticValidation = { name: 'static-validators', setup(plugin) {
      plugin.onResolve({ filter: /(?:^|\/)schemas$/ }, args => (args.importer.replace(/\\/g, '/').endsWith('modules/bridge.ts') ? { path: 'validators', namespace: 'module-validators' } : undefined));
      plugin.onLoad({ filter: /.*/, namespace: 'module-validators' }, () => ({ contents: validatorCode, loader: 'js', resolveDir: root }));
    } };
    const consoleBuild = await esbuild.build({
      entryPoints: [path.join(root, 'studio/owner/console/main.tsx')], outfile: path.join(consoleDir, 'console.js'), bundle: true, platform: 'browser',
      format: 'iife', jsx: 'automatic', legalComments: 'none', metafile: true, logLevel: 'silent', minify: true, define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [staticValidation],
    });
    metafiles['owner-console'] = consoleBuild.metafile;
    // Пробный запуск программ со своим экраном: клиент flux.* и набор Flux, те же файлы, что Flux отдаёт по /_flux/
    const pageClient = await esbuild.build({ entryPoints: [path.join(root, 'modules/page/client.ts')], bundle: true, write: false, platform: 'browser', format: 'iife', minify: true, legalComments: 'none', logLevel: 'silent', metafile: true });
    metafiles['owner-page-client'] = pageClient.metafile;
    fs.writeFileSync(path.join(consoleDir, 'flux.v1.js'), pageClient.outputFiles[0].text);
    fs.copyFileSync(path.join(root, 'modules/page/flux-ui.v1.css'), path.join(consoleDir, 'flux-ui.v1.css'));
    for (const file of ['index.html', 'console.css']) fs.copyFileSync(path.join(root, 'studio/owner/console', file), path.join(consoleDir, file));
    // Оформление Flux — тот же файл и шрифты, что у главного окна Studio (собраны выше)
    fs.copyFileSync(path.join(app, 'renderer', 'flux.css'), path.join(consoleDir, 'flux.css'));
    fs.cpSync(path.join(app, 'renderer', 'fonts'), path.join(consoleDir, 'fonts'), { recursive: true });
  }

  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
    name: target === 'owner' ? 'flux-studio-owner' : 'flux-studio', productName: spec.productName, version: pkg.version,
    description: spec.description, author: 'Flux', main: 'main.cjs',
  }, null, 2));
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(metafiles));
  return { app, outDir, spec, metafiles };
}

/** Настройки electron-builder для сборки; отдельной функцией, чтобы проверки видели значок и имя файла, не запуская упаковку */
function builderConfig({ target, outDir, release }) {
  const spec = TARGETS[target];
  return {
    appId: spec.appId, productName: spec.productName, electronVersion: pkg.devDependencies.electron,
    npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false,
    directories: { app: path.join(outDir, 'app'), output: release },
    files: ['**/*'],
    // Рабочий поток контрольных примеров запускается как файл: из app.asar его не открыть
    asarUnpack: ['controls-worker.cjs', 'ts-build-worker.cjs', 'esbuild.wasm'],
    win: { target: [{ target: 'portable', arch: ['x64'] }], icon: path.join(root, 'studio/icons', `${spec.icon}.ico`), artifactName: spec.exe.replace(/\.exe$/, '.${ext}') },
    portable: { requestExecutionLevel: 'user' },
  };
}

function pack({ target, outDir, release }) {
  const spec = TARGETS[target];
  const config = builderConfig({ target, outDir, release });
  const file = path.join(outDir, 'builder.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', file, '--win', 'portable', '--x64', '--publish', 'never'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('electron-builder завершился с ошибкой.');
  return path.join(release, spec.exe);
}

module.exports = { buildStudio, pack, builderConfig, TARGETS, editorsEntry };

if (require.main === module) {
  const target = process.argv[2];
  const outDir = path.join(root, 'dist-studio', target || 'developer');
  buildStudio({ target, outDir }).then(() => {
    console.log(`Flux Studio (${target}) ${pkg.version}: пакет в ${path.relative(root, outDir)}/app`);
    if (process.argv.includes('--pack')) console.log('Упаковано:', pack({ target, outDir, release: path.join(root, 'release-studio') }));
  }).catch(error => { console.error(error); process.exit(1); });
}
