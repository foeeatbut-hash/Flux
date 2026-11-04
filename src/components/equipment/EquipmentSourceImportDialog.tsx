import React, { useEffect, useMemo, useRef, useState } from 'react';
import { rememberImport } from '../../lib/lastImport';
import { WindowDialogOrEmbedded } from '../ui/WindowDialog';
import { Btn, IconBtn } from '../ui';
import CustomSelect from '../CustomSelect';
import ImportPlanTable, { needsChoice } from './ImportPlanTable';
import ImportPlanDecisions from './ImportPlanDecisions';
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
type PlanDto = { success: true; fileName: string; sha256: string; revision: string; previewToken?: string; replacesOrphanBinding?: { sourceId: string; revision: string | null }; unitTag: { identifier: string; existingTagId?: string; action?: string }; plan: any };
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
  const ambiguousLinks = (plan?.plan?.tagLinks || []).filter(needsChoice);
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
      // Партию запоминаем так же, как в старом пути импорта: серверная отмена умеет её откатить,
      // а без записи строка «можно отменить импорт» на экране Оборудования не появится.
      if (payload.batchId) rememberImport(projectId, String(payload.batchId), 1);
      // План построен на состоянии до записи: после успеха он устарел, и «Подтвердить» на нём дало бы 409.
      setPlan(null);
      await onImported({ source, tagIdentifier, category, baselineApplied: payload.baselineApplied !== false, bindingId: payload.associations?.bindingId || payload.bindingId || source.sourceId });
      const done = [...doneTags, tagIdentifier];
      setDoneTags(done);
      const next = selectedTags.find(tag => !done.includes(tag));
      if (!next) {
        chainRef.current = false;
        try { setLedgerRevision((await loadEquipmentDocumentBindings(projectId)).revision); } catch (_) { /* Следующий план упрётся в 409 и перестроится. */ }
        onAllImported?.(); return;
      }
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
  const pendingTags = selectedTags.filter(tag => !doneTags.includes(tag));
  const confirmBlocked = !canManage || busy || !safeToApply || (!units.length && !blocks.length) || applyTagLinks.some((link: any) => ['ambiguous', 'invalid'].includes(link.action));
  const tagInput = xmlTagChoices.length > 1
    ? <fieldset className="min-w-0 text-xs text-[var(--flux-text-muted)]"><legend className="sr-only">Установки из этого файла</legend>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span>Установки из этого файла:</span>{xmlTagChoices.map(value => <label key={value} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={selectedTags.includes(value)} onChange={() => toggleTag(value)} disabled={busy || !canManage || doneTags.includes(value)} /><span className={value === tagIdentifier ? 'font-medium text-[var(--flux-text)]' : ''}>{value}</span>{doneTags.includes(value) && <Check className="h-3 w-3 text-emerald-600" aria-label="импортирована" />}</label>)}</div>
        {selectedTags.length > 1 && <p className="mt-1">План ниже — для {tagIdentifier || '—'}; остальные отмеченные установки загрузятся следом из этого же файла.</p>}</fieldset>
    : <label className="flex min-w-0 items-center gap-2 text-xs text-[var(--flux-text-muted)]">Тег оборудования<input value={tagIdentifier} onChange={event => { operationRef.current += 1; setBusy(false); setTagIdentifier(event.target.value); setSelectedTags(event.target.value.trim() ? [event.target.value] : []); setPlan(null); clearReviewSelections(); }} disabled={busy || !canManage} placeholder="Тег из имени установки в XML" className="fx-input w-56 font-mono" /></label>;
  return (
    <>
    <ImportFileChooser ref={filePicker} accept=".xml" label="Выбрать XML" trigger={() => null} onFiles={() => {}} onWindowsFile={(ref, entry, context) => { void chooseFile({ ref, name: entry.name, ...context }); }} />
    <ImportFileChooser ref={folderPicker} selectFolder label="Выбрать папку XML" trigger={() => null} onFiles={() => {}} onWindowsFolder={ref => { void changeFolder(ref); }} />
    {/* Встроенная карточка (inline) и встроенный режим мастера — блок без окна;
        отдельно открытый импорт — дочернее окно программы. У карточки нет
        overflow, рамки и внешних отступов: закреплённые шапка таблицы и подвал
        «прилипают» к краю прокручиваемой панели мастера, а отступ сверху и
        снизу сдвинул бы их внутрь, и строки просвечивали бы в зазоре. */}
    <WindowDialogOrEmbedded embedded={embedded || inline} onClose={close} busy={busy} label="Загрузить оборудование из XML"
      embeddedClassName={inline ? 'flex flex-col' : 'flex h-full min-h-0 w-full flex-col overflow-hidden'}
      className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-md dark:border-slate-700 dark:bg-slate-950">
        {inline
          ? <header className="flex flex-wrap items-baseline gap-x-3 border-b border-[var(--flux-line)] px-4 py-2"><h3 id="equipment-source-import-title" className="text-sm font-semibold">Загрузка установки из XML</h3><p className="fx-hint">Данные проекта изменятся только после подтверждения.</p></header>
          : <header data-dialog-drag className="flex items-center justify-between border-b border-[var(--flux-line)] px-4 py-3"><div><h2 id="equipment-source-import-title" className="text-sm font-semibold">Загрузить оборудование из XML</h2><p className="fx-hint">Сначала проверьте план; данные проекта изменятся только после подтверждения.</p></div><IconBtn label="Закрыть" onClick={close} disabled={busy}><X className="h-4 w-4" /></IconBtn></header>}
        <div className={inline ? 'space-y-2 px-4 py-3' : 'min-h-0 flex-1 space-y-2 overflow-y-auto p-4'}>
          {!canManage && <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Недостаточно прав для импорта оборудования.</div>}
          {!inline && <div className="flex flex-wrap items-center gap-2">
            <Btn onClick={() => void chooseFile()} disabled={!canManage || busy}><Upload />{file ? 'Выбрать другой XML' : 'Выбрать XML-файл'}</Btn>
            <div className="flex min-w-[220px] flex-1 items-center gap-2 text-xs text-[var(--flux-text-muted)]">Категория оборудования
              <div className="min-w-0 flex-1"><CustomSelect ariaLabel="Категория оборудования" value={category} disabled={busy || !canManage} options={categories.map(item => ({ value: item.id, label: item.label }))} onChange={next => { operationRef.current += 1; setBusy(false); setCategory(next); setPlan(null); clearReviewSelections(); }} /></div></div>
          </div>}
          {file && <div className="space-y-1.5 rounded border border-[var(--flux-line)] bg-[var(--flux-hover)] px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              {tagInput}
              <label className="flex items-center gap-2 text-xs text-[var(--flux-text-muted)]">Ревизия<input value={revision} onChange={event => { operationRef.current += 1; setBusy(false); setRevision(event.target.value); setPlan(null); clearReviewSelections(); }} disabled={busy || !canManage} className="fx-input w-20" /></label>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-[var(--flux-text-muted)]">
              <span className="min-w-0 truncate" title={`${file.selectedFile.name} · ${folderLabel}`}>Файл <span className="text-[var(--flux-text)]">{file.selectedFile.name}</span> · папка источника <span className="text-[var(--flux-text)]">{folderLabel}</span></span>
              {!inline && <Btn size="sm" tone="ghost" onClick={() => void changeFolder()} disabled={busy || !canManage}><FolderOpen />Исправить папку</Btn>}
            </div>
            {file.revisionWarning && <p className="text-xs text-amber-800 dark:text-amber-300" role="status">{file.revisionWarning}</p>}
          </div>}
          {error && <div role="alert" className="flex gap-2 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}
          {notice && <div role="status" className="rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">{notice}</div>}
          {plan && <section className="space-y-2" aria-label="План импорта">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3"><h3 className="text-sm font-semibold">Предпросмотр · {plan.fileName} · ревизия {plan.revision}</h3><span className="fx-hint">Тег: <span className="font-mono">{plan.unitTag?.identifier || tagIdentifier}</span></span></div>
            {plan.replacesOrphanBinding && <p role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Прежняя установка с этим тегом удалена, а её привязка XML осталась. При импорте привязка перейдёт к новой установке; история ревизий сохранится.</p>}
            {!!planTotals.overrides && <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Есть {planTotals.overrides} ручных значений. Импорт ждёт отдельного разрешения конфликта и не заменяет их автоматически.</p>}
            {!!unknownKinds.length && <div className="space-y-2"><div className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200"><strong>В XML есть нераспознанные виды данных:</strong> {unknownKinds.join(', ')}. Импорт остановлен, чтобы не пропустить эти позиции. Укажите их роли ниже и повторите проверку.</div><UnknownKinds kinds={unknownKinds} onSaved={() => void requestPlan()} /></div>}
            {warnings.map((warning: any, index: number) => <p key={index} className="text-xs text-amber-800 dark:text-amber-300">{typeof warning === 'string' ? warning : warning?.message || JSON.stringify(warning)}</p>)}
            <ImportPlanDecisions plan={plan.plan} choices={choices} disabled={busy || !canManage} onChoice={(key, value) => setChoices(current => ({ ...current, [key]: value }))} />
            <ImportPlanTable plan={plan.plan} choices={tagLinkChoices} disabled={busy || !canManage} onChoices={patch => setTagLinkChoices(current => ({ ...current, ...patch }))} />
          </section>}
        </div>
        <footer className={`${inline ? 'sticky bottom-0 z-[2]' : ''} flex flex-wrap items-center justify-between gap-2 border-t border-[var(--flux-line)] bg-[var(--flux-bg)] px-4 py-2`}>
          {inline ? <span /> : <Btn onClick={close} disabled={busy}>Закрыть</Btn>}
          <div className="flex flex-wrap gap-2">{file && <Btn onClick={() => void requestPlan()} disabled={!canManage || busy || !category || !tagIdentifier.trim()}>{busy && !plan ? <Loader2 className="animate-spin" /> : null}{inline && plan ? 'Обновить план' : 'Показать план'}</Btn>}{plan && <Btn tone="primary" onClick={() => void applyImport()} disabled={confirmBlocked} title={!safeToApply ? 'Сначала разрешите все спорные сопоставления и теги.' : undefined}><Check />{pendingTags.length > 1 ? `Подтвердить импорт · ${pendingTags.length} установки` : 'Подтвердить импорт'}</Btn>}</div>
        </footer>
      </WindowDialogOrEmbedded>
    </>
  );
}
