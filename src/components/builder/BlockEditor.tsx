/**
 * Настройка одного блока бланка и параметров страницы.
 *
 * Поле значения — выражение: текст с `{полями}`. Чтобы не помнить имена, у
 * каждого поля есть выбор из каталога полей (FIELD_CATALOG) — он дописывает
 * `{путь}` туда, где стоит курсор.
 */
import React, { useRef } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, Braces, Image as ImageIcon } from 'lucide-react';
import type { Block, BlankTemplate, TableColumn, FieldPair, SpecRow, TableSource } from '../../../catalog/blank/model';
import { FIELD_CATALOG } from '../../../catalog/blank/data';
import { FILTER_NAMES } from '../../../catalog/blank/expr';
import { Btn, Field, Input, Select, SectionTitle } from '../catalog/ui';

const uid = () => Math.random().toString(36).slice(2, 9);

/** Поле выражения с выбором поля из каталога */
export function ExprInput({ value, onChange, placeholder, scope }: { value: string; onChange: (v: string) => void; placeholder?: string; scope?: 'item' | 'group' | 'doc' }) {
  const ref = useRef<HTMLInputElement>(null);
  const insert = (path: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, at)}{${path}}${value.slice(el?.selectionEnd ?? at)}`;
    onChange(next);
    requestAnimationFrame(() => el?.focus());
  };
  const fields = FIELD_CATALOG.filter((f) => !scope || f.scope === scope || f.scope === 'doc' || f.scope === 'group' || scope === 'item');
  return (
    <div className="flex items-center gap-1 min-w-0">
      <Input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="font-mono" />
      <select value="" onChange={(e) => { if (e.target.value) insert(e.target.value); }} title="Вставить поле" aria-label="Вставить поле"
        className="w-8 shrink-0 px-1 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs cursor-pointer">
        <option value="">{'{…}'}</option>
        {fields.map((f) => <option key={f.path} value={f.path.replace('<ключ>', 'purpose')}>{f.label} — {f.path}</option>)}
      </select>
    </div>
  );
}

function TextPair({ label, value, onChange, expr }: { label: string; value: { ru: string; en?: string }; onChange: (v: { ru: string; en?: string }) => void; expr?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <Field label={`${label} (RU)`}>{expr ? <ExprInput value={value.ru} onChange={(ru) => onChange({ ...value, ru })} /> : <Input value={value.ru} onChange={(e) => onChange({ ...value, ru: e.target.value })} />}</Field>
      <Field label={`${label} (EN)`}>{expr ? <ExprInput value={value.en || ''} onChange={(en) => onChange({ ...value, en })} /> : <Input value={value.en || ''} onChange={(e) => onChange({ ...value, en: e.target.value })} />}</Field>
    </div>
  );
}

function moveIn<T>(list: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

function RowTools({ onUp, onDown, onDel }: { onUp: () => void; onDown: () => void; onDel: () => void }) {
  return (
    <span className="inline-flex gap-0.5 shrink-0">
      <Btn tone="ghost" onClick={onUp} aria-label="Выше"><ArrowUp className="w-3 h-3" /></Btn>
      <Btn tone="ghost" onClick={onDown} aria-label="Ниже"><ArrowDown className="w-3 h-3" /></Btn>
      <Btn tone="ghost" onClick={onDel} aria-label="Удалить"><Trash2 className="w-3 h-3" /></Btn>
    </span>
  );
}

export const BLOCK_TYPES: Array<{ type: Block['type']; label: string; make: () => Block }> = [
  { type: 'title', label: 'Шапка с логотипом', make: () => ({ id: uid(), type: 'title', text: { ru: '{family.code}', en: '{family.code}' }, height: 2 }) },
  { type: 'fields', label: 'Реквизиты', make: () => ({ id: uid(), type: 'fields', labelSpan: 1, valueSpan: 3, pairs: [{ id: uid(), label: { ru: 'Объект', en: 'Object' }, value: '{doc.object}' }] }) },
  { type: 'table', label: 'Таблица', make: () => ({ id: uid(), type: 'table', source: 'items', columns: [{ id: uid(), title: { ru: 'TAG', en: 'TAG' }, value: '{tags|lines}', span: 2, align: 'left' }] }) },
  { type: 'specs', label: 'Характеристики', make: () => ({ id: uid(), type: 'specs', labelSpan: 2, valueSpan: 5, unitSpan: 1, rows: [{ id: uid(), label: { ru: 'Назначение', en: 'Purpose' }, value: '{spec.purpose.value|default:-}' }] }) },
  { type: 'text', label: 'Текст', make: () => ({ id: uid(), type: 'text', text: { ru: 'Текст', en: 'Text' } }) },
  { type: 'signatures', label: 'Подписи', make: () => ({ id: uid(), type: 'signatures', rows: [{ id: uid(), label: { ru: 'Разработал', en: 'Prepared' }, value: '{issue.prepared}' }] }) },
  { type: 'spacer', label: 'Пустая строка', make: () => ({ id: uid(), type: 'spacer', rows: 1 }) },
];

const SOURCES: Array<{ value: TableSource; label: string }> = [
  { value: 'items', label: 'позиции листа' }, { value: 'actuators', label: 'приводы позиций' }, { value: 'heating', label: 'обогрев позиций' },
  { value: 'revisions', label: 'история выпусков' }, { value: 'families', label: 'состав комплекта (листы)' },
];

export function BlockEditor({ block, onChange, assets, onAsset }: {
  block: Block; onChange: (b: Block) => void; assets: Record<string, string>; onAsset: (id: string, dataUrl: string) => void;
}) {
  const b = block;
  const common = (
    <>
      {b.type !== 'title' && b.type !== 'spacer' && (
        <TextPair label="Заголовок блока" value={b.title || { ru: '', en: '' }} onChange={(t) => onChange({ ...b, title: t.ru || t.en ? t : undefined })} />
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-end">
        <Field label="Показывать, если" hint="Выражение: пусто — всегда; {hasActuators|yesno:1/} — только если есть привод">
          <ExprInput value={b.visibleIf || ''} onChange={(v) => onChange({ ...b, visibleIf: v || undefined })} />
        </Field>
        <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer pb-1"><input type="checkbox" checked={!!b.breakBefore} onChange={(e) => onChange({ ...b, breakBefore: e.target.checked })} /> С новой страницы</label>
      </div>
    </>
  );

  if (b.type === 'title') {
    const upload = (key: 'logo' | 'logoRight') => (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => { const id = `${key}-${uid()}`; onAsset(id, String(r.result)); onChange({ ...b, [key]: id }); };
      r.readAsDataURL(f);
      e.target.value = '';
    };
    return (
      <div className="flex flex-col gap-2">
        <TextPair label="Заголовок" value={b.text} onChange={(text) => onChange({ ...b, text })} expr />
        <div className="grid grid-cols-3 gap-2">
          <Field label="Строк высотой"><Input type="number" min={1} max={6} value={b.height || 1} onChange={(e) => onChange({ ...b, height: Number(e.target.value) || 1 })} /></Field>
          {(['logo', 'logoRight'] as const).map((k) => (
            <Field key={k} label={k === 'logo' ? 'Логотип слева' : 'Логотип справа'}>
              <span className="flex items-center gap-1">
                {b[k] && assets[b[k]!] ? <img src={assets[b[k]!]} alt="" className="h-7 max-w-[80px] object-contain border border-slate-200 dark:border-slate-700 rounded" /> : <ImageIcon className="w-4 h-4 text-slate-400" />}
                <label className="text-2xs text-emerald-700 dark:text-emerald-400 cursor-pointer hover:underline">выбрать<input type="file" accept="image/png,image/jpeg" className="hidden" onChange={upload(k)} /></label>
                {b[k] && <button type="button" className="text-2xs text-slate-400 hover:text-rose-600 cursor-pointer" onClick={() => onChange({ ...b, [k]: undefined })}>убрать</button>}
              </span>
            </Field>
          ))}
        </div>
        {common}
      </div>
    );
  }

  if (b.type === 'fields' || b.type === 'signatures') {
    const list: FieldPair[] = b.type === 'fields' ? b.pairs : b.rows;
    const set = (next: FieldPair[]) => onChange(b.type === 'fields' ? { ...b, pairs: next } : { ...b, rows: next });
    return (
      <div className="flex flex-col gap-2">
        {b.type === 'fields' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Колонок под подпись"><Input type="number" min={1} value={b.labelSpan} onChange={(e) => onChange({ ...b, labelSpan: Math.max(1, Number(e.target.value) || 1) })} /></Field>
            <Field label="Колонок под значение"><Input type="number" min={1} value={b.valueSpan} onChange={(e) => onChange({ ...b, valueSpan: Math.max(1, Number(e.target.value) || 1) })} /></Field>
          </div>
        )}
        <SectionTitle right={<Btn onClick={() => set([...list, { id: uid(), label: { ru: 'Поле', en: 'Field' }, value: '' }])}><Plus className="w-3 h-3" /> Поле</Btn>}>Поля</SectionTitle>
        {list.map((p, i) => (
          <div key={p.id} className="rounded-md border border-slate-200 dark:border-slate-700 p-1.5 flex flex-col gap-1">
            <div className="flex items-start gap-1">
              <div className="flex-1 min-w-0"><TextPair label="Подпись" value={p.label} onChange={(label) => set(list.map((x) => (x.id === p.id ? { ...x, label } : x)))} /></div>
              <RowTools onUp={() => set(moveIn(list, i, -1))} onDown={() => set(moveIn(list, i, 1))} onDel={() => set(list.filter((x) => x.id !== p.id))} />
            </div>
            <Field label="Значение"><ExprInput value={p.value} onChange={(value) => set(list.map((x) => (x.id === p.id ? { ...x, value } : x)))} /></Field>
          </div>
        ))}
        {common}
      </div>
    );
  }

  if (b.type === 'table') {
    const set = (columns: TableColumn[]) => onChange({ ...b, columns });
    return (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Строки из"><Select value={b.source} onChange={(v) => onChange({ ...b, source: v as TableSource })} options={SOURCES} /></Field>
          <Field label="Если строк нет"><Input value={b.emptyText || ''} onChange={(e) => onChange({ ...b, emptyText: e.target.value })} /></Field>
        </div>
        <SectionTitle right={<Btn onClick={() => set([...b.columns, { id: uid(), title: { ru: 'Колонка', en: 'Column' }, value: '', span: 1 }])}><Plus className="w-3 h-3" /> Колонка</Btn>}>Колонки</SectionTitle>
        {b.columns.map((c, i) => (
          <div key={c.id} className="rounded-md border border-slate-200 dark:border-slate-700 p-1.5 flex flex-col gap-1">
            <div className="flex items-start gap-1">
              <div className="flex-1 min-w-0"><TextPair label="Заголовок" value={c.title} onChange={(title) => set(b.columns.map((x) => (x.id === c.id ? { ...x, title } : x)))} /></div>
              <RowTools onUp={() => set(moveIn(b.columns, i, -1))} onDown={() => set(moveIn(b.columns, i, 1))} onDel={() => set(b.columns.filter((x) => x.id !== c.id))} />
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_70px_110px] gap-1.5">
              <Field label="Значение"><ExprInput value={c.value} scope="item" onChange={(value) => set(b.columns.map((x) => (x.id === c.id ? { ...x, value } : x)))} /></Field>
              <Field label="Ширина"><Input type="number" min={1} value={c.span} onChange={(e) => set(b.columns.map((x) => (x.id === c.id ? { ...x, span: Math.max(1, Number(e.target.value) || 1) } : x)))} /></Field>
              <Field label="Выравнивание"><Select value={c.align || 'center'} onChange={(v) => set(b.columns.map((x) => (x.id === c.id ? { ...x, align: v as any } : x)))} options={[{ value: 'center', label: 'по центру' }, { value: 'left', label: 'слева' }]} /></Field>
            </div>
          </div>
        ))}
        {common}
      </div>
    );
  }

  if (b.type === 'specs') {
    const set = (rows: SpecRow[]) => onChange({ ...b, rows });
    return (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Колонок подписи"><Input type="number" min={1} value={b.labelSpan} onChange={(e) => onChange({ ...b, labelSpan: Math.max(1, Number(e.target.value) || 1) })} /></Field>
          <Field label="Колонок значения"><Input type="number" min={1} value={b.valueSpan} onChange={(e) => onChange({ ...b, valueSpan: Math.max(1, Number(e.target.value) || 1) })} /></Field>
          <Field label="Колонок ед. изм."><Input type="number" min={0} value={b.unitSpan} onChange={(e) => onChange({ ...b, unitSpan: Math.max(0, Number(e.target.value) || 0) })} /></Field>
        </div>
        <SectionTitle right={<Btn onClick={() => set([...b.rows, { id: uid(), label: { ru: 'Характеристика', en: 'Property' }, value: '' }])}><Plus className="w-3 h-3" /> Строка</Btn>}>Строки</SectionTitle>
        {b.rows.map((r, i) => (
          <div key={r.id} className="rounded-md border border-slate-200 dark:border-slate-700 p-1.5 flex flex-col gap-1">
            <div className="flex items-start gap-1">
              <div className="flex-1 min-w-0"><TextPair label="Подпись" value={r.label} onChange={(label) => set(b.rows.map((x) => (x.id === r.id ? { ...x, label } : x)))} /></div>
              <RowTools onUp={() => set(moveIn(b.rows, i, -1))} onDown={() => set(moveIn(b.rows, i, 1))} onDel={() => set(b.rows.filter((x) => x.id !== r.id))} />
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
              <Field label="Значение" hint="{spec.<ключ>.value} — из Каталога"><ExprInput value={r.value} scope="group" onChange={(value) => set(b.rows.map((x) => (x.id === r.id ? { ...x, value } : x)))} /></Field>
              <Field label="Выпадающий список в Excel" hint="варианты через запятую"><Input value={(r.options || []).join(', ')} onChange={(e) => set(b.rows.map((x) => (x.id === r.id ? { ...x, options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } : x)))} /></Field>
            </div>
          </div>
        ))}
        {common}
      </div>
    );
  }

  if (b.type === 'text') {
    return (
      <div className="flex flex-col gap-2">
        <TextPair label="Текст" value={b.text} onChange={(text) => onChange({ ...b, text })} expr />
        <Field label="Вид"><Select value={b.tone || 'normal'} onChange={(v) => onChange({ ...b, tone: v as any })} options={[{ value: 'normal', label: 'обычный' }, { value: 'bold', label: 'жирный' }, { value: 'note', label: 'примечание' }]} /></Field>
        {common}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Field label="Пустых строк"><Input type="number" min={1} value={(b as any).rows || 1} onChange={(e) => onChange({ ...b, rows: Math.max(1, Number(e.target.value) || 1) } as Block)} /></Field>
      {common}
    </div>
  );
}

export function PageEditor({ t, onChange }: { t: BlankTemplate; onChange: (t: BlankTemplate) => void }) {
  const page = t.page;
  const style = t.style;
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>Сетка</SectionTitle>
      <Field label="Ширины колонок (символы Excel)" hint={`${t.columns.length} колонок; блоки делят ширину листа между ними`}>
        <Input value={t.columns.join(', ')} onChange={(e) => {
          const cols = e.target.value.split(/[,;\s]+/).map((x) => Number(x)).filter((x) => x > 0);
          if (cols.length) onChange({ ...t, columns: cols });
        }} className="font-mono" />
      </Field>
      <SectionTitle>Страница</SectionTitle>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Формат"><Select value={page.paper} onChange={(v) => onChange({ ...t, page: { ...page, paper: v as any } })} options={[{ value: 'A4', label: 'A4' }, { value: 'A3', label: 'A3' }]} /></Field>
        <Field label="Ориентация"><Select value={page.orientation} onChange={(v) => onChange({ ...t, page: { ...page, orientation: v as any } })} options={[{ value: 'portrait', label: 'книжная' }, { value: 'landscape', label: 'альбомная' }]} /></Field>
        <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer self-end pb-1"><input type="checkbox" checked={page.fitWidth} onChange={(e) => onChange({ ...t, page: { ...page, fitWidth: e.target.checked } })} /> Вписать по ширине</label>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {(['top', 'bottom', 'left', 'right'] as const).map((k) => (
          <Field key={k} label={{ top: 'Верх, мм', bottom: 'Низ, мм', left: 'Слева, мм', right: 'Справа, мм' }[k]}>
            <Input type="number" min={0} value={page.margins[k]} onChange={(e) => onChange({ ...t, page: { ...page, margins: { ...page.margins, [k]: Number(e.target.value) || 0 } } })} />
          </Field>
        ))}
      </div>
      <SectionTitle>Колонтитул</SectionTitle>
      <div className="grid grid-cols-1 gap-1.5">
        {(['left', 'center', 'right'] as const).map((k) => (
          <Field key={k} label={{ left: 'Слева', center: 'По центру', right: 'Справа' }[k]} hint={k === 'center' ? '{page} — номер страницы, {pages} — всего страниц' : undefined}>
            <ExprInput value={page.footer[k] || ''} onChange={(v) => onChange({ ...t, page: { ...page, footer: { ...page.footer, [k]: v } } })} />
          </Field>
        ))}
      </div>
      <SectionTitle>Оформление</SectionTitle>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Шрифт"><Select value={style.font} onChange={(v) => onChange({ ...t, style: { ...style, font: v } })} options={['Arial', 'Times New Roman', 'Calibri', 'Tahoma', 'Verdana'].map((f) => ({ value: f, label: f }))} /></Field>
        <Field label="Кегль"><Input type="number" min={7} max={14} value={style.size} onChange={(e) => onChange({ ...t, style: { ...style, size: Number(e.target.value) || 10 } })} /></Field>
        <Field label="Кегль заголовка"><Input type="number" min={8} max={28} value={style.titleSize} onChange={(e) => onChange({ ...t, style: { ...style, titleSize: Number(e.target.value) || 14 } })} /></Field>
        <Field label="Заливка шапок"><input type="color" value={`#${style.headFill}`} onChange={(e) => onChange({ ...t, style: { ...style, headFill: e.target.value.slice(1).toUpperCase() } })} className="h-7 w-full rounded border border-slate-200 dark:border-slate-700 cursor-pointer" /></Field>
        <Field label="Заливка подписей"><input type="color" value={`#${style.labelFill}`} onChange={(e) => onChange({ ...t, style: { ...style, labelFill: e.target.value.slice(1).toUpperCase() } })} className="h-7 w-full rounded border border-slate-200 dark:border-slate-700 cursor-pointer" /></Field>
        <Field label="Рамки"><Select value={style.border} onChange={(v) => onChange({ ...t, style: { ...style, border: v as any } })} options={[{ value: 'thin', label: 'тонкие' }, { value: 'none', label: 'без рамок' }]} /></Field>
      </div>
      <div className="text-2xs text-slate-400 flex items-start gap-1"><Braces className="w-3 h-3 mt-0.5" /> Фильтры выражений: {FILTER_NAMES.join(', ')}. Пример: {'{tags|join: }'}, {'{spec.pressure.value|default:-}'}, {'{doc.docNo}{doc.rev|prefix:_}'}</div>
    </div>
  );
}
