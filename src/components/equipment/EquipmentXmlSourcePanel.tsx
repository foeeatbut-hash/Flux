import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, FolderOpen, Link2, RefreshCw, Unlink, Upload } from 'lucide-react';
import { windowsFilesRequest } from '../../lib/windowsFiles';
import {
  getEquipmentSourceBinding, pickEquipmentSource, pickEquipmentSourceFolder, removeEquipmentSourceBinding,
  saveEquipmentSourceBinding, scanEquipmentSource,
  type EquipmentSourceCandidate, type EquipmentSourceFilenameRule, type EquipmentSourcePreview, type LocalEquipmentSourceBinding,
} from '../../lib/equipmentSourcesLocal';

type SourceDto = { sourceId: string; projectId: string; tagId: string; elementId: string; targetType: 'system' | 'component'; systemId?: string; tagIdentifier: string; boundIdentifier: string; revisionOrder: string[]; selectedRule: EquipmentSourceFilenameRule; lastImportedRevision: string | null; lastImportedSha256: string | null; lastImportedAt?: string | null; lastReviewedRevision?: string | null; lastReviewedSha256?: string | null; lastReviewedAt?: string | null };
type ChangeDto = { id: string; group: string; key: string; targetLabel?: string; kind: 'added' | 'changed' | 'missing'; current?: { value: unknown; unit?: string }; proposed?: { value: unknown; unit?: string }; catalogCurrent?: { value: unknown; unit?: string; source: 'catalog' }; manual: boolean };
type StructuralAction = { id: string; kind: 'added' | 'removed' | 'ambiguous' | 'moved' | 'restored' | 'metadata-changed'; label: string; reason: string; parsedKey?: string; elementIds: string[]; field?: string; before?: unknown; after?: unknown; proposed?: { code?: string; title?: string; equipType?: string; groups?: Array<{ title: string; params: Array<{ key: string; value: string; unit?: string }> }>; monoblockName?: string; parentName?: string; sourceOrder?: number; tags?: string[]; role?: string; instanceNo?: number; instanceCount?: number } };
type CandidateDto = { id: string; revision: string; fileName: string; sha256: string; status: string; changes: ChangeDto[]; structuralActions?: StructuralAction[]; decisions: Record<string, any>; expectedVersion: number; createdAt: string; undoBatchId?: string | null; revisionWarning?: string | null };
type ScanChoice = EquipmentSourceCandidate;

const api = (path: string) => `/api${path}`;
const statusText: Record<string, string> = { pending: 'Найдена ревизия, решения не приняты', partial: 'Изменения рассмотрены частично', complete: 'Изменения приняты', keepResolved: 'Проверка завершена, текущие значения сохранены', noChanges: 'Изменений нет' };
const valueText = (value?: { value: unknown; unit?: string }) => value ? `${String(value.value ?? '')}${value.unit ? ` ${value.unit}` : ''}` : '—';
const dateText = (value?: string | null) => value ? new Date(value).toLocaleString('ru-RU') : '—';
const ruleText = (rule?: EquipmentSourceFilenameRule) => rule?.kind === 'selected-name' ? `Выбранное имя: ${rule.fileName}` : 'Точное имя тега';
const isOpen = (status: string) => status === 'pending' || status === 'partial';

/** Путь и capability Проводника остаются локальными; сервер хранит только привязку и результаты сверки. */
export default function EquipmentXmlSourcePanel(props: { projectId: string; tag: { id: string; identifier: string }; elementId: string; targetType: 'system' | 'component'; systemId?: string; canManage: boolean; onChanged?: () => void }) {
  const { projectId, tag, elementId, targetType, systemId, canManage, onChanged } = props;
  const [source, setSource] = useState<SourceDto | null>(null);
  const [binding, setBinding] = useState<LocalEquipmentSourceBinding | null>(null);
  const [candidates, setCandidates] = useState<CandidateDto[]>([]);
  const [activeCandidateId, setActiveCandidateId] = useState('');
  const [preview, setPreview] = useState<Extract<EquipmentSourcePreview, { status: 'ready' }> | null>(null);
  const [scanChoices, setScanChoices] = useState<ScanChoice[]>([]);
  const [scanWarnings, setScanWarnings] = useState<string[]>([]);
  const [scanChoiceId, setScanChoiceId] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [lastCheck, setLastCheck] = useState<{ at: string; result: string } | null>(null);
  const [sourceUnavailable, setSourceUnavailable] = useState(false);
  const [sourceRootName, setSourceRootName] = useState('');
  const [autoCheck, setAutoCheck] = useState(() => { try { return localStorage.getItem('flux.equipmentXmlAutoCheck') !== '0'; } catch { return true; } });
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(true);
  const [revisionOrderText, setRevisionOrderText] = useState('');
  const busyRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const latestRef = useRef({ source, binding });
  latestRef.current = { source, binding };

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    try {
      const response = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/sources`));
      const payload = response.ok ? await response.json() : null;
      if (generation !== loadGenerationRef.current) return;
      if (!response.ok) throw new Error(payload?.error || 'Не удалось прочитать источник XML');
      const selected = (payload.sources || []).find((item: SourceDto) => item.tagId === tag.id && item.elementId === elementId && item.targetType === targetType && (item.systemId || '') === (systemId || '')) || null;
      setSource(selected);
      if (!selected) { setBinding(null); setCandidates([]); setActiveCandidateId(''); return; }
      const local = getEquipmentSourceBinding(projectId, selected.sourceId, tag.id, elementId) || null;
      setBinding(local);
      setRevisionOrderText((local?.revisionOrder || selected.revisionOrder || []).join(', '));
      const candidateResponse = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(selected.sourceId)}/candidates`));
      const result = candidateResponse.ok ? await candidateResponse.json() : null;
      if (generation !== loadGenerationRef.current) return;
      if (candidateResponse.ok) {
        const list: CandidateDto[] = result.candidates || [];
        setCandidates(list);
        setActiveCandidateId(current => list.some(item => item.id === current) ? current : (list.find(item => isOpen(item.status)) || list[list.length - 1])?.id || '');
        if (result.renamed) setMessage(`Тег переименован: ${selected.boundIdentifier} → ${result.currentIdentifier}. Проверьте имя XML.`);
      }
    } catch (error: any) {
      if (generation === loadGenerationRef.current) setMessage(error?.message || 'Не удалось прочитать источник XML');
    }
  }, [projectId, tag.id, tag.identifier, elementId, targetType, systemId]);

  const activeCandidate = candidates.find(item => item.id === activeCandidateId) || null;
  const saveLocal = (next: LocalEquipmentSourceBinding) => { saveEquipmentSourceBinding(next); setBinding(next); };

  useEffect(() => {
    void load();
    return () => { loadGenerationRef.current += 1; };
  }, [load]);
  useEffect(() => {
    let timer: number | undefined;
    const onSourceChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.kind !== 'equipment-source' || detail.projectId !== projectId || (source && detail.id !== source.sourceId)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void load(); }, 80);
    };
    window.addEventListener('socket:entity:changed', onSourceChanged);
    return () => { window.clearTimeout(timer); window.removeEventListener('socket:entity:changed', onSourceChanged); };
  }, [load, projectId, source?.sourceId]);
  useEffect(() => {
    const rootId = binding?.rootId || preview?.sourceFolder.rootId;
    if (!rootId) return;
    void windowsFilesRequest<{ roots: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>>({ action: 'roots' }).then(response => {
      if ('data' in response) {
        const roots = Array.isArray(response.data) ? response.data : response.data.roots;
        setSourceRootName(roots.find(item => item.id === rootId)?.name || '');
      }
    });
  }, [binding?.rootId, preview?.sourceFolder.rootId]);

  const chooseInitialFile = async () => {
    if (!canManage) return;
    setBusy(true); setMessage(''); setPreview(null);
    try {
      const picked = await pickEquipmentSource(tag.identifier);
      if ('error' in picked) throw new Error(picked.error.message);
      const value = picked.data as EquipmentSourcePreview;
      if (value.status === 'ready') { setPreview(value); setExpanded(true); }
      else if (value.status !== 'canceled') setMessage(value.message);
    } catch (error: any) { setMessage(error?.message || 'Не удалось выбрать XML'); }
    finally { setBusy(false); }
  };

  const changePreviewFolder = async () => {
    if (!canManage) return;
    setBusy(true);
    try {
      const picked = await pickEquipmentSourceFolder();
      if ('error' in picked) throw new Error(picked.error.message);
      if (picked.data && preview) {
        const fileRef = preview.selectedFile.ref;
        const folderRef = picked.data;
        const prefix = folderRef.relativePath ? `${folderRef.relativePath.replace(/\/$/u, '')}/` : '';
        if (fileRef.rootId !== folderRef.rootId || !fileRef.relativePath.startsWith(prefix)) {
          setMessage('Выбранный XML не находится внутри указанной папки. Выберите папку-родитель этого файла.');
          return;
        }
        if (!fileRef.relativePath.slice(prefix.length).includes('/')) {
          setMessage('Папка источника должна содержать подпапки ревизий. Выберите родительскую папку XML.');
          return;
        }
        setPreview({ ...preview, sourceFolder: folderRef });
      }
    } catch (error: any) { setMessage(error?.message || 'Не удалось выбрать папку источника'); }
    finally { setBusy(false); }
  };

  const confirmBinding = async () => {
    if (!canManage) return;
    if (!preview) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/sources`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId: tag.id, elementId, targetType, systemId, fileName: preview.selectedFile.name, revision: preview.revision, selectedRule: preview.selectedRule, sha256: preview.sha256, size: preview.size, base64: preview.base64 }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось сохранить источник');
      const created = payload.source as SourceDto;
      const next: LocalEquipmentSourceBinding = { sourceId: created.sourceId, projectId, tagId: tag.id, elementId, targetType, ...(systemId ? { systemId } : {}), tagIdentifier: tag.identifier, rootId: preview.sourceFolder.rootId, relativePath: preview.sourceFolder.relativePath, selectedFileRef: preview.selectedFile.ref, revisionOrder: created.revisionOrder || ['A','B','C','D','E','F','G','H','I','J'], selectedRule: preview.selectedRule };
      saveLocal(next); setSource(created); setPreview(null); setExpanded(true); setMessage(`Источник связан · ревизия ${preview.revision}`); onChanged?.();
    } catch (error: any) { setMessage(error?.message || 'Не удалось сохранить источник'); }
    finally { setBusy(false); }
  };

  const rebindFolder = async () => {
    if (!canManage) return;
    setBusy(true); setMessage('');
    try {
      const picked = await pickEquipmentSourceFolder();
      if ('error' in picked) throw new Error(picked.error.message);
      if (!picked.data || !source) return;
      const next: LocalEquipmentSourceBinding = binding ? { ...binding, rootId: picked.data.rootId, relativePath: picked.data.relativePath } : {
        sourceId: source.sourceId, projectId, tagId: tag.id, elementId, targetType, ...(systemId ? { systemId } : {}), tagIdentifier: tag.identifier,
        rootId: picked.data.rootId, relativePath: picked.data.relativePath, revisionOrder: source.revisionOrder || ['A','B','C','D','E'], selectedRule: source.selectedRule,
      };
      saveLocal(next); setMessage('Локальную папку источника обновили.');
    } catch (error: any) { setMessage(error?.message || 'Не удалось выбрать папку'); }
    finally { setBusy(false); }
  };

  const openFolder = async () => {
    if (!binding) return;
    const response = await windowsFilesRequest({ action: 'open', ref: { rootId: binding.rootId, relativePath: binding.relativePath } });
    if ('error' in response) setMessage(response.error.message);
  };

  const rebindFile = async () => {
    if (!canManage) return;
    if (!source) return;
    setBusy(true); setMessage('');
    try {
      const picked = await pickEquipmentSource(tag.identifier);
      if ('error' in picked) throw new Error(picked.error.message);
      const value = picked.data as EquipmentSourcePreview;
      if (value.status !== 'ready') { if (value.status !== 'canceled') setMessage(value.message); return; }
      const response = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.sourceId)}/rebind`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: value.selectedFile.name, selectedRule: value.selectedRule, revision: value.revision, sha256: value.sha256, size: value.size, base64: value.base64 }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось перепривязать файл');
      const updated = payload.source as SourceDto;
      const next: LocalEquipmentSourceBinding = { sourceId: updated.sourceId, projectId, tagId: tag.id, elementId, targetType, ...(systemId ? { systemId } : {}), tagIdentifier: tag.identifier, rootId: value.sourceFolder.rootId, relativePath: value.sourceFolder.relativePath, selectedFileRef: value.selectedFile.ref, revisionOrder: updated.revisionOrder, selectedRule: value.selectedRule };
      saveLocal(next); setSource(updated); setMessage('Имя тега и XML перепривязаны.');
    } catch (error: any) { setMessage(error?.message || 'Не удалось перепривязать файл'); }
    finally { setBusy(false); }
  };

  const submitScanChoice = async (selected: ScanChoice) => {
    if (!canManage) return;
    const current = latestRef.current;
    if (!current.source) return;
    if (current.binding) saveLocal({ ...current.binding, selectedRule: selected.selectedRule, selectedFileRef: selected.fileRef });
    setBusy(true); busyRef.current = true; setMessage('');
    try {
      const response = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(current.source.sourceId)}/check`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: selected.fileName, revision: selected.revision, selectedRule: selected.selectedRule, sha256: selected.sha256, size: selected.size, base64: selected.base64 }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось сравнить XML');
      if (payload.candidate) { setCandidates(items => [payload.candidate, ...items.filter(item => item.id !== payload.candidate.id)]); setActiveCandidateId(payload.candidate.id); }
      setScanChoices([]); setExpanded(true); setLastCheck({ at: new Date().toISOString(), result: `Ревизия ${selected.revision} загружена для проверки` });
      setMessage(`Загружена для проверки ревизия ${selected.revision}`); await load();
    } catch (error: any) { setMessage(error?.message || 'Не удалось проверить XML'); setLastCheck({ at: new Date().toISOString(), result: error?.message || 'Ошибка проверки' }); }
    finally { setBusy(false); busyRef.current = false; }
  };

  const check = useCallback(async (force = false) => {
    if (!canManage) return;
    if (busyRef.current) return;
    const current = latestRef.current;
    if (!current.binding || !current.source) { setSourceUnavailable(true); setLastCheck({ at: new Date().toISOString(), result: 'Источник недоступен на этом компьютере' }); return; }
    busyRef.current = true; setBusy(true); setMessage('');
    try {
      const result = await scanEquipmentSource(current.binding);
      if (result.status === 'ambiguous') {
        setSourceUnavailable(false);
        setScanWarnings([...result.invalidFiles?.map(name => `Файл «${name}» не прошёл проверку тега.`) || [], ...(result.message ? [result.message] : [])]);
        setScanChoices(result.candidates); setScanChoiceId(result.candidates[0] ? `${result.candidates[0].revision}:${result.candidates[0].fileName}` : '');
        setMessage(result.message); setLastCheck({ at: new Date().toISOString(), result: 'Нужно выбрать XML-файл' }); return;
      }
      if (result.status !== 'ready') {
        setSourceUnavailable(result.status === 'source-unavailable');
        setScanWarnings(result.invalidFiles?.map(name => `Файл «${name}» не прошёл проверку тега.`) || []);
        if (result.candidates.length) {
          setScanChoices(result.candidates); setScanChoiceId(`${result.candidates[0].revision}:${result.candidates[0].fileName}`);
        }
        throw new Error(result.message);
      }
      setSourceUnavailable(false);
      setScanWarnings([...(result.warnings || []), ...(result.invalidFiles?.map(name => `Файл «${name}» не прошёл проверку тега.`) || [])]);
      if (result.warnings?.length) setMessage(result.warnings.join(' '));
      const selected = result.recommended;
      if (!selected) throw new Error('Подходящая ревизия не найдена.');
      if (!force && (selected.sha256 === current.source.lastImportedSha256 || selected.sha256 === current.source.lastReviewedSha256)) {
        setSourceUnavailable(false);
        const resultText = `Изменений нет · ревизия ${selected.revision}`;
        setMessage(resultText); setLastCheck({ at: new Date().toISOString(), result: resultText }); return;
      }
      // Keep the scan lock while submitting; submitScanChoice owns that lock after this point.
      busyRef.current = false;
      await submitScanChoice(selected);
      return;
    } catch (error: any) {
      const text = error?.message || 'Не удалось проверить обновления';
      setMessage(text); setLastCheck({ at: new Date().toISOString(), result: text });
      if (/источник недоступен|папке|доступ/iu.test(text)) setSourceUnavailable(true);
    } finally { setBusy(false); busyRef.current = false; }
  }, [projectId, load, canManage]);

  const decide = async (items: Array<{ id: string; action: 'accept' | 'keep' | 'accept_missing'; overrideManual?: boolean }>) => {
    if (!canManage) return;
    const current = latestRef.current.source;
    if (!current || !activeCandidate) return;
    setBusy(true);
    try {
      const response = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(current.sourceId)}/candidates/${encodeURIComponent(activeCandidate.id)}/decisions`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: activeCandidate.expectedVersion, decisions: items }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось сохранить решения');
      setMessage(statusText[payload.status] || 'Решение сохранено');
      if (payload.batchId) setCandidates(rows => rows.map(item => item.id === activeCandidate.id ? { ...item, undoBatchId: payload.batchId } : item));
      await load(); onChanged?.();
    } catch (error: any) { setMessage(error?.message || 'Не удалось сохранить решение'); }
    finally { setBusy(false); }
  };

  const decideStructural = async (items: Array<{ id: string; action: 'accept' | 'keep' }>) => {
    if (!canManage || !items.length) return;
    const current = latestRef.current.source;
    if (!current || !activeCandidate) return;
    setBusy(true);
    try {
      const response = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(current.sourceId)}/candidates/${encodeURIComponent(activeCandidate.id)}/decisions`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: activeCandidate.expectedVersion, structuralDecisions: items }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось сохранить решение по составу');
      setMessage(statusText[payload.status] || 'Решение по составу сохранено');
      if (payload.batchId) setCandidates(rows => rows.map(item => item.id === activeCandidate.id ? { ...item, undoBatchId: payload.batchId } : item));
      await load(); onChanged?.();
    } catch (error: any) { setMessage(error?.message || 'Не удалось сохранить решение по составу'); }
    finally { setBusy(false); }
  };

  const confirmNoChanges = async () => {
    if (!canManage) return;
    if (!source || !activeCandidate) return;
    setBusy(true);
    try {
      const response = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.sourceId)}/candidates/${encodeURIComponent(activeCandidate.id)}/decisions`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: activeCandidate.expectedVersion, confirmNoChanges: true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось завершить проверку');
      setMessage('Проверка завершена · изменений нет'); await load();
    } catch (error: any) { setMessage(error?.message || 'Не удалось завершить проверку'); }
    finally { setBusy(false); }
  };

  const undoDecision = async () => {
    if (!canManage) return;
    if (!activeCandidate?.undoBatchId) return;
    setBusy(true);
    try {
      const planResponse = await fetch(api(`/equipment/import-undo/${encodeURIComponent(activeCandidate.undoBatchId)}`));
      const plan = await planResponse.json().catch(() => ({}));
      if (!planResponse.ok || plan.action !== 'restore') throw new Error(plan.reason || plan.error || 'Решение уже нельзя отменить без потери новых изменений.');
      const response = await fetch(api('/equipment/import-undo'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: activeCandidate.undoBatchId }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.restored) throw new Error(result.error || 'Решение уже изменилось в другой сессии.');
      setMessage('Решение отменено; ревизию можно рассмотреть снова.'); await load(); onChanged?.();
    } catch (error: any) { setMessage(error?.message || 'Не удалось отменить решение'); }
    finally { setBusy(false); }
  };

  const deleteBinding = async () => {
    if (!canManage) return;
    if (!source) return;
    setBusy(true);
    try {
      const response = await fetch(api(`/equipment/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.sourceId)}`), { method: 'DELETE' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Не удалось удалить привязку');
      removeEquipmentSourceBinding(projectId, source.sourceId, tag.id, elementId);
      setSource(null); setBinding(null); setCandidates([]); setMessage('Привязка удалена.'); onChanged?.();
    } catch (error: any) { setMessage(error?.message || 'Не удалось удалить привязку'); }
    finally { setBusy(false); }
  };

  const saveOrder = () => {
    if (!canManage) return;
    if (!binding) return;
    const order = revisionOrderText.split(/[\s,;]+/u).map(item => item.trim()).filter(Boolean);
    if (!order.length || new Set(order.map(item => item.toUpperCase())).size !== order.length) { setMessage('Укажите порядок без повторов, например A, B, C, D.'); return; }
    const next = { ...binding, revisionOrder: order };
    saveLocal(next); setMessage('Порядок ревизий сохранён на этом компьютере.');
  };

  const groups = useMemo(() => {
    const changes = activeCandidate?.changes || [];
    const visible = canManage && onlyUnreviewed ? changes.filter(change => !activeCandidate?.decisions?.[change.id]) : changes;
    const map = new Map<string, ChangeDto[]>();
    for (const change of visible) map.set(change.group, [...(map.get(change.group) || []), change]);
    return [...map.entries()];
  }, [activeCandidate, onlyUnreviewed, canManage]);

  // Stable timer callback reads the latest source and local capability, and skips overlapping scans.
  useEffect(() => {
    if (!canManage || !source?.sourceId || !binding || !autoCheck) return;
    const first = window.setTimeout(() => void check(), 250);
    const interval = window.setInterval(() => void check(), 5 * 60 * 1000);
    return () => { window.clearTimeout(first); window.clearInterval(interval); };
  }, [source?.sourceId, binding?.rootId, binding?.relativePath, check, autoCheck, canManage]);

  const unbound = !source;
  const folderRelativePath = binding?.relativePath ?? preview?.sourceFolder.relativePath ?? '';
  const folderLabel = [sourceRootName, folderRelativePath].filter(Boolean).join(' · ') || 'Выбранная папка';
  const activeScanChoice = scanChoices.find(item => `${item.revision}:${item.fileName}` === scanChoiceId);
  return (
    <section className="shrink-0 border-b border-slate-200 bg-slate-50/70 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-950/30">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link2 className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        <span className="font-medium text-slate-700 dark:text-slate-300">{source ? `Источник: ${source.lastImportedRevision || 'XML'} · ${source.boundIdentifier}.xml` : `XML для тега ${tag.identifier} не привязан`}</span>
        {source && sourceUnavailable && <span className="text-amber-700 dark:text-amber-300">· Источник недоступен</span>}
        {source && <span className="text-slate-500 dark:text-slate-400">· {activeCandidate && isOpen(activeCandidate.status) ? `${statusText[activeCandidate.status]} ${activeCandidate.revision}` : `ревизия ${source.lastImportedRevision || '—'}`}</span>}
        <button type="button" onClick={() => setExpanded(value => !value)} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800" aria-expanded={expanded}>{source ? 'Подробнее' : 'Связать'} <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} /></button>
        {source && canManage && <button type="button" onClick={() => void check(true)} disabled={busy} className="inline-flex items-center gap-1 rounded px-2 py-1 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:text-emerald-300 dark:hover:bg-emerald-950/50"><RefreshCw className="h-3 w-3" />Проверить</button>}
        {message && <span className="min-w-0 basis-full text-slate-500 dark:text-slate-400" role="status">{message}</span>}
      </div>
      {expanded && <div className="mt-2 space-y-2">
        {preview && canManage && <div className="rounded border border-sky-300 bg-sky-50 p-2 text-slate-700 dark:border-sky-900 dark:bg-sky-950/30 dark:text-slate-300">
          <div className="font-medium">Проверьте найденный источник перед сохранением</div>
          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1"><dt>Тег</dt><dd className="break-all">{tag.identifier}</dd><dt>Файл</dt><dd className="break-all">{preview.selectedFile.name}</dd><dt>Ревизия</dt><dd>{preview.revision || 'не определена'}</dd><dt>Папка</dt><dd className="break-all">{[sourceRootName, preview.sourceFolder.relativePath].filter(Boolean).join(' · ') || 'Выбранная папка'}</dd><dt>Правило XML</dt><dd><select aria-label="Правило выбора XML" value={preview.selectedRule.kind} onChange={event => setPreview({ ...preview, selectedRule: event.target.value === 'exact-tag' ? { kind: 'exact-tag' } : { kind: 'selected-name', fileName: preview.selectedFile.name } })} className="rounded border border-slate-300 bg-white px-1 py-0.5 dark:border-slate-700 dark:bg-slate-950"><option value="exact-tag" disabled={preview.selectedFile.name.slice(0, -4).normalize('NFC').trim().toLocaleLowerCase() !== tag.identifier.normalize('NFC').trim().toLocaleLowerCase()}>Точное имя тега</option><option value="selected-name">Закрепить выбранное имя файла</option></select></dd></dl>
          {preview.revisionWarning && <p className="mt-1 text-amber-800 dark:text-amber-300" role="status">{preview.revisionWarning}</p>}
          <div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => void changePreviewFolder()} disabled={busy} className="rounded border border-slate-300 px-2 py-1 hover:bg-white dark:border-slate-700 dark:hover:bg-slate-900">Исправить папку</button><button type="button" onClick={() => void confirmBinding()} disabled={busy} className="rounded bg-emerald-700 px-2 py-1 text-white hover:bg-emerald-600 disabled:opacity-50">Подтвердить привязку</button><button type="button" onClick={() => setPreview(null)} disabled={busy} className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700">Отмена</button></div>
        </div>}
        <div className="flex flex-wrap gap-2">
          {unbound ? canManage ? <button type="button" onClick={() => void chooseInitialFile()} disabled={busy || !!preview} className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 hover:bg-white disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900"><Upload className="h-3 w-3" />Выбрать XML</button> : <span className="text-slate-500 dark:text-slate-400">Источник XML не привязан</span> : <>
            {canManage && <>
            <button type="button" onClick={() => void rebindFolder()} disabled={busy} className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 hover:bg-white disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900"><FolderOpen className="h-3 w-3" />Перепривязать папку</button>
            <button type="button" onClick={() => void deleteBinding()} disabled={busy} className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-slate-600 hover:bg-white disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"><Unlink className="h-3 w-3" />Удалить привязку</button>
            {source.boundIdentifier !== tag.identifier && <button type="button" onClick={() => void rebindFile()} disabled={busy} className="inline-flex items-center gap-1 rounded border border-amber-300 px-2 py-1 text-amber-800 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"><Upload className="h-3 w-3" />Проверить новое имя тега</button>}
            </>}
            {binding && <button type="button" onClick={() => void openFolder()} disabled={busy} className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 hover:bg-white disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900">Открыть папку</button>}
          </>}
        </div>
        {source && <div className="grid gap-x-4 gap-y-1 rounded border border-slate-200 bg-white/70 p-2 sm:grid-cols-2 dark:border-slate-800 dark:bg-slate-900/50">
          <div><span className="text-slate-500 dark:text-slate-400">Тег: </span>{tag.identifier} <span className="text-slate-500">({source.boundIdentifier} в источнике)</span></div>
          <div className="min-w-0 break-all"><span className="text-slate-500 dark:text-slate-400">Папка: </span>{folderLabel}</div>
          <div className="min-w-0 break-all"><span className="text-slate-500 dark:text-slate-400">Файл: </span>{binding?.selectedFileRef?.relativePath || `${source.boundIdentifier}.xml`}</div>
          <div><span className="text-slate-500 dark:text-slate-400">Загружено: </span>{source.lastImportedRevision || '—'} · {dateText(source.lastImportedAt)}</div>
          <div><span className="text-slate-500 dark:text-slate-400">Последняя проверка: </span>{lastCheck ? `${dateText(lastCheck.at)} · ${lastCheck.result}` : source.lastReviewedAt ? `${dateText(source.lastReviewedAt)} · ревизия ${source.lastReviewedRevision || '—'}` : 'ещё не выполнялась в этой сессии'}</div>
          <div><span className="text-slate-500 dark:text-slate-400">Правило XML: </span>{ruleText(binding?.selectedRule || source.selectedRule)}</div>
          {canManage && <label className="flex items-center gap-2"><input type="checkbox" checked={autoCheck} onChange={event => { const enabled = event.target.checked; setAutoCheck(enabled); try { localStorage.setItem('flux.equipmentXmlAutoCheck', enabled ? '1' : '0'); } catch { /* настройка останется в этой сессии */ } }} />Автоматическая проверка при открытии и каждые 5 минут</label>}
          {canManage && <label className="flex min-w-0 items-center gap-2 sm:col-span-2"><span className="shrink-0 text-slate-500 dark:text-slate-400">Порядок ревизий</span><input value={revisionOrderText} onChange={event => setRevisionOrderText(event.target.value)} onBlur={saveOrder} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveOrder(); } }} className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950" aria-label="Порядок ревизий" /><button type="button" onClick={saveOrder} className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700">Сохранить</button></label>}
        </div>}
        {source && !binding && <div className="flex items-center gap-1 text-amber-700 dark:text-amber-300"><AlertTriangle className="h-3.5 w-3.5" />Источник недоступен на этом компьютере. Укажите локальную папку ревизий.</div>}
        {scanWarnings.length > 0 && <div className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200" role="status">{scanWarnings.map((warning, index) => <p key={`${index}:${warning}`}>{warning}</p>)}</div>}
        {canManage && scanChoices.length > 0 && <div className="rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950/30">
          <div className="font-medium">Найдено несколько XML. Выберите файл для сравнения.</div>
          <div className="mt-1 flex flex-wrap gap-2"><select value={scanChoiceId} onChange={event => setScanChoiceId(event.target.value)} className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950">{scanChoices.map(item => <option key={`${item.revision}:${item.fileName}`} value={`${item.revision}:${item.fileName}`}>Ревизия {item.revision} · {item.fileName} · {item.size.toLocaleString('ru-RU')} байт</option>)}</select><button type="button" onClick={() => activeScanChoice && void submitScanChoice(activeScanChoice)} disabled={busy || !activeScanChoice} className="rounded bg-emerald-700 px-2 py-1 text-white disabled:opacity-50">Сравнить выбранный</button></div>
        </div>}
        {candidates.length > 0 && <div className="flex flex-wrap items-center gap-2">
          <label className="text-slate-500 dark:text-slate-400" htmlFor={`candidate-${elementId}`}>Проверка</label>
          <select id={`candidate-${elementId}`} value={activeCandidateId} onChange={event => setActiveCandidateId(event.target.value)} className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950">{candidates.map(item => <option key={item.id} value={item.id}>{item.revision} · {item.fileName} · {statusText[item.status] || item.status}</option>)}</select>
          {activeCandidate && <span className="text-slate-500 dark:text-slate-400">{activeCandidate.changes.length} изменений · {dateText(activeCandidate.createdAt)}</span>}
        </div>}
        {activeCandidate && <div className="rounded border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">Ревизия {activeCandidate.revision} · {activeCandidate.fileName} · {statusText[activeCandidate.status] || activeCandidate.status}</span>
            <div className="flex flex-wrap gap-2">
              {canManage && isOpen(activeCandidate.status) && <><button type="button" onClick={() => void decide(activeCandidate.changes.filter(change => !activeCandidate.decisions[change.id] && change.kind !== 'missing' && !change.manual).map(change => ({ id: change.id, action: 'accept' as const })))} disabled={busy || !activeCandidate.changes.some(change => !activeCandidate.decisions[change.id] && change.kind !== 'missing' && !change.manual)} className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2 py-1 text-white hover:bg-emerald-600 disabled:opacity-50"><Check className="h-3 w-3" />Принять все</button><button type="button" onClick={() => void decide(activeCandidate.changes.filter(change => !activeCandidate.decisions[change.id]).map(change => ({ id: change.id, action: 'keep' as const })))} disabled={busy || !activeCandidate.changes.some(change => !activeCandidate.decisions[change.id])} className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700">Оставить всё</button>{!!activeCandidate.structuralActions?.some(action => !activeCandidate.decisions?.[action.id]) && <><button type="button" onClick={() => void decideStructural(activeCandidate.structuralActions!.filter(action => !activeCandidate.decisions?.[action.id]).map(action => ({ id: action.id, action: 'accept' as const })))} disabled={busy} className="rounded border border-emerald-500 px-2 py-1 text-emerald-800 disabled:opacity-50 dark:text-emerald-300">Принять состав</button><button type="button" onClick={() => void decideStructural(activeCandidate.structuralActions!.filter(action => !activeCandidate.decisions?.[action.id]).map(action => ({ id: action.id, action: 'keep' as const })))} disabled={busy} className="rounded border border-slate-300 px-2 py-1 disabled:opacity-50 dark:border-slate-700">Оставить состав</button></>}</>}
              {canManage && activeCandidate.changes.length === 0 && !activeCandidate.structuralActions?.length && isOpen(activeCandidate.status) && <button type="button" onClick={() => void confirmNoChanges()} disabled={busy} className="rounded bg-emerald-700 px-2 py-1 text-white">Подтвердить отсутствие изменений</button>}
              {canManage && activeCandidate.undoBatchId && <button type="button" onClick={() => void undoDecision()} disabled={busy} className="rounded border border-slate-300 px-2 py-1 disabled:opacity-50 dark:border-slate-700">Отменить решение</button>}
            </div>
          </div>
          {activeCandidate.revisionWarning && <p className="mt-1 text-amber-800 dark:text-amber-300" role="status">{activeCandidate.revisionWarning}</p>}
          {!!activeCandidate.structuralActions?.length && <div className="mt-2 rounded border border-amber-400 bg-amber-50 p-2 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" role="group" aria-label="Изменения состава установки"><div className="font-semibold">Изменения состава установки</div><p className="mt-1">Для каждого изменения явно выберите, принять предложение XML или оставить состав проекта. Решения сохраняются и отменяются вместе с характеристиками.</p><div className="mt-2 space-y-2">{activeCandidate.structuralActions.map(action => { const decision = activeCandidate.decisions?.[action.id]?.action; return <div key={action.id} className="rounded border border-amber-300/70 bg-white/60 p-2 dark:border-amber-900 dark:bg-slate-950/40"><div className="font-medium">{action.kind === 'added' ? 'Добавление' : action.kind === 'removed' ? 'Удаление из XML' : action.kind === 'moved' ? 'Перемещение' : action.kind === 'restored' ? 'Восстановление' : action.kind === 'metadata-changed' ? 'Изменение сведений' : 'Неоднозначное сопоставление'}: {action.label}</div>{action.reason && <p className="mt-0.5 text-amber-800 dark:text-amber-300">{action.reason}</p>}{action.field && <p className="mt-0.5">{action.field}: {String(action.before ?? '—')} → {String(action.after ?? '—')}</p>}{action.proposed && <div className="mt-1 border-l-2 border-sky-400 pl-2 text-slate-700 dark:text-slate-300"><span className="font-medium">Предложено XML:</span> {[action.proposed.title, action.proposed.equipType, action.proposed.monoblockName, action.proposed.parentName].filter(Boolean).join(' · ')}{action.proposed.groups?.map((group, groupIndex) => <div key={`${group.title}:${groupIndex}`} className="mt-1">{group.title}{group.params.map((param, paramIndex) => <div key={`${param.key}:${paramIndex}`}>{param.key}: {param.value}{param.unit ? ` ${param.unit}` : ''}</div>)}</div>)}</div>}<div className="mt-2 flex flex-wrap items-center gap-2">{decision ? <span className="text-xs font-semibold">{decision === 'accept' ? 'Предложение принято' : 'Состав проекта оставлен'}</span> : canManage && isOpen(activeCandidate.status) && <><button type="button" onClick={() => void decideStructural([{ id: action.id, action: 'accept' }])} disabled={busy} className="rounded border border-emerald-500 px-2 py-1 text-xs text-emerald-800 disabled:opacity-50 dark:text-emerald-300">Принять предложение</button><button type="button" onClick={() => void decideStructural([{ id: action.id, action: 'keep' }])} disabled={busy} className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-50 dark:border-slate-700">Оставить состав</button></>}</div></div>; })}</div></div>}
          {canManage && isOpen(activeCandidate.status) && activeCandidate.changes.length > 0 && <label className="mt-2 inline-flex items-center gap-1 text-slate-500 dark:text-slate-400"><input type="checkbox" checked={onlyUnreviewed} onChange={event => setOnlyUnreviewed(event.target.checked)} />Только нерассмотренные отличия</label>}
          {isOpen(activeCandidate.status) ? groups.map(([group, changes]) => <div key={group} className="mt-2 border-t border-slate-100 pt-1.5 dark:border-slate-800">
            <div className="mb-1 flex flex-wrap justify-between gap-2"><span className="font-medium text-slate-600 dark:text-slate-300">{group}</span>{canManage && <span className="flex gap-3"><button type="button" onClick={() => void decide(changes.filter(change => !change.manual && change.kind !== 'missing' && !activeCandidate.decisions[change.id]).map(change => ({ id: change.id, action: 'accept' as const })))} className="text-emerald-700 hover:underline dark:text-emerald-300">Принять группу</button><button type="button" onClick={() => void decide(changes.filter(change => !activeCandidate.decisions[change.id]).map(change => ({ id: change.id, action: 'keep' as const })))} className="text-slate-600 hover:underline dark:text-slate-300">Оставить группу</button></span>}</div>
            {changes.map(change => <div key={change.id} className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 border-t border-slate-100/70 py-2 dark:border-slate-800/70 sm:grid-cols-[minmax(100px,1fr)_minmax(75px,1fr)_minmax(75px,1fr)_minmax(75px,1fr)] lg:grid-cols-[minmax(110px,1fr)_minmax(90px,1fr)_minmax(90px,1fr)_minmax(90px,1fr)_auto]">
              <span className="min-w-0 break-words font-medium">{change.key}{change.targetLabel && <span className="ml-1 font-normal text-slate-500 dark:text-slate-400">· {change.targetLabel}</span>}{change.manual && <span className="ml-1 text-amber-700 dark:text-amber-300">· вручную</span>}</span>
              <span className="min-w-0 break-words text-slate-500 dark:text-slate-400"><span className="sm:hidden">Текущее значение: </span>{valueText(change.current)}</span>
              {change.catalogCurrent ? <span className="min-w-0 break-words text-slate-500 dark:text-slate-400"><span className="sm:hidden">Каталог сейчас · только чтение: </span>{valueText(change.catalogCurrent)}</span> : <span className="hidden sm:block" aria-hidden="true" />}
              <span className="min-w-0 break-words"><span className="sm:hidden">Предложено: </span>{change.kind === 'missing' ? 'нет в XML' : valueText(change.proposed)}</span>
              {canManage && <span className="flex flex-wrap gap-1 sm:col-span-4 lg:col-span-1">
                {change.kind !== 'missing' && !change.manual && <button type="button" onClick={() => void decide([{ id: change.id, action: 'accept' }])} className="rounded border border-slate-300 px-1.5 py-0.5 dark:border-slate-700">Принять</button>}
                {change.manual && <button type="button" onClick={() => void decide([{ id: change.id, action: change.kind === 'missing' ? 'accept_missing' : 'accept', overrideManual: true }])} className="rounded border border-amber-300 px-1.5 py-0.5 text-amber-800 dark:border-amber-800 dark:text-amber-300">Заменить ручное</button>}
                {change.kind === 'missing' && <button type="button" onClick={() => void decide([{ id: change.id, action: 'accept_missing', overrideManual: change.manual }])} className="rounded border border-rose-300 px-1.5 py-0.5 text-rose-700 dark:border-rose-900 dark:text-rose-300">Удалить</button>}
                <button type="button" onClick={() => void decide([{ id: change.id, action: 'keep' }])} className="rounded border border-slate-300 px-1.5 py-0.5 dark:border-slate-700">Оставить</button>
              </span>}
            </div>)}
          </div>) : <div className="mt-2 border-t border-slate-100 pt-2 text-slate-500 dark:border-slate-800 dark:text-slate-400">Все отличия рассмотрены. Сохранённое решение можно отменить, пока характеристики не менялись.</div>}
        </div>}
      </div>}
    </section>
  );
}
