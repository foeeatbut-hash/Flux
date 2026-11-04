import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import CustomSelect from '../CustomSelect';
import { Btn, FilterSeg, Status, type Tone } from '../ui';

/**
 * Таблица плана импорта XML: одна позиция — одна строка.
 *
 * Было: на каждую позицию блок «Тег «…» · Моноблок 1» с селектором во всю
 * ширину, три десятка таких блоков листались в окошке в 18 строк. Теперь
 * слева наименование из XML, рядом распознанный тег, правее компактный селектор
 * действия с тегом; сводка плана — фильтр, групповые действия — над таблицей.
 * Решения (`tagLinkChoices`) остаются в окне импорта: таблица только показывает
 * их и отдаёт изменения наверх.
 */

type Filter = 'all' | 'new' | 'update' | 'same' | 'attention';
const SEP = '‖'; // тот же разделитель, что у blockKey на сервере: система‖моноблок‖код
const needsChoice = (link: any) => ['ambiguous', 'invalid'].includes(link?.action);
export const linkKeyOf = (link: any) => `${link.blockKey}\u0000${link.identifier}`;

/** Что выбрано в селекторе сейчас: решение инженера или предложение плана. */
export function currentLinkValue(link: any, choices: Record<string, string>): string {
  const own = choices[linkKeyOf(link)];
  if (own !== undefined) return own;
  if (needsChoice(link)) return '';
  return link.action === 'link' && link.existingTagId ? `link:${link.existingTagId}` : link.action;
}

function optionsFor(link: any): Array<{ value: string; label: string }> {
  return [
    ...(link.existingTagId ? [{ value: `link:${link.existingTagId}`, label: 'Связать с точным тегом' }] : []),
    ...(link.candidates || []).map((c: any) => ({ value: `link:${c.id}`, label: `Связать с ${c.identifier}` })),
    { value: 'create', label: 'Создать новый тег' },
    { value: 'skip', label: 'Пропустить тег' },
  ];
}

/** Короткая подпись в закрытом селекторе: полная — в списке. */
const SHORT: Array<[RegExp, string]> = [[/^Связать с точным тегом$/, 'Связать'], [/^Создать новый тег$/, 'Создать'], [/^Пропустить тег$/, 'Пропустить']];
const shortLabel = (label: string) => SHORT.find(([re]) => re.test(label))?.[1] || label;

interface Row {
  id: string; title: string; mono: string; tag: string; link: any | null;
  state: 'system' | 'new' | 'update' | 'same';
  changed: number; overrides: number; params: any[];
  /** Тег установки решается в строке её корневой записи (__unit__), а не здесь */
  delegated?: boolean;
}

function buildRows(plan: any): Row[] {
  const links: any[] = plan?.tagLinks || [];
  const used = new Set<any>();
  const linkOf = (key: string) => { const found = links.find(l => l.blockKey === key); if (found) used.add(found); return found || null; };
  const rows: Row[] = [];
  // У настоящего плана есть корневая запись установки (__unit__) — блок с тем же ключом, что и у
  // тега установки. Селектор тега тогда живёт в её строке, а строка системы только называет тег:
  // иначе одно решение показывалось двумя селекторами и считалось в «Создать все новые» дважды
  const blockKeys = new Set<string>((plan?.blocks || []).map((block: any) => block.key));
  for (const [index, system] of (plan?.systems || plan?.units || []).entries()) {
    const unitKey = `${system.name}${SEP}${SEP}__unit__`;
    const delegated = blockKeys.has(unitKey);
    const link = delegated ? null : linkOf(unitKey);
    const named = delegated ? links.find(l => l.blockKey === unitKey) : link;
    rows.push({ id: `system:${system.name}:${index}`, title: system.title && system.title !== system.name ? system.title : 'Установка', mono: system.action === 'match' ? 'обновится' : 'будет создана', tag: named?.identifier || system.name || '', link, delegated, state: 'system', changed: 0, overrides: 0, params: [] });
  }
  for (const [index, block] of (plan?.blocks || []).entries()) {
    const link = linkOf(block.key);
    const params = (Array.isArray(block.params) ? block.params : []).filter((p: any) => p.status !== 'same');
    rows.push({
      id: `block:${block.key || block.itemCode}:${index}`, title: block.title || block.itemCode || 'Позиция',
      // Тип — только когда он что-то добавляет к названию («Вентилятор 1» уже говорит «вентилятор»)
      mono: [block.monoblockName, block.equipType && !String(block.title || '').toLowerCase().includes(String(block.equipType).toLowerCase()) && String(block.equipType).toLowerCase()].filter(Boolean).join(' · '),
      tag: link?.identifier || '', link, state: block.action === 'create' ? 'new' : block.action === 'update' ? 'update' : 'same',
      changed: block.changedCount || 0, overrides: block.overrideImpact || 0, params,
    });
  }
  // Тег, у которого в плане нет своей позиции, всё равно решается — строкой с кодом из ключа
  for (const link of links) if (!used.has(link)) {
    const [, mono = '', code = ''] = String(link.blockKey).split(SEP);
    rows.push({ id: `link:${linkKeyOf(link)}`, title: code || 'Позиция', mono, tag: link.identifier, link, state: 'same', changed: 0, overrides: 0, params: [] });
  }
  return rows;
}

const STATE: Record<Row['state'], { label: string; tone: Tone }> = {
  system: { label: 'Установка', tone: 'sky' }, new: { label: 'Новая', tone: 'emerald' },
  update: { label: 'Изменится', tone: 'amber' }, same: { label: 'Без изменений', tone: 'slate' },
};

export default function ImportPlanTable({ plan, choices, onChoices, disabled }: {
  plan: any; choices: Record<string, string>; onChoices: (patch: Record<string, string>) => void; disabled: boolean;
}) {
  const rows = useMemo(() => buildRows(plan), [plan]);
  const [filter, setFilter] = useState<Filter>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<string[]>([]);
  const unresolved = (row: Row) => !!row.link && needsChoice(row.link) && !choices[linkKeyOf(row.link)];
  const count = (test: (row: Row) => boolean) => rows.filter(test).length;
  const attention = count(unresolved);
  // Когда всё спорное решено, пункт «Требуют выбора» исчезает — вместе с пустой выдачей под ним
  const shown: Filter = filter === 'attention' && !attention ? 'all' : filter;
  const visible = rows.filter(row => shown === 'all' ? true : shown === 'attention' ? unresolved(row) : row.state === shown);
  const systems = (plan?.systems || plan?.units || []).length;
  const allPicked = visible.length > 0 && visible.every(row => picked.includes(row.id));

  // Групповое действие идёт над отмеченными строками, а без отметок — над видимыми
  const scope = (picked.length ? rows.filter(row => picked.includes(row.id)) : visible).filter(row => row.link);
  const forCreate = scope.filter(row => row.link.action === 'create');
  const forLink = scope.filter(row => row.link.existingTagId);
  const bulk = (targets: Row[], value: (row: Row) => string) => onChoices(Object.fromEntries(targets.map(row => [linkKeyOf(row.link), value(row)])));
  const toggle = (list: string[], id: string) => list.includes(id) ? list.filter(item => item !== id) : [...list, id];

  return <div className="@container min-w-0">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pb-2">
      <span className="fx-hint tabular-nums">Систем: {plan?.totals?.systems ?? systems}</span>
      <FilterSeg<Filter> label="Показать позиции" value={shown} onChange={setFilter} options={[
        { value: 'all', label: 'Все', count: rows.length },
        { value: 'new', label: 'Новых', count: count(row => row.state === 'new') },
        { value: 'update', label: 'Обновлений', count: count(row => row.state === 'update') },
        { value: 'same', label: 'Без изменений', count: count(row => row.state === 'same') },
        ...(attention ? [{ value: 'attention' as const, label: 'Требуют выбора', count: attention }] : []),
      ]} />
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <span className="fx-hint">{picked.length ? `Выбрано: ${picked.length}` : 'Для всех показанных'}</span>
        <Btn size="sm" disabled={disabled || !forCreate.length} onClick={() => bulk(forCreate, () => 'create')} title="Завести новые теги там, где точного совпадения в проекте нет">Создать все новые{forCreate.length ? ` · ${forCreate.length}` : ''}</Btn>
        <Btn size="sm" disabled={disabled || !forLink.length} onClick={() => bulk(forLink, row => `link:${row.link.existingTagId}`)} title="Связать с тегами проекта, совпавшими по написанию точно">Связать все точные{forLink.length ? ` · ${forLink.length}` : ''}</Btn>
        {picked.length > 0 && <Btn size="sm" tone="ghost" disabled={disabled} onClick={() => bulk(scope, () => 'skip')}>Пропустить выбранные</Btn>}
      </div>
    </div>
    <table className="fx-table w-full table-fixed">
      <thead><tr>
        <th className="hidden w-8 @xl:table-cell"><input type="checkbox" aria-label="Выбрать все показанные" checked={allPicked} disabled={!visible.length} onChange={() => setPicked(allPicked ? [] : visible.map(row => row.id))} /></th>
        <th>Наименование</th>
        <th className="w-24 @xl:w-40">Тег</th>
        <th className="hidden w-32 @2xl:table-cell">Позиция</th>
        <th className="w-28 @xl:w-40">Действие</th>
      </tr></thead>
      <tbody>
        {visible.map(row => {
          const expanded = open.includes(row.id) && row.params.length > 0;
          const bad = unresolved(row);
          const value = row.link ? currentLinkValue(row.link, choices) : '';
          const options = row.link ? optionsFor(row.link).map(o => ({ ...o, label: o.label })) : [];
          return <Fragment key={row.id}>
            <tr aria-selected={picked.includes(row.id) || undefined}>
              <td className="hidden @xl:table-cell"><input type="checkbox" aria-label={`Выбрать ${row.title}`} checked={picked.includes(row.id)} onChange={() => setPicked(list => toggle(list, row.id))} /></td>
              <td className="min-w-0">
                <div className="flex min-w-0 items-center gap-1">
                  {row.params.length > 0
                    ? <button type="button" className="fx-ibtn shrink-0" aria-expanded={expanded} aria-label={expanded ? `Скрыть отличия: ${row.title}` : `Показать отличия: ${row.title}`} onClick={() => setOpen(list => toggle(list, row.id))}>{expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button>
                    : <span className="w-6 shrink-0" />}
                  <span className="truncate" title={`${row.title}${row.mono ? ` · ${row.mono}` : ''}`}>{row.title}{row.mono && <span className="ml-1.5 text-[var(--flux-text-muted)]">{row.mono}</span>}</span>
                </div>
              </td>
              <td className="min-w-0"><span className="block truncate font-mono text-xs" title={row.link?.problem ? `${row.tag}: ${row.link.problem}` : row.tag}>{row.tag || <span className="text-[var(--flux-text-faint)]">—</span>}</span></td>
              <td className="hidden @2xl:table-cell"><Status tone={bad ? 'rose' : STATE[row.state].tone} title={row.overrides ? `Ручных значений под заменой: ${row.overrides}` : undefined}>{STATE[row.state].label}{row.state === 'update' && row.changed ? ` · ${row.changed}` : ''}</Status></td>
              <td>{row.link
                ? <CustomSelect ariaLabel={`Действие с тегом ${row.tag}`} disabled={disabled} value={value} placeholder="Выберите…" menuAlign="right" menuClassName="min-w-64"
                    options={options.map(o => ({ ...o, label: o.value === value ? shortLabel(o.label) : o.label }))} onChange={next => onChoices({ [linkKeyOf(row.link)]: next })}
                    className={bad ? '[&>button]:border-[var(--flux-bad-text)]' : ''} />
                : <span className="text-[var(--flux-text-faint)]" title={row.delegated ? 'Тег установки выбирается в строке её корневой записи ниже' : undefined}>{row.delegated ? '—' : 'без тега'}</span>}</td>
            </tr>
            {expanded && <tr><td className="hidden @xl:table-cell" />
              <td colSpan={4} className="!h-auto py-1.5">
                <ul className="grid gap-x-4 gap-y-0.5 text-xs text-[var(--flux-text-muted)] @2xl:grid-cols-2">
                  {row.params.map((param: any, index: number) => <li key={`${param.group}:${param.key}:${index}`} className="break-words">{param.group ? `${param.group} · ` : ''}{param.key}: {param.oldValue ?? '—'} → {param.value}{param.unit ? ` ${param.unit}` : ''}{param.warning && <span className="ml-1 text-amber-700 dark:text-amber-300">· {param.warning}</span>}</li>)}
                </ul>
              </td></tr>}
          </Fragment>;
        })}
        {!visible.length && <tr><td colSpan={5} className="!h-auto py-3 text-center text-[var(--flux-text-muted)]">{rows.length ? 'В этом разделе плана позиций нет.' : 'Сервер не вернул позиции для показа. Импорт заблокирован до корректного плана.'}</td></tr>}
      </tbody>
    </table>
  </div>;
}
