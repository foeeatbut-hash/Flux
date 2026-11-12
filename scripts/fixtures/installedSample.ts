/**
 * Учебная «Параметры позиции» установленной программой: подписанный выпуск в кэше проверенных выпусков
 * и запись «установлена» у человека — как после установки из Flux Store. Встроенной она в Flux больше нет,
 * поэтому наборы, которым нужна работающая программа, ставят её этим путём (корень доверия — одноразовый).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ModuleCache } from '../../electron/moduleCache';
import { ModuleSelection } from '../../electron/moduleSelection';
import { buildModuleRuntime } from '../../modules/build';
import { sampleModules } from '../../modules/sampleModules';
import { packBundle, splitChunks } from '../../modules/trust/bundle';
import { hexOf, newKey, releaseEnvelope } from './moduleTrust';

const FIXTURE = path.resolve('modules/fixtures/equipment-inspector');

export async function installSampleProgram(dataDir: string, userId: string) {
  const manifest = sampleModules[0];
  const root = newKey(), rootHex = hexOf(root), author = hexOf(newKey());
  fs.mkdirSync(dataDir, { recursive: true });
  const runtime = await buildModuleRuntime(FIXTURE, manifest);
  const bundle = packBundle({
    'manifest.json': JSON.stringify(manifest), 'form.json': fs.readFileSync(path.join(FIXTURE, 'form.json'), 'utf8'),
    'logic/main.ts': fs.readFileSync(path.join(FIXTURE, 'logic/main.ts'), 'utf8'), 'build/runtime.js': runtime,
  });
  const signature = releaseEnvelope(root, bundle, { moduleId: manifest.id, version: manifest.version, author });
  const cache = new ModuleCache(dataDir, rootHex);
  const result = await cache.install({ id: `rel-${manifest.id}`, moduleId: manifest.id, version: manifest.version, signature }, splitChunks(bundle));
  if (!result.ok) throw new Error(`Выпуск образца не принят кэшем: ${result.why}`);
  const selection = new ModuleSelection(path.join(dataDir, 'selection.json'));
  await selection.load(); await selection.activate(userId);
  await selection.install(manifest.id, manifest.version, { dirty: false });
  return { rootHex, dataDir, manifest, author };
}
