import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, FolderOpen, Loader2, Upload, X } from 'lucide-react';
import { inferEquipmentSourceFilenameRule } from '../../../equipment/sourceXml';
import {
  pickEquipmentSourceForImport, pickEquipmentSourceFolder, saveEquipmentSourceBinding,
  type EquipmentSourceImportPreview, type LocalEquipmentSourceBinding,
} from '../../lib/equipmentSourcesLocal';
import { windowsFilesRequest } from '../../lib/windowsFiles';

type Category = { id: string; label: string };
type ImportedSource = { sourceId: string; tagId: string; targetType: 'system'; systemId: string; elementId: string; revision: string; sha256: string; fileName: string; revisionOrder?: string[]; unitTag?: { identifier: string } };
type PlanDto = { success: true; fileName: string; sha256: string; revision: string; previewToken?: string; unitTag: { identifier: string; existingTagId?: string; action?: string }; plan: any };
const api = (path: string) => `/api${path}`;
const revisionOrder = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const toMessage = (error: unknown) => error instanceof Error ? error.message : 'Не удалось обработать XML-файл.';

/** Первичный XML импорт: неизменяемый снимок → серверный план → явное применение. */
export default function EquipmentSourceImportDialog(props: { projectId: string; categories: Category[]; canManage: boolean; onClose: () => void; onImported: (result: { source: ImportedSource; tagIdentifier: string; category: string; baselineApplied: boolean }) => void }) {
  const { projectId, categories, canManage, onClose, onImported } = props;
  const [category, setCategory] = useState(categories[0]?.id || '');
  const [file, setFile] = useState<Extract<EquipmentSourceImportPreview, { status: 'ready' }> | null>(null);
  const [tagIdentifier, setTagIdentifier] = useState('');
  const [xmlTagChoices, setXmlTagChoices] = useState<string[]>([]);
  const [revision, setRevision] = useState('');
  const [folderName, setFolderName] = useState('');
  const [rootName, setRootName] = useState('');
  const [plan, setPlan] = useState<PlanDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [tagLinkChoices, setTagLinkChoices] = useState<Record<string, string>>({});
  const operationRef = useRef(0);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const previousProjectRef = useRef(projectId);
  const clearReviewSelections = () => { setChoices({}); setTagLinkChoices({}); };

  useEffect(() => {
    const projectChanged = previousProjectRef.current !== projectId;
    previousProjectRef.current = projectId;
    operationRef.current += 1;
    setPlan(null); setBusy(false); setError('');
    if (projectChanged) { setFile(null); setTagIdentifier(''); setRevision(''); setXmlTagChoices([]); clearReviewSelections(); }
  }, [projectId]);

  useEffect(() => {
    if (!file) return;
    void windowsFilesRequest<{ roots: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }> >({ action: 'roots' }).then(response => {
      if ('data' in response) {
        const roots = Array.isArray(response.data) ? response.data : response.data.roots;
        setRootName(roots.find(root => root.id === file.sourceFolder.rootId)?.name || '');
      }
    });
  }, [file?.sourceFolder.rootId]);

  const planTotals = plan?.plan?.totals || {};
  const units = useMemo(() => plan?.plan?.systems || plan?.plan?.units || [], [plan]);
  const blocks = useMemo(() => plan?.plan?.blocks || [], [plan]);
  const warnings = useMemo(() => {
    const raw = plan?.plan?.warningsList || plan?.plan?.warningMessages || plan?.plan?.warnings;
    return Array.isArray(raw) ? raw : [];
  }, [plan]);
  const unresolvedMatches = (plan?.plan?.matches || []).filter((row: any) => !choices[row.key]);
  const unresolvedSystems = (plan?.plan?.systemRows || []).filter((row: any) => !choices[row.key]);
  const ambiguousLinks = (plan?.plan?.tagLinks || []).filter((link: any) => ['ambiguous', 'invalid'].includes(link.action));
  const unresolvedTagLinks = ambiguousLinks.filter((link: any) => !tagLinkChoices[`${link.blockKey}\u0000${link.identifier}`]);
  const unknownKinds: string[] = plan?.plan?.unknownKinds || [];
  const safeToApply = !unresolvedMatches.length && !unresolvedSystems.length && !unresolvedTagLinks.length && !unknownKinds.length;
  const applyTagLinks = (plan?.plan?.tagLinks || []).map((link: any) => {
    const selected = tagLinkChoices[`${link.blockKey}\u0000${link.identifier}`];
    if (!selected) return link;
    if (selected.startsWith('link:')) return { ...link, action: 'link', existingTagId: selected.slice(5) };
    return { ...link, action: selected };
  });

  const chooseFile = async () => {
    if (!canManage) return;
    const operation = ++operationRef.current;
    setBusy(true); setError(''); setNotice(''); setPlan(null);
    try {
      const result = await pickEquipmentSourceForImport();
      if (operation !== operationRef.current) return;
      if ('error' in result) throw new Error(result.error.message);
      if (result.data.status === 'canceled') return;
      if (result.data.status !== 'ready') throw new Error(result.data.message);
      const picked = result.data;
      const doc = new DOMParser().parseFromString(picked.text, 'application/xml');
      const names = Array.from(doc.getElementsByTagName('*')).filter(node => ['system', 'equipmentsystem', 'установка', 'unit'].includes((node.localName || node.tagName).toLocaleLowerCase().split(':').pop() || '')).flatMap(node => {
        const name = node.getAttribute('name') || node.getAttribute('код') || node.getAttribute('code');
        const tags = Array.from(node.getElementsByTagName('*')).filter(child => ['tag', 'тег'].includes((child.localName || child.tagName).toLocaleLowerCase().split(':').pop() || '')).map(child => child.textContent?.trim() || child.getAttribute('identifier') || '').filter(Boolean);
        return [name, ...tags].filter((value): value is string => !!value);
      });
      const uniqueNames = Array.from(new Set(names));
      clearReviewSelections();
      setXmlTagChoices(uniqueNames);
      setFile(picked); setTagIdentifier(uniqueNames.length === 1 ? uniqueNames[0] : ''); setRevision(picked.revision); setFolderName(picked.sourceFolder.relativePath);
    } catch (reason) { if (operation === operationRef.current) setError(toMessage(reason)); }
    finally { if (operation === operationRef.current) setBusy(false); }
  };

  const changeFolder = async () => {
    if (!canManage || !file) return;
    const operation = ++operationRef.current;
    setBusy(true); setError('');
    try {
      const picked = await pickEquipmentSourceFolder();
      if (operation !== operationRef.current) return;
      if ('error' in picked) throw new Error(picked.error.message);
      if (!picked.data) return;
      const sourceFile = file.selectedFile.ref;
      const folder = picked.data;
      const prefix = folder.relativePath ? `${folder.relativePath.replace(/\/$/u, '')}/` : '';
      if (sourceFile.rootId !== folder.rootId || !sourceFile.relativePath.startsWith(prefix)) throw new Error('Выбранный XML не находится внутри указанной папки.');
      if (!sourceFile.relativePath.slice(prefix.length).includes('/')) throw new Error('Папка источника должна содержать подпапки ревизий. Выберите родительскую папку XML.');
      setFile({ ...file, sourceFolder: folder }); setFolderName(folder.relativePath); setPlan(null);
    } catch (reason) { if (operation === operationRef.current) setError(toMessage(reason)); }
    finally { if (operation === operationRef.current) setBusy(false); }
  };

  const requestBody = () => {
    if (!file) throw new Error('Сначала выберите XML-файл.');
    const normalizedTag = tagIdentifier.trim();
    if (!normalizedTag) throw new Error('Укажите тег оборудования.');
    if (!revision.trim()) throw new Error('Укажите ревизию файла.');
    if (!category) throw new Error('Выберите категорию оборудования.');
    return { projectId, category, fileName: file.selectedFile.name, revision: revision.trim(), tagIdentifier: normalizedTag, sha256: file.sha256, size: file.size, base64: file.base64, choices };
  };

  const requestPlan = async () => {
    if (!canManage) return;
    const operation = ++operationRef.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const body = requestBody();
      const response = await fetch(api('/equipment/source-import/preview'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (operation !== operationRef.current) return;
      if (!response.ok || payload.success === false) throw new Error(payload.error || 'Не удалось подготовить предпросмотр импорта.');
      setPlan(payload as PlanDto);
    } catch (reason) { if (operation === operationRef.current) { setError(toMessage(reason)); setPlan(null); } }
    finally { if (operation === operationRef.current) setBusy(false); }
  };

  const applyImport = async () => {
    if (!canManage || !plan || !file) return;
    const operation = ++operationRef.current;
    const projectAtStart = projectId;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(api('/equipment/source-import/apply'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...requestBody(), previewToken: plan.previewToken, edits: {}, choices, tagLinks: applyTagLinks, conflictMode: 'wait' }) });
      const payload = await response.json().catch(() => ({}));
      if (operation !== operationRef.current || projectAtStart !== projectIdRef.current) return;
      if (!response.ok || payload.success === false) {
        if (response.status === 409) setPlan(null);
        throw new Error(payload.error || (response.status === 409 ? 'План устарел. Подготовьте его повторно перед подтверждением.' : 'Импорт не выполнен. Текущие данные оборудования сохранены.'));
      }
      const source = payload.source as ImportedSource;
      if (!source?.sourceId || !source.tagId || !source.systemId || !source.elementId) throw new Error('Импорт завершился, но сервер не вернул устойчивую привязку XML. Обновите список и проверьте карточку оборудования.');
      const selectedRule = inferEquipmentSourceFilenameRule(source.fileName || file.selectedFile.name, tagIdentifier);
      try {
        if (!selectedRule) throw new Error('Правило имени XML не определено.');
        const binding: LocalEquipmentSourceBinding = { sourceId: source.sourceId, projectId, tagId: source.tagId, systemId: source.systemId, elementId: source.elementId, targetType: 'system', tagIdentifier, rootId: file.sourceFolder.rootId, relativePath: file.sourceFolder.relativePath, selectedFileRef: file.selectedFile.ref, revisionOrder: source.revisionOrder || revisionOrder, selectedRule };
        saveEquipmentSourceBinding(binding);
        setNotice('Импорт выполнен, а локальная папка ревизий связана с этой установкой.');
      } catch (reason) {
        setNotice(`Оборудование импортировано. Локальную папку XML нужно перепривязать в карточке установки${reason instanceof Error ? `: ${reason.message}` : '.'}`);
      }
      onImported({ source, tagIdentifier, category, baselineApplied: payload.baselineApplied !== false });
    } catch (reason) { if (operation === operationRef.current && projectAtStart === projectIdRef.current) setError(toMessage(reason)); }
    finally { if (operation === operationRef.current && projectAtStart === projectIdRef.current) setBusy(false); }
  };

  const close = () => { if (!busy) onClose(); };
  const folderLabel = [rootName, folderName].filter(Boolean).join(' · ') || 'Выбранная папка';
  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/40 p-3" role="dialog" aria-modal="true" aria-labelledby="equipment-source-import-title">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-700 dark:bg-slate-950">
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800"><div><h2 id="equipment-source-import-title" className="text-sm font-semibold">Загрузить оборудование из XML</h2><p className="text-xs text-slate-500 dark:text-slate-400">Сначала проверьте план; данные проекта изменятся только после подтверждения.</p></div><button type="button" onClick={close} disabled={busy} aria-label="Закрыть" className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-900"><X className="h-4 w-4" /></button></header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {!canManage && <div className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Недостаточно прав для импорта оборудования.</div>}
          <div className="flex flex-wrap items-end gap-2">
            <button type="button" onClick={() => void chooseFile()} disabled={!canManage || busy} className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-3 py-2 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900"><Upload className="h-3.5 w-3.5" />{file ? 'Выбрать другой XML' : 'Выбрать XML-файл'}</button>
            <label className="min-w-[190px] flex-1 text-xs text-slate-600 dark:text-slate-300">Категория оборудования<select value={category} onChange={event => { operationRef.current += 1; setBusy(false); setCategory(event.target.value); setPlan(null); clearReviewSelections(); }} disabled={busy || !canManage} className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-2 dark:border-slate-700 dark:bg-slate-900">{categories.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          </div>
          {file && <div className="rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="min-w-0 text-xs text-slate-600 dark:text-slate-300">Тег оборудования{xmlTagChoices.length > 1 ? <select value={tagIdentifier} onChange={event => { operationRef.current += 1; setBusy(false); setTagIdentifier(event.target.value); setPlan(null); clearReviewSelections(); }} disabled={busy || !canManage} className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-2 dark:border-slate-700 dark:bg-slate-950"><option value="">Выберите корневой тег из XML</option>{xmlTagChoices.map(value => <option key={value} value={value}>{value}</option>)}</select> : <input value={tagIdentifier} onChange={event => { operationRef.current += 1; setBusy(false); setTagIdentifier(event.target.value); setPlan(null); clearReviewSelections(); }} disabled={busy || !canManage} placeholder="Тег из имени установки в XML" className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-2 dark:border-slate-700 dark:bg-slate-950" />}</label>
              <label className="text-xs text-slate-600 dark:text-slate-300">Ревизия<input value={revision} onChange={event => { operationRef.current += 1; setBusy(false); setRevision(event.target.value); setPlan(null); clearReviewSelections(); }} disabled={busy || !canManage} className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-2 dark:border-slate-700 dark:bg-slate-950" /></label>
              <div className="min-w-0 text-xs sm:col-span-2"><span className="text-slate-500 dark:text-slate-400">Файл: </span><span className="break-all">{file.selectedFile.name}</span></div>
              <div className="min-w-0 break-all text-xs sm:col-span-2"><span className="text-slate-500 dark:text-slate-400">Папка ревизий: </span>{folderLabel}</div>
            </div>
            {file.revisionWarning && <p className="mt-2 text-xs text-amber-800 dark:text-amber-300" role="status">{file.revisionWarning}</p>}
            <button type="button" onClick={() => void changeFolder()} disabled={busy || !canManage} className="mt-2 inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"><FolderOpen className="h-3.5 w-3.5" />Исправить папку источника</button>
          </div>}
          {error && <div role="alert" className="flex gap-2 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}
          {notice && <div role="status" className="rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">{notice}</div>}
          {plan && <section className="space-y-2 rounded border border-slate-200 p-3 dark:border-slate-800" aria-label="План импорта">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Предпросмотр · {plan.fileName} · ревизия {plan.revision}</h3><span className="text-xs text-slate-500 dark:text-slate-400">Тег: {plan.unitTag?.identifier || tagIdentifier}</span></div>
            <p className="text-xs text-slate-600 dark:text-slate-300">Систем: {planTotals.systems ?? units.length} · новых позиций: {planTotals.newBlocks ?? 0} · обновлений: {planTotals.updatedBlocks ?? 0} · без изменений: {planTotals.unchangedBlocks ?? 0}</p>
            {!!planTotals.overrides && <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Есть {planTotals.overrides} ручных значений. Импорт ждёт отдельного разрешения конфликта и не заменяет их автоматически.</p>}
            {!!unknownKinds.length && <div className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200"><strong>В XML есть нераспознанные виды данных:</strong> {unknownKinds.join(', ')}. Импорт остановлен, чтобы не пропустить эти позиции. Исправьте типы в шаблоне импорта и повторите проверку.</div>}
            {warnings.map((warning: any, index: number) => <p key={index} className="text-xs text-amber-800 dark:text-amber-300">{typeof warning === 'string' ? warning : warning?.message || JSON.stringify(warning)}</p>)}
            {(plan.plan?.systemRows || []).map((row: any) => <label key={row.key} className="block rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{row.why || `Выберите установку для ${row.name}`}<select value={choices[row.key] || ''} onChange={event => setChoices(current => ({ ...current, [row.key]: event.target.value }))} className="mt-1 w-full rounded border border-amber-400 bg-white px-2 py-1 text-slate-900 dark:border-amber-800 dark:bg-slate-950 dark:text-slate-100"><option value="">Требуется выбор</option>{(row.options || []).map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}
            {(plan.plan?.matches || []).map((row: any) => <label key={row.key} className="block rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{row.title} · {row.at}<div className="mt-1 text-amber-800 dark:text-amber-300">{row.why}</div><select value={choices[row.key] || ''} onChange={event => setChoices(current => ({ ...current, [row.key]: event.target.value }))} className="mt-1 w-full rounded border border-amber-400 bg-white px-2 py-1 text-slate-900 dark:border-amber-800 dark:bg-slate-950 dark:text-slate-100"><option value="">Требуется выбор</option>{(row.options || []).map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}
            {(plan.plan?.tagLinks || []).map((link: any) => { const key = `${link.blockKey}\u0000${link.identifier}`; const initial = link.action === 'link' && link.existingTagId ? `link:${link.existingTagId}` : ['ambiguous', 'invalid'].includes(link.action) ? '' : link.action; return <label key={`${link.blockKey}:${link.identifier}`} className={`block rounded border p-2 text-xs ${['ambiguous', 'invalid'].includes(link.action) ? 'border-rose-300 bg-rose-50 text-rose-950 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200' : 'border-slate-200 text-slate-700 dark:border-slate-800 dark:text-slate-300'}`}>Тег «{link.identifier}» · {String(link.blockKey).split('‖')[1] || 'Установка'}{link.problem ? ` · ${link.problem}` : ''}<select value={tagLinkChoices[key] ?? initial} onChange={event => setTagLinkChoices(current => ({ ...current, [key]: event.target.value }))} className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"><option value="">Выберите действие</option>{link.existingTagId && <option value={`link:${link.existingTagId}`}>Связать с точным тегом проекта</option>}{(link.candidates || []).map((candidate: any) => <option key={candidate.id} value={`link:${candidate.id}`}>Связать с {candidate.identifier}</option>)}<option value="create">Создать новый тег</option><option value="skip">Пропустить тег</option></select></label>; })}
            <div className="max-h-72 space-y-1 overflow-y-auto rounded border border-slate-100 dark:border-slate-800">
              {units.map((unit: any, index: number) => <div key={`${unit.name || unit.title}:${index}`} className="px-2 py-1.5 text-xs"><span className="font-medium">{unit.name || unit.title || `Установка ${index + 1}`}</span><span className="ml-2 text-slate-500 dark:text-slate-400">{unit.action === 'match' ? `обновится${unit.matchedName ? ` · ${unit.matchedName}` : ''}` : 'будет создана'}</span></div>)}
              {blocks.map((block: any, index: number) => <div key={`${block.key || block.itemCode}:${index}`} className="border-t border-slate-100 px-2 py-1.5 text-xs dark:border-slate-800"><div className="flex flex-wrap justify-between gap-1"><span className="font-medium">{block.title || block.itemCode || 'Позиция'} · {block.equipType || 'Оборудование'}</span><span className="text-slate-500 dark:text-slate-400">{block.action === 'create' ? 'новая' : block.action === 'update' ? 'изменится' : 'без изменений'} · {block.changedCount || 0} отличий · {block.overrideImpact || 0} ручных значений</span></div>{Array.isArray(block.params) && <div className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-2">{block.params.filter((param: any) => param.status !== 'same').map((param: any, paramIndex: number) => <div key={`${param.group}:${param.key}:${paramIndex}`} className="break-words text-slate-600 dark:text-slate-300">{param.group ? `${param.group} · ` : ''}{param.key}: {param.oldValue ?? '—'} → {param.value}{param.unit ? ` ${param.unit}` : ''}</div>)}</div>}</div>)}
              {!units.length && !blocks.length && <div className="p-2 text-xs text-slate-500 dark:text-slate-400">Сервер не вернул позиции для показа. Импорт заблокирован до корректного плана.</div>}
            </div>
            {plan.plan?.missing?.length > 0 && <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"><strong>Позиции проекта, которых нет в XML ({plan.plan.missing.length}):</strong><p>Оставить без изменений — действие по умолчанию. Снятие требует явного выбора.</p>{plan.plan.missing.map((item: any) => <label key={item.key} className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-amber-200 pt-1 dark:border-amber-900"><span>{item.title || item.name || item.label || item.id} · {item.at || item.systemName}</span><select value={choices[item.key] || 'keep'} onChange={event => setChoices(current => ({ ...current, [item.key]: event.target.value }))} className="rounded border border-amber-400 bg-white px-2 py-1 text-slate-900 dark:border-amber-800 dark:bg-slate-950 dark:text-slate-100"><option value="keep">Оставить</option><option value="remove">Снять эту позицию</option></select></label>)}</div>}
          </section>}
        </div>
        <footer className="flex flex-wrap justify-between gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          <button type="button" onClick={close} disabled={busy} className="rounded border border-slate-300 px-3 py-2 text-xs dark:border-slate-700">Закрыть</button>
          <div className="flex flex-wrap gap-2">{file && <button type="button" onClick={() => void requestPlan()} disabled={!canManage || busy || !category || !tagIdentifier.trim()} className="rounded border border-slate-300 px-3 py-2 text-xs disabled:opacity-50 dark:border-slate-700">{busy && !plan ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" /> : null}Показать план</button>}{plan && <button type="button" onClick={() => void applyImport()} disabled={!canManage || busy || !safeToApply || !units.length && !blocks.length || applyTagLinks.some((link: any) => ['ambiguous', 'invalid'].includes(link.action))} title={!safeToApply ? 'Сначала разрешите все спорные сопоставления и теги.' : undefined} className="inline-flex items-center gap-1 rounded bg-emerald-700 px-3 py-2 text-xs text-white disabled:opacity-50"><Check className="h-3.5 w-3.5" />Подтвердить импорт</button>}</div>
        </footer>
      </div>
    </div>
  );
}
