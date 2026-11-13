/**
 * История версий проекта в Studio: снимки, сравнение, откат (studio/shared/history.ts).
 *
 * Что доказывается (каждая защита проверена мутацией: копия модуля с испорченной защитой обязана провалить своё условие):
 * - снимок лежит в `.flux/history/`, которой нет ни в дереве, ни в пакете, ни в архиве; одинаковый снимок не создаётся;
 * - сравнение: добавлен, удалён, изменён; построчная разница; двоичный файл — «изменён, N байт»;
 * - откат: предпросмотр без записи, токен предпросмотра, снимок «перед откатом» ДО записи, откатом отменяется откат,
 *   файлы вне истории (по .fluxignore, сборочные каталоги) не трогаются, пустые папки убираются, снимок-цель не вытесняется;
 * - пределы: число и объём, ручные и отправки вытесняются последними, объекты без снимков удаляются;
 * - безопасность: путь снимка за пределами папки, повреждённый JSON, подменённый и пропавший объект не роняют список и не
 *   дают записать файл; ссылка на месте `.flux/history` отвергается; временных файлов не остаётся.
 *
 * Запуск: npx tsx scripts/test-studio-history.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { zipProject } from '../studio/shared/archive';
import * as realHistory from '../studio/shared/history';
import * as realWorkspace from '../studio/shared/workspace';
import * as realNotes from '../studio/shared/ownerNotes';

type HistoryModule = typeof realHistory;
type WorkspaceModule = typeof realWorkspace;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-studio-history-'));
const shared = path.join(__dirname, '..', 'studio', 'shared');
const enc = (s: string) => new TextEncoder().encode(s);
const text = (p: string) => fs.readFileSync(p, 'utf8');
const put = (root: string, rel: string, data: string | Uint8Array) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const walk = (dir: string): string[] => { try { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); } catch { return []; } };
const lines = (n: number) => Array.from({ length: n }, (_, i) => `строка ${i + 1}`).join('\n');

/** Все условия набора. Для настоящего модуля все истинны; мутант обязан сделать ложным своё условие */
async function battery(H: HistoryModule, W: WorkspaceModule, tag: string): Promise<Map<string, boolean>> {
  const R = new Map<string, boolean>();
  const check = (name: string, fn: () => unknown) => { try { R.set(name, !!fn()); } catch { R.set(name, false); } };
  const fails = (fn: () => unknown, code?: string) => { try { fn(); return false; } catch (e: any) { return e?.constructor?.name === 'HistoryFailure' && (!code || e.code === code); } };
  // Шаги подготовки: у мутанта они могут падать, а оценивается только условие
  const step = <T,>(fn: () => T): T => { try { return fn(); } catch { return undefined as T; } };
  let clock = 1_700_000_000_000;
  const now = () => (clock += 1000);
  const base = path.join(temp, tag);
  const project = (name: string, files: Record<string, string | Uint8Array> = {}) => { const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true }); for (const [r, d] of Object.entries(files)) put(dir, r, d); return dir; };

  // ---- основной путь: снимок, сравнение, откат ----
  const dir = project('main', { 'manifest.json': '{"id":"demo","version":"0.1.0"}', 'form.json': '{"form":1}', 'logic/main.ts': lines(20), 'assets/pic.png': new Uint8Array([0x89, 0x50, 0xff, 0xfe, 0x00, 0x01, 0x02]), '.fluxignore': 'private/\n',
    'private/secret.txt': 'не в истории', 'build/out.js': 'сборка' });
  const space = new W.Workspace(dir), h = new H.History(space, { now });
  check('список пуст и папку не создаёт', () => h.list().snapshots.length === 0 && !fs.existsSync(path.join(dir, '.flux')));
  const s1 = h.save('manual', { note: '  Первая версия  ' });
  check('снимок создан, заметка обрезана по краям', () => s1.created && s1.snapshot.note === 'Первая версия' && s1.snapshot.reason === 'manual' && s1.snapshot.complete);
  check('в снимке файлы пакета и .fluxignore, без ignored и сборки', () => s1.snapshot.fileCount === 5 && Object.keys(h.files(s1.snapshot.id)).sort().join() === '.fluxignore,assets/pic.png,form.json,logic/main.ts,manifest.json');
  check('история лежит в .flux/history', () => fs.existsSync(path.join(dir, '.flux', 'history', 'snapshots', `${s1.snapshot.id}.json`)));
  check('в дереве нет .flux', () => space.tree().every(e => !/(^|\/)\.flux(\/|$)/.test(e.path)));
  check('в пакете нет .flux', () => Object.keys(space.pack()).every(p => !/(^|\/)\.flux(\/|$)/.test(p)));
  const zip = await JSZip.loadAsync(await zipProject(space));
  check('в архиве нет .flux', () => Object.keys(zip.files).every(p => !/(^|\/)\.flux(\/|$)/.test(p)) && Object.keys(zip.files).includes('manifest.json'));
  check('редактор не открывает .flux/history', () => { try { space.resolve('.flux/history/snapshots/x.json'); return false; } catch (e) { return e instanceof W.WorkspaceFailure; } });
  check('одинаковый снимок не создаётся', () => { const r = h.save('build'); return !r.created && r.snapshot.id === s1.snapshot.id && h.list().snapshots.length === 1; });
  check('отправка у такого же снимка запоминает версию и не теряет заметку', () => { const r = h.save('publish', { version: '0.2.0' }); return !r.created && r.snapshot.reason === 'publish' && r.snapshot.version === '0.2.0' && r.snapshot.note === 'Первая версия'; });

  put(dir, 'logic/main.ts', lines(20).replace('строка 5', 'строка пять') + '\nновая строка');
  fs.rmSync(path.join(dir, 'form.json'));
  put(dir, 'docs/readme.md', 'описание\n');
  put(dir, 'assets/pic.png', new Uint8Array([0x89, 0x50, 0xff, 0xfe, 0x00, 0x01, 0x02, 0x03, 0x04]));
  const s2 = h.save('build');
  check('изменённое состояние — новый снимок', () => s2.created && h.list().snapshots.length === 2 && h.list().snapshots[0].id === s2.snapshot.id);
  check('отправка: снимок помечается версией, причина не понижается', () => {
    const a = h.promote(s2.snapshot.id, 'publish', { version: '0.1.1', note: 'Запрос r1' }), b = h.promote(s2.snapshot.id, 'build');
    return a.reason === 'publish' && a.version === '0.1.1' && a.note === 'Запрос r1' && b.reason === 'publish' && h.get(s2.snapshot.id).version === '0.1.1' && fails(() => h.promote('1700000000999-abcdef', 'publish'), 'missing');
  });
  const cmp = h.compare(s1.snapshot.id, s2.snapshot.id), by = (p: string) => cmp.files.find(f => f.path === p);
  check('сравнение: добавлен, удалён, изменён, не тронутое не в списке', () => by('docs/readme.md')?.status === 'added' && by('form.json')?.status === 'removed' && by('logic/main.ts')?.status === 'changed' && !by('manifest.json') && cmp.same === 2);
  check('сравнение: построчная разница', () => { const l = by('logic/main.ts')!.lines; return l.some(x => x.op === '-' && x.text === 'строка 5') && l.some(x => x.op === '+' && x.text === 'строка пять') && l.some(x => x.op === '+' && x.text === 'новая строка'); });
  check('сравнение: двоичный — размеры вместо строк', () => { const f = by('assets/pic.png')!; return f.binary && f.lines.length === 0 && f.sizeBefore === 7 && f.sizeAfter === 9 && f.status === 'changed'; });
  put(dir, 'manifest.json', '{"id":"demo","version":"0.1.1"}');
  check('сравнение снимка с текущими файлами', () => { const c = h.compare(s2.snapshot.id, 'current'); return c.files.length === 1 && c.files[0].path === 'manifest.json' && c.files[0].lines.some(l => l.op === '+' && l.text.includes('0.1.1')); });
  check('сравнение с неизвестным снимком — отказ', () => fails(() => h.compare('1700000000999-abcdef', 'current'), 'missing') && fails(() => h.compare('../x', 'current'), 'missing'));

  const before = text(path.join(dir, 'logic/main.ts'));
  const plan = h.plan(s1.snapshot.id);
  const act = (p: string) => plan.entries.find(e => e.path === p)?.action;
  check('предпросмотр: появится, исчезнет, изменится', () => act('form.json') === 'create' && act('docs/readme.md') === 'delete' && act('logic/main.ts') === 'modify' && act('assets/pic.png') === 'modify' && act('manifest.json') === 'modify');
  check('предпросмотр ничего не пишет', () => text(path.join(dir, 'logic/main.ts')) === before && !fs.existsSync(path.join(dir, 'form.json')) && h.list().snapshots.length === 2);
  put(dir, 'notes.md', 'добавлено после предпросмотра');
  check('токен: файлы изменились после предпросмотра — откат отказывает и ничего не пишет', () => fails(() => h.rollback(s1.snapshot.id, plan.token), 'changed') && text(path.join(dir, 'logic/main.ts')) === before && fs.existsSync(path.join(dir, 'docs/readme.md')));
  check('откат к неизвестной версии — отказ', () => fails(() => h.rollback('1700000000999-abcdef', 'x'), 'missing'));
  const plan2 = h.plan(s1.snapshot.id);
  const done = step(() => h.rollback(s1.snapshot.id, plan2.token))!;
  check('откат: файлы восстановлены', () => text(path.join(dir, 'logic/main.ts')) === lines(20) && text(path.join(dir, 'form.json')) === '{"form":1}' && text(path.join(dir, 'manifest.json')).includes('0.1.0') && fs.readFileSync(path.join(dir, 'assets/pic.png')).length === 7);
  check('откат: лишние файлы убраны вместе с пустой папкой', () => !fs.existsSync(path.join(dir, 'docs')) && !fs.existsSync(path.join(dir, 'notes.md')));
  check('откат: файлы вне истории не тронуты', () => text(path.join(dir, 'private/secret.txt')) === 'не в истории' && text(path.join(dir, 'build/out.js')) === 'сборка');
  check('откат: снимок «перед откатом» создан и содержит прежнее состояние', () => {
    const rp = done.restorePoint, files = h.files(rp.id);
    return rp.reason === 'before-rollback' && !!files['docs/readme.md'] && !!files['notes.md'] && new TextDecoder().decode(files['logic/main.ts']).includes('строка пять');
  });
  check('откат: отменяется тем же способом', () => {
    const p = h.plan(done.restorePoint.id);
    h.rollback(done.restorePoint.id, p.token);
    return text(path.join(dir, 'docs/readme.md')) === 'описание\n' && text(path.join(dir, 'notes.md')) === 'добавлено после предпросмотра' && text(path.join(dir, 'logic/main.ts')).includes('строка пять');
  });
  check('откат к совпадающей версии не нужен', () => { const c = h.save('manual'); return fails(() => h.rollback(c.snapshot.id, h.plan(c.snapshot.id).token), 'changed'); });
  check('временных файлов не осталось', () => walk(path.join(dir, '.flux')).every(f => !f.endsWith('.tmp')));

  // ---- файл есть на диске, но по .fluxignore не входит в историю: откат его не теряет ----
  const dirS = project('shadow', { 'manifest.json': '{"id":"s"}', 'notes.txt': 'старые заметки' });
  const spaceS = new W.Workspace(dirS), hs = new H.History(spaceS, { now });
  const sOld = hs.save('manual');
  put(dirS, '.fluxignore', 'notes.txt\n'); put(dirS, 'notes.txt', 'новые заметки, которые нельзя потерять');
  const shadowPlan = hs.plan(sOld.snapshot.id);
  check('откат: файл вне истории, который будет перезаписан, назван в предпросмотре', () => shadowPlan.shadowed.includes('notes.txt'));
  const shadowDone = step(() => hs.rollback(sOld.snapshot.id, shadowPlan.token))!;
  check('откат: перезаписываемый файл вне истории сохранён в снимке «перед откатом»', () => new TextDecoder().decode(hs.files(shadowDone.restorePoint.id)['notes.txt']).startsWith('новые заметки') && text(path.join(dirS, 'notes.txt')) === 'старые заметки');

  // ---- пределы и порядок вытеснения ----
  const dirE = project('evict', { 'f.txt': '0' });
  const he = new H.History(new W.Workspace(dirE), { now, maxSnapshots: 4 });
  let n = 0;
  const snap = (reason: any, meta: any = {}) => { put(dirE, 'f.txt', `содержимое ${++n}`); return he.save(reason, meta).snapshot; };
  const reasons = () => he.list().snapshots.map(s => s.reason).sort().join();
  const b1 = snap('build'), m1 = snap('manual'), b2 = snap('build'), p1 = snap('publish');
  snap('before-rollback');
  check('вытеснение: первой уходит сборка, ручные и отправка остаются', () => he.list().snapshots.length === 4 && !he.list().snapshots.some(s => s.id === b1.id) && [m1, b2, p1].every(x => he.list().snapshots.some(s => s.id === x.id)));
  snap('build'); snap('build');
  check('вытеснение: сборки уходят раньше «перед откатом», ручных и отправок', () => reasons() === 'before-rollback,build,manual,publish' && !he.list().snapshots.some(s => s.id === b2.id));
  snap('manual'); snap('manual');
  check('вытеснение: ручные раньше отправок, «перед откатом» раньше ручных', () => he.list().snapshots.length === 4 && he.list().snapshots.every(s => s.reason === 'manual' || s.reason === 'publish') && he.list().snapshots.some(s => s.id === p1.id));
  snap('manual');
  check('вытеснение: самая старая ручная уходит раньше отправки', () => !he.list().snapshots.some(s => s.id === m1.id) && he.list().snapshots.some(s => s.id === p1.id));
  check('вытеснение: объекты без снимков удалены', () => walk(path.join(dirE, '.flux', 'history', 'objects')).length === he.list().snapshots.length);
  check('вытеснение: новейший снимок не уходит никогда', () => he.list().snapshots[0].reason === 'manual' && text(path.join(dirE, 'f.txt')) === `содержимое ${n}` && he.files(he.list().snapshots[0].id)['f.txt'].length > 0);

  const dirB = project('bytes', { 'big.txt': 'x' });
  const hb = new H.History(new W.Workspace(dirB), { now, maxBytes: 3000 });
  for (let i = 0; i < 5; i++) { put(dirB, 'big.txt', `${i}`.repeat(1000)); hb.save('build'); }
  check('предел объёма: лишнее вытеснено, объём не больше предела', () => hb.list().snapshots.length === 3 && hb.list().bytes <= 3000);
  put(dirB, 'big.txt', 'y'.repeat(4000));
  check('снимок больше предела не создаётся', () => fails(() => hb.save('manual'), 'too-large') && hb.list().snapshots.length === 3);

  const dirT = project('toomany');
  for (let i = 0; i < 401; i++) put(dirT, `d/f${i}.txt`, `${i}`);
  check('больше 400 файлов — отказ с объяснением', () => fails(() => new H.History(new W.Workspace(dirT), { now }).save('manual'), 'too-large'));

  // ---- безопасность: подделанные и повреждённые снимки ----
  const dirX = project('tamper', { 'a.txt': 'первая', 'b.txt': 'вторая' });
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside, { recursive: true });
  const hx = new H.History(new W.Workspace(dirX), { now });
  const good1 = hx.save('manual').snapshot;
  put(dirX, 'a.txt', 'изменённая первая'); put(dirX, 'b.txt', 'изменённая вторая');
  const good2 = hx.save('manual').snapshot;
  const snapDir = path.join(dirX, '.flux', 'history', 'snapshots');
  const forged = (id: string, rel: string) => {
    const stored = JSON.parse(text(path.join(snapDir, `${good1.id}.json`)));
    stored.id = id; stored.files[rel] = stored.files['a.txt'];
    fs.writeFileSync(path.join(snapDir, `${id}.json`), JSON.stringify(stored));
  };
  forged('1700000000001-aaaaaa', '../outside/pwn.txt');
  forged('1700000000002-bbbbbb', '.flux/history/pwn.txt');
  forged('1700000000003-cccccc', 'a\\b.txt');
  forged('1700000000004-dddddd', '/etc/pwn.txt');
  fs.writeFileSync(path.join(snapDir, '1700000000005-eeeeee.json'), '{не json');
  const listed = hx.list();
  check('подделанные пути и битый JSON показаны как повреждённые, список жив', () => listed.damaged.length === 5 && listed.snapshots.length === 2);
  check('повреждённые снимки не открываются и не откатываются', () => ['1700000000001-aaaaaa', '1700000000002-bbbbbb', '1700000000004-dddddd', '1700000000005-eeeeee'].every(id => fails(() => hx.plan(id), 'damaged') && fails(() => hx.files(id), 'damaged')));
  check('за пределами папки ничего не записано', () => !fs.existsSync(path.join(outside, 'pwn.txt')) && !fs.existsSync(path.join(base, 'pwn.txt')) && !fs.existsSync(path.join(dirX, '.flux/history/pwn.txt')));
  step(() => hx.remove('1700000000001-aaaaaa'));
  check('повреждённую версию можно убрать самому', () => hx.list().damaged.length === 4 && fails(() => hx.remove('1700000000001-aaaaaa'), 'missing'));
  // подмена объекта: тот же размер, другое содержимое
  const objDir = path.join(dirX, '.flux', 'history', 'objects');
  const oldHash = JSON.parse(text(path.join(snapDir, `${good1.id}.json`))).files['a.txt'].h as string;
  const objFile = path.join(objDir, oldHash.slice(0, 2), oldHash);
  const original = fs.readFileSync(objFile);
  fs.writeFileSync(objFile, Buffer.alloc(original.length, 0x41));
  const signature = () => walk(dirX).filter(f => !f.includes(`${path.sep}.flux${path.sep}`)).map(f => `${f}:${text(f)}`).join('|');
  const untouched = signature();
  check('подменённый объект: файл версии отвергается, откат не пишет ничего', () => fails(() => hx.files(good1.id), 'damaged') && fails(() => hx.plan(good1.id), 'damaged') && signature() === untouched);
  check('подменённый объект ломает только свою версию', () => { const f = hx.files(good2.id); return new TextDecoder().decode(f['a.txt']) === 'изменённая первая'; });
  fs.writeFileSync(objFile, original);
  fs.rmSync(objFile);
  check('пропавший объект: версия помечена неполной, открыть нельзя', () => hx.list().snapshots.find(s => s.id === good1.id)?.complete === false && fails(() => hx.files(good1.id), 'damaged'));

  // ---- ссылка на месте .flux/history ----
  const dirL = project('link', { 'a.txt': '1' });
  const away = path.join(base, 'away'); fs.mkdirSync(away, { recursive: true });
  fs.mkdirSync(path.join(dirL, '.flux'));
  let linked = true;
  try { fs.symlinkSync(away, path.join(dirL, '.flux', 'history'), 'junction'); } catch { linked = false; }
  check('ссылка на месте .flux/history отвергается, наружу ничего не пишется', () => !linked || (fails(() => new H.History(new W.Workspace(dirL), { now }).save('manual'), 'unsafe') && fs.readdirSync(away).length === 0));

  // ---- защита целевого снимка от вытеснения при откате ----
  const dirP = project('protect', { 'f.txt': 'исходный' });
  const hp = new H.History(new W.Workspace(dirP), { now, maxSnapshots: 3 });
  const target = hp.save('build').snapshot;
  put(dirP, 'f.txt', 'второй'); hp.save('manual');
  put(dirP, 'f.txt', 'третий'); hp.save('manual');
  put(dirP, 'f.txt', 'четвёртый');
  step(() => hp.rollback(target.id, hp.plan(target.id).token));
  check('откат: версия, к которой откатываются, не вытесняется снимком «перед откатом»', () => hp.list().snapshots.some(s => s.id === target.id) && text(path.join(dirP, 'f.txt')) === 'исходный' && hp.list().snapshots.some(s => s.reason === 'before-rollback'));
  return R;
}

/** Замечания владельца, привязанные к снимку отправки (studio/shared/ownerNotes.ts) */
function notesBattery(N: typeof realNotes): Map<string, boolean> {
  const R = new Map<string, boolean>();
  const check = (name: string, fn: () => unknown) => { try { R.set(name, !!fn()); } catch { R.set(name, false); } };
  const before = 'a\nb\nc\nd', after = 'x\na\nB\nc\nd';
  check('замечание: целая строка переехала вместе со сдвигом и не помечена', () => { const l = N.locateLine(before, after, 1), c = N.locateLine(before, after, 3); return l.line === 2 && !l.changed && c.line === 4 && !c.changed; });
  check('замечание: изменившаяся строка помечена и указывает на новое место', () => { const l = N.locateLine(before, after, 2); return l.line === 3 && l.changed; });
  check('замечание: удалённая строка помечена', () => { const l = N.locateLine('a\nb\nc', 'a\nc', 2); return l.changed && l.line === 2; });
  const notes = [{ path: 'f.ts', line: 2, text: 'к b' }, { path: 'f.ts', line: null, text: 'ко всему файлу' }, { path: 'gone.ts', line: 1, text: 'файла нет' }];
  const files: Record<string, string> = { 'f.ts': after };
  const anchored = N.anchorNotes(notes, p => p === 'f.ts' ? before : null, p => files[p] ?? null);
  check('замечание: с отправкой — перенос и признак изменения', () => anchored[0].anchored && anchored[0].changed && anchored[0].currentLine === 3);
  check('замечание: ко всему файлу и к пропавшему файлу', () => anchored[1].currentLine === null && !anchored[1].changed && anchored[2].fileGone && anchored[2].changed);
  const loose = N.anchorNotes(notes, null, p => files[p] ?? null);
  check('замечание: без снимка отправки остаётся на своём номере и ничего не утверждает', () => !loose[0].anchored && !loose[0].changed && loose[0].currentLine === 2);
  return R;
}

/** Мутанты: [условие, файл, что заменить, на что] */
const MUTANTS: Array<[string, 'history' | 'workspace', string, string]> = [
  ['подделанные пути и битый JSON показаны как повреждённые, список жив', 'history', '      relativeParts(rel); // тот же разбор', '      void rel; // тот же разбор'],
  ['откат: снимок «перед откатом» создан и содержит прежнее состояние', 'history', "restore = this.save('before-rollback', {", "restore = { snapshot: plan.snapshot, created: false, evicted: 0 }; void ({"],
  ['вытеснение: сборки уходят раньше «перед откатом», ручных и отправок', 'history', 'REASON_RANK[a.reason] - REASON_RANK[b.reason] || a.time - b.time', 'REASON_RANK[b.reason] - REASON_RANK[a.reason] || a.time - b.time'],
  ['подменённый объект: файл версии отвергается, откат не пишет ничего', 'history', "if (sha(data) !== f.h) throw new HistoryFailure(`Файл «${rel}» в версии повреждён.`, 'damaged');", ''],
  ['токен: файлы изменились после предпросмотра — откат отказывает и ничего не пишет', 'history', 'if (plan.token !== token)', 'if (false)'],
  ['ссылка на месте .flux/history отвергается, наружу ничего не пишется', 'history', 'try { st = fs.lstatSync(at); }', 'try { st = fs.statSync(at); }'],
  ['одинаковый снимок не создаётся', 'history', 'last && last.tree === tree && this.info(last).complete', 'false'],
  ['откат: версия, к которой откатываются, не вытесняется снимком «перед откатом»', 'history', 'protect: [id], ', ''],
  ['откат: перезаписываемый файл вне истории сохранён в снимке «перед откатом»', 'history', 'include: plan.shadowed', 'include: []'],
  ['вытеснение: объекты без снимков удалены', 'history', 'if (evicted) this.collect();', ''],
  ['в дереве нет .flux', 'workspace', "'.svn', FLUX_DIR]", "'.svn']"],
];

async function main() {
  let passed = 0;
  console.log('История версий: настоящий модуль');
  const real = await battery(realHistory, realWorkspace, 'real');
  for (const [name, value] of real) { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); }
  assert.ok(real.size >= 40, `условий слишком мало: ${real.size}`);

  const notes = notesBattery(realNotes);
  for (const [name, value] of notes) { assert.ok(value, name); passed++; console.log(`  ✓ ${name}`); }

  console.log('Мутации защит');
  const made: string[] = [];
  try {
    let i = 0;
    for (const [condition, file, from, to] of MUTANTS) {
      const sources = { history: path.join(shared, 'history.ts'), workspace: path.join(shared, 'workspace.ts') };
      const source = fs.readFileSync(sources[file], 'utf8');
      assert.ok(source.includes(from), `в ${file}.ts нет места для мутации: ${from.slice(0, 60)}`);
      const id = `${process.pid}_${i++}`;
      // Мутант подменяет один модуль; второй остаётся настоящим, но импортируется из того же каталога
      const mutantPath = path.join(shared, `__mutant_${file}_${id}.ts`);
      fs.writeFileSync(mutantPath, source.replace(from, to));
      made.push(mutantPath);
      let H: HistoryModule = realHistory, W: WorkspaceModule = realWorkspace;
      if (file === 'history') H = await import(mutantPath);
      else {
        // history.ts импортирует './workspace': копия истории смотрит на мутантный workspace
        const historyCopy = path.join(shared, `__mutant_history_ws_${id}.ts`);
        fs.writeFileSync(historyCopy, fs.readFileSync(sources.history, 'utf8').replace("from './workspace'", `from './__mutant_workspace_${id}'`));
        fs.renameSync(mutantPath, path.join(shared, `__mutant_workspace_${id}.ts`));
        made.push(historyCopy, path.join(shared, `__mutant_workspace_${id}.ts`));
        W = await import(path.join(shared, `__mutant_workspace_${id}.ts`));
        H = await import(historyCopy);
      }
      const result = await battery(H, W, `mutant-${id}`);
      assert.equal(result.get(condition), false, `мутация не поймана условием «${condition}»`);
      passed++; console.log(`  ✓ мутация поймана: ${condition}`);
    }
    const notesSource = path.join(shared, 'ownerNotes.ts'), mutantNotes = path.join(shared, `__mutant_notes_${process.pid}.ts`);
    const original = fs.readFileSync(notesSource, 'utf8'), broken = '{ line: newN + 1, changed: true }';
    assert.ok(original.includes(broken));
    fs.writeFileSync(mutantNotes, original.replace(broken, '{ line: newN + 1, changed: false }'));
    made.push(mutantNotes);
    const mutated = notesBattery(await import(mutantNotes));
    assert.equal(mutated.get('замечание: изменившаяся строка помечена и указывает на новое место'), false, 'мутация признака «строка изменилась» не поймана');
    passed++; console.log('  ✓ мутация поймана: признак «строка изменилась»');
  } finally { for (const f of made) fs.rmSync(f, { force: true }); }
  console.log(`\nИстория версий: ${passed} проверок прошли.`);
}
main().then(() => { fs.rmSync(temp, { recursive: true, force: true }); }, e => { console.error(e); process.exit(1); });
