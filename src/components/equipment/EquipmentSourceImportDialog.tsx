import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, FolderOpen, Loader2, Upload, X } from 'lucide-react';
import { expandEquipmentUnitGroup, inferEquipmentSourceFilenameRule } from '../../../equipment/sourceXml';
import { autoFixTag, PERMISSIVE_TAG_POLICY } from '../../../equipment/tagPolicy';
import {
  extractEquipmentXmlUnitTags, extractRevisionFromXml, pickEquipmentSourceForImport, saveEquipmentSourceBinding,
  type EquipmentSourceImportPreview, type LocalEquipmentSourceBinding,
} from '../../lib/equipmentSourcesLocal';
import { windowsFilesRequest, type WindowsFileRef } from '../../lib/windowsFiles';
import ImportFileChooser, { type ImportFileChooserHandle } from '../ImportFileChooser';
import UnknownKinds from '../import/UnknownKinds';
import type { PortableFolderLocator } from '../../../filesystem/contracts';
import { loadEquipmentDocumentBindings } from '../../lib/equipmentDocumentBindings';

type Category = { id: string; label: string };
type ImportedSource = { sourceId: string; tagId: string; targetType: 'system'; systemId: string; elementId: string; revision: string; sha256: string; fileName: string; revisionOrder?: string[]; unitTag?: { identifier: string } };
type PlanDto = { success: true; fileName: string; sha256: string; revision: string; previewToken?: string; unitTag: { identifier: string; existingTagId?: string; action?: string }; plan: any };
const api = (path: string) => `/api${path}`;
const revisionOrder = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const toMessage = (error: unknown) => error instanceof Error ? error.message : 'Не удалось обработать XML-файл.';

/**
 * Снимок XML для плана. Ссылка на файл и папка есть только у файла из
 * Проводника Windows: без них импорт идёт так же, просто без локальной
 * привязки папки ревизий.
 */
type SourceFile = Omit<Extract<EquipmentSourceImportPreview, { status: 'ready' }>, 'selectedFile' | 'sourceFolder' | 'modifiedAt'> & {
  selectedFile: { ref?: WindowsFileRef; name: string }; sourceFolder?: WindowsFileRef;
};

/** XML, уже прочитанный мастером импорта: план строится из этих байтов, повторный выбор файла не нужен. */
export type InlineXmlSource = {
  name: string; base64: string; sha256: string; size: number; text: string;
  fileRef?: WindowsFileRef; sourceFolder?: WindowsFileRef; suggestedTag?: string; portableLocator?: PortableFolderLocator;
};

function inlineRevision(source: InlineXmlSource): { revision: string; revisionWarning?: string } {
  const xmlRevision = extractRevisionFromXml(source.text) || '';
  const base = source.sourceFolder?.relativePath ? `${source.sourceFolder.relativePath.replace(/\/$/u, '')}/` : '';
  const path = source.fileRef?.relativePath || '';
  const rest = base && path.startsWith(base) ? path.slice(base.length).split('/') : [];
  const folderRevision = rest.length > 1 ? rest[0] : '';
  const differs = xmlRevision && folderRevision && xmlRevision.trim().toUpperCase() !== folderRevision.trim().toUpperCase();
  return { revision: xmlRevision || folderRevision || 'A', ...(differs ? { revisionWarning: `В XML указана ревизия ${xmlRevision}, а имя папки — ${folderRevision}; используется ревизия из XML.` } : {}) };
}

/** Первичный XML импорт: неизменяемый снимок → серверный план → явное применение. */
export default function EquipmentSourceImportDialog(props: { projectId: string; categories: Category[]; canManage: boolean; onClose: () => void; onImported: (result: { source: ImportedSource; tagIdentifier: string; category: string; baselineApplied: boolean; bindingId?: string }) => void | Promise<void>; embedded?: boolean; initialCategory?: string; initialUnits?: Array<{ name: string; title?: string; tags?: string[] }>; inlineSource?: InlineXmlSource; category?: string; expectedLedgerRevision?: number; onAllImported?: () => void }) {
  const filePicker = useRef<ImportFileChooserHandle>(null);
  const folderPicker = useRef<ImportFileChooserHandle>(null);
  const { projectId, categories, canManage, onClose, onImported, onAllImported, embedded = false, initialCategory, initialUnits, inlineSource, expectedLedgerRevision } = props;
  // Встроенный в мастер импорта вид: категорию выбирают в шапке мастера.
  const inline = Boolean(inlineSource);
  const [category, setCategory] = useState(props.category || initialCategory || categories[0]?.id || '');
  const [file, setFile] = useState<SourceFile | null>(null);
  const [tagIdentifier, setTagIdentifier] = useState('');
  const [xmlTagChoices, setXmlTagChoices] = useState<string[]>([]);
  const [revision, setRevision] = useState('');
  const [folderName, setFolderName] = useState('');
  const [rootName, setRootName] = useState('');
  const [sourceLocator, setSourceLocator] = useState<PortableFolderLocator | undefined>();
  const [ledgerRevision, setLedgerRevision] = useState(expectedLedgerRevision);
  const [plan, setPlan] = useState<PlanDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [tagLinkChoices, setTagLinkChoices] = useState<Record<string, string>>({});
  // Один XML может описывать несколько одинаковых установок (001ABC → 001A, 001B, 001C):
  // каждая отмеченная получает свою запись и свою привязку к этому же файлу.
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [doneTags, setDoneTags] = useState<string[]>([]);
  const chainRef = useRef(false);
  const operationRef = useRef(0);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const previousProjectRef = useRef(projectId);
  useEffect(() => setLedgerRevision(expectedLedgerRevision), [expectedLedgerRevision]);
  const clearReviewSelections = () => { setChoices({}); setTagLinkChoices({}); };

  useEffect(() => {
    if (!inlineSource) return;
    operationRef.current += 1;
    const { revision: inferred, revisionWarning } = inlineRevision(inlineSource);
    const picked: SourceFile = {
      status: 'ready', selectedFile: { ...(inlineSource.fileRef ? { ref: inlineSource.fileRef } : {}), name: inlineSource.name },
      ...(inlineSource.sourceFolder ? { sourceFolder: inlineSource.sourceFolder } : {}),
      revision: inferred, ...(revisionWarning ? { revisionWarning } : {}),
      sha256: inlineSource.sha256, size: inlineSource.size, base64: inlineSource.base64, text: inlineSource.text,
    };
    setSourceLocator(inlineSource.portableLocator);
    acceptFile(picked, inlineSource.suggestedTag, true);
    // Источник разбирается один раз на файл очереди.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineSource?.sha256, inlineSource?.name]);

  // Категорию встроенного вида задаёт мастер; смена категории меняет план.
  useEffect(() => {
    if (!inline || !props.category || props.category === category) return;
    operationRef.current += 1;
    setBusy(false); setCategory(props.category); setPlan(null); clearReviewSelections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.category]);

  // Встроенный вид сразу показывает план: тег, ревизия и категория уже известны.
  const [autoPlan, setAutoPlan] = useState(0);
  useEffect(() => {
    if (!inline || !autoPlan || !file || !category || !tagIdentifier.trim() || plan) return;
    void requestPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlan, category]);

  useEffect(() => {
    const projectChanged = previousProjectRef.current !== projectId;
    previousProjectRef.current = projectId;
    if (!projectChanged) return;
    operationRef.current += 1;
    setPlan(null); setBusy(false); setError('');
    setFile(null); setTagIdentifier(''); setRevision(''); setXmlTagChoices([]); clearReviewSelections();
  }, [projectId]);

  useEffect(() => {
    if (!file?.sourceFolder) return;
    const rootId = file.sourceFolder.rootId;
    void windowsFilesRequest<{ roots: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }> >({ action: 'roots' }).then(response => {
      if ('data' in response) {
        const roots = Array.isArray(response.data) ? response.data : response.data.roots;
        setRootName(roots.find(root => root.id === rootId)?.name || '');
      }
    }).catch(() => undefined);
  }, [file?.sourceFolder?.rootId]);

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

  /** Тег и ревизия по снимку XML; `fromQueue` — файл пришёл из очереди мастера с уже разобранными установками. */
  const acceptFile = (picked: SourceFile, suggested: string | undefined, fromQueue: boolean) => {
    const extracted = extractEquipmentXmlUnitTags(picked.text);
    const normalize = (value: unknown) => { const text = String(value || '').trim(); return autoFixTag(text, PERMISSIVE_TAG_POLICY)?.identifier || text; };
    const primaryUnitNames = fromQueue && initialUnits?.length ? initialUnits.map(unit => normalize(unit.name)).filter(Boolean) : [];
    const fromInitialUnits = fromQueue && initialUnits?.length ? initialUnits.flatMap(unit => [unit.name, ...(unit.tags || [])]).map(normalize).filter(Boolean) : [];
    const rawNames = Array.from(new Set(primaryUnitNames.length === 1 ? primaryUnitNames : [...fromInitialUnits, ...extracted]));
    const groups = rawNames.map(name => ({ name, members: expandEquipmentUnitGroup(name) }));
    const groupMembers = groups.flatMap(group => group.members);
    const uniqueNames = Array.from(new Set(groups.flatMap(group => group.members.length ? group.members : [group.name])));
    clearReviewSelections(); setPlan(null); setError(''); setNotice(''); setDoneTags([]); chainRef.current = false;
    setXmlTagChoices(uniqueNames);
    const suggestedTag = suggested && (!uniqueNames.length || uniqueNames.includes(suggested)) ? suggested : '';
    const firstTag = suggestedTag || uniqueNames[0] || '';
    setSelectedTags(groupMembers.length ? groupMembers : firstTag ? [firstTag] : []);
    setFile(picked); setTagIdentifier(groupMembers.length && !suggestedTag ? groupMembers[0] : firstTag); setRevision(picked.revision); setFolderName(picked.sourceFolder?.relativePath || '');
    if (fromQueue) setAutoPlan(value => value + 1);
  };

  // Следующая установка группы: план без спорных мест подтверждается сам, спорный ждёт инженера.
  useEffect(() => {
    if (!chainRef.current || !plan || busy) return;
    if (safeToApply && (units.length || blocks.length) && !applyTagLinks.some((link: any) => ['ambiguous', 'invalid'].includes(link.action))) { void applyImport(); return; }
    chainRef.current = false;
    setNotice(`Проверьте план для ${tagIdentifier} и подтвердите импорт.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  const toggleTag = (tag: string) => {
    const next = selectedTags.includes(tag) ? selectedTags.filter(item => item !== tag) : xmlTagChoices.filter(item => item === tag || selectedTags.includes(item));
    setSelectedTags(next);
    const current = next.find(item => !doneTags.includes(item)) || '';
    if (current === tagIdentifier) return;
    operationRef.current += 1; setBusy(false); chainRef.current = false;
    setTagIdentifier(current); setPlan(null); clearReviewSelections();
    if (current && inline) setAutoPlan(value => value + 1);
  };

  const chooseFile = async (selected?: { ref: WindowsFileRef; name: string; sourceFolder?: WindowsFileRef; suggestedTag?: string; portableLocator?: PortableFolderLocator }) => {
    if (!canManage) return;
    if (!selected) { filePicker.current?.open(); return; }
    const operation = ++operationRef.current;
    setBusy(true); setError(''); setNotice(''); setPlan(null);
    try {
      const result = await pickEquipmentSourceForImport(windowsFilesRequest, selected);
      if (operation !== operationRef.current) return;
      if ('error' in result) throw new Error(result.error.message);
      if (result.data.status === 'canceled') return;
      if (result.data.status !== 'ready') throw new Error(result.data.message);
      setSourceLocator(selected.portableLocator);
      acceptFile(result.data, result.data.suggestedTag, false);
    } catch (reason) { if (operation === operationRef.current) setError(toMessage(reason)); }
    finally { if (operation === operationRef.current) setBusy(false); }
  };

  const changeFolder = async (selectedFolder?: import('../../lib/windowsFiles').WindowsFileRef) => {
    if (!canManage || !file) return;
    if (!selectedFolder) { folderPicker.current?.open(); return; }
    if (!file.selectedFile.ref) { setError('Файл загружен не из Проводника Windows: папку ревизий можно связать позже в карточке установки.'); return; }
    const operation = ++operationRef.current;
    setBusy(true); setError('');
    try {
      if (operation !== operationRef.current) return;
      const sourceFile = file.selectedFile.ref;
      const folder = selectedFolder;
      if (!sourceFile) return;
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
    return { projectId, category, fileName: file.selectedFile.name, revision: revision.trim(), tagIdentifier: normalizedTag, sha256: file.sha256, size: file.size, base64: file.base64, choices,
      ...(file.sourceFolder && sourceLocator ? { locator: sourceLocator } : {}),
      ...(Number.isSafeInteger(ledgerRevision) ? { expectedLedgerRevision: ledgerRevision } : {}) };
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
        if (response.status === 409) {
          setPlan(null);
          try { setLedgerRevision((await loadEquipmentDocumentBindings(projectId)).revision); }
          catch (_) { /* Конфликт остаётся видимым; план нужно построить повторно. */ }
        }
        throw new Error(payload.error || (response.status === 409 ? 'План устарел. Подготовьте его повторно перед подтверждением.' : 'Импорт не выполнен. Текущие данные оборудования сохранены.'));
      }
      const source = payload.source as ImportedSource;
      if (!source?.sourceId || !source.tagId || !source.systemId || !source.elementId) throw new Error('Импорт завершился, но сервер не вернул устойчивую привязку XML. Обновите список и проверьте карточку оборудования.');
      const ruleFileName = source.fileName || file.selectedFile.name;
      const selectedRule = inferEquipmentSourceFilenameRule(ruleFileName, tagIdentifier) || (/\.xml$/iu.test(ruleFileName) ? { kind: 'selected-name' as const, fileName: ruleFileName } : null);
      try {
        if (!selectedRule) throw new Error('Правило имени XML не определено.');
        if (!file.selectedFile.ref || !file.sourceFolder) throw new Error('файл выбран не из Проводника Windows');
        const binding: LocalEquipmentSourceBinding = { sourceId: source.sourceId, projectId, tagId: source.tagId, systemId: source.systemId, elementId: source.elementId, targetType: 'system', tagIdentifier, rootId: file.sourceFolder.rootId, relativePath: file.sourceFolder.relativePath, selectedFileRef: file.selectedFile.ref, revisionOrder: source.revisionOrder || revisionOrder, selectedRule };
        saveEquipmentSourceBinding(binding);
        setNotice('Импорт выполнен, а локальная папка ревизий связана с этой установкой.');
      } catch (reason) {
        setNotice(`Оборудование импортировано. Локальную папку XML нужно перепривязать в карточке установки${reason instanceof Error ? `: ${reason.message}` : '.'}`);
      }
      await onImported({ source, tagIdentifier, category, baselineApplied: payload.baselineApplied !== false, bindingId: payload.associations?.bindingId || payload.bindingId || source.sourceId });
      const done = [...doneTags, tagIdentifier];
      setDoneTags(done);
      const next = selectedTags.find(tag => !done.includes(tag));
      if (!next) { chainRef.current = false; onAllImported?.(); return; }
      // Каждая запись меняет журнал привязок: следующую установку планируем от свежей ревизии.
      try { setLedgerRevision((await loadEquipmentDocumentBindings(projectId)).revision); } catch (_) { /* Сервер вернёт 409, и план перестроится. */ }
      if (operation !== operationRef.current) return;
      chainRef.current = true;
      setTagIdentifier(next); setPlan(null); clearReviewSelections(); setAutoPlan(value => value + 1);
    } catch (reason) { if (operation === operationRef.current && projectAtStart === projectIdRef.current) setError(toMessage(reason)); }
    finally { if (operation === operationRef.current && projectAtStart === projectIdRef.current) setBusy(false); }
  };

  const close = () => { if (!busy) onClose(); };
  const folderLabel = [rootName, folderName].filter(Boolean).join(' · ') || (file?.sourceFolder ? 'Выбранная папка' : 'не связана (файл загружен с диска)');
  return (
    <>
    <ImportFileChooser ref={filePicker} accept=".xml" label="Выбрать XML" trigger={() => null} onFiles={() => {}} onWindowsFile={(ref, entry, context) => { void chooseFile({ ref, name: entry.name, ...context }); }} />
    <ImportFileChooser ref={folderPicker} selectFolder label="Выбрать папку XML" trigger={() => null} onFiles={() => {}} onWindowsFolder={ref => { void changeFolder(ref); }} />
    <div className={inline ? 'flex flex-col rounded-xl border border-slate-200 dark:border-slate-800' : embedded ? 'flex h-full min-h-0 flex-col overflow-hidden' : 'fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/40 p-3'} role={inline ? 'region' : 'dialog'} aria-modal={embedded || inline ? undefined : true} aria-labelledby="equipment-source-import-title">
      <div className={inline ? 'flex w-full flex-col' : embedded ? 'flex h-full min-h-0 w-full flex-col overflow-hidden' : 'flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-700 dark:bg-slate-950'}>
        {inline ? <header className="border-b border-slate-200 px-3 py-2 dark:border-slate-800"><h3 id="equipment-source-import-title" className="text-sm font-semibold">Загрузка установки из XML</h3><p className="text-xs text-slate-500 dark:text-slate-400">План строится по этому файлу; данные проекта изменятся только после подтверждения.</p></header> : <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800"><div><h2 id="equipment-source-import-title" className="text-sm font-semibold">Загрузить оборудование из XML</h2><p className="text-xs text-slate-500 dark:text-slate-400">Сначала проверьте план; данные проекта изменятся только после подтверждения.</p></div><button type="button" onClick={close} disabled={busy} aria-label="Закрыть" className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-900"><X className="h-4 w-4" /></button></header>}
        <div className={inline ? 'space-y-3 p-3' : 'min-h-0 flex-1 space-y-3 overflow-y-auto p-4'}>
          {!canManage && <div className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Недостаточно прав для импорта оборудования.</div>}
          {!inline && <div className="flex flex-wrap items-end gap-2">
            <button type="button" onClick={() => void chooseFile()} disabled={!canManage || busy} className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-3 py-2 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900"><Upload className="h-3.5 w-3.5" />{file ? 'Выбрать другой XML' : 'Выбрать XML-файл'}</button>
            <label className="min-w-[190px] flex-1 text-xs text-slate-600 dark:text-slate-300">Категория оборудования<select value={category} onChange={event => { operationRef.current += 1; setBusy(false); setCategory(event.target.value); setPlan(null); clearReviewSelections(); }} disabled={busy || !canManage} className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-2 dark:border-slate-700 dark:bg-slate-900">{categories.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          </div>}
          {file && <div className="rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
            <div className="grid gap-2 sm:grid-cols-2">
              {xmlTagChoices.length > 1 ? <fieldset className="min-w-0 text-xs text-slate-600 dark:text-slate-300"><legend>Установки из этого файла</legend><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{xmlTagChoices.map(value => <label key={value} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={selectedTags.includes(value)} onChange={() => toggleTag(value)} disabled={busy || !canManage || doneTags.includes(value)} /><span className={value === tagIdentifier ? 'font-semibold text-slate-900 dark:text-white' : ''}>{value}</span>{doneTags.includes(value) && <Check className="h-3 w-3 text-emerald-600" aria-label="импортирована" />}</label>)}</div>{selectedTags.length > 1 && <p className="mt-1 text-slate-500 dark:text-slate-400">План ниже — для {tagIdentifier || '—'}; остальные отмеченные установки загрузятся следом из этого же файла.</p>}</fieldset> : <label className="min-w-0 text-xs text-slate-600 dark:text-slate-300">Тег оборудования<input value={tagIdentifier} onChange={event => { operationRef.current += 1; setBusy(false); setTagIdentifier(event.target.value); setSelectedTags(event.target.value.trim() ? [event.target.value] : []); setPlan(null); clearReviewSelections(); }} disabled={busy || !canManage} placeholder="Тег из имени установки в XML" className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-2 dark:border-slate-700 dark:bg-slate-950" /></label>}
              <label className="text-xs text-slate-600 dark:text-slate-300">Ревизия<input value={revision} onChange={event => { operationRef.current += 1; setBusy(false); setRevision(event.target.value); setPlan(null); clearReviewSelections(); }} disabled={busy || !canManage} className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-2 dark:border-slate-700 dark:bg-slate-950" /></label>
              <div className="min-w-0 text-xs sm:col-span-2"><span className="text-slate-500 dark:text-slate-400">Файл: </span><span className="break-all">{file.selectedFile.name}</span></div>
              <div className="min-w-0 break-all text-xs sm:col-span-2"><span className="text-slate-500 dark:text-slate-400">Папка источника: </span>{folderLabel}</div>
            </div>
            {file.revisionWarning && <p className="mt-2 text-xs text-amber-800 dark:text-amber-300" role="status">{file.revisionWarning}</p>}
            {!inline && <button type="button" onClick={() => void changeFolder()} disabled={busy || !canManage} className="mt-2 inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"><FolderOpen className="h-3.5 w-3.5" />Исправить папку источника</button>}
          </div>}
          {error && <div role="alert" className="flex gap-2 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}
          {notice && <div role="status" className="rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">{notice}</div>}
          {plan && <section className="space-y-2 rounded border border-slate-200 p-3 dark:border-slate-800" aria-label="План импорта">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Предпросмотр · {plan.fileName} · ревизия {plan.revision}</h3><span className="text-xs text-slate-500 dark:text-slate-400">Тег: {plan.unitTag?.identifier || tagIdentifier}</span></div>
            <p className="text-xs text-slate-600 dark:text-slate-300">Систем: {planTotals.systems ?? units.length} · новых позиций: {planTotals.newBlocks ?? 0} · обновлений: {planTotals.updatedBlocks ?? 0} · без изменений: {planTotals.unchangedBlocks ?? 0}</p>
            {!!planTotals.overrides && <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Есть {planTotals.overrides} ручных значений. Импорт ждёт отдельного разрешения конфликта и не заменяет их автоматически.</p>}
            {!!unknownKinds.length && <div className="space-y-2"><div className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200"><strong>В XML есть нераспознанные виды данных:</strong> {unknownKinds.join(', ')}. Импорт остановлен, чтобы не пропустить эти позиции. Укажите их роли ниже и повторите проверку.</div><UnknownKinds kinds={unknownKinds} onSaved={() => void requestPlan()} /></div>}
            {warnings.map((warning: any, index: number) => <p key={index} className="text-xs text-amber-800 dark:text-amber-300">{typeof warning === 'string' ? warning : warning?.message || JSON.stringify(warning)}</p>)}
            {(plan.plan?.systemRows || []).map((row: any) => <label key={row.key} className="block rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{row.why || `Выберите установку для ${row.name}`}<select value={choices[row.key] || ''} onChange={event => setChoices(current => ({ ...current, [row.key]: event.target.value }))} className="mt-1 w-full rounded border border-amber-400 bg-white px-2 py-1 text-slate-900 dark:border-amber-800 dark:bg-slate-950 dark:text-slate-100"><option value="">Требуется выбор</option>{(row.options || []).map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}
            {(plan.plan?.matches || []).map((row: any) => <label key={row.key} className="block rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{row.title} · {row.at}<div className="mt-1 text-amber-800 dark:text-amber-300">{row.why}</div><select value={choices[row.key] || ''} onChange={event => setChoices(current => ({ ...current, [row.key]: event.target.value }))} className="mt-1 w-full rounded border border-amber-400 bg-white px-2 py-1 text-slate-900 dark:border-amber-800 dark:bg-slate-950 dark:text-slate-100"><option value="">Требуется выбор</option>{(row.options || []).map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}
            {(plan.plan?.tagLinks || []).map((link: any) => { const key = `${link.blockKey}\u0000${link.identifier}`; const initial = link.action === 'link' && link.existingTagId ? `link:${link.existingTagId}` : ['ambiguous', 'invalid'].includes(link.action) ? '' : link.action; return <label key={`${link.blockKey}:${link.identifier}`} className={`block rounded border p-2 text-xs ${['ambiguous', 'invalid'].includes(link.action) ? 'border-rose-300 bg-rose-50 text-rose-950 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200' : 'border-slate-200 text-slate-700 dark:border-slate-800 dark:text-slate-300'}`}>Тег «{link.identifier}» · {String(link.blockKey).split('‖')[1] || 'Установка'}{link.problem ? ` · ${link.problem}` : ''}<select value={tagLinkChoices[key] ?? initial} onChange={event => setTagLinkChoices(current => ({ ...current, [key]: event.target.value }))} className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"><option value="">Выберите действие</option>{link.existingTagId && <option value={`link:${link.existingTagId}`}>Связать с точным тегом проекта</option>}{(link.candidates || []).map((candidate: any) => <option key={candidate.id} value={`link:${candidate.id}`}>Связать с {candidate.identifier}</option>)}<option value="create">Создать новый тег</option><option value="skip">Пропустить тег</option></select></label>; })}
            <div className="max-h-72 space-y-1 overflow-y-auto rounded border border-slate-100 dark:border-slate-800">
              {units.map((unit: any, index: number) => <div key={`${unit.name || unit.title}:${index}`} className="px-2 py-1.5 text-xs"><span className="font-medium">{unit.name || unit.title || `Установка ${index + 1}`}</span><span className="ml-2 text-slate-500 dark:text-slate-400">{unit.action === 'match' ? `обновится${unit.matchedName ? ` · ${unit.matchedName}` : ''}` : 'будет создана'}</span></div>)}
              {blocks.map((block: any, index: number) => <div key={`${block.key || block.itemCode}:${index}`} className="border-t border-slate-100 px-2 py-1.5 text-xs dark:border-slate-800"><div className="flex flex-wrap justify-between gap-1"><span className="font-medium">{block.title || block.itemCode || 'Позиция'} · {block.equipType || 'Оборудование'}</span><span className="text-slate-500 dark:text-slate-400">{block.action === 'create' ? 'новая' : block.action === 'update' ? 'изменится' : 'без изменений'} · {block.changedCount || 0} отличий · {block.overrideImpact || 0} ручных значений</span></div>{Array.isArray(block.params) && <div className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-2">{block.params.filter((param: any) => param.status !== 'same').map((param: any, paramIndex: number) => <div key={`${param.group}:${param.key}:${paramIndex}`} className="break-words text-slate-600 dark:text-slate-300">{param.group ? `${param.group} · ` : ''}{param.key}: {param.oldValue ?? '—'} → {param.value}{param.unit ? ` ${param.unit}` : ''}{param.warning && <span className="ml-1 text-amber-700 dark:text-amber-300">· {param.warning}</span>}</div>)}</div>}</div>)}
              {!units.length && !blocks.length && <div className="p-2 text-xs text-slate-500 dark:text-slate-400">Сервер не вернул позиции для показа. Импорт заблокирован до корректного плана.</div>}
            </div>
            {plan.plan?.missing?.length > 0 && <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"><strong>Позиции проекта, которых нет в XML ({plan.plan.missing.length}):</strong><p>Оставить без изменений — действие по умолчанию. Снятие требует явного выбора.</p>{plan.plan.missing.map((item: any) => <label key={item.key} className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-amber-200 pt-1 dark:border-amber-900"><span>{item.title || item.name || item.label || item.id} · {item.at || item.systemName}</span><select value={choices[item.key] || 'keep'} onChange={event => setChoices(current => ({ ...current, [item.key]: event.target.value }))} className="rounded border border-amber-400 bg-white px-2 py-1 text-slate-900 dark:border-amber-800 dark:bg-slate-950 dark:text-slate-100"><option value="keep">Оставить</option><option value="remove">Снять эту позицию</option></select></label>)}</div>}
          </section>}
        </div>
        <footer className="flex flex-wrap justify-between gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          {inline ? <span /> : <button type="button" onClick={close} disabled={busy} className="rounded border border-slate-300 px-3 py-2 text-xs dark:border-slate-700">Закрыть</button>}
          <div className="flex flex-wrap gap-2">{file && <button type="button" onClick={() => void requestPlan()} disabled={!canManage || busy || !category || !tagIdentifier.trim()} className="rounded border border-slate-300 px-3 py-2 text-xs disabled:opacity-50 dark:border-slate-700">{busy && !plan ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" /> : null}{inline && plan ? 'Обновить план' : 'Показать план'}</button>}{plan && <button type="button" onClick={() => void applyImport()} disabled={!canManage || busy || !safeToApply || !units.length && !blocks.length || applyTagLinks.some((link: any) => ['ambiguous', 'invalid'].includes(link.action))} title={!safeToApply ? 'Сначала разрешите все спорные сопоставления и теги.' : undefined} className="inline-flex items-center gap-1 rounded bg-emerald-700 px-3 py-2 text-xs text-white disabled:opacity-50"><Check className="h-3.5 w-3.5" />{selectedTags.filter(tag => !doneTags.includes(tag)).length > 1 ? `Подтвердить импорт · ${selectedTags.filter(tag => !doneTags.includes(tag)).length} установки` : 'Подтвердить импорт'}</button>}</div>
        </footer>
      </div>
    </div>
    </>
  );
}
