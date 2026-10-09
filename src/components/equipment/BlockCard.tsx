import React, { useEffect, useState } from 'react';
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Eye, EyeOff, History, LayoutGrid, Network, Pencil, Plus,
  RefreshCw, Save, Tag as TagIcon, X,
} from 'lucide-react';
import { useInsightStore } from '../../store/insightStore';
import { useStore } from '../../store/store';
import { useEntityChanged } from '../../lib/entityWatch';
import { normalizeSpecs, type ParamConflict } from '../../lib/specs';
import TypeChip from './TypeChip';
import CatalogSourcePanel from './CatalogSourcePanel';
import E3SchemeLine from './E3SchemeLine';

/**
 * Карточка позиции: характеристики, теги, конфликты, правки.
 *
 * Уехала из `screens/Equipment.tsx` целиком, без изменения поведения: экран
 * стоял у планки размера, а карточка — самая большая его часть и при этом
 * самостоятельная. Всё, что ей нужно, приходит свойствами.
 */

export default function BlockCard(props: any) {
  const { comp, unitName, showAllParams, setShowAllParams, isHidden, toggleHidden, onResolve, onOverride, onHistory, onSaveView, onPickTag, onUnlinkTag, blockLabel, onBackToUnit, highlightKey, onReload } = props;
  const specs = normalizeSpecs(comp?.specs);
  const groupTitles = specs.groups.filter((group: any) => Array.isArray(group.params) && group.params.length > 0).map((group: any) => String(group.title || 'Параметры'));
  const groupStorageKey = `flux.equipment.expanded-groups:${comp?.id || ''}`;
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => readExpandedGroups(groupStorageKey, groupTitles));
  useEffect(() => setExpandedGroups(readExpandedGroups(groupStorageKey, groupTitles)), [groupStorageKey, groupTitles.join('\u0000')]);
  useEffect(() => {
    try { localStorage.setItem(groupStorageKey, JSON.stringify(expandedGroups)); } catch { /* сохранение вида не должно ломать карточку */ }
  }, [groupStorageKey, expandedGroups]);
  // Подсветка характеристики, к которой привёл ИИ-чат: скроллим к строке
  const hlNorm = (highlightKey || '').trim().toLowerCase();
  useEffect(() => {
    if (!hlNorm) return;
    const targetGroup = specs.groups.find((group: any) => (group.params || []).some((param: any) => String(param.key || '').trim().toLowerCase() === hlNorm));
    if (targetGroup) setExpandedGroups(current => ({ ...current, [String(targetGroup.title || 'Параметры')]: true }));
    const t = setTimeout(() => {
      document.querySelector('[data-hl-param="1"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 180);
    return () => clearTimeout(t);
  }, [hlNorm, comp?.id]);
  let conflicts: ParamConflict[] = [];
  try { conflicts = comp?.paramConflicts ? JSON.parse(comp.paramConflicts) : []; } catch (_) { conflicts = []; }
  if (!Array.isArray(conflicts)) conflicts = [];
  let overrides: Record<string, string> = {};
  try { overrides = comp?.overrides ? JSON.parse(comp.overrides) : {}; } catch (_) { overrides = {}; }
  const conflictOf = (g: string, k: string) => conflicts.find(c => c.group === g && c.key === k);
  const catalogOrigins = new Set((comp.catalogSource?.effective || []).filter((param: any) => param.source === 'catalog').map((param: any) => `${param.group || ''}||${param.key}`));
  const openWhereUsed = useInsightStore((st) => st.openWhere);
  // Кто-то ещё правит эту же карточку: сообщаем, но не перечитываем сами —
  // иначе набранное в поле значение исчезло бы под руками
  const me = useStore((st) => st.user);
  const { change, clear } = useEntityChanged('element', comp?.id, me?.id);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');

  return (
    <>
      <div
        data-share-route="/equipment"
        data-share-focus={`equip:${comp?.id}`}
        data-share-label={`Оборудование: ${blockLabel ? blockLabel(comp) : (comp?.name || '')}`}
        className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {onBackToUnit && (
              <button type="button" onClick={onBackToUnit} className="inline-flex items-center gap-1 text-2xs font-semibold text-slate-400 hover:text-emerald-600 cursor-pointer" title="Вернуться к схеме установки">
                <LayoutGrid className="w-3 h-3" /> схема
              </button>
            )}
            {/* Тип и вид — угаданные правилом, с поправкой по нажатию */}
            <TypeChip componentId={comp.id} typed={props.typed} onSaved={() => onReload?.()} say={props.say || (() => {})} />
            <span className="text-2xs text-slate-400 font-mono">{unitName} · v{comp.version}</span>
          </div>
          {/* Имя переносится, а не обрывается: «Электродвигатель 160М6-УХЛ2-400-IM1001»
              и есть то, что ищут глазами */}
          <h3 className="u-sel text-sm font-semibold mt-1 break-words line-clamp-3" title={blockLabel(comp)}>{blockLabel(comp)}</h3>
          <E3SchemeLine componentId={comp.id} version={comp.version} />
          {props.composition?.parent && (
            <button type="button" onClick={() => props.onOpenPosition?.(props.composition.parent.id)}
              className="mt-1 inline-flex items-center gap-1 text-2xs text-slate-500 hover:text-emerald-600 cursor-pointer max-w-full"
              title="Открыть позицию, в которую входит эта">
              <span className="shrink-0">входит в</span>
              <span className="font-semibold truncate">{props.composition.parent.label}</span>
              {props.composition.parent.tag && <span className="font-mono text-emerald-700 dark:text-emerald-400 shrink-0">{props.composition.parent.tag}</span>}
            </button>
          )}
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {(comp.tags || []).map((t: any) => (
              <span key={t.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/40 text-2xs text-emerald-700 dark:text-emerald-300">
                <TagIcon className="w-2.5 h-2.5" /><span className="u-sel">{t.identifier}</span>
                <button type="button" onClick={() => onUnlinkTag(t.id)} className="hover:text-rose-500 cursor-pointer"><X className="w-2.5 h-2.5" /></button>
              </span>
            ))}
            <button type="button" onClick={onPickTag} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-dashed border-slate-300 dark:border-slate-600 text-2xs text-slate-500 hover:border-emerald-400 hover:text-emerald-600 cursor-pointer"><Plus className="w-2.5 h-2.5" />тег</button>
            {/* Своя позиция внутрь этой: датчик ПТС на двигатель, коробка на клапан */}
            {props.onAddInside && (
              <button type="button" onClick={props.onAddInside} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-dashed border-slate-300 dark:border-slate-600 text-2xs text-slate-500 hover:border-emerald-400 hover:text-emerald-600 cursor-pointer" title="Завести позицию внутрь этой — со своим тегом"><Plus className="w-2.5 h-2.5" />позиция внутрь</button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" onClick={() => setShowAllParams(!showAllParams)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer" title={showAllParams ? 'Показывать по профилю' : 'Показать все параметры'}>
            {showAllParams ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
          {/* Набор характеристик, который нужен для работы, сохраняется прямо
              отсюда: человек видит те самые строки, а не вспоминает названия
              полей на пустом месте. Порядок и столбцы шаблон не хранит — это
              дело разметки таблицы */}
          <button type="button" onClick={onSaveView} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer" title="Сохранить вид: набор характеристик для «Таблицы»"><Save className="w-4 h-4" /></button>
          <button type="button" onClick={onHistory} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer" title="История версий"><History className="w-4 h-4" /></button>
          {/* Связи элемента: в каких документах, файлах и строках ВДР он
              встречается. Рядом с историей не случайно — оба вопроса задают
              перед тем, как что-то в элементе поменять. */}
          <button type="button" onClick={() => openWhereUsed('element', comp.id)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer" title="Карточка связей: теги, документы, обсуждения"><Network className="w-4 h-4" /></button>
        </div>
      </div>

      {change && (
        <div className="px-4 py-2 bg-sky-50 dark:bg-sky-950/20 border-b border-sky-200 dark:border-sky-900/40 text-xs text-sky-800 dark:text-sky-300 flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 min-w-0 truncate">
            {change.by ? `${change.by} изменил эту карточку` : 'Карточку изменили'} — вы смотрите старые данные
          </span>
          <button type="button" onClick={() => { clear(); onReload?.(); }}
            className="fx-btn fx-btn-primary fx-btn-sm shrink-0">
            Обновить
          </button>
          <button type="button" onClick={clear} title="Скрыть сообщение"
            className="shrink-0 p-0.5 rounded hover:bg-sky-100 dark:hover:bg-sky-900/40 cursor-pointer">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="px-4 py-2 bg-rose-50 dark:bg-rose-950/20 border-b border-rose-200 dark:border-rose-900/40 text-xs text-rose-700 dark:text-rose-400 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" /> Данные изменились в {conflicts.length} параметрах — примите расчёт ✓ или измените вручную ✎
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 @container">
        <div className="mb-3"><CatalogSourcePanel componentId={comp.id} version={comp.version} equipClass={props.typed?.cls || comp.equipClass || comp.equipType} onChanged={() => onReload?.()} /></div>
        {specs.groups.length === 0 && (
          <div className="text-xs text-slate-400 text-center py-6">У этого элемента нет параметров.</div>
        )}
        {/* Группы читаются сверху вниз; сетка не разрывает одну группу между колонками. */}
        <div className="flex items-center justify-end gap-2 mb-1">
          <button type="button" className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer" onClick={() => setExpandedGroups(Object.fromEntries(groupTitles.map(title => [title, !groupTitles.every(item => expandedGroups[item])])))}>
            {groupTitles.length && groupTitles.every(title => expandedGroups[title]) ? 'Свернуть группы' : 'Раскрыть группы'}
          </button>
        </div>
        <div className="grid grid-cols-1 gap-x-3 gap-y-2">
        {/* Порядок разделов и параметров — по виду категории для этого типа */}
        {(props.arrangeGroups ? props.arrangeGroups(specs.groups) : specs.groups).map((g: any) => {
          if (!showAllParams && props.composition?.hiddenGroups?.includes(g.title)) return null;
          const groupHidden = isHidden(comp.equipType, `g:${g.title}`);
          if (groupHidden && !showAllParams) return null;
          const visibleParams = (g.params || []).filter(p => showAllParams || !isHidden(comp.equipType, `p:${g.title}||${p.key}`));
          if ((g.params || []).length === 0 || (visibleParams.length === 0 && !showAllParams)) return null;
          return (
            <section key={g.title} className="min-w-0">
              <div className="flex items-center gap-1.5 min-h-7 border-b border-slate-200 dark:border-slate-800">
                <button type="button" aria-expanded={!!expandedGroups[g.title]} onClick={() => setExpandedGroups(current => ({ ...current, [g.title]: !current[g.title] }))} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left cursor-pointer">
                  {expandedGroups[g.title] ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-400" />}
                  <h4 className="min-w-0 truncate text-xs font-medium text-slate-600 dark:text-slate-300" title={g.title}>{g.title}</h4>
                  <span className="text-2xs tabular-nums text-slate-500 dark:text-slate-400">{visibleParams.length}</span>
                </button>
                {showAllParams && (
                  <button type="button" onClick={() => toggleHidden(comp.equipType, `g:${g.title}`)} className="text-slate-300 hover:text-slate-500 cursor-pointer" title={groupHidden ? 'Показывать группу' : 'Скрыть группу'}>
                    {groupHidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  </button>
                )}
              </div>
              {expandedGroups[g.title] && <div className="grid grid-cols-2 @[640px]:grid-cols-4 gap-x-3 divide-y divide-slate-200 dark:divide-slate-800">
                {(showAllParams ? g.params : visibleParams).map(p => {
                  const token = `p:${g.title}||${p.key}`;
                  const pHidden = isHidden(comp.equipType, token);
                  const conf = conflictOf(g.title, p.key);
                  const overridden = overrides[`${g.title}||${p.key}`] !== undefined;
                  const catalogLocked = catalogOrigins.has(`${g.title}||${p.key}`) && !overridden;
                  const isEditing = editKey === token;
                  const isHl = !!hlNorm && String(p.key || '').trim().toLowerCase() === hlNorm;
                  const fullRow = String(p.key || '').length > 38 || String(p.value || '').length > 44 || /примеч|описани|комментар/i.test(String(p.key || '')) || /[\r\n]/.test(String(p.value || ''));
                  return (
                    <div key={p.key} {...(isHl ? { 'data-hl-param': '1' } : {})}
                      className={`col-span-2 @[640px]:col-span-2 ${fullRow ? 'col-span-full @[640px]:col-span-full' : ''} grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 min-h-7 px-1.5 py-1 text-xs transition-colors duration-300 ${pHidden && showAllParams ? 'opacity-40' : ''} ${conf ? 'bg-rose-50/60 dark:bg-rose-950/15' : ''} ${isHl ? 'bg-emerald-100 dark:bg-emerald-900/40 ring-2 ring-inset ring-emerald-400 animate-pulse rounded-md' : ''}`}>
                      {/* Ключ и значение переносятся, а не обрываются многоточием:
                          «Температура воздуха в помещении» читается целиком */}
                      <span className="u-sel text-slate-500 dark:text-slate-400 min-w-0 break-words">{p.key}</span>
                      {isEditing ? (
                        <>
                          <input value={editVal} onChange={e => setEditVal(e.target.value)} autoFocus
                            onKeyDown={e => { if (e.key === 'Enter') { onOverride(comp, g.title, p.key, editVal); setEditKey(null); } if (e.key === 'Escape') setEditKey(null); }}
                            className="w-full min-w-0 px-1.5 py-0.5 text-xs bg-white dark:bg-slate-950 border border-emerald-400 rounded" />
                          <span className="flex items-center gap-1">
                            <button type="button" onClick={() => { onOverride(comp, g.title, p.key, editVal); setEditKey(null); }} className="text-emerald-600 cursor-pointer" title="Записать (Enter)"><Check className="w-3.5 h-3.5" /></button>
                            <button type="button" onClick={() => setEditKey(null)} className="text-slate-400 cursor-pointer" title="Отмена (Esc)"><X className="w-3.5 h-3.5" /></button>
                          </span>
                        </>
                      ) : (
                        <>
                          <span className={`u-sel font-semibold min-w-0 break-words ${overridden ? 'text-amber-600 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100'}`} title={overridden ? 'Изменено вручную' : catalogLocked ? 'Значение каталога. Исправить данные каталога можно в справочнике.' : ''}>
                            {p.value}{p.unit ? <span className="text-slate-400 font-normal"> {p.unit}</span> : ''}
                          </span>
                          <span className="flex items-center gap-1 justify-end">
                          {catalogLocked ? (
                            <span className="text-xs text-slate-400" title="Данные каталога можно менять в справочнике каталога">Каталог</span>
                          ) : conf ? (
                            <span className="flex items-center gap-1 shrink-0">
                              <span className="text-2xs text-rose-500">→ {conf.newValue}</span>
                              <button type="button" onClick={() => onResolve(comp, conf, 'accept')} className="p-0.5 text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-950 rounded cursor-pointer" title="Принять значение из расчёта"><Check className="w-3.5 h-3.5" /></button>
                              <button type="button" onClick={() => { setEditKey(token); setEditVal(conf.newValue); }} className="p-0.5 text-amber-600 hover:bg-amber-100 dark:hover:bg-amber-950 rounded cursor-pointer" title="Изменить вручную"><Pencil className="w-3.5 h-3.5" /></button>
                            </span>
                          ) : (
                            <button type="button" onClick={() => { setEditKey(token); setEditVal(p.value); }} className="p-0.5 text-slate-300 hover:text-amber-500 cursor-pointer" title="Изменить вручную"><Pencil className="w-3 h-3" /></button>
                          )}
                          {showAllParams && (
                            <button type="button" onClick={() => toggleHidden(comp.equipType, token)} className="text-slate-300 hover:text-slate-500 cursor-pointer shrink-0" title={pHidden ? 'Показывать' : 'Скрыть'}>
                              {pHidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                            </button>
                          )}
                          </span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>}
            </section>
          );
        })}
        </div>
        {/* Состав следует за характеристиками, чтобы блок оставался читаемым. */}
        {(props.composition?.children?.length || 0) > 0 && (
            <div className="mb-3" data-composition>
            <div className="text-xs font-medium text-slate-400 mb-1">
              Состав · {props.composition.children.length}
            </div>
            <div className="rounded-lg border border-slate-150 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-850">
              {props.composition.children.map((c: any) => (
                <button key={c.id} type="button" onClick={() => props.onOpenPosition?.(c.id)}
                  style={{ paddingLeft: `${10 + c.depth * 16}px` }}
                  className="w-full grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-center pr-2.5 py-1.5 text-left text-xs hover:bg-emerald-50/60 dark:hover:bg-emerald-950/20 cursor-pointer">
                  <span className="min-w-0">
                    <span className="block break-words">{c.label}</span>
                    <span className="block text-2xs text-slate-400">{[props.classTitle?.(c.cls), c.kind].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className={`font-mono text-2xs ${c.tag ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-300 dark:text-slate-500'}`}>{c.tag || 'без тега'}</span>
                </button>
              ))}
            </div>
            {(props.composition.hiddenGroups?.length || 0) > 0 && !showAllParams && (
              <p className="mt-1.5 text-2xs text-slate-400">
                Разделы «{props.composition.hiddenGroups.join('», «')}» — в карточках позиций состава, здесь не повторяются.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function readExpandedGroups(storageKey: string, titles: string[]): Record<string, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return Object.fromEntries(titles.map((title, index) => [title, typeof saved[title] === 'boolean' ? saved[title] : index < 2]));
  } catch { /* старое или повреждённое состояние вида заменяется безопасным начальным */ }
  return Object.fromEntries(titles.map((title, index) => [title, index < 2]));
}
