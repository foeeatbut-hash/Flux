import React, { useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { CatalogDocument, CatalogRef, CatalogTable, Family } from '../../../catalog/model';
import { Btn, Field, Input, Select, SectionTitle } from './ui';
import { uploadCatalogAsset } from '../../services/catalogAssetService';
import { attachCatalogSource } from '../../../catalog/sources';
import CatalogSectionEditor from './CatalogSectionEditor';
import ImportFileChooser from '../ImportFileChooser';

function id(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function refField(ref: CatalogRef | undefined, key: keyof CatalogRef, value: string): CatalogRef | undefined {
  const next = { ...(ref || { file: '' }), [key]: value || undefined, file: (key === 'file' ? value : ref?.file) || '' };
  return next.file || next.pages || next.edition || next.assetId || next.physicalPage || next.printedPage ? next : undefined;
}

function emptyTable(): CatalogTable {
  return { id: id('table'), title: 'Новая таблица', columns: [], rows: [] };
}

function emptyDocument(): CatalogDocument {
  return { id: id('doc'), label: 'Документ', kind: 'manual', file: '' };
}

function emptyRow(table: CatalogTable): CatalogTable['rows'][number] {
  return { id: id('row'), values: Object.fromEntries(table.columns.map((column) => [column.key, ''])), verified: false };
}

export default function CatalogSourceEditor({ family, onChange, readOnly }: {
  family: Family; onChange: (family: Family) => void; readOnly?: boolean;
}) {
  const familyRef = useRef(family);
  familyRef.current = family;
  const [uploads, setUploads] = useState<Record<string, { progress: number; error?: string }>>({});
  const upload = async (key: string, file: File, attach: (current: Family, assetId: string, name: string) => Family) => {
    const sourceFamily = familyRef.current;
    setUploads((items) => ({ ...items, [key]: { progress: 0 } }));
    try {
      const assetId = await uploadCatalogAsset(file, sourceFamily, (progress) => setUploads((items) => ({ ...items, [key]: { progress } })));
      if (familyRef.current.id !== sourceFamily.id) throw new Error('Файл загружен для предыдущей модели и не привязан к текущей. Повторите загрузку в исходной карточке.');
      const current = familyRef.current;
      const originalRef = key === 'catalog' ? sourceFamily.catalog : sourceFamily.documents?.find(d => key === `document:${d.id}`);
      if (key.startsWith('document:') && !current.documents?.some(d => key === `document:${d.id}`)) throw new Error('Документ удалён во время загрузки. Добавьте его снова, чтобы привязать файл.');
      const currentRef = key === 'catalog' ? current.catalog : current.documents?.find(d => key === `document:${d.id}`);
      if ((originalRef?.file || '') !== (currentRef?.file || '') || (originalRef?.edition || '') !== (currentRef?.edition || '')) throw new Error('Ссылка или редакция источника изменена во время загрузки. Проверьте её и повторите привязку файла.');
      onChange(attach(attachCatalogSource(current, originalRef, assetId), assetId, file.name));
      setUploads((items) => { const next = { ...items }; delete next[key]; return next; });
    } catch (error) {
      setUploads((items) => ({ ...items, [key]: { progress: items[key]?.progress || 0, error: error instanceof Error ? error.message : 'Файл не загружен' } }));
    }
  };
  const uploadControl = (key: string, label: string, attach: (current: Family, assetId: string, name: string) => Family) => {
    const state = uploads[key];
    const busy = !!state && !state.error;
    return <div className="flex flex-col items-start gap-1">
      <ImportFileChooser disabled={readOnly || busy} className={`fx-btn fx-btn-sm ${readOnly || busy ? 'opacity-50' : ''}`} label={busy ? `Загрузка ${Math.round(state.progress * 100)}%` : state?.error ? 'Повторить загрузку' : label} onFiles={files => { if (files[0]) void upload(key, files[0], attach); }} />
      {state?.error && <span role="alert" className="text-xs text-rose-600 dark:text-rose-400">{state.error}</span>}
    </div>;
  };
  const setCatalog = (key: keyof CatalogRef, value: string) => onChange({ ...family, catalog: refField(family.catalog, key, value) });
  const setDocument = (index: number, patch: Partial<CatalogDocument>) => onChange({
    ...family, documents: (family.documents || []).map((document, position) => position === index ? { ...document, ...patch } : document),
  });
  const removeDocument = (index: number) => onChange({ ...family, documents: (family.documents || []).filter((_, position) => position !== index) });
  const setTable = (index: number, next: CatalogTable) => onChange({ ...family, tables: (family.tables || []).map((table, position) => position === index ? next : table) });
  const removeTable = (index: number) => onChange({ ...family, tables: (family.tables || []).filter((_, position) => position !== index) });

  return <div className="flex flex-col gap-4">
    <CatalogSectionEditor sections={family.sections || []} readOnly={readOnly} onChange={sections => onChange({ ...family, sections })} />
    <section className="flex flex-col gap-2">
      <SectionTitle>Источник модели</SectionTitle>
      <div className="grid grid-cols-1 gap-2 @[700px]:grid-cols-3">
        <Field label="Файл каталога"><Input value={family.catalog?.file || ''} onChange={(event) => setCatalog('file', event.target.value)} placeholder="Название PDF или документа" disabled={readOnly} /></Field>
        <Field label="Страницы"><Input value={family.catalog?.pages || ''} onChange={(event) => setCatalog('pages', event.target.value)} placeholder="например, 12–14" disabled={readOnly} /></Field>
        <Field label="Редакция"><Input value={family.catalog?.edition || ''} onChange={(event) => setCatalog('edition', event.target.value)} placeholder="Обозначение или дата" disabled={readOnly} /></Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {family.catalog?.assetId ? <p className="text-xs text-slate-500 dark:text-slate-400">К файлу привязано вложение.</p> : family.catalog?.file ? <p className="text-xs text-slate-500 dark:text-slate-400">Указана ссылка на источник; файл ещё не загружен.</p> : null}
        {uploadControl('catalog', family.catalog?.assetId ? 'Заменить файл' : 'Прикрепить файл', (current, assetId, name) => ({ ...current, catalog: { ...(current.catalog || { file: '' }), file: current.catalog?.file || name, assetId } }))}
      </div>
    </section>

    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2"><SectionTitle>Документы</SectionTitle><span className="text-xs text-slate-500 dark:text-slate-400">{family.documents?.length || 0}</span>
        {!readOnly && <Btn className="ml-auto" onClick={() => onChange({ ...family, documents: [...(family.documents || []), emptyDocument()] })}><Plus className="h-3 w-3" /> Документ</Btn>}
      </div>
      {(family.documents || []).map((document, index) => <div key={document.id} className="grid grid-cols-1 items-end gap-2 border-b border-slate-100 pb-2 dark:border-slate-800 @[850px]:grid-cols-[minmax(120px,1fr)_130px_minmax(160px,1.4fr)_100px_90px_90px_110px_auto]">
        <Field label="Название"><Input value={document.label} onChange={(event) => setDocument(index, { label: event.target.value })} placeholder="Руководство" disabled={readOnly} /></Field>
        <Field label="Вид"><Select value={document.kind} onChange={(value) => setDocument(index, { kind: value as CatalogDocument['kind'] })} disabled={readOnly} options={[
          { value: 'manual', label: 'Руководство' }, { value: 'image', label: 'Изображение' }, { value: 'drawing', label: 'Чертёж' }, { value: 'curve', label: 'График' },
        ]} /></Field>
        <Field label="Файл"><Input value={document.file} onChange={(event) => setDocument(index, { file: event.target.value })} placeholder="Имя исходного файла" disabled={readOnly} /></Field>
        <Field label="Страницы"><Input value={document.pages || ''} onChange={(event) => setDocument(index, { pages: event.target.value || undefined })} placeholder="12–14" disabled={readOnly} /></Field>
        <Field label="Физ. страница"><Input value={document.physicalPage ?? ''} onChange={(event) => { const raw = event.target.value; setDocument(index, { physicalPage: /^\d+$/.test(raw) ? Number(raw) : undefined }); }} placeholder="12" type="number" min="1" step="1" disabled={readOnly} /></Field>
        <Field label="Печатная стр."><Input value={document.printedPage || ''} onChange={(event) => setDocument(index, { printedPage: event.target.value || undefined })} placeholder="8" disabled={readOnly} /></Field>
        <Field label="Редакция"><Input value={document.edition || ''} onChange={(event) => setDocument(index, { edition: event.target.value || undefined })} placeholder="2024" disabled={readOnly} /></Field>
        {!readOnly && <Btn tone="ghost" onClick={() => removeDocument(index)} aria-label="Удалить документ"><Trash2 className="h-3 w-3" /></Btn>}
        <div className="col-span-full flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500 dark:text-slate-400">{document.assetId ? 'Файл загружен и привязан к записи.' : document.file ? 'Файл ещё не загружен.' : 'Добавьте имя файла или загрузите вложение.'}</span>
          {uploadControl(`document:${document.id}`, document.assetId ? 'Заменить файл' : 'Загрузить файл', (current, assetId, name) => ({
            ...current, documents: (current.documents || []).map((item) => item.id === document.id ? { ...item, assetId, file: item.file || name } : item),
          }))}
        </div>
      </div>)}
      {!(family.documents || []).length && <p className="text-xs text-slate-500 dark:text-slate-400">Документы можно добавить отдельно от основного каталога.</p>}
    </section>

    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2"><SectionTitle>Таблицы характеристик</SectionTitle><span className="text-xs text-slate-500 dark:text-slate-400">{family.tables?.length || 0}</span>
        {!readOnly && <Btn className="ml-auto" onClick={() => onChange({ ...family, tables: [...(family.tables || []), emptyTable()] })}><Plus className="h-3 w-3" /> Таблица</Btn>}
      </div>
      {(family.tables || []).map((table, tableIndex) => <TableEditor key={table.id} table={table} readOnly={readOnly} onChange={(next) => setTable(tableIndex, next)} onRemove={() => removeTable(tableIndex)} />)}
      {!(family.tables || []).length && <p className="text-xs text-slate-500 dark:text-slate-400">Таблицы добавляются по данным источника; значения не рассчитываются и не интерполируются.</p>}
    </section>
  </div>;
}

function TableEditor({ table, onChange, onRemove, readOnly }: {
  table: CatalogTable; onChange: (table: CatalogTable) => void; onRemove: () => void; readOnly?: boolean;
}) {
  const updateColumn = (index: number, patch: Partial<CatalogTable['columns'][number]>) => {
    const columns = table.columns.map((column, position) => position === index ? { ...column, ...patch } : column);
    const rows = table.rows.map((row) => ({ ...row, values: Object.fromEntries(columns.map((column) => [column.key, row.values[column.key] ?? ''])) }));
    onChange({ ...table, columns, rows });
  };
  const removeColumn = (index: number) => {
    const columns = table.columns.filter((_, position) => position !== index);
    const rows = table.rows.map((row) => {
      const values = { ...row.values };
      delete values[table.columns[index].key];
      return { ...row, values };
    });
    onChange({ ...table, columns, rows });
  };
  const updateCell = (rowIndex: number, key: string, value: string) => onChange({
    ...table, rows: table.rows.map((row, index) => index === rowIndex ? { ...row, values: { ...row.values, [key]: value } } : row),
  });
  const updateRow = (rowIndex: number, patch: Partial<CatalogTable['rows'][number]>) => onChange({
    ...table, rows: table.rows.map((row, index) => index === rowIndex ? { ...row, ...patch } : row),
  });
  const addColumn = (role: 'input' | 'output') => {
    const key = id('axis');
    const column = { key, label: role === 'input' ? 'Параметр' : 'Значение', role } as const;
    onChange({ ...table, columns: [...table.columns, column], rows: table.rows.map((row) => ({ ...row, values: { ...row.values, [key]: '' } })) });
  };

  return <div className="flex min-w-0 flex-col gap-2 border-y border-slate-200 py-2 dark:border-slate-700">
    <div className="flex items-end gap-2"><Field label="Название таблицы" className="min-w-0 flex-1"><Input value={table.title} onChange={(event) => onChange({ ...table, title: event.target.value })} disabled={readOnly} /></Field>
      {!readOnly && <Btn tone="ghost" onClick={onRemove} aria-label="Удалить таблицу"><Trash2 className="h-3 w-3" /></Btn>}
      {!readOnly && <Btn onClick={() => addColumn('input')}><Plus className="h-3 w-3" /> Входной столбец</Btn>}
      {!readOnly && <Btn onClick={() => addColumn('output')}><Plus className="h-3 w-3" /> Результат</Btn>}
      {!readOnly && <Btn onClick={() => onChange({ ...table, rows: [...table.rows, emptyRow(table)] })}><Plus className="h-3 w-3" /> Строка</Btn>}
    </div>
    <div className="grid grid-cols-1 gap-2 @[700px]:grid-cols-3">
      <Field label="Источник таблицы"><Input value={table.source?.file || ''} onChange={(event) => onChange({ ...table, source: refField(table.source, 'file', event.target.value) })} placeholder="Файл каталога" disabled={readOnly} /></Field>
      <Field label="Страницы"><Input value={table.source?.pages || ''} onChange={(event) => onChange({ ...table, source: refField(table.source, 'pages', event.target.value) })} placeholder="12–14" disabled={readOnly} /></Field>
      <Field label="Редакция"><Input value={table.source?.edition || ''} onChange={(event) => onChange({ ...table, source: refField(table.source, 'edition', event.target.value) })} disabled={readOnly} /></Field>
    </div>
    {!table.columns.length && <p className="text-xs text-slate-500 dark:text-slate-400">Добавьте входные параметры и столбцы результата. Произвольные формулы не выполняются.</p>}
    {!!table.columns.length && <div className="max-w-full overflow-auto border border-slate-200 dark:border-slate-700">
      <table className="w-full min-w-[700px] border-collapse text-left text-xs">
        <thead className="bg-slate-50 dark:bg-slate-800"><tr>
          {table.columns.map((column, index) => <th key={column.key} className="min-w-36 border-b border-slate-200 p-1.5 dark:border-slate-700">
            <div className="mb-1 text-2xs font-medium text-slate-500 dark:text-slate-400">{column.role === 'input' ? 'Входной параметр' : 'Выходное значение'}</div>
            <div className="flex gap-1"><Input value={column.label} onChange={(event) => updateColumn(index, { label: event.target.value })} disabled={readOnly} aria-label="Подпись столбца" />
              {!readOnly && <button type="button" className="text-slate-400 hover:text-rose-600" onClick={() => removeColumn(index)} aria-label="Удалить столбец"><Trash2 className="h-3 w-3" /></button>}</div>
            <div className="mt-1 grid grid-cols-[minmax(0,1fr)_90px] gap-1"><Input value={column.unit || ''} onChange={(event) => updateColumn(index, { unit: event.target.value || undefined })} placeholder="Единица" disabled={readOnly} aria-label="Единица измерения" />
              <Select value={column.role} onChange={(role) => updateColumn(index, { role: role as 'input' | 'output' })} disabled={readOnly} aria-label="Роль столбца" options={[{ value: 'input', label: 'Вход' }, { value: 'output', label: 'Результат' }]} /></div>
          </th>)}
          <th className="min-w-56 border-b border-slate-200 p-1.5 dark:border-slate-700">Источник строки</th>
          <th className="w-20 border-b border-slate-200 p-1.5 dark:border-slate-700">Сверено</th>
          {!readOnly && <th className="w-10 border-b border-slate-200 dark:border-slate-700" />}
        </tr></thead>
        <tbody>{table.rows.map((row, rowIndex) => <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800">
          {table.columns.map((column) => <td key={column.key} className="min-w-36 p-1.5 align-top"><Input value={row.values[column.key] ?? ''} onChange={(event) => updateCell(rowIndex, column.key, event.target.value)} disabled={readOnly} aria-label={`${column.label}, строка ${rowIndex + 1}`} /></td>)}
          <td className="min-w-56 p-1.5 align-top"><div className="flex flex-col gap-1">
            <Input value={row.source?.file || ''} onChange={(event) => updateRow(rowIndex, { source: refField(row.source, 'file', event.target.value) })} placeholder="Файл, если отличается от таблицы" disabled={readOnly} aria-label="Источник строки" />
            <div className="grid grid-cols-2 gap-1"><Input value={row.source?.pages || ''} onChange={(event) => updateRow(rowIndex, { source: refField(row.source, 'pages', event.target.value) })} placeholder="Страницы" disabled={readOnly} aria-label="Страницы источника строки" />
              <Input value={row.source?.edition || ''} onChange={(event) => updateRow(rowIndex, { source: refField(row.source, 'edition', event.target.value) })} placeholder="Редакция" disabled={readOnly} aria-label="Редакция источника строки" /></div>
          </div></td>
          <td className="p-1.5 text-center align-top"><input type="checkbox" checked={row.verified} onChange={(event) => updateRow(rowIndex, { verified: event.target.checked })} disabled={readOnly} aria-label="Строка сверена с источником" /></td>
          {!readOnly && <td className="p-1 text-center align-top"><button type="button" className="p-1 text-slate-400 hover:text-rose-600" onClick={() => onChange({ ...table, rows: table.rows.filter((_, index) => index !== rowIndex) })} aria-label="Удалить строку"><Trash2 className="h-3 w-3" /></button></td>}
        </tr>)}</tbody>
      </table>
    </div>}
  </div>;
}
