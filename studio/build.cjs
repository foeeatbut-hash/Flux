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

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

const TARGETS = {
  developer: {
    entry: 'studio/entry-developer.ts', productName: 'Flux Studio', appId: 'ru.flux.studio', exe: 'FluxStudio.exe',
    description: 'Flux Studio — программа разработчика подпрограмм Flux',
  },
  owner: {
    entry: 'studio/entry-owner.ts', productName: 'Flux Studio — Владелец', appId: 'ru.flux.studio.owner', exe: 'FluxStudio-Владелец.exe',
    description: 'Flux Studio — сборка владельца: лицензии, выпуск обновлений Flux и подписи',
  },
};

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

  const define = { __STUDIO_VERSION__: JSON.stringify(pkg.version), __STUDIO_BUILD__: JSON.stringify(target) };
  const node = { bundle: true, platform: 'node', format: 'cjs', external: ['electron'], legalComments: 'none', define, metafile: true, logLevel: 'silent' };

  const entryPoints = [path.join(root, spec.entry)];
  const mainBuild = extraMain
    ? await esbuild.build({ ...node, stdin: { contents: `require(${JSON.stringify(path.join(root, spec.entry))});require(${JSON.stringify(path.resolve(extraMain))});`, resolveDir: root, loader: 'js' }, outfile: path.join(app, 'main.cjs') })
    : await esbuild.build({ ...node, entryPoints, outfile: path.join(app, 'main.cjs') });
  const metafiles = { main: mainBuild.metafile };
  const preload = await esbuild.build({ ...node, entryPoints: [path.join(root, 'studio/shell/preload.ts')], outfile: path.join(app, 'preload.cjs') });
  metafiles.preload = preload.metafile;
  const renderer = await esbuild.build({
    entryPoints: [path.join(root, 'studio/renderer/main.tsx')], outfile: path.join(app, 'renderer', 'renderer.js'), bundle: true, platform: 'browser',
    format: 'iife', jsx: 'automatic', legalComments: 'none', metafile: true, logLevel: 'silent', minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  metafiles.renderer = renderer.metafile;
  for (const file of ['index.html', 'styles.css']) fs.copyFileSync(path.join(root, 'studio/renderer', file), path.join(app, 'renderer', file));

  if (target === 'owner') {
    // Раздел владельца — отдельные файлы рядом с оболочкой. Расположение (owner/main.cjs и ../ui) то же,
    // что было у отдельной программы, поэтому пути внутри её кода не менялись.
    for (const name of ['main', 'preload']) {
      const built = await esbuild.build({ ...node, entryPoints: [path.join(root, `studio/owner/src/${name}.cjs`)], outfile: path.join(app, 'owner', `${name}.cjs`) });
      metafiles[`owner-${name}`] = built.metafile;
    }
    fs.cpSync(path.join(root, 'studio/owner/ui'), path.join(app, 'ui'), { recursive: true });
  }

  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
    name: target === 'owner' ? 'flux-studio-owner' : 'flux-studio', productName: spec.productName, version: pkg.version,
    description: spec.description, author: 'Flux', main: 'main.cjs',
  }, null, 2));
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(metafiles));
  return { app, outDir, spec, metafiles };
}

function pack({ target, outDir, release }) {
  const spec = TARGETS[target];
  const config = {
    appId: spec.appId, productName: spec.productName, electronVersion: pkg.devDependencies.electron,
    npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false,
    directories: { app: path.join(outDir, 'app'), output: release },
    files: ['**/*'],
    win: { target: [{ target: 'portable', arch: ['x64'] }], icon: path.join(root, 'build/icon.png'), artifactName: spec.exe.replace(/\.exe$/, '.${ext}') },
    portable: { requestExecutionLevel: 'user' },
  };
  const file = path.join(outDir, 'builder.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', file, '--win', 'portable', '--x64', '--publish', 'never'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('electron-builder завершился с ошибкой.');
  return path.join(release, spec.exe);
}

module.exports = { buildStudio, pack, TARGETS };

if (require.main === module) {
  const target = process.argv[2];
  const outDir = path.join(root, 'dist-studio', target || 'developer');
  buildStudio({ target, outDir }).then(() => {
    console.log(`Flux Studio (${target}) ${pkg.version}: пакет в ${path.relative(root, outDir)}/app`);
    if (process.argv.includes('--pack')) console.log('Упаковано:', pack({ target, outDir, release: path.join(root, 'release-studio') }));
  }).catch(error => { console.error(error); process.exit(1); });
}
