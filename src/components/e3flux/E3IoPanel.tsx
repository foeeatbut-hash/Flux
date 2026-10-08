/**
 * «Таблица IO» (docs/e3-integration.md, 5.4 и 5.9): сколько сигналов DI/DO/AI/AO
 * даёт каждый вид устройства и какое изделие E3 ставится для строки, плюс
 * правила, которыми решение и его признаки превращаются в строки таблицы.
 * Загружается вместе с классификатором (лист «Таблица IO»); имя изделия E3 и
 * правила — настройки каталога, файл их не трогает. Строка и правило правятся
 * в диалоге, как «Правила» признаков.
 */
import React, { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { IO_KEYS } from '../../../e3/ioTable';
import type { E3IoRow, E3IoRule } from '../../../e3/solutionTypes';
import { e3SolutionsService as svc } from '../../services/e3SolutionsService';
import { Btn, Empty, FilterSeg, Input, SectionHead, Tabs, Toolbar } from '../ui';
import { confirmAsk } from '../catalog/ui';
import E3IoRowDialog from './E3IoRowDialog';
import E3IoRuleDialog from './E3IoRuleDialog';
import { ioCountText, ioRefText, ioWhenText } from './e3IoText';
import type { SolutionBookState } from './useSolutionBook';

const muted = 'text-slate-500 dark:text-slate-400';
type Tab = 'rows' | 'rules';
type View = 'all' | 'open';

export default function E3IoPanel({ state, rights }: { state: SolutionBookState; rights: { edit: boolean } }) {
  const { book, error, busy, run } = state;
  const [tab, setTab] = useState<Tab>('rows');
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>('all');
  const [editRow, setEditRow] = useState<string | null>(null); // id строки; '' — новая
  const [editRule, setEditRule] = useState<string | null>(null); // id правила; '' — новое
  const [dialogError, setDialogError] = useState('');

  const rows = book?.ioTable || [];
  const rules = book?.ioRules || [];
  const features = book?.features || [];
  const title = (id: string) => features.find((f) => f.id === id)?.title || id;
  const groups = useMemo(() => [...new Set(rows.map((r) => r.group).filter(Boolean))], [rows]);
  const classes = useMemo(() => [...new Set([...features.map((f) => f.mainClass), ...rules.map((r) => r.mainClass)].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [features, rules]);
  const noName = rows.filter((r) => !r.component?.trim()).length;
  const shown = useMemo(() => {
    const low = q.trim().toLocaleLowerCase('ru');
    return rows.filter((r) => (view === 'all' || !r.component?.trim()) && (!low || `${r.group} ${r.name} ${r.code} ${r.component || ''}`.toLocaleLowerCase('ru').includes(low)));
  }, [rows, q, view]);
  const shownRules = useMemo(() => {
    const low = q.trim().toLocaleLowerCase('ru');
    return rules.filter((r) => !low || `${r.title} ${r.mainClass} ${r.role} ${r.row.name || ''} ${r.row.code || ''}`.toLocaleLowerCase('ru').includes(low));
  }, [rules, q]);
  const open = (setter: (v: string | null) => void, id: string) => { setDialogError(''); setter(id); };
  const closeRow = () => { setEditRow(null); setDialogError(''); };
  const closeRule = () => { setEditRule(null); setDialogError(''); };
  const row = editRow ? rows.find((r) => r.id === editRow) || null : null;
  const rule = editRule ? rules.find((r) => r.id === editRule) || null : null;

  const saveRow = async (r: E3IoRow) => { if (await run((v) => (editRow === '' ? svc.createIoRow(r, v) : svc.saveIoRow(r, v)), setDialogError)) closeRow(); };
  const removeRow = async () => {
    if (!row) return;
    if (!(await confirmAsk('Удалить строку таблицы IO?', `«${row.name}» исчезнет из каталога. Правила состава, которые на неё ссылались, перестанут находить строку. Повторная загрузка файла вернёт строку, если она в нём есть.`, { confirmLabel: 'Удалить', tone: 'danger' }))) return;
    if (await run((v) => svc.deleteIoRow(row.id, v), setDialogError)) closeRow();
  };
  const saveRule = async (r: E3IoRule) => { if (await run((v) => (editRule === '' ? svc.createIoRule(r, v) : svc.saveIoRule(r, v)), setDialogError)) closeRule(); };
  const removeRule = async () => {
    if (!rule) return;
    if (!(await confirmAsk('Удалить правило состава?', `«${rule.title}»: решения этого класса перестанут получать из него изделия в блоке.`, { confirmLabel: 'Удалить', tone: 'danger' }))) return;
    if (await run((v) => svc.deleteIoRule(rule.id, v), setDialogError)) closeRule();
  };
  const keys = (e: React.KeyboardEvent, go: () => void) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(); } };

  return (
    <div className="fx-page min-w-0">
      <SectionHead title="Таблица IO"
        actions={rights.edit && <Btn tone="primary" disabled={busy || !book} onClick={() => (tab === 'rows' ? open(setEditRow, '') : open(setEditRule, ''))}>
          <Plus className="w-3.5 h-3.5" /> {tab === 'rows' ? 'Добавить строку' : 'Добавить правило'}</Btn>}>
        <Tabs label="Что показать" value={tab} onChange={(t) => { setTab(t); setQ(''); }} tabs={[{ value: 'rows', label: 'Строки', count: rows.length, title: 'Сигналы по видам устройств и изделия E3' }, { value: 'rules', label: 'Правила состава', count: rules.length, title: 'Как решение и его признаки превращаются в строки таблицы' }]} />
      </SectionHead>
      {error && editRow === null && editRule === null && <p role="alert" className="fx-error px-4 py-1">{error}</p>}
      {!book ? <p className={`p-4 text-sm ${muted}`}>{error ? '' : 'Загружаю каталог…'}</p> : <>
        <Toolbar>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'rows' ? 'Группа, наименование или изделие' : 'Название, класс или строка'} aria-label="Поиск" className="max-w-[360px] flex-1" />
          {tab === 'rows' && <FilterSeg label="Какие строки показать" value={view} onChange={setView} options={[
            { value: 'all', label: 'Все', count: rows.length },
            { value: 'open', label: 'Без изделия E3', count: noName, hint: 'Для этих строк рецепт не знает, какой компонент ставить' },
          ]} />}
        </Toolbar>
        <div className="fx-page-body">
          {tab === 'rows' ? (!rows.length ? <div className="p-4"><Empty title="Таблица IO пуста" text="Она читается вместе с классификатором: загрузите файл на вкладке «Решения» — лист «Таблица IO» прочитается по имени. Строки можно и добавить вручную." /></div>
            : !shown.length ? <div className="p-4"><Empty title="Строки не найдены" text="Измените поиск или отбор." /></div> : (
              <table className="fx-table text-left">
                <thead><tr><th>Группа</th><th>Наименование</th><th>Обозначение</th>{IO_KEYS.map((k) => <th key={k} className="text-right">{k.toUpperCase()}</th>)}<th>Изделие E3</th></tr></thead>
                <tbody>{shown.map((r) => (
                  <tr key={r.id} tabIndex={0} role="button" className="cursor-pointer" onClick={() => open(setEditRow, r.id)} onKeyDown={(e) => keys(e, () => open(setEditRow, r.id))}>
                    <td className={`whitespace-nowrap ${r.group ? '' : muted}`}>{r.group || '—'}</td>
                    <td className="max-w-[320px] truncate" title={r.name}>{r.name}</td>
                    <td className={`whitespace-nowrap font-mono ${r.code ? '' : muted}`}>{r.code || '—'}</td>
                    {IO_KEYS.map((k) => <td key={k} className={`text-right tabular-nums ${r[k] ? '' : muted}`}>{r[k] || '—'}</td>)}
                    <td className={`max-w-[240px] truncate font-mono ${r.component ? '' : muted}`} title={r.component}>{r.component || '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            ))
            : (!rules.length ? <div className="p-4"><Empty title="Правил состава нет" text="Правило превращает ответы решения на признаки в строки таблицы IO: например, «пружинный привод клапана — строка с пружинным приводом». Стартовые правила добавляет «Добавить недостающее» в разделе «Признаки»." /></div>
              : !shownRules.length ? <div className="p-4"><Empty title="Правила не найдены" text="Измените поиск." /></div> : (
                <table className="fx-table text-left">
                  <thead><tr><th>Класс</th><th>Правило</th><th>Условие</th><th>Роль</th><th>Строка таблицы IO</th><th>Сколько</th></tr></thead>
                  <tbody>{shownRules.map((r) => (
                    <tr key={r.id} tabIndex={0} role="button" className="cursor-pointer" onClick={() => open(setEditRule, r.id)} onKeyDown={(e) => keys(e, () => open(setEditRule, r.id))}>
                      <td className="whitespace-nowrap">{r.mainClass}</td>
                      <td className="max-w-[240px] truncate" title={r.id}>{r.title}</td>
                      <td className="max-w-[260px] truncate" title={ioWhenText(r, title)}>{ioWhenText(r, title)}</td>
                      <td className="whitespace-nowrap">{r.role}</td>
                      <td className="max-w-[260px] truncate" title={ioRefText(r.row)}>{r.row.name || r.row.code || r.row.group}</td>
                      <td className="max-w-[200px] truncate tabular-nums" title={ioCountText(r.count, title)}>{ioCountText(r.count, title)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ))}
        </div>
      </>}
      {editRow !== null && book && (editRow === '' || row) && <E3IoRowDialog key={`${editRow}:${book.version}`} row={row} existing={rows.map((r) => r.id)} groups={groups} canEdit={rights.edit} busy={busy}
        error={dialogError} onSave={(r) => void saveRow(r)} onDelete={() => void removeRow()} onClose={closeRow} />}
      {editRule !== null && book && (editRule === '' || rule) && <E3IoRuleDialog key={`${editRule}:${book.version}`} rule={rule} classes={classes} features={features} groups={groups} canEdit={rights.edit} busy={busy}
        error={dialogError} onSave={(r) => void saveRule(r)} onDelete={() => void removeRule()} onClose={closeRule} />}
    </div>
  );
}
