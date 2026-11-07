import React from 'react';
import { RefreshCw } from 'lucide-react';
import { Btn, SectionTitle } from '../ui';
import { useToastStore } from '../../store/toastStore';
import { useStore } from '../../store/store';
import { can } from '../../lib/permissions';
import { getSettings, putSettings, trackLinks, unlinkLink } from '../../lib/docflowApi';
import { bindingFor, bindingsOfProject, scanFolder } from '../../lib/docflowAssign';
import { folderOfBinding, newGroup, renameFile } from '../../lib/docflowFiles';
import { useBindingLedger } from '../explorer/useProjectFolderBindings';
import { useProjectDocs } from './useProjectDocs';
import AssignFileDialog from './AssignFileDialog';
import AddToRegistryDialog from './AddToRegistryDialog';
import type { PickRow } from './RowPicker';
import { dirOf } from '../../../shared/docflow/links';
import { reconcile, type ReconFile, type ReconRow, type Reconciliation } from '../../../shared/docflow/reconcile';
import { docInfoOf } from '../files/docEntryInfo';
import type { RowForCheck } from '../../../shared/docflow/nameMask';
import type { WindowsFileRef } from '../../lib/windowsFiles';
import { windowsFilesRequest } from '../../lib/windowsFiles';

/**
 * «Сверка с папкой» (docs/docflow-program.md, 4.3): рабочая папка проекта против реестра.
 * Четыре группы расхождений; сверка только показывает, что с найденным делать — решает
 * человек (автосвязи нет). Расчёт — чистая функция shared/docflow/reconcile.ts.
 */
interface Loaded { rows: ReconRow[]; pick: Map<string, PickRow>; files: ReconFile[]; truncated: boolean; base: WindowsFileRef | null }
type Task = { kind: 'assign'; row: PickRow; file?: WindowsFileRef } | { kind: 'add'; file: ReconFile; ref: WindowsFileRef } | null;

export default function ReconcileTab({ projectId }: { projectId: string }) {
  const user = useStore((s) => s.user);
  const toast = useToastStore((s) => s.addToast);
  const mayFiles = can(user, 'docflow.files');
  const maySettings = can(user, 'docflow.settings');
  const { docs, reload: reloadDocs } = useProjectDocs([projectId]);
  const ctx = docs[projectId];
  const { bindings } = useBindingLedger(user?.id);
  const work = bindingFor(bindings, projectId, 'work');
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [state, setState] = React.useState<'idle' | 'busy' | 'error'>('idle');
  const [message, setMessage] = React.useState('');
  const [task, setTask] = React.useState<Task>(null);

  const refOf = (base: WindowsFileRef | null, relativePath: string): WindowsFileRef | undefined => base ? { ...base, relativePath: [base.relativePath, relativePath].filter(Boolean).join('/') } : undefined;

  const run = React.useCallback(async () => {
    if (!work) return;
    setState('busy'); setMessage('');
    try {
      const base = await folderOfBinding(work);
      if (!base) { setState('error'); setMessage(`Папка «${work.label}» не найдена среди папок этого компьютера. Откройте её в Проводнике и привяжите заново.`); return; }
      const registers: Array<{ id: string; name: string; poNumber: string }> = (await fetch(`/api/vdr/registers?projectId=${encodeURIComponent(projectId)}`).then((r) => r.json()).catch(() => ({}))).registers || [];
      const rows: ReconRow[] = []; const pick = new Map<string, PickRow>();
      for (const reg of registers) {
        const items: any[] = (await fetch(`/api/vdr/items?registerId=${encodeURIComponent(reg.id)}`).then((r) => r.json()).catch(() => ({}))).items || [];
        for (const it of items) {
          let tags: string[] = []; try { tags = JSON.parse(it.equipmentTags || '[]'); } catch { /* пустой список */ }
          const row: RowForCheck = { contractorNo: it.contractorNo, ownerNo: it.ownerNo, vendorNo: it.vendorNo, vdrCode: it.vdrCode, revision: it.revision, language: it.language, tags, poNumber: reg.poNumber };
          rows.push({ id: it.id, registerId: reg.id, title: it.titleRu || it.titleEn || '', status: it.status, row });
          pick.set(it.id, { id: it.id, registerId: reg.id, registerName: reg.name, contractorNo: it.contractorNo, ownerNo: it.ownerNo, vendorNo: it.vendorNo, titleRu: it.titleRu, titleEn: it.titleEn, vdrCode: it.vdrCode, revision: it.revision, status: it.status });
        }
      }
      const scan = await scanFolder(base);
      setLoaded({ rows, pick, files: scan.files.map((f) => ({ folderKey: work.locationKey, relativePath: f.relativePath, name: f.name })), truncated: scan.truncated, base });
      setState('idle');
    } catch (e: any) { setState('error'); setMessage(e?.message || 'Не удалось сверить'); }
  }, [work?.id, projectId]);
  React.useEffect(() => { void run(); }, [run]);

  const result: Reconciliation | null = React.useMemo(() => (ctx && loaded ? reconcile(ctx.config, loaded.rows, loaded.files, ctx.links) : null), [ctx, loaded]);
  const again = () => { void reloadDocs(projectId); void run(); };

  const renameBySheet = async (linkId: string, itemId: string, relativePath: string, expectedName: string) => {
    const ref = refOf(loaded?.base || null, relativePath);
    if (!ref || !expectedName) return;
    try {
      await renameFile(ref, expectedName, newGroup('reconcile'));
      const t = await trackLinks([{ itemId, linkId, relativePath: [dirOf(relativePath), expectedName].filter(Boolean).join('/'), fileName: expectedName }]);
      if (!t.ok) toast(t.data.error || 'Файл переименован, связь не обновилась', 'error'); else toast(`Переименован в «${expectedName}»`, 'success');
      again();
    } catch (e: any) { toast(e?.message || 'Не удалось переименовать', 'error'); }
  };
  const ignoreFile = async (name: string) => {
    const current = await getSettings(projectId);
    if (!current.ok) return;
    const config = { ...current.data.config, masks: { ...current.data.config.masks, ignore: [...new Set([...current.data.config.masks.ignore, name])] } };
    const saved = await putSettings(projectId, config, current.data.stored ? current.data.updatedAt : null);
    if (saved.ok) { toast(`«${name}» больше не считается документом`, 'success'); again(); } else toast(saved.data.error || 'Не удалось сохранить правило', 'error');
  };
  const reveal = (relativePath: string) => { const ref = refOf(loaded?.base || null, relativePath); if (ref) void windowsFilesRequest({ action: 'reveal', ref }); };

  if (!work) return <div className="p-4 text-sm text-slate-500 dark:text-slate-400">У проекта не назначена рабочая папка. В Проводнике: правой кнопкой по папке проекта → «Привязать к проекту» → «Назначение: Рабочая».</div>;
  const rowName = (id: string) => { const r = loaded?.pick.get(id); return r ? `${r.contractorNo || r.ownerNo || r.vendorNo || '—'} · ${r.titleRu || r.titleEn}` : id; };
  const fileLabel = (f: ReconFile) => f.relativePath;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4 text-xs" data-reconcile>
      <div className="flex items-center gap-3">
        <Btn disabled={state === 'busy'} onClick={again}><RefreshCw size={14} className={state === 'busy' ? 'animate-spin' : ''} /> Сверить</Btn>
        <span className="text-slate-500 dark:text-slate-400">{state === 'busy' ? 'Читаю папку…' : result ? `Файлов в папке: ${result.scanned}${result.ignored ? ` (служебных ${result.ignored})` : ''}${loaded?.truncated ? ' · показана часть: слишком много файлов' : ''}` : ''}</span>
      </div>
      {message && <p role="alert" className="text-rose-600 dark:text-rose-400">{message}</p>}
      {result && (
        <>
          <Group title="Есть в реестре, файла нет" count={result.noFile.length} empty="У каждой строки есть файл текущей ревизии.">
            {result.noFile.map((x) => <Line key={x.rowId} text={`${rowName(x.rowId)} · ред. ${x.revision}`} hint={x.candidates.length ? `подходит по имени: ${x.candidates.map(fileLabel).join(', ')}` : ''}>
              {mayFiles && x.candidates.slice(0, 1).map((c) => <Btn key={c.relativePath} size="sm" onClick={() => setTask({ kind: 'assign', row: loaded!.pick.get(x.rowId)!, file: refOf(loaded!.base, c.relativePath) })}>Связать с файлом…</Btn>)}
              {mayFiles && <Btn size="sm" onClick={() => setTask({ kind: 'assign', row: loaded!.pick.get(x.rowId)! })}>Привязать файл…</Btn>}
            </Line>)}
          </Group>
          <Group title="Файл есть, в реестре нет" count={result.noRow.length} empty="Все файлы с читаемым именем есть в реестре.">
            {result.noRow.map((x) => <Line key={x.file.relativePath} text={fileLabel(x.file)} hint={x.matches.length ? `совпал шифр строки: ${x.matches.map(rowName).join('; ')}` : 'такой строки нет'}>
              {mayFiles && x.matches.slice(0, 1).map((id) => <Btn key={id} size="sm" onClick={() => setTask({ kind: 'assign', row: loaded!.pick.get(id)!, file: refOf(loaded!.base, x.file.relativePath) })}>Связать с…</Btn>)}
              {mayFiles && !x.matches.length && <Btn size="sm" onClick={() => setTask({ kind: 'add', file: x.file, ref: refOf(loaded!.base, x.file.relativePath)! })}>Добавить в реестр</Btn>}
            </Line>)}
          </Group>
          <Group title="Имя не по маске" count={result.offMask.length} empty="Все файлы названы по маске проекта.">
            {result.offMask.map((x) => <Line key={x.file.relativePath} text={fileLabel(x.file)} hint={x.problems.join('; ')}>
              <Btn size="sm" onClick={() => reveal(x.file.relativePath)}>Показать в Проводнике</Btn>
              {maySettings && <Btn size="sm" onClick={() => void ignoreFile(x.file.name)}>Не документ</Btn>}
            </Line>)}
          </Group>
          <Group title="Расходится" count={result.diverged.length} empty="Привязанные файлы совпадают со строками.">
            {result.diverged.map((x) => <Line key={x.link.id} text={`${rowName(x.rowId)} · ${x.link.relativePath}`} hint={x.problems.join('; ')}>
              {mayFiles && x.reason === 'name' && x.expectedName && <Btn size="sm" onClick={() => void renameBySheet(x.link.id, x.rowId, x.link.relativePath, x.expectedName)}>Переименовать по строке в {x.expectedName}</Btn>}
              {mayFiles && x.reason === 'missing' && <Btn size="sm" onClick={() => setTask({ kind: 'assign', row: loaded!.pick.get(x.rowId)! })}>Найти…</Btn>}
              {mayFiles && <Btn size="sm" onClick={() => void unlinkLink(x.rowId, x.link.id, 'отвязан при сверке').then(() => again())}>Отвязать</Btn>}
            </Line>)}
          </Group>
        </>
      )}
      {task?.kind === 'assign' && ctx && <AssignFileDialog role="file" projectId={projectId} docs={ctx} bindings={bindingsOfProject(bindings, projectId)} row={task.row} file={task.file} onClose={() => setTask(null)} onDone={again} />}
      {task?.kind === 'add' && ctx && (() => {
        const info = docInfoOf({ name: task.file.name, kind: 'file' }, { projectId, folderKey: work.locationKey, purpose: work.purpose, relativePath: task.file.relativePath }, { config: ctx.config, byPath: new Map(), items: {}, links: [] });
        return info ? <AddToRegistryDialog projectId={projectId} docs={ctx} file={task.ref} info={info} onClose={() => setTask(null)} onDone={again} /> : null;
      })()}
    </div>
  );
}

function Group({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} data-recon-group>
      <SectionTitle right={<span className="text-slate-500 dark:text-slate-400">{count}</span>}>{title}</SectionTitle>
      {count === 0 ? <p className="py-1 text-slate-500 dark:text-slate-400">{empty}</p> : <ul className="divide-y divide-slate-100 dark:divide-slate-800">{children}</ul>}
    </section>
  );
}

function Line({ text, hint, children }: { text: string; hint?: string; children?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5">
      <span className="min-w-0 flex-1"><span className="break-words font-medium">{text}</span>{hint && <span className="block text-slate-500 dark:text-slate-400">{hint}</span>}</span>
      <span className="flex shrink-0 gap-2">{children}</span>
    </li>
  );
}
