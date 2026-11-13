/**
 * История версий проекта («как в GitHub»): снимки файлов, сравнение и откат. Без React и Electron — считает и главный процесс,
 * и проверки.
 *
 * Хранилище — скрытая папка `.flux/history/` внутри проекта (в дерево, в пакет и в архив она не попадает, редактор её не
 * открывает): `objects/<первые два знака>/<sha256>` — содержимое файлов по хешу, `snapshots/<id>.json` — список «путь → хеш»,
 * время и причина. Одинаковые файлы разных снимков лежат один раз. Снимок — это то, что идёт в пакет, плюс `.fluxignore`;
 * сборочные каталоги и файлы с именами, которые нельзя положить в пакет, в историю не входят и откатом не трогаются.
 *
 * Правила безопасности (чужие файлы человека, поэтому без молчаливых потерь — `flux-data-safety`):
 * - пути из снимка проходят те же проверки, что у Workspace (`relativeParts`), записываются через Workspace, а не fs;
 * - откат сначала читает и проверяет по хешу ВСЕ нужные файлы, затем сохраняет текущее состояние снимком «перед откатом»
 *   и только после этого пишет; не удалось сохранить — файлы не тронуты;
 * - предпросмотр откатa (`plan`) даёт токен: если файлы изменились после предпросмотра, откат отказывает;
 * - повреждённый снимок не роняет список, а показывается как повреждённый; повреждённый объект ломает только свой снимок.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MODULE_BUNDLE_MAX } from '../../modules/trust/claims';
import { diffFiles, type DiffLine } from '../../modules/trust/diff';
import type { BundleFiles } from '../../modules/trust/bundle';
import { FLUX_DIR, IGNORE_FILE, MAX_FILES, relativeParts, WorkspaceFailure, type Workspace } from './workspace';

export class HistoryFailure extends Error { constructor(message: string, readonly code: 'too-large' | 'damaged' | 'changed' | 'unsafe' | 'missing' | 'failed' = 'failed') { super(message); } }

export type SnapshotReason = 'manual' | 'build' | 'publish' | 'before-rollback';
/** Порядок вытеснения: меньшее число уходит первым. Ручные и отправки — последними */
export const REASON_RANK: Record<SnapshotReason, number> = { build: 0, 'before-rollback': 1, manual: 2, publish: 3 };
export const REASON_TEXT: Record<SnapshotReason, string> = { manual: 'Сохранена вручную', build: 'Сборка', publish: 'Отправка на публикацию', 'before-rollback': 'Перед откатом' };

export const MAX_SNAPSHOTS = 100;
export const MAX_HISTORY_BYTES = 256 * 1024 * 1024;
const NOTE_MAX = 300;
/** Больше этого в одной файловой разнице окну не отдаётся: остальное — «показаны первые строки» */
const DIFF_LINES_MAX = 4000;

export interface SnapshotInfo {
  id: string; time: number; reason: SnapshotReason; note: string; version: string | null;
  fileCount: number; bytes: number; tree: string;
  /** Все объекты на месте (по размеру); полная проверка по хешу — при чтении снимка */
  complete: boolean;
}
export interface DamagedInfo { id: string; problem: string }
export interface FileChange { path: string; status: 'added' | 'removed' | 'changed'; binary: boolean; lines: DiffLine[]; truncated: boolean; sizeBefore: number | null; sizeAfter: number | null }
export interface Comparison { from: string; to: string; files: FileChange[]; same: number }
export interface PlanEntry { path: string; action: 'create' | 'modify' | 'delete'; sizeBefore: number | null; sizeAfter: number | null }
export interface RollbackPlan { snapshot: SnapshotInfo; entries: PlanEntry[]; unchanged: number; token: string; /** Файлы, которые уже есть на диске, но не входят в историю (по правилам исключения) и будут перезаписаны: их текущая версия попадёт в снимок «перед откатом» */ shadowed: string[] }
export interface SaveResult { snapshot: SnapshotInfo; created: boolean; evicted: number }
export interface HistoryOptions { maxSnapshots?: number; maxBytes?: number; now?: () => number }

interface Stored { v: 1; id: string; time: number; reason: SnapshotReason; note: string; version: string | null; tree: string; files: Record<string, { h: string; n: number }> }

const sha = (data: Uint8Array | string) => crypto.createHash('sha256').update(data).digest('hex');
const HASH = /^[0-9a-f]{64}$/;
const SNAP_ID = /^\d{13}-[0-9a-f]{6}$/;
const treeHash = (files: Record<string, { h: string }>) => sha(Object.keys(files).sort().map(p => `${p}\0${files[p].h}\n`).join(''));
const hashOf = (files: BundleFiles): Record<string, { h: string; n: number }> => Object.fromEntries(Object.entries(files).map(([p, d]) => [p, { h: sha(d), n: d.length }]));

export class History {
  private readonly dir: string;
  private readonly maxSnapshots: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  constructor(private readonly space: Workspace, options: HistoryOptions = {}) {
    this.dir = path.join(space.root, FLUX_DIR, 'history');
    this.maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS;
    this.maxBytes = options.maxBytes ?? MAX_HISTORY_BYTES;
    this.now = options.now ?? Date.now;
  }

  // ---- хранилище ----
  /** Каталог истории; ссылка на его месте (junction наружу) отвергается: запись пошла бы за пределы проекта */
  private store(create: boolean): string | null {
    let at = this.space.root;
    for (const part of [FLUX_DIR, 'history']) {
      at = path.join(at, part);
      let st: fs.Stats | null = null;
      try { st = fs.lstatSync(at); } catch { /* нет */ }
      if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new HistoryFailure('Папка истории `.flux/history` занята ссылкой или файлом — история не используется.', 'unsafe');
      if (!st) { if (!create) return null; fs.mkdirSync(at); }
    }
    return at;
  }
  private objectPath(hash: string): string { return path.join(this.dir, 'objects', hash.slice(0, 2), hash); }
  private snapshotPath(id: string): string { return path.join(this.dir, 'snapshots', `${id}.json`); }
  /** Запись через временный файл: оборванная запись не оставляет полфайла */
  private put(file: string, data: Uint8Array | string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
  }
  private putObject(hash: string, data: Uint8Array) {
    const file = this.objectPath(hash);
    try { if (fs.statSync(file).size === data.length) return; } catch { /* нет объекта */ }
    this.put(file, data);
  }

  /** Снимок из файла: проверка формата и каждого пути. Любое нарушение — снимок повреждён, а не «выход за папку» */
  private parse(id: string, text: string): Stored {
    const value = JSON.parse(text) as Stored;
    if (value?.v !== 1 || value.id !== id || !Number.isFinite(value.time) || !(value.reason in REASON_RANK) || typeof value.files !== 'object' || value.files === null) throw new Error('неверный формат');
    for (const [rel, f] of Object.entries(value.files)) {
      relativeParts(rel); // тот же разбор путей, что у Workspace: `..`, `\`, абсолютные и служебные каталоги отвергаются
      if (!HASH.test(f?.h) || !Number.isSafeInteger(f.n) || f.n < 0) throw new Error(`неверная запись файла ${rel.slice(0, 80)}`);
    }
    if (Object.keys(value.files).length > MAX_FILES) throw new Error('слишком много файлов');
    return value;
  }
  private info(value: Stored): SnapshotInfo {
    let complete = true;
    for (const f of Object.values(value.files)) { try { if (fs.statSync(this.objectPath(f.h)).size !== f.n) complete = false; } catch { complete = false; } }
    return { id: value.id, time: value.time, reason: value.reason, note: String(value.note ?? ''), version: value.version ?? null, tree: value.tree,
      fileCount: Object.keys(value.files).length, bytes: Object.values(value.files).reduce((s, f) => s + f.n, 0), complete };
  }
  private scan(): { stored: Stored[]; damaged: DamagedInfo[] } {
    const stored: Stored[] = [], damaged: DamagedInfo[] = [];
    const store = this.store(false);
    if (!store) return { stored, damaged };
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(store, 'snapshots')); } catch { /* нет снимков */ }
    for (const name of names.sort()) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !SNAP_ID.test(id)) continue;
      try { stored.push(this.parse(id, fs.readFileSync(this.snapshotPath(id), 'utf8'))); }
      catch (e) { damaged.push({ id, problem: `Снимок повреждён: ${(e as Error).message || 'не читается'}.` }); }
    }
    stored.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
    return { stored, damaged };
  }

  // ---- чтение ----
  /** Список для окна: новые сверху; повреждённые — отдельно, список не падает */
  list(): { snapshots: SnapshotInfo[]; damaged: DamagedInfo[]; bytes: number } {
    const { stored, damaged } = this.scan();
    return { snapshots: stored.map(s => this.info(s)).reverse(), damaged, bytes: this.usedBytes(stored) };
  }
  private usedBytes(stored: Stored[]): number {
    const seen = new Map<string, number>();
    for (const s of stored) for (const f of Object.values(s.files)) seen.set(f.h, f.n);
    let total = 0;
    for (const n of seen.values()) total += n;
    return total;
  }
  private find(id: string): Stored {
    if (!SNAP_ID.test(id)) throw new HistoryFailure('Такой версии нет.', 'missing');
    try { return this.parse(id, fs.readFileSync(this.snapshotPath(id), 'utf8')); }
    catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') throw new HistoryFailure('Такой версии нет.', 'missing');
      throw new HistoryFailure('Версия повреждена и не может быть открыта.', 'damaged');
    }
  }
  get(id: string): SnapshotInfo { return this.info(this.find(id)); }
  /** Файлы снимка; каждый объект проверяется по хешу — подмена или порча дают отказ, а не тихо неверный файл */
  files(id: string): BundleFiles {
    const value = this.find(id), out: BundleFiles = {};
    for (const [rel, f] of Object.entries(value.files)) {
      let data: Uint8Array;
      try { data = new Uint8Array(fs.readFileSync(this.objectPath(f.h))); } catch { throw new HistoryFailure(`В версии нет файла «${rel}»: она повреждена.`, 'damaged'); }
      if (sha(data) !== f.h) throw new HistoryFailure(`Файл «${rel}» в версии повреждён.`, 'damaged');
      out[rel] = data;
    }
    return out;
  }
  /** Текущие файлы проекта, которые входят в историю */
  current(include: string[] = []): BundleFiles {
    const out: BundleFiles = {};
    let total = 0;
    const take = (rel: string) => {
      if (Object.keys(out).length >= MAX_FILES) throw new HistoryFailure(`В проекте больше ${MAX_FILES} файлов для истории. Уберите лишнее или перечислите в ${IGNORE_FILE}.`, 'too-large');
      const data = this.space.read(rel);
      total += data.length;
      if (total > MODULE_BUNDLE_MAX) throw new HistoryFailure('Файлы проекта больше 32 МиБ — версию сохранить нельзя. Уберите лишнее или перечислите в ' + IGNORE_FILE + '.', 'too-large');
      out[rel] = data;
    };
    for (const entry of this.space.tree()) if (!entry.dir && (!entry.ignored || entry.path === IGNORE_FILE)) take(entry.path);
    for (const rel of include) if (!(rel in out)) take(rel);
    return out;
  }

  // ---- запись снимка ----
  save(reason: SnapshotReason, meta: { note?: string; version?: string | null; protect?: string[]; include?: string[] } = {}): SaveResult {
    const note = String(meta.note ?? '').trim().slice(0, NOTE_MAX), version = meta.version ? String(meta.version).slice(0, 40) : null;
    const files = hashOf(this.current(meta.include));
    const tree = treeHash(files), bytes = Object.values(files).reduce((s, f) => s + f.n, 0);
    if (bytes > this.maxBytes) throw new HistoryFailure('Проект больше предела истории — версию сохранить нельзя.', 'too-large');
    const { stored } = this.scan();
    const last = stored[stored.length - 1];
    // Одинаковый с предыдущим снимок не создаётся; но причина «важнее» (отправка, ручная) и версия не теряются
    if (last && last.tree === tree && this.info(last).complete) {
      const stronger = REASON_RANK[reason] > REASON_RANK[last.reason];
      if (stronger || (version && !last.version) || (note && !last.note && reason === last.reason)) {
        const next: Stored = { ...last, reason: stronger ? reason : last.reason, version: last.version || version, note: last.note || note };
        this.put(this.snapshotPath(last.id), JSON.stringify(next));
        return { snapshot: this.info(next), created: false, evicted: 0 };
      }
      return { snapshot: this.info(last), created: false, evicted: 0 };
    }
    this.store(true);
    // Время строго растёт: порядок снимков — порядок id
    const time = Math.max(this.now(), (last?.time ?? 0) + 1);
    const id = `${String(time).padStart(13, '0')}-${crypto.randomBytes(3).toString('hex')}`;
    for (const [rel, f] of Object.entries(files)) this.putObject(f.h, this.space.read(rel));
    const value: Stored = { v: 1, id, time, reason, note, version, tree, files };
    this.put(this.snapshotPath(id), JSON.stringify(value)); // снимок появляется последним: без него объекты — просто мусор
    const evicted = this.enforce([id, ...(meta.protect ?? [])]);
    return { snapshot: this.info(value), created: true, evicted };
  }

  /** Пределы: число снимков и объём объектов. Первыми уходят сборки, затем «перед откатом», последними ручные и отправки */
  private enforce(keep: string[]): number {
    let evicted = 0;
    for (;;) {
      const { stored } = this.scan();
      if (stored.length <= this.maxSnapshots && this.usedBytes(stored) <= this.maxBytes) break;
      const newest = stored[stored.length - 1]?.id;
      const victim = stored.filter(s => s.id !== newest && !keep.includes(s.id)).sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason] || a.time - b.time)[0];
      if (!victim) break;
      fs.rmSync(this.snapshotPath(victim.id), { force: true });
      evicted++;
    }
    if (evicted) this.collect();
    return evicted;
  }
  /** Объекты, на которые не ссылается ни один снимок, удаляются; нечитаемый снимок объекты не удерживает */
  private collect() {
    const used = new Set<string>();
    for (const s of this.scan().stored) for (const f of Object.values(s.files)) used.add(f.h);
    const root = path.join(this.dir, 'objects');
    let fans: string[] = [];
    try { fans = fs.readdirSync(root); } catch { return; }
    for (const fan of fans) {
      let names: string[] = [];
      try { names = fs.readdirSync(path.join(root, fan)); } catch { continue; }
      for (const name of names) if (!used.has(name)) fs.rmSync(path.join(root, fan, name), { force: true });
    }
  }
  /** Человек убирает версию сам (в том числе повреждённую) */
  remove(id: string): void {
    if (!SNAP_ID.test(id)) throw new HistoryFailure('Такой версии нет.', 'missing');
    if (!fs.existsSync(this.snapshotPath(id))) throw new HistoryFailure('Такой версии нет.', 'missing');
    fs.rmSync(this.snapshotPath(id), { force: true });
    this.collect();
  }

  // ---- сравнение ----
  /** `from` и `to` — идентификатор снимка или `current` (файлы проекта сейчас) */
  compare(from: string, to: string): Comparison {
    const load = (ref: string) => ref === 'current' ? this.current() : this.files(ref);
    const a = load(from), b = load(to);
    const files: FileChange[] = [];
    let same = 0;
    for (const d of diffFiles(a, b)) {
      if (d.status === 'same') { same++; continue; }
      const truncated = d.lines.length > DIFF_LINES_MAX;
      files.push({ path: d.path, status: d.status, binary: d.binary, lines: truncated ? d.lines.slice(0, DIFF_LINES_MAX) : d.lines, truncated, sizeBefore: a[d.path]?.length ?? null, sizeAfter: b[d.path]?.length ?? null });
    }
    return { from, to, files, same };
  }

  // ---- откат ----
  /** Предпросмотр: что изменится, появится и исчезнет. Ничего не пишет */
  plan(id: string): RollbackPlan {
    const target = this.files(id), current = this.current();
    const entries: PlanEntry[] = [];
    let unchanged = 0;
    const shadowed: string[] = [];
    for (const d of diffFiles(current, target)) {
      if (d.status === 'same') { unchanged++; continue; }
      entries.push({ path: d.path, action: d.status === 'added' ? 'create' : d.status === 'removed' ? 'delete' : 'modify', sizeBefore: current[d.path]?.length ?? null, sizeAfter: target[d.path]?.length ?? null });
      if (d.status === 'added' && this.onDisk(d.path)) shadowed.push(d.path);
    }
    return { snapshot: this.get(id), entries, unchanged, shadowed, token: sha(`${treeHash(hashOf(current))}|${id}`) };
  }
  private onDisk(rel: string): boolean { try { return this.space.exists(rel); } catch { return false; } }

  /** Откат: `token` — из предпросмотра. Возвращает снимок «перед откатом» (по нему откат отменяется тем же способом) */
  rollback(id: string, token: string): { restorePoint: SnapshotInfo; entries: PlanEntry[] } {
    const plan = this.plan(id); // читает и проверяет по хешу весь целевой снимок ДО любой записи
    if (plan.token !== token) throw new HistoryFailure('Файлы проекта изменились после предпросмотра. Откройте предпросмотр заново.', 'changed');
    if (!plan.entries.length) throw new HistoryFailure('Проект уже совпадает с этой версией.', 'changed');
    const target = this.files(id);
    let restore: SaveResult;
    try {
      // Без снимка «перед откатом» файлы не трогаются: иначе вернуть текущее состояние будет нечем
      restore = this.save('before-rollback', { note: `Перед откатом к версии от ${new Date(plan.snapshot.time).toLocaleString('ru-RU')}`, protect: [id], include: plan.shadowed });
      this.files(restore.snapshot.id);
    } catch (e) { throw new HistoryFailure(`Откат отменён: не удалось сохранить текущее состояние (${(e as Error).message}). Файлы не изменены.`, 'failed'); }
    try {
      for (const e of plan.entries) if (e.action !== 'delete') this.space.write(e.path, target[e.path]);
      for (const e of plan.entries) if (e.action === 'delete') { this.space.remove(e.path); this.pruneEmpty(e.path); }
    } catch (e) {
      const text = e instanceof WorkspaceFailure || e instanceof Error ? e.message : String(e);
      throw new HistoryFailure(`Откат не завершён: ${text}. Текущее состояние сохранено в версии «Перед откатом» — к ней можно вернуться.`, 'failed');
    }
    return { restorePoint: restore.snapshot, entries: plan.entries };
  }
  /** Пустые папки после удалённых файлов убираются; папка с чем-то внутри остаётся (rmdir не трогает непустую) */
  private pruneEmpty(rel: string) {
    const parts = rel.split('/').slice(0, -1);
    while (parts.length) {
      try { fs.rmdirSync(this.space.resolve(parts.join('/'))); } catch { return; }
      parts.pop();
    }
  }
}
