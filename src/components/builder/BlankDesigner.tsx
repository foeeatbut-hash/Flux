/**
 * Конструктор бланков: шаблоны, листы, блоки, страница — и живой предпросмотр.
 *
 * Шаблон общий на программу (или личный), а предпросмотр строится на данных
 * открытой ведомости: так видно, как бланк ляжет на настоящие позиции, а не на
 * выдуманный пример. Если ведомость пуста — на примере из трёх клапанов.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, FilePlus2, Plus, Save, Star, Trash2, ArrowUp, ArrowDown, History, RotateCcw } from 'lucide-react';
import type { Catalog } from '../../../catalog/model';
import type { BlankTemplate, Block, BlankLang, SheetTemplate } from '../../../catalog/blank/model';
import type { SelectionItemData, ListHeader } from '../../../catalog/selection';
import { defaultBlankTemplate, emptyBlankTemplate } from '../../../catalog/blank/defaults';
import { buildBlankData } from '../../../catalog/blank/data';
import { renderBlank } from '../../../catalog/blank/render';
import { catalogService, type StoredTemplate } from '../../services/catalogService';
import { useCatalogStore } from '../../store/catalogStore';
import { useToastStore } from '../../store/toastStore';
import BlankPreview from './BlankPreview';
import { BlockEditor, PageEditor, BLOCK_TYPES } from './BlockEditor';
import { Btn, Chip, Field, Input, Seg, Select, SectionTitle, confirmAsk as openConfirm, promptAsk as openPrompt } from '../catalog/ui';

const SAMPLE: SelectionItemData[] = [
  { id: 's1', classId: 'cls-valve', familyId: 'veza-kpu-1n', values: { purpose: 'О', exec: 'В', W: 900, H: 400, type: '2*ф', drive: 'ЭПВ24', terminals: 'КК' }, tags: ['3700-B02-DF-001', '3700-B02-DF-004'], qty: 2, designation: '', status: 'matched', sort: 1 },
  { id: 's2', classId: 'cls-valve', familyId: 'veza-germik-p', values: { H: 600, W: 1000, exec: 'Н', drive: 'РУЧКА', driveCount: 1 }, tags: ['3700-C01-DV-001'], qty: 1, designation: '', status: 'matched', sort: 2 },
  { id: 's3', classId: 'cls-valve', familyId: 'veza-tulpan-1', values: { H: 500, W: 800, exec: 'В' }, tags: ['3700-B03-DN-001'], qty: 1, designation: '', status: 'matched', sort: 3 },
];

const newId = () => `tpl-${Math.random().toString(36).slice(2, 10)}`;

export default function BlankDesigner({ catalog, items, header, orderNos, canEdit }: {
  catalog: Catalog; items: SelectionItemData[]; header: ListHeader; orderNos: Record<string, string>; canEdit: boolean;
}) {
  const templates = useCatalogStore((s) => s.templates);
  const loadTemplates = useCatalogStore((s) => s.loadTemplates);
  const addToast = useToastStore((s) => s.addToast);
  const [curId, setCurId] = useState('');
  const [draft, setDraft] = useState<BlankTemplate | null>(null);
  const [meta, setMeta] = useState<Pick<StoredTemplate, 'scope' | 'isDefault'>>({ scope: 'SHARED', isDefault: false });
  const [sheetId, setSheetId] = useState('');
  const [blockId, setBlockId] = useState('');
  const [panel, setPanel] = useState<'block' | 'page' | 'history'>('block');
  const [lang, setLang] = useState<BlankLang>('ru');
  const [useSample, setUseSample] = useState(false);
  const [revs, setRevs] = useState<Array<{ id: string; action: string; createdAt: string }>>([]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);
  useEffect(() => {
    if (curId || !templates.length) return;
    const t = templates.find((x) => x.isDefault) || templates[0];
    open(t);
  }, [templates]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (t: StoredTemplate) => {
    setCurId(t.id);
    setDraft(t.layout || defaultBlankTemplate());
    setMeta({ scope: t.scope, isDefault: t.isDefault });
    setSheetId(t.layout?.sheets[0]?.id || '');
    setBlockId('');
    setPanel('block');
  };
  const stored = templates.find((t) => t.id === curId);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(stored?.layout || null);

  const sheet = draft?.sheets.find((s) => s.id === sheetId) || draft?.sheets[0];
  const block = sheet?.blocks.find((b) => b.id === blockId);

  const grids = useMemo(() => {
    if (!draft) return [];
    const src = useSample || !items.length ? SAMPLE : items;
    const repeat = draft.sheets.find((s) => s.repeat !== 'none')?.repeat || 'family';
    const data = buildBlankData({ catalog, header: useSample || !items.length ? { docNo: 'ПРИМЕР-0001', object: 'Объект', customer: 'Заказчик', executor: 'Исполнитель', ...header } : header, items: src, orderNos, issue: { rev: '0', date: new Date().toISOString(), reason: 'Предпросмотр' } }, repeat);
    try { return renderBlank(draft, data, lang); } catch { return []; }
  }, [draft, items, header, orderNos, catalog, lang, useSample]);

  const setSheet = (s: SheetTemplate) => draft && setDraft({ ...draft, sheets: draft.sheets.map((x) => (x.id === s.id ? s : x)) });
  const setBlock = (b: Block) => sheet && setSheet({ ...sheet, blocks: sheet.blocks.map((x) => (x.id === b.id ? b : x)) });

  const save = async () => {
    if (!draft) return;
    try {
      await catalogService.saveTemplate(curId, { name: draft.name, layout: draft, scope: meta.scope, isDefault: meta.isDefault });
      await loadTemplates();
      addToast('Шаблон сохранён', 'success');
    } catch (e: any) { addToast(e?.message || 'Не сохранилось', 'error'); }
  };

  const create = async (from: 'default' | 'empty' | 'copy') => {
    const name = await openPrompt('Новый шаблон', 'Как назвать шаблон?', from === 'copy' && draft ? `${draft.name} (копия)` : 'Новый шаблон');
    if (!name) return;
    const base = from === 'copy' && draft ? JSON.parse(JSON.stringify(draft)) : from === 'default' ? defaultBlankTemplate() : emptyBlankTemplate();
    const id = newId();
    try {
      await catalogService.saveTemplate(id, { name, layout: { ...base, name }, scope: 'SHARED' });
      await loadTemplates();
      const t = useCatalogStore.getState().templates.find((x) => x.id === id);
      if (t) open(t);
    } catch (e: any) { addToast(e?.message || 'Не создалось', 'error'); }
  };

  const remove = async () => {
    if (!stored || !(await openConfirm('Удалить шаблон?', `«${stored.name}» пропадёт у всех. Уже выпущенные бланки останутся.`, { confirmLabel: 'Удалить', tone: 'danger' }))) return;
    try { await catalogService.removeTemplate(stored.id); setCurId(''); setDraft(null); await loadTemplates(); } catch (e: any) { addToast(e?.message || 'Не удалилось', 'error'); }
  };

  const showHistory = async () => {
    setPanel('history');
    try { setRevs((await catalogService.revisions('template', curId)).revisions); } catch { setRevs([]); }
  };

  if (!draft) return <div className="text-xs text-slate-400">Загружаю шаблоны…</div>;

  return (
    <div className="grid grid-cols-1 @[1100px]:grid-cols-[minmax(0,420px)_minmax(0,1fr)] gap-3 min-h-0 h-full">
      <div className="flex flex-col min-h-0 gap-2">
        <div className="flex items-end gap-1.5 flex-wrap">
          <Field label="Шаблон" className="flex-1 min-w-[180px]">
            <Select value={curId} onChange={(id) => { const t = templates.find((x) => x.id === id); if (t) open(t); }}
              options={templates.map((t) => ({ value: t.id, label: `${t.isDefault ? '★ ' : ''}${t.name}${t.scope === 'PERSONAL' ? ' (личный)' : ''} · в.${t.version}` }))} />
          </Field>
          {canEdit && (
            <>
              <Btn onClick={() => create('default')} title="Новый шаблон по образцу «Бланк-заказ ВЕЗА»"><FilePlus2 className="w-3.5 h-3.5" /></Btn>
              <Btn onClick={() => create('copy')} title="Копия текущего"><Copy className="w-3.5 h-3.5" /></Btn>
              <Btn onClick={remove} tone="danger" title="Удалить шаблон"><Trash2 className="w-3.5 h-3.5" /></Btn>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="flex-1 min-w-[160px] font-semibold" aria-label="Имя шаблона" disabled={!canEdit} />
          <label className="inline-flex items-center gap-1 text-2xs cursor-pointer"><input type="checkbox" checked={meta.isDefault} onChange={(e) => setMeta({ ...meta, isDefault: e.target.checked })} disabled={!canEdit} /><Star className="w-3 h-3" /> основной</label>
          <label className="inline-flex items-center gap-1 text-2xs cursor-pointer"><input type="checkbox" checked={meta.scope === 'PERSONAL'} onChange={(e) => setMeta({ ...meta, scope: e.target.checked ? 'PERSONAL' : 'SHARED' })} disabled={!canEdit} /> личный</label>
          {canEdit && <Btn tone="primary" onClick={save} disabled={!dirty && JSON.stringify(meta) === JSON.stringify({ scope: stored?.scope, isDefault: stored?.isDefault })}><Save className="w-3.5 h-3.5" /> Сохранить</Btn>}
        </div>

        <SectionTitle right={canEdit && <Btn onClick={() => {
          const s: SheetTemplate = { id: newId(), name: 'Лист', repeat: 'none', blocks: [] };
          setDraft({ ...draft, sheets: [...draft.sheets, s] }); setSheetId(s.id);
        }}><Plus className="w-3 h-3" /> Лист</Btn>}>Листы</SectionTitle>
        <div className="flex flex-wrap gap-1">
          {draft.sheets.map((s) => (
            <button key={s.id} type="button" onClick={() => { setSheetId(s.id); setBlockId(''); setPanel('block'); }} aria-pressed={sheet?.id === s.id}
              className={`px-2 py-1 rounded-md text-2xs font-semibold border cursor-pointer ${sheet?.id === s.id ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}>
              {s.name} {s.repeat !== 'none' && <span className="opacity-70">×{s.repeat === 'family' ? 'семейство' : 'семейство+исп.'}</span>}
            </button>
          ))}
        </div>
        {sheet && (
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_70px] gap-1.5 items-end">
            <Field label="Имя листа" hint="{family.code}{execSuffix}"><Input value={sheet.name} onChange={(e) => setSheet({ ...sheet, name: e.target.value })} className="font-mono" disabled={!canEdit} /></Field>
            <Field label="Листов">
              <Select value={sheet.repeat} onChange={(v) => setSheet({ ...sheet, repeat: v as any })} disabled={!canEdit}
                options={[{ value: 'none', label: 'один на комплект' }, { value: 'family', label: 'на каждое семейство' }, { value: 'family-exec', label: 'на семейство и исполнение' }]} />
            </Field>
            <Field label="Сквозных"><Input type="number" min={0} value={sheet.printTitleRows || 0} onChange={(e) => setSheet({ ...sheet, printTitleRows: Number(e.target.value) || undefined })} disabled={!canEdit} /></Field>
          </div>
        )}
        {sheet && canEdit && draft.sheets.length > 1 && (
          <div><Btn tone="danger" onClick={() => { setDraft({ ...draft, sheets: draft.sheets.filter((x) => x.id !== sheet.id) }); setSheetId(''); }}><Trash2 className="w-3 h-3" /> Удалить лист</Btn></div>
        )}

        <SectionTitle right={canEdit && sheet && (
          <select value="" onChange={(e) => {
            const t = BLOCK_TYPES.find((x) => x.type === e.target.value);
            if (!t) return;
            const b = t.make();
            setSheet({ ...sheet, blocks: [...sheet.blocks, b] }); setBlockId(b.id); setPanel('block');
          }} className="px-1.5 py-0.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-2xs cursor-pointer" aria-label="Добавить блок">
            <option value="">+ блок…</option>
            {BLOCK_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
        )}>Блоки листа</SectionTitle>
        <div className="flex flex-col gap-1">
          {sheet?.blocks.map((b, i) => (
            <div key={b.id} className={`flex items-center gap-1 rounded-md border px-2 py-1 ${blockId === b.id ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-slate-200 dark:border-slate-700'}`}>
              <button type="button" className="flex-1 min-w-0 text-left text-xs cursor-pointer" onClick={() => { setBlockId(b.id); setPanel('block'); }}>
                <b>{BLOCK_TYPES.find((t) => t.type === b.type)?.label}</b>
                <span className="text-slate-400"> {b.title?.ru || (b.type === 'title' || b.type === 'text' ? b.text.ru : '')}</span>
                {b.visibleIf && <Chip tone="sky">по условию</Chip>}
                {b.breakBefore && <Chip>с новой стр.</Chip>}
              </button>
              {canEdit && (
                <>
                  <Btn tone="ghost" onClick={() => { const bl = [...sheet.blocks]; if (i > 0) { [bl[i - 1], bl[i]] = [bl[i], bl[i - 1]]; setSheet({ ...sheet, blocks: bl }); } }} aria-label="Выше"><ArrowUp className="w-3 h-3" /></Btn>
                  <Btn tone="ghost" onClick={() => { const bl = [...sheet.blocks]; if (i < bl.length - 1) { [bl[i + 1], bl[i]] = [bl[i], bl[i + 1]]; setSheet({ ...sheet, blocks: bl }); } }} aria-label="Ниже"><ArrowDown className="w-3 h-3" /></Btn>
                  <Btn tone="ghost" onClick={() => setSheet({ ...sheet, blocks: sheet.blocks.filter((x) => x.id !== b.id) })} aria-label="Удалить блок"><Trash2 className="w-3 h-3" /></Btn>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="flex gap-1 mt-2">
          <Seg label="Настройка" value={panel} onChange={(v) => (v === 'history' ? showHistory() : setPanel(v))} options={[{ value: 'block', label: 'блок' }, { value: 'page', label: 'страница и стиль' }, { value: 'history', label: 'история' }]} />
        </div>
        <div className="flex-1 min-h-0 overflow-auto pr-1">
          {panel === 'block' && block && canEdit && <BlockEditor block={block} onChange={setBlock} assets={draft.assets || {}} onAsset={(id, url) => setDraft({ ...draft, assets: { ...(draft.assets || {}), [id]: url } })} />}
          {panel === 'block' && !block && <div className="text-xs text-slate-400">Выберите блок слева или щёлкните по нему в предпросмотре.</div>}
          {panel === 'page' && canEdit && <PageEditor t={draft} onChange={setDraft} />}
          {panel === 'history' && (
            <div className="flex flex-col gap-1">
              {!revs.length && <div className="text-xs text-slate-400">Правок ещё не было.</div>}
              {revs.map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-xs">
                  <History className="w-3.5 h-3.5 text-slate-400" />
                  <span className="tabular-nums">{new Date(r.createdAt).toLocaleString('ru-RU')}</span>
                  <Chip>{r.action}</Chip>
                  <span className="flex-1" />
                  {canEdit && <Btn tone="ghost" onClick={async () => { await catalogService.restore(r.id); await loadTemplates(); const t = useCatalogStore.getState().templates.find((x) => x.id === curId); if (t) open(t); addToast('Шаблон возвращён к снимку', 'success'); }}><RotateCcw className="w-3 h-3" /> вернуть</Btn>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col min-h-0 gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Seg label="Язык" value={lang} onChange={setLang} options={[{ value: 'ru', label: 'RU' }, { value: 'en', label: 'EN' }, { value: 'ru+en', label: 'RU+EN' }]} />
          <label className="inline-flex items-center gap-1 text-2xs cursor-pointer"><input type="checkbox" checked={useSample || !items.length} disabled={!items.length} onChange={(e) => setUseSample(e.target.checked)} /> на примере</label>
          <span className="text-2xs text-slate-400">{grids.length} лист.</span>
          {dirty && <Chip tone="amber">не сохранён</Chip>}
        </div>
        <BlankPreview sheets={grids} selectedBlock={blockId} onPickBlock={(id) => {
          const s = draft.sheets.find((x) => x.blocks.some((b) => b.id === id));
          if (s) { setSheetId(s.id); setBlockId(id); setPanel('block'); }
        }} />
      </div>
    </div>
  );
}
