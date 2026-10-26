/** Вкладки страницы модели: обзор, характеристики, исполнения, документы, применение в проектах. */
import React from 'react';
import type { Catalog, CatalogDocument, Family } from '../../../../catalog/model';
import { textOf } from '../../../../catalog/model';
import type { CatalogUsage } from '../../../services/catalogService';
import CatalogContents from '../CatalogContents';
import { Empty } from '../ui';
import { Block, DataTable, FactRows, ParamTable, SourceList, type Report } from './ModelParts';
import { plural } from '../../../lib/plural';
import { documentCount, type Entry } from './readerModel';

const muted = 'text-[var(--flux-text-muted)]';
const verified = (f: Family) => (f.tables || []).filter((t) => t.rows.some((r) => r.verified)).map((t) => ({ ...t, rows: t.rows.filter((r) => r.verified) }));

interface Ctx { entry: Entry; catalog: Catalog; onReport?: Report; onOpenEntry: (e: Entry) => void; siblings: Entry[] }

/** Описание из справочника бывает целой страницей текста: сворачиваем до шести строк, остальное по нажатию */
function Description({ text }: { text: string }) {
  const [full, setFull] = React.useState(false);
  const long = text.length > 420 || text.split('\n').length > 6;
  return <>
    <p className={`m-0 whitespace-pre-wrap text-[13px] leading-5 ${long && !full ? 'line-clamp-6' : ''}`}>{text}</p>
    {long && <button type="button" className="block text-xs text-[var(--flux-accent-text)] hover:underline" onClick={() => setFull((v) => !v)}>{full ? 'Свернуть' : 'Показать полностью'}</button>}
  </>;
}

/**
 * Описание из PDF часто начинается тем, что уже есть в шапке: заголовком
 * раздела «Назначение», кодом, названием, разделом комплектации. Убираем эти
 * строки, чтобы текст не повторял шапку и заголовок блока.
 */
export function cleanDescription(text: string, repeats: string[]): string {
  const known = new Set(repeats.map((r) => r.trim().toLowerCase()).filter(Boolean).concat(['назначение', 'дополнительная комплектация']));
  const kept = text.split('\n').map((line) => line.replace(/[ \t]{2,}/gu, ' ').trim()).filter((line) => !known.has(line.toLowerCase())).join('\n');
  // Текст извлечён из PDF с переносами по ширине страницы: склеиваем строки
  // абзаца и слова с переносом, абзацы (пустая строка) оставляем.
  return kept.replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2').replace(/([^\n])\n(?!\n)/gu, '$1 ').replace(/\n{3,}/gu, '\n\n').trim();
}

export function Overview({ entry, catalog, usage }: Ctx & { usage: CatalogUsage | null | 'error' }) {
  const f = entry.family; const cls = catalog.classes.find((c) => c.id === f.classId); const c = entry.component;
  const info: Array<[string, string]> = [
    ['Тип оборудования', (entry.classIds.map((id) => textOf(catalog.classes.find((x) => x.id === id)?.title)).filter(Boolean).join(', '))],
    ['Вид изделия', textOf(f.typeLabel)], ['Изготовитель', entry.maker], ['Обозначения', f.aliases?.join(', ') || ''],
    ...(c ? [['Совместимые модели', c.familyIds?.length ? c.familyIds.map((id) => catalog.families.find((x) => x.id === id)?.code || id).join(', ') : 'Не ограничены в данных каталога'] as [string, string]] : []),
  ];
  const docs = documentCount(f); const tables = f.tables?.length || 0; const used = usage && usage !== 'error' ? usage.total.projects : -1;
  const summary = [
    !entry.isComponent && f.params.length ? `${f.params.length} ${plural(f.params.length, 'параметр', 'параметра', 'параметров')} исполнения` : '',
    docs ? `${docs} ${plural(docs, 'документ', 'документа', 'документов')}` : '', tables ? `${tables} ${plural(tables, 'таблица', 'таблицы', 'таблиц')}` : '',
    !entry.isComponent && used > 0 ? `используется в ${used} ${plural(used, 'проекте', 'проектах', 'проектах')}` : '',
    !entry.isComponent && used === 0 ? 'в проектах пока не используется' : '',
  ].filter(Boolean);
  const description = cleanDescription(textOf(f.description), [f.code, textOf(f.title), ...(f.sections || []).map((x) => x.title)]);
  // Две колонки на всю ширину окна: текст слева, короткие сведения справа — без пустой правой половины.
  return <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 @[900px]:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
    <div className="min-w-0 space-y-4">
      {description && <Block title="Назначение"><Description text={description} /></Block>}
      {!!f.facts && Object.keys(f.facts).length > 0 && <Block title="Признаки модели"><FactRows facts={f.facts} definitions={cls?.facts || []} /></Block>}
      <CatalogContents key={f.id} sections={f.sections || []} />
    </div>
    <aside className="min-w-0 space-y-4 @[900px]:sticky @[900px]:top-0">
      <Block title="Общие сведения"><dl className="cat-def cat-def-compact">{info.filter(([, v]) => v).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
        {summary.length > 0 && <p className={`m-0 text-xs ${muted}`}>{summary.join(' · ')}</p>}</Block>
      {f.status !== 'full' && f.todo?.length ? <Block title="Что сверить с каталогом производителя"><ul className="m-0 pl-4 text-[13px]">{f.todo.map((t) => <li key={t}>{t}</li>)}</ul></Block> : null}
    </aside>
  </div>;
}

export function Specs({ entry, catalog, onReport }: Ctx) {
  const f = entry.family;
  return <div className="flex flex-col gap-4">
    <CatalogContents key={`${f.id}-specs`} sections={f.sections || []} kind="specs" />
    {verified(f).map((t) => <DataTable key={t.id} table={t} onReport={onReport} />)}
    {f.specs.length > 0 && <Block title="Данные спецификации"><dl className="cat-def">{f.specs.map((s, i) => <React.Fragment key={`${s.key}-${i}`}><dt>{textOf(s.label)}</dt><dd>{textOf(s.value)}{s.unit ? ` ${s.unit}` : ''}</dd></React.Fragment>)}</dl></Block>}
    {!f.sections?.length && !verified(f).length && !f.specs.length && <FactRows facts={f.facts} definitions={catalog.classes.find((c) => c.id === f.classId)?.facts || []} />}
  </div>;
}

export function Variants({ entry, onReport, onOpenEntry, siblings }: Ctx) {
  const f = entry.family;
  return <div className="flex flex-col gap-4">
    {!entry.isComponent && <Block title="Исполнения по параметрам"><ParamTable family={f} onReport={onReport} /></Block>}
    <Block title={entry.isComponent ? 'Подходящие модели' : 'Другие модели этого типа'}>
      {siblings.length ? <ul className="m-0 grid list-none grid-cols-1 gap-x-6 p-0 @[640px]:grid-cols-2">{siblings.map((s) => <li key={s.family.id}>
        <button type="button" className="fx-li !h-auto min-h-8 py-1" onClick={() => onOpenEntry(s)}>
          <span className="font-mono">{s.family.code}</span><span className={`min-w-0 flex-1 truncate ${muted}`}>{textOf(s.family.title)}</span></button></li>)}</ul>
        : <p className={`m-0 text-xs ${muted}`}>{entry.isComponent ? 'Совместимые модели в данных не указаны.' : 'Других моделей этого типа у изготовителя пока нет.'}</p>}
    </Block>
  </div>;
}

export function Documents({ entry, onReport, onOpenDocument }: Ctx & { onOpenDocument: (d: CatalogDocument) => void }) {
  const f = entry.family;
  return <div className="space-y-4">
    <Block title="Документы"><SourceList family={f} onOpen={onOpenDocument} /></Block>
    <CatalogContents key={`${f.id}-docs`} sections={f.sections || []} />
    {verified(f).map((t) => <DataTable key={t.id} table={t} onReport={onReport} />)}
    {f.rules.length > 0 && <Block title="Примечания к применению"><ul className="m-0 list-none p-0">{f.rules.map((r) => <li key={r.id} className="border-b border-[var(--flux-line)] py-2 text-[13px]">{r.message}</li>)}</ul></Block>}
  </div>;
}

export function Usage({ entry, usage }: { entry: Entry; usage: CatalogUsage | null | 'error' }) {
  if (entry.isComponent) return <Empty title="Учёт по комплектующим не ведётся" text="Комплектующие подбираются внутри позиций ведомостей. Смотрите применение у модели изделия." />;
  if (usage === null) return <p role="status" className={`text-xs ${muted}`}>Проверяю ведомости…</p>;
  if (usage === 'error') return <p role="alert" className="text-xs text-[var(--flux-bad-text)]">Не удалось получить список проектов.</p>;
  if (!usage.usage.length) return <Empty title="В проектах не используется" text="Эта модель пока не выбрана ни в одной ведомости Конструктора из доступных вам проектов." />;
  return <div>
    <p className={`mb-2 text-xs ${muted}`}>{usage.total.projects} проектов · {usage.total.items} позиций · {usage.total.qty} шт.</p>
    <table className="fx-table"><thead><tr><th>Проект</th><th>Ведомости</th><th className="text-right">Позиций</th><th className="text-right">Количество</th></tr></thead>
      <tbody>{usage.usage.map((p) => <tr key={p.projectId}>
        <td><span>{p.projectName}</span>{p.projectCode && <span className={`ml-2 font-mono text-xs ${muted}`}>{p.projectCode}</span>}</td>
        <td className={`max-w-0 truncate ${muted}`}>{p.lists.map((l) => l.name).join(', ')}</td>
        <td className="text-right tabular-nums">{p.items}</td><td className="text-right tabular-nums">{p.qty}</td></tr>)}</tbody></table>
  </div>;
}
