/**
 * Две сборки Flux Studio: разделение, одинаковая версия и умение проверки падать.
 *
 * Что доказывается:
 * - сборка разработчика проходит проверку, в ней нет ни файла, ни метки кода владельца;
 * - сборка владельца проверку НЕ проходит (иначе проверка ничего не ловит), и каждая
 *   метка из списка в ней действительно есть (иначе метка мёртвая и защищает от пустоты);
 * - мутация: стоит подключить модуль владельца в сборку разработчика — проверка падает
 *   и называет файл и метку;
 * - мутация по тексту: метка, дописанная в готовый пакет, тоже ловится;
 * - обе сборки несут номер версии Flux из корневого package.json, а имя exe — по решению владельца.
 *
 * Запуск: npx tsx scripts/test-studio-bundle.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBundle, OUTSIDE_MARKERS, OWNER_LOGIN_MARKERS, OWNER_MARKERS } from './check-studio-bundle';

const { buildStudio, TARGETS } = require('../studio/build.cjs');
const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-bundle-'));
  try {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    console.log('Сборка разработчика');
    const developer = path.join(temp, 'developer');
    await buildStudio({ target: 'developer', outDir: developer });
    ok('проверка бандла разработчика проходит', checkBundle(developer).length === 0);
    ok('в пакете разработчика нет каталогов раздела владельца', !fs.existsSync(path.join(developer, 'app/owner')) && !fs.existsSync(path.join(developer, 'app/ui')));

    console.log('Сборка владельца');
    const owner = path.join(temp, 'owner');
    await buildStudio({ target: 'owner', outDir: owner });
    const ownerProblems = checkBundle(owner);
    ok('проверка ловит код владельца в пакете владельца', ownerProblems.length > 0);
    const ownerText = fs.readdirSync(path.join(owner, 'app'), { recursive: true, encoding: 'utf8' })
      .map((name) => path.join(owner, 'app', name)).filter((file) => fs.statSync(file).isFile()).map((file) => fs.readFileSync(file, 'latin1')).join('\n');
    const dead = OWNER_MARKERS.filter((marker) => !ownerText.includes(marker));
    ok(`каждая метка есть в сборке владельца (нет: ${dead.join(', ') || '—'})`, dead.length === 0);

    // Вход владельца файлом ключа — не код владельца: он есть в обеих сборках (решение владельца 11 ноября 2026), а его метки не запретны
    const developerText = fs.readdirSync(path.join(developer, 'app'), { recursive: true, encoding: 'utf8' })
      .map((name) => path.join(developer, 'app', name)).filter((file) => fs.statSync(file).isFile()).map((file) => fs.readFileSync(file, 'latin1')).join('\n');
    for (const marker of Object.keys(OWNER_LOGIN_MARKERS)) {
      ok(`вход владельца: метка «${marker}» есть в обеих сборках`, developerText.includes(marker) && ownerText.includes(marker));
      ok(`вход владельца: метка «${marker}» не запретна у разработчика`, !OWNER_MARKERS.includes(marker) && !(marker in OUTSIDE_MARKERS));
    }
    const staleLogin = Object.entries(OWNER_LOGIN_MARKERS).filter(([marker, file]) => !fs.readFileSync(path.join(root, file), 'utf8').includes(marker));
    ok(`метки входа владельца живы (устарели: ${staleLogin.map(([m]) => m).join(', ') || '—'})`, staleLogin.length === 0);
    ok('но подписи и запись хранилища у разработчика по-прежнему запрещены: generateVaults, signUpdate, issueLicense ищутся по тексту',
      ['generateVaults', 'signUpdate', 'issueLicense'].every((marker) => OWNER_MARKERS.includes(marker) && !developerText.includes(marker)));

    const stale = Object.entries(OUTSIDE_MARKERS).filter(([marker, file]) => !fs.readFileSync(path.join(root, file), 'utf8').includes(marker));
    ok(`метки кода владельца вне studio/owner живы (устарели: ${stale.map(([m]) => m).join(', ') || '—'})`, stale.length === 0);

    console.log('Мутации: проверка должна падать');
    const mutated = path.join(temp, 'mutated');
    await buildStudio({ target: 'developer', outDir: mutated, extraMain: path.join(root, 'studio/owner/src/signing.cjs') });
    const mutationProblems = checkBundle(mutated);
    ok('модуль владельца подключён в сборку разработчика — проверка падает по карте сборки', mutationProblems.some((p) => /studio\/owner\/src\/signing\.cjs/.test(p)));
    ok('и по тексту пакета — называет метку подписи', mutationProblems.some((p) => /метка кода владельца «(signUpdate|issueLicense)»/.test(p)));
    // Разделы владельца этапа 4в: подпись подпрограмм и назначение обновлений не должны попасть в сборку разработчика ни под каким видом
    for (const [label, file, marker] of [['назначение обновлений', 'studio/owner/src/campaigns.ts', 'signCampaign'], ['подпись подпрограмм', 'studio/owner/src/moduleSigning.ts', 'signModule']] as const) {
      const dir = path.join(temp, `section-${marker}`);
      await buildStudio({ target: 'developer', outDir: dir, extraMain: path.join(root, file) });
      const problems = checkBundle(dir);
      ok(`${label} в сборке разработчика — проверка падает по карте сборки и по метке «${marker}»`,
        problems.some((p) => p.includes(`в карте сборки`) && p.includes(file)) && problems.some((p) => p.includes(`«${marker}»`)));
    }
    ok('у разработчика нет окна разделов владельца', !fs.existsSync(path.join(developer, 'app/ui/console')) && !fs.existsSync(path.join(developer, 'app/owner/console-preload.cjs')));
    ok('у владельца окно разделов есть', fs.existsSync(path.join(owner, 'app/ui/console/console.js')) && fs.existsSync(path.join(owner, 'app/owner/console-preload.cjs')));
    // Общий импорт кода владельца: по пути исходника (сам файл) и копией с другим именем файла и функций
    const pathOnly = path.join(temp, 'path-only');
    const sharedImport = path.join(temp, 'shared-import.ts');
    fs.writeFileSync(sharedImport, `import * as owner from ${JSON.stringify(path.join(root, 'modules/trust/owner.ts'))}; (globalThis as any).x = owner;`);
    await buildStudio({ target: 'developer', outDir: pathOnly, extraMain: sharedImport });
    ok('общий импорт modules/trust/owner.ts ловится по пути исходника', checkBundle(pathOnly).some((p) => /файл владельца: modules\/trust\/owner\.ts/.test(p)));
    // Копия лежит в репозитории (нужны её соседи по импорту) под другим именем и с переименованными функциями
    const mutant = path.join(root, 'modules/trust/__studio_mutant.ts');
    try {
      fs.writeFileSync(mutant, fs.readFileSync(path.join(root, 'modules/trust/owner.ts'), 'utf8').replace(/build(\w+)Claim/g, 'make$1Entry'));
      fs.writeFileSync(sharedImport, `import * as owner from ${JSON.stringify(mutant)}; (globalThis as any).x = owner;`);
      const copy = path.join(temp, 'copy');
      await buildStudio({ target: 'developer', outDir: copy, extraMain: sharedImport });
      const copyProblems = checkBundle(copy);
      ok('копия с другим именем файла и функций не названа по пути', !copyProblems.some((p) => /в карте сборки/.test(p)));
      ok('но проверка падает по тексту: переименование функций не прячет код владельца', copyProblems.some((p) => /метка кода владельца «(Описание правки не прошло проверку|Запрос разработчика повреждён)»/.test(p)));
    } finally { fs.rmSync(mutant, { force: true }); }
    const tampered = path.join(temp, 'tampered');
    await buildStudio({ target: 'developer', outDir: tampered });
    fs.appendFileSync(path.join(tampered, 'app/renderer/renderer.js'), '\n// issueLicense\n');
    ok('метка, дописанная в готовый пакет, ловится', checkBundle(tampered).some((p) => /renderer\.js.*issueLicense/.test(p)));
    const asar = path.join(temp, 'app.asar');
    fs.writeFileSync(asar, Buffer.from('FLUXPUBLIC1'));
    ok('метка внутри app.asar ловится', checkBundle(developer, asar).some((p) => /asar.*FLUXPUBLIC1/.test(p)));
    // Сборка без входа владельца тоже отказ: иначе владелец не сможет войти в Studio прежним файлом ключа
    const noLogin = path.join(temp, 'no-login');
    await buildStudio({ target: 'developer', outDir: noLogin });
    const mainFile = path.join(noLogin, 'app/main.cjs');
    fs.writeFileSync(mainFile, fs.readFileSync(mainFile, 'utf8').split('signOwnerChallenge').join('signSomethingElse'));
    ok('в пакете разработчика нет входа владельца — проверка падает', checkBundle(noLogin).some((p) => /нет входа владельца.*signOwnerChallenge/.test(p)));
    const noMap = path.join(temp, 'no-map');
    fs.cpSync(developer, noMap, { recursive: true }); fs.rmSync(path.join(noMap, 'meta.json'));
    ok('без карты сборки проверка не молчит', checkBundle(noMap).some((p) => /meta\.json/.test(p)));

    console.log('Версия и имена');
    for (const [name, dir] of [['разработчика', developer], ['владельца', owner]] as const) {
      ok(`номер версии сборки ${name} — как у Flux (${version})`, JSON.parse(fs.readFileSync(path.join(dir, 'app/package.json'), 'utf8')).version === version);
    }
    ok('имена файлов — по решению владельца', TARGETS.developer.exe === 'FluxStudio.exe' && TARGETS.owner.exe === 'FluxStudio-Владелец.exe');
    ok('главный процесс разработчика знает свою сборку', fs.readFileSync(path.join(developer, 'app/main.cjs'), 'utf8').includes('"developer"'));

    console.log(`\nFlux Studio: две сборки — ${passed} проверок пройдено`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exit(1); });
