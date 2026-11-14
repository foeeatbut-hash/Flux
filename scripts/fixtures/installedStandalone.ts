/**
 * Самостоятельная программа-страница («Заметки») установленной: подписанный выпуск в кэше проверенных выпусков и запись
 * «установлена» у человека — как после установки из Flux Store (образец — installedSample.ts).
 *
 * Ничего не читает во Flux и открывается только из «Пуска» (modules/storage/model.ts, `isStandalone`), без интернета и других
 * программ (`worksOffline`). Страница показывает, есть ли у неё проект (`flux.context.projectId`), и хранит счётчик в `flux.state`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ModuleCache } from '../../electron/moduleCache';
import { ModuleSelection } from '../../electron/moduleSelection';
import type { ModuleManifest } from '../../modules/contract';
import { packBundle, splitChunks } from '../../modules/trust/bundle';
import { hexOf, newKey, releaseEnvelope } from './moduleTrust';

export const STANDALONE_ID = 'quick-notes';
export const standaloneManifest: ModuleManifest = {
  id: STANDALONE_ID, name: 'Быстрые заметки', version: '1.0.0', author: 'Flux', contractVersion: 3, entries: ['start'], reads: [], logic: 'logic/main.ts', ui: 'page',
  store: { category: 'other', summary: 'Заметки инженера, которые хранятся на этом компьютере', requires: { flux: '1.0.0' } } as never,
};

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="/_flux/flux-ui.v1.css"></head><body>
<script src="/_flux/flux.v1.js"></script>
<h1 id="t">Быстрые заметки</h1>
<p id="project"></p>
<p>Сохранено заметок: <b id="n">0</b></p>
<button class="fx-btn" id="add">Добавить заметку</button>
<script src="/ui/app.js"></script></body></html>`;
const script = `flux.ready.then(async () => {
  const show = n => { document.getElementById('n').textContent = String(n); };
  document.getElementById('project').textContent = flux.context.projectId ? 'Проект выбран' : 'Проект не выбран';
  show(((await flux.state.get()).n) || 0);
  document.getElementById('add').onclick = async () => { const next = (((await flux.state.get()).n) || 0) + 1; await flux.state.set({ n: next }); show(next); };
  document.body.dataset.ready = '1';
});`;

export async function installStandaloneProgram(dataDir: string, userId: string) {
  const root = newKey(), rootHex = hexOf(root), author = hexOf(newKey());
  fs.mkdirSync(dataDir, { recursive: true });
  const bundle = packBundle({ 'manifest.json': JSON.stringify(standaloneManifest), 'logic/main.ts': 'export default {};', 'ui/index.html': html, 'ui/app.js': script });
  const signature = releaseEnvelope(root, bundle, { moduleId: STANDALONE_ID, version: standaloneManifest.version, author, contractVersion: 3 });
  const cache = new ModuleCache(dataDir, rootHex);
  const result = await cache.install({ id: `rel-${STANDALONE_ID}`, moduleId: STANDALONE_ID, version: standaloneManifest.version, signature }, splitChunks(bundle));
  if (!result.ok) throw new Error(`Выпуск самостоятельной программы не принят кэшем: ${result.why}`);
  const selection = new ModuleSelection(path.join(dataDir, 'selection.json'));
  await selection.load(); await selection.activate(userId);
  await selection.install(STANDALONE_ID, standaloneManifest.version, { dirty: false });
  return { rootHex, dataDir, manifest: standaloneManifest, author };
}
