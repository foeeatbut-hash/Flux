import React, { useEffect, useMemo, useState } from 'react';
import { useEscapeClose } from '../lib/useDismiss';
import {
  X, Loader2, CheckCircle2, AlertTriangle, FileSpreadsheet, ChevronRight, ChevronDown,
  Plus, RefreshCw, Minus, Pencil,
} from 'lucide-react';
import { rememberImport } from '../lib/lastImport';
import TagLinksPanel, { type TagLink } from './import/TagLinksPanel';

// ── Предпросмотр импорта оборудования (dry-run, Фаза 2 «Импорт бланков 2.0») ──
// Показывает, ЧТО изменится в проекте, ДО записи: дерево систем/блоков с диффом,
// инлайн-правка кривых значений, выбор области, предупреждения валидации.
// Файлы обрабатываются по одному (очередь); БД трогается только по кнопке импорта.

interface PlanParam {
  group: string; key: string; value: string; unit: string;
  status: 'new' | 'changed' | 'same'; oldValue?: string; warning?: string;
}
interface PlanBlock {
  key: string; systemName: string; monoblockName: string; itemCode: string;
  title: string; equipType: string;
  action: 'create' | 'update' | 'unchanged';
  params: PlanParam[]; changedCount: number; newCount: number; overrideImpact: number;
}
interface PlanSystem { name: string; title: string; action: 'create' | 'match'; matchedName?: string }
interface ImportPlan {
  systems: PlanSystem[]; blocks: PlanBlock[]; tagLinks?: TagLink[];
  totals: { systems: number; newBlocks: number; updatedBlocks: number; unchangedBlocks: number; conflicts: number; warnings: number; overrides: number; tagsNew?: number; tagsLinked?: number };
}

type Edits = Record<string, Record<string, string>>; // blockKey → "группа‖ключ" → значение

interface Props {
  fileIds: string[];
  category: string;
  categoryLabel: string;
  projectId: string;
  onClose: () => void;
  onDone: (summary: { files: number; conflicts: number }) => void;
}

const actionBadge = (a: PlanBlock['action']) =>
  a === 'create' ? { icon: Plus, cls: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30', text: 'новый' }
  : a === 'update' ? { icon: RefreshCw, cls: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30', text: 'изменится' }
  : { icon: Minus, cls: 'text-slate-400 bg-slate-100 dark:bg-slate-800', text: 'без изменений' };

export default function EquipmentImportPreview({ fileIds, category, categoryLabel, projectId, onClose, onDone }: Props) {
  useEscapeClose(true, onClose);

  const [idx, setIdx] = useState(0);
  const [fileName, setFileName] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const [activeBlock, setActiveBlock] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set()); // снятые галочки блоков
  const [edits, setEdits] = useState<Edits>({});
  const [totalConflicts, setTotalConflicts] = useState(0);
  // Второй шаг предпросмотра: что сделать с технологическими позициями бланка
  const [tagLinks, setTagLinks] = useState<TagLink[]>([]);
  const [showTags, setShowTags] = useState(false);

  const fileId = fileIds[idx];

  const loadPlan = async (currentEdits: Edits) => {
    setLoading(true); setError('');
    try {
      const r = await fetch('/api/equipment/import-plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, category, projectId, edits: currentEdits }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Не удалось построить план'); setPlan(null); }
      else {
        setPlan(d.plan); setFileName(d.fileName);
        setActiveBlock(d.plan.blocks[0]?.key || null);
        setTagLinks(d.plan.tagLinks || []);
      }
    } catch (e: any) { setError(e.message || 'Ошибка сети'); }
    finally { setLoading(false); }
  };

  useEffect(() => { setExcluded(new Set()); setEdits({}); setShowTags(false); loadPlan({}); /* новый файл */ }, [fileId]);

  const titleOfBlock = (key: string) => {
    const b = plan?.blocks.find(x => x.key === key);
    if (!b) return key;
    return b.itemCode === '__unit__' ? 'параметры установки' : (b.title || b.itemCode);
  };
  const setTagAction = (i: number, action: TagLink['action']) =>
    setTagLinks(list => list.map((l, j) => (j === i ? { ...l, action } : l)));

  // Дерево: система → её блоки (моноблок как подпись строки)
  const grouped = useMemo(() => {
    const map = new Map<string, PlanBlock[]>();
    for (const b of plan?.blocks || []) {
      if (!map.has(b.systemName)) map.set(b.systemName, []);
      map.get(b.systemName)!.push(b);
    }
    return map;
  }, [plan]);

  const active = plan?.blocks.find(b => b.key === activeBlock) || null;
  const isExcluded = (k: string) => excluded.has(k);
  const toggleBlock = (k: string) => setExcluded(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleSystem = (sys: string, blocks: PlanBlock[]) => {
    const allOn = blocks.every(b => !isExcluded(b.key));
    setExcluded(s => { const n = new Set(s); for (const b of blocks) allOn ? n.add(b.key) : n.delete(b.key); return n; });
  };

  const setEdit = (blockKey: string, group: string, key: string, value: string) => {
    setEdits(e => ({ ...e, [blockKey]: { ...(e[blockKey] || {}), [`${group}‖${key}`]: value } }));
  };

  const selectedBlocks = (plan?.blocks || []).filter(b => !isExcluded(b.key));
  const selectedCount = selectedBlocks.length;

  const apply = async () => {
    if (!plan || selectedCount === 0) return;
    setApplying(true);
    try {
      const r = await fetch('/api/equipment/import-to-category', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId, category, projectId, edits,
          selection: selectedBlocks.map(b => b.key),
          // Теги только выбранных позиций: снятая галочка не должна завести тег
          tagLinks: tagLinks.filter(l => selectedBlocks.some(b => b.key === l.blockKey)),
        }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Ошибка импорта'); setApplying(false); return; }
      const conflicts = totalConflicts + (d.conflictsCount || 0);
      setTotalConflicts(conflicts);
      // Партию запоминаем сразу: если импорт идёт очередью, отменить нужно
      // будет последний файл — на нём обычно и замечают, что залили не туда
      if (d.batchId) rememberImport(projectId, d.batchId, fileIds.length);
      // Следующий файл в очереди или завершение
      if (idx + 1 < fileIds.length) { setIdx(idx + 1); }
      else { onDone({ files: fileIds.length, conflicts }); }
    } catch (e: any) { setError(e.message || 'Ошибка сети'); }
    finally { setApplying(false); }
  };

  const t = plan?.totals;

  return (
    <div className="fixed inset-0 z-[75] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-5xl h-[85vh] bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Шапка */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <FileSpreadsheet className="w-5 h-5 text-emerald-600 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-bold text-slate-800 dark:text-white truncate">{fileName || 'Загрузка…'}</div>
            <div className="text-xs text-slate-500">
              Импорт в «{categoryLabel}»{fileIds.length > 1 ? ` · файл ${idx + 1} из ${fileIds.length}` : ''} · предпросмотр (БД не изменена)
            </div>
          </div>
          <button type="button" title="Закрыть предпросмотр без импорта" onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded cursor-pointer"><X className="w-5 h-5" /></button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
            <AlertTriangle className="w-8 h-8 text-rose-500" />
            <div className="text-sm text-slate-600 dark:text-slate-300 max-w-md">{error}</div>
            {fileIds.length > 1 && idx + 1 < fileIds.length && (
              <button type="button" onClick={() => setIdx(idx + 1)} className="text-xs font-bold px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer">Пропустить файл</button>
            )}
          </div>
        ) : plan && (
          <>
            {/* Сводка */}
            <div className="flex flex-wrap items-center gap-2 px-5 py-2.5 border-b border-slate-200 dark:border-slate-800 text-xs shrink-0">
              <Chip color="emerald" label={`+${t!.newBlocks} новых`} />
              <Chip color="amber" label={`${t!.updatedBlocks} изменится`} />
              <Chip color="slate" label={`${t!.unchangedBlocks} без изменений`} />
              {t!.conflicts > 0 && <Chip color="amber" label={`${t!.conflicts} расхождений значений`} />}
              {t!.overrides > 0 && <Chip color="rose" label={`затронет ручных правок: ${t!.overrides}`} />}
              {t!.warnings > 0 && <Chip color="rose" label={`⚠ проверьте: ${t!.warnings}`} />}
              <span className="flex-1" />
              {tagLinks.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowTags(v => !v)}
                  title="Технологические позиции бланка: привязать к существующим тегам или завести новые"
                  className="text-xs font-bold px-2 py-1 rounded-lg border border-emerald-300 text-emerald-700 dark:text-emerald-300 dark:border-emerald-800 cursor-pointer"
                >
                  {showTags ? '← к параметрам' : `Теги бланка: ${tagLinks.length} (создать ${tagLinks.filter(l => l.action === 'create').length})`}
                </button>
              )}
            </div>

            <div className={`flex-1 min-h-0 flex ${showTags ? 'hidden' : ''}`}>
              {/* Дерево */}
              <div className="w-80 shrink-0 border-r border-slate-200 dark:border-slate-800 overflow-auto p-2">
                {[...grouped.entries()].map(([sys, blocks]) => {
                  const s = plan.systems.find(x => x.name === sys);
                  const allOn = blocks.every(b => !isExcluded(b.key));
                  return (
                    <div key={sys} className="mb-1">
                      <div className="flex items-center gap-1.5 px-1.5 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-850">
                        <button type="button" onClick={() => setCollapsed(c => ({ ...c, [sys]: !c[sys] }))} className="text-slate-400 cursor-pointer">
                          {collapsed[sys] ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                        <input type="checkbox" checked={allOn} onChange={() => toggleSystem(sys, blocks)} className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer" />
                        <span className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate flex-1" title={s?.title}>{sys}</span>
                        {s?.action === 'create'
                          ? <span className="text-2xs px-1 rounded bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 font-bold">новая</span>
                          : <span className="text-2xs px-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 font-bold" title={s?.matchedName ? `сопоставлена с «${s.matchedName}»` : ''}>есть</span>}
                      </div>
                      {!collapsed[sys] && blocks.map(b => {
                        const ba = actionBadge(b.action);
                        return (
                          <div key={b.key}
                            className={`flex items-center gap-1.5 pl-8 pr-1.5 py-1.5 rounded-lg cursor-pointer ${activeBlock === b.key ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-850'} ${isExcluded(b.key) ? 'opacity-40' : ''}`}
                            onClick={() => setActiveBlock(b.key)}>
                            <input type="checkbox" checked={!isExcluded(b.key)} onClick={e => e.stopPropagation()} onChange={() => toggleBlock(b.key)} className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer" />
                            <span className="text-xs text-slate-700 dark:text-slate-300 truncate flex-1" title={b.title}>
                              {b.itemCode === '__unit__' ? '⚙ параметры установки' : b.title}
                            </span>
                            <span className={`text-2xs px-1 rounded font-bold ${ba.cls}`}>{ba.text}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

              {/* Параметры выбранного блока */}
              <div className="flex-1 overflow-auto p-4">
                {active ? (
                  <>
                    <div className="text-sm font-bold text-slate-800 dark:text-white mb-1">{active.itemCode === '__unit__' ? 'Параметры установки' : active.title}</div>
                    <div className="text-xs text-slate-400 mb-3">{active.equipType} · {active.params.length} параметров{active.overrideImpact > 0 ? ` · перекроет ${active.overrideImpact} ваших правок` : ''}</div>
                    <table className="w-full text-xs">
                      <thead className="text-slate-400 text-left">
                        <tr><th className="py-1 font-semibold">Параметр</th><th className="py-1 font-semibold">Значение</th><th className="py-1 font-semibold">Ед.</th><th className="py-1 font-semibold w-8"></th></tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-850">
                        {active.params.map((p, i) => {
                          const editKey = `${p.group}‖${p.key}`;
                          const edited = edits[active.key]?.[editKey];
                          const shown = edited !== undefined ? edited : p.value;
                          return (
                            <tr key={i} className={p.warning ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''}>
                              <td className="py-1.5 pr-2 text-slate-600 dark:text-slate-300">
                                <span className="text-2xs text-slate-400 block">{p.group}</span>{p.key}
                              </td>
                              <td className="py-1.5 pr-2">
                                <div className="flex items-center gap-1.5">
                                  <input
                                    value={shown}
                                    onChange={e => setEdit(active.key, p.group, p.key, e.target.value)}
                                    className={`w-full px-1.5 py-0.5 rounded border bg-transparent text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500 ${edited !== undefined ? 'border-emerald-400' : 'border-transparent hover:border-slate-200 dark:hover:border-slate-700'}`}
                                  />
                                  {p.status === 'changed' && edited === undefined && (
                                    <span className="text-2xs text-amber-600 whitespace-nowrap" title={`было: ${p.oldValue}`}>← {p.oldValue}</span>
                                  )}
                                  {p.status === 'new' && <span className="text-2xs text-emerald-500 shrink-0">нов.</span>}
                                </div>
                              </td>
                              <td className="py-1.5 pr-2 text-slate-500">{p.unit}</td>
                              <td className="py-1.5">
                                {p.warning && <span title={p.warning}><AlertTriangle className="w-3.5 h-3.5 text-amber-500" /></span>}
                                {edited !== undefined && <Pencil className="w-3 h-3 text-emerald-500" />}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {active.params.some(p => p.warning) && (
                      <div className="mt-3 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        Значения с пометкой выходят за типовой диапазон — возможна ошибка распознавания. Исправьте прямо здесь до импорта.
                      </div>
                    )}
                  </>
                ) : <div className="text-sm text-slate-400 text-center py-12">Выберите блок в дереве слева</div>}
              </div>
            </div>

            {/* Второй шаг: технологические позиции бланка */}
            {showTags && (
              <div className="flex-1 min-h-0 flex">
                <TagLinksPanel links={tagLinks} titleOf={titleOfBlock} onChange={setTagAction} />
              </div>
            )}

            {/* Действия */}
            <div className="flex items-center justify-between px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 shrink-0">
              <span className="text-xs text-slate-500">Выбрано к импорту: <b>{selectedCount}</b> из {plan.blocks.length}</span>
              <div className="flex items-center gap-2">
                <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-semibold text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-850 cursor-pointer">Отмена</button>
                <button type="button" onClick={apply} disabled={applying || selectedCount === 0}
                  className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-sm font-bold cursor-pointer flex items-center gap-1.5">
                  {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  Импортировать {selectedCount}{fileIds.length > 1 ? ` (файл ${idx + 1}/${fileIds.length})` : ''}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Chip({ color, label }: { color: 'emerald' | 'amber' | 'slate' | 'rose'; label: string }) {
  const cls = {
    emerald: 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400',
    amber: 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400',
    slate: 'bg-slate-100 dark:bg-slate-800 text-slate-500',
    rose: 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400',
  }[color];
  return <span className={`px-2 py-0.5 rounded-full font-bold ${cls}`}>{label}</span>;
}
