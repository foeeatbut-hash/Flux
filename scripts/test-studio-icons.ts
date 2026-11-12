/**
 * Значки программ: у Flux прежний, у Flux Studio и Flux Studio — Владелец свои и явно различимые.
 *
 * Доказывается: у трёх сборок разные хеши значков; в каждом .ico есть все размеры 16–256 и каждая картинка — настоящий PNG
 * заявленного размера; цвет знака на панели задач (16 px) у трёх программ заметно разный; electron-builder каждой сборки
 * получает свой .ico (и portable-файл свой), а у Flux остался build/icon.png; значок окна в готовом пакете — тот же файл,
 * что значок exe; записанные в репозиторий значки совпадают с тем, что даёт scripts/gen-studio-icons.cjs.
 *
 * Запуск: npx tsx scripts/test-studio-icons.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildStudio, builderConfig, TARGETS } = require('../studio/build.cjs');
const { generate, SIZES, decodePng } = require('./gen-studio-icons.cjs');
const root = path.resolve(__dirname, '..');
let passed = 0;
const ok = (name: string, value: unknown) => { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); };
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Разбор .ico: список картинок с размером и PNG-телом */
function readIco(file: string) {
  const data = fs.readFileSync(file);
  assert.equal(data.readUInt16LE(2), 1, 'это значок');
  return Array.from({ length: data.readUInt16LE(4) }, (_, i) => {
    const at = 6 + i * 16, size = data[at] || 256, length = data.readUInt32LE(at + 8), offset = data.readUInt32LE(at + 12);
    return { size, png: data.subarray(offset, offset + length) };
  });
}
const hue = ([r, g, b]: number[]) => { const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min; if (!d) return 0; const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

async function main() {
  const files = { flux: path.join(root, 'build/icon.png'), developer: path.join(root, 'studio/icons/studio-developer.ico'), owner: path.join(root, 'studio/icons/studio-owner.ico') };
  ok('у трёх программ три разных значка (хеши различаются)', new Set(Object.values(files).map(sha)).size === 3);
  ok('значки окна (png) тоже разные', sha(path.join(root, 'studio/icons/studio-developer.png')) !== sha(path.join(root, 'studio/icons/studio-owner.png')));

  const shades: Record<string, number> = {};
  for (const kind of ['developer', 'owner'] as const) {
    const images = readIco(files[kind]);
    ok(`${kind}: в .ico все размеры ${SIZES.join(', ')} (есть ${images.map(i => i.size).join(', ')})`, SIZES.every((s: number) => images.some(i => i.size === s)));
    for (const { size, png } of images) {
      const tmp = path.join(os.tmpdir(), `flux-icon-${process.pid}-${size}.png`);
      fs.writeFileSync(tmp, png);
      const decoded = decodePng(tmp); fs.rmSync(tmp);
      assert.ok(decoded.width === size && decoded.height === size, `${kind} ${size}: картинка ${decoded.width}×${decoded.height}`);
      if (size === 16) { const at = (4 * 16 + 4) * 4; shades[kind] = hue([...decoded.data.subarray(at, at + 3)]); }
    }
    ok(`${kind}: каждая картинка — настоящий PNG заявленного размера`, true);
  }
  const fluxIcon = decodePng(files.flux); shades.flux = hue([...fluxIcon.data.subarray((60 * fluxIcon.width + 60) * 4, (60 * fluxIcon.width + 60) * 4 + 3)]);
  ok(`цвет на панели задач различим: Flux ${shades.flux.toFixed(0)}°, Studio ${shades.developer.toFixed(0)}°, Владелец ${shades.owner.toFixed(0)}°`,
    gap(shades.flux, shades.developer) > 40 && gap(shades.flux, shades.owner) > 40 && gap(shades.developer, shades.owner) > 40);

  for (const target of ['developer', 'owner'] as const) {
    const config = builderConfig({ target, outDir: '/x', release: '/y' });
    ok(`${target}: electron-builder получает свой .ico`, config.win.icon === files[target]);
    ok(`${target}: portable-файл называется ${TARGETS[target].exe}`, config.win.artifactName === TARGETS[target].exe.replace(/\.exe$/, '.${ext}'));
  }
  ok('Flux: значок в настройках сборки прежний (build/icon.png)', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.win.icon === 'build/icon.png');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-icons-'));
  try {
    for (const target of ['developer', 'owner'] as const) {
      const built = await buildStudio({ target, outDir: path.join(temp, target) });
      ok(`${target}: значок окна в пакете — тот же файл, что значок exe`, sha(path.join(built.app, 'icon.ico')) === sha(files[target]) && sha(path.join(built.app, 'icon.png')) === sha(path.join(root, 'studio/icons', `studio-${target}.png`)));
    }
    ok('главный процесс ставит значок окну (панель задач совпадает с exe)', /icon: windowIcon\(\)/.test(fs.readFileSync(path.join(root, 'studio/shell/main.ts'), 'utf8')));
    generate(path.join(temp, 'again'));
    for (const name of ['studio-developer.ico', 'studio-owner.ico', 'studio-developer.png', 'studio-owner.png']) {
      ok(`${name}: в репозитории то же, что даёт генератор (значок не правили вручную)`, sha(path.join(temp, 'again', name)) === sha(path.join(root, 'studio/icons', name)));
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log(`\nЗначки программ: ${passed} проверок пройдено`);
}
main().catch(error => { console.error(error); process.exit(1); });
