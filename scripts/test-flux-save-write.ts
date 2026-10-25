/**
 * Запись в папку через Проводник Flux (src/lib/fluxSaveWrite.ts) и связка
 * saveBytes → окно «Сохранить в…» (store/fluxSaveStore.ts) без интерфейса.
 *
 * Мост подменён памятью: проверяются правила — как называется вторая копия,
 * что делает «Заменить», что случается при занятом имени, что при предельном
 * размере и что в браузере выгрузка остаётся обычным скачиванием.
 */
import { nameProblem, numberedName, readablePath, writeIntoFolder, existingEntry, type SaveRequestFn } from '../src/lib/fluxSaveWrite';
import { saveBytes } from '../src/lib/saveToWindows';
import { useFluxSaveStore } from '../src/store/fluxSaveStore';
import { bytesToBase64 } from '../src/lib/windowsFiles';

let ok = 0; let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { ok++; console.log('✓', name); }
  else { fail++; console.error('✗', name, '\n   получено:', JSON.stringify(got), '\n   ожидалось:', JSON.stringify(want)); }
};

/** Память вместо диска: путь → base64 */
function fakeBridge() {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const request: SaveRequestFn = (async (req: any) => {
    calls.push(req.action);
    const at = (parent: { relativePath: string }, name: string) => (parent.relativePath ? `${parent.relativePath}/${name}` : name);
    if (req.action === 'stat') {
      const key = req.ref.relativePath;
      return files.has(key) ? { ok: true, data: { name: key.split('/').pop(), relativePath: key, kind: 'file' } } : { ok: false, error: { code: 'ENOENT', message: 'нет файла' } };
    }
    if (req.action === 'publish') {
      const key = at(req.parent, req.name);
      if (files.has(key)) return { ok: false, error: { code: 'EEXIST', message: 'занято' } };
      files.set(key, req.base64);
      return { ok: true, data: { ref: { rootId: req.parent.rootId, relativePath: key } } };
    }
    if (req.action === 'fileHash') return files.has(req.ref.relativePath) ? { ok: true, data: { sha256: 'h:' + files.get(req.ref.relativePath) } } : { ok: false, error: { code: 'ENOENT', message: 'нет' } };
    if (req.action === 'write') {
      if (req.baseSha256 !== 'h:' + files.get(req.ref.relativePath)) return { ok: false, error: { code: 'CONFLICT', message: 'изменился' } };
      files.set(req.ref.relativePath, req.base64);
      return { ok: true, data: {} };
    }
    return { ok: false, error: { code: 'UNEXPECTED', message: req.action } };
  }) as SaveRequestFn;
  return { files, calls, request };
}

(async () => {
  eq('вторая копия получает номер перед расширением', numberedName('Смета.xlsx', 2), 'Смета (2).xlsx');
  eq('имя без расширения нумеруется в конце', numberedName('Архив', 3), 'Архив (3)');
  eq('скрытый файл без расширения не ломается', numberedName('.env', 2), '.env (2)');
  eq('запрещённые знаки отвергаются', nameProblem('a:b.txt') !== '', true);
  eq('пустое имя отвергается', nameProblem('  ') !== '', true);
  eq('имя с точкой на конце отвергается', nameProblem('файл.') !== '', true);
  eq('зарезервированное имя отвергается', nameProblem('CON.txt') !== '', true);
  eq('обычное русское имя принимается', nameProblem('Смета март.xlsx'), '');
  eq('путь для человека — как в Windows', readablePath('Документы', 'Отчёты/2026'), 'Документы\\Отчёты\\2026');

  const folder = { rootId: 'r1', relativePath: 'Отчёты' };
  const bytes = new Uint8Array([1, 2, 3]);
  const b64 = bytesToBase64(bytes);

  const a = fakeBridge();
  const first = await writeIntoFolder(a.request, folder, 'Смета.xlsx', bytes, 'new');
  eq('новый файл лёг в выбранную папку', first.ref.relativePath, 'Отчёты/Смета.xlsx');
  eq('содержимое записано без искажений', a.files.get('Отчёты/Смета.xlsx'), b64);
  eq('черновик Flux не создаётся (копия не остаётся в данных программы)', a.calls.includes('createDraft'), false);
  eq('занятое имя находится до записи', (await existingEntry(a.request, folder, 'Смета.xlsx'))?.kind, 'file');
  eq('свободное имя не находится', await existingEntry(a.request, folder, 'Другое.xlsx'), null);

  let refused = '';
  try { await writeIntoFolder(a.request, folder, 'Смета.xlsx', bytes, 'new'); } catch (e: any) { refused = e.message; }
  eq('занятое имя не затирается без выбора человека', refused.includes('уже есть'), true);

  const fresh = new Uint8Array([9, 9]);
  const replaced = await writeIntoFolder(a.request, folder, 'Смета.xlsx', fresh, 'replace');
  eq('«Заменить» пишет в тот же файл', replaced.ref.relativePath, 'Отчёты/Смета.xlsx');
  eq('замена записала новое содержимое', a.files.get('Отчёты/Смета.xlsx'), bytesToBase64(fresh));
  eq('замена шла с проверкой версии (fileHash → write)', a.calls.slice(-2), ['fileHash', 'write']);

  const both = await writeIntoFolder(a.request, folder, 'Смета.xlsx', bytes, 'keepBoth');
  eq('«Оставить оба» берёт первое свободное имя', both.ref.relativePath, 'Отчёты/Смета (2).xlsx');
  const third = await writeIntoFolder(a.request, folder, 'Смета.xlsx', bytes, 'keepBoth');
  eq('следующая копия получает следующий номер', third.ref.relativePath, 'Отчёты/Смета (3).xlsx');
  eq('исходный файл «Оставить оба» не тронут', a.files.get('Отчёты/Смета.xlsx'), bytesToBase64(fresh));

  // saveBytes: с мостом — окно из очереди; без моста — обычное скачивание
  const clicks: string[] = [];
  (globalThis as any).document = { createElement: () => { const link: any = { click() { clicks.push(link.download); } }; return link; } };
  const browser = await saveBytes('Отчёт.docx', new Uint8Array([1]));
  eq('без моста выгрузка — скачивание браузером', [browser.ok, clicks], [true, ['Отчёт.docx']]);

  (globalThis as any).window = { electron: { windowsFiles: {} } };
  const pending = saveBytes('Журнал.txt', new Uint8Array([5]), { dir: 'C:\\Работа', quiet: true });
  const queued = useFluxSaveStore.getState().queue[0];
  eq('с мостом выгрузка становится окном в очереди', [queued?.mode, queued?.mode === 'file' ? queued.name : '', queued?.mode === 'file' ? queued.dir : ''], ['file', 'Журнал.txt', 'C:\\Работа']);
  if (queued?.mode === 'file') queued.resolve({ ok: true, path: 'Работа\\Журнал.txt', canceled: false, error: '' });
  useFluxSaveStore.getState().done(queued.id);
  const done = await pending;
  eq('ответ окна доходит до вызывающего, путь называет, куда легло', [done.ok, done.path], [true, 'Работа\\Журнал.txt']);

  const huge = await saveBytes('Огромный.bin', { byteLength: 65 * 1024 * 1024 } as unknown as Uint8Array);
  eq('файл больше 64 МБ отвергается словами, а не молча', [huge.ok, huge.error.includes('64 МБ')], [false, true]);

  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
