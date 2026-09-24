/**
 * Импорт MTO и спецификаций: файл → лист → колонки → план → запись.
 *
 * Файл читается прямо в окне: MTO бывает на десять тысяч строк, а разбор
 * листа на сервере отдаёт первые пятьсот. Запись — одним пакетом через
 * ведомость, с отменой; до записи человек видит, что будет новым, что
 * изменится и что пропало (flux-data-safety, п. 1–3).
 */
import React, { useMemo, useState } from 'react';
import { FileSpreadsheet, Upload, ArrowRight, ArrowLeft, Check, AlertTriangle } from 'lucide-react';
import type { Catalog } from '../../../catalog/model';
import type { SelectionItemData } from '../../../catalog/selection';
import { guessHeader, readRows, planSheetImport, textForMatch, COLUMN_ROLES, signatureOfHeader, type ColumnMap, type ColumnRole, type SheetRow, type ImportPlan } from '../../../catalog/sheetImport';
import { describe } from '../../../catalog/describe';
import { matchDescription, type Learned } from '../../../catalog/match';
import { detectorsFor } from '../../../catalog/seed';
import { buildDesignation } from '../../../catalog/designation';
import { signatureOf } from '../../../catalog/text';
import { catalogService } from '../../services/catalogService';
import { newItemId, nextSort } from '../../store/builderStore';
import { Btn, Chip, Confidence, Empty, Field, Input, Select, Seg } from '../catalog/ui';

type Step = 'file' | 'columns' | 'plan';

interface Book { name: string; sheets: Array<{ name: string; rows: string[][] }> }

const ACTION: Record<string, { label: string; tone: 'emerald' | 'sky' | 'slate' | 'rose' | 'amber' }> = {
  new: { label: 'новая', tone: 'emerald' }, update: { label: 'изменится', tone: 'sky' }, same: { label: 'без изменений', tone: 'slate' },
  conflict: { label: 'конфликт', tone: 'rose' }, skip: { label: 'пропуск', tone: 'slate' },
};

async function readBook(file: File): Promise<Book> {
  const XLSX: any = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  return {
    name: file.name,
    sheets: wb.SheetNames.map((name: string) => ({
      name,
      rows: (XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false }) as unknown[][])
        .map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)))),
    })),
  };
}

export default function ImportWizard({ catalog, classId, items, learned, onApply, onDone }: {
  catalog: Catalog; classId: string; items: SelectionItemData[]; learned: Learned[];
  onApply: (title: string, upserts: Array<Partial<SelectionItemData>>, removeIds: string[]) => Promise<void>;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>('file');
  const [book, setBook] = useState<Book | null>(null);
  const [sheet, setSheet] = useState('');
  const [headerRow, setHeaderRow] = useState(0);
  const [cols, setCols] = useState<ColumnMap>({});
  const [onlyTagged, setOnlyTagged] = useState(true);
  const [fullDoc, setFullDoc] = useState(false);
  const [rev, setRev] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [take, setTake] = useState<Set<number>>(new Set());
  const [removeTake, setRemoveTake] = useState<Set<string>>(new Set());
  const [fromFile, setFromFile] = useState<Set<string>>(new Set());
  const [famOverride, setFamOverride] = useState<Record<number, string>>({});
  const [view, setView] = useState<'act' | 'all'>('act');

  const rows = useMemo(() => book?.sheets.find((s) => s.name === sheet)?.rows || [], [book, sheet]);
  const cls = catalog.classes.find((c) => c.id === classId);
  const tagRules = catalog.tagRules.filter((r) => r.classId === classId);

  const openFile = async (file: File) => {
    setError(''); setBusy('Читаю файл…');
    try {
      const b = await readBook(file);
      setBook(b);
      // Лист со спецификацией — тот, где нашлась шапка с тегами и описанием
      const scored = b.sheets.map((s) => ({ s, g: guessHeader(s.rows) })).filter((x) => x.g);
      const best = scored.sort((a, c) => (c.g!.columns.tag !== undefined ? 1 : 0) - (a.g!.columns.tag !== undefined ? 1 : 0) || c.s.rows.length - a.s.rows.length)[0];
      const pick = best?.s.name || b.sheets[0]?.name || '';
      await chooseSheet(b, pick);
      setStep('columns');
    } catch (e: any) {
      setError(`Файл не читается: ${e?.message || e}`);
    } finally { setBusy(''); }
  };

  const chooseSheet = async (b: Book, name: string) => {
    setSheet(name);
    const s = b.sheets.find((x) => x.name === name);
    const g = s ? guessHeader(s.rows) : null;
    let mapped = g?.columns || {};
    let hr = g?.headerRow ?? 0;
    // Сохранённый профиль формата сильнее угадывания: его уже проверил человек
    try {
      const sig = s ? signatureOfHeader(s.rows[hr] || []) : '';
      const { profiles } = await catalogService.profiles();
      const prof = profiles.find((p) => p.signature === sig);
      if (prof) { mapped = prof.mapping.columns; hr = prof.mapping.headerRow; }
    } catch { /* без профиля — по угадыванию */ }
    setHeaderRow(hr);
    setCols(mapped);
  };

  const buildPlan = () => {
    setBusy('Подбираю позиции…');
    setTimeout(() => {
      try {
        const guess = { headerRow, columns: cols, signature: signatureOfHeader(rows[headerRow] || []) };
        const parsed = readRows(rows, guess, tagRules, { onlyTagged });
        const det = detectorsFor(cls?.code || 'valve');
        let sort = nextSort(items);
        const propose = (r: SheetRow): Partial<SelectionItemData> => {
          const text = textForMatch(r);
          const d = describe(text, det, { tags: r.tags, productCode: r.code || undefined });
          const list = matchDescription(catalog, d, { classId, learned, limit: 3 });
          const top = list.find((c) => !c.rejected);
          return {
            classId, tags: r.tags, qty: r.qty, sourceText: [r.description, r.type].filter(Boolean).join('\n'),
            sourceRef: { file: book?.name, sheet, row: r.row, rev: rev || undefined },
            familyId: top?.familyId, values: top?.values || {}, designation: top?.designation || '',
            match: top ? {
              confidence: top.confidence, reasons: top.reasons,
              alternatives: list.slice(1).map((c) => ({ familyId: c.familyId, score: c.score, designation: c.designation })),
              questions: top.questions.map((q) => ({ param: q.param, label: q.label })),
            } : undefined,
            status: top ? 'matched' : 'draft', sort: sort++,
          };
        };
        const p = planSheetImport(items, parsed, propose, { fullDocument: fullDoc });
        setPlan(p);
        setTake(new Set(p.entries.map((e, i) => (e.action === 'new' || e.action === 'update' ? i : -1)).filter((i) => i >= 0)));
        setRemoveTake(new Set());
        setFromFile(new Set());
        setFamOverride({});
        setStep('plan');
        catalogService.saveProfile({ name: `${book?.name || 'Таблица'} · ${sheet}`, signature: guess.signature, mapping: { columns: cols, headerRow, sheet } }).catch(() => undefined);
      } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(''); }
    }, 20);
  };

  /** Предложение строки с учётом выбранного вручную семейства */
  const proposedOf = (i: number) => {
    const e = plan!.entries[i];
    const fid = famOverride[i];
    if (!fid || fid === e.proposed.familyId) return e.proposed;
    const f = catalog.families.find((x) => x.id === fid)!;
    const d = describe(textForMatch(e.row), detectorsFor(cls?.code || 'valve'), { tags: e.row.tags });
    const c = matchDescription({ ...catalog, families: [f] }, d, { classId })[0];
    return { ...e.proposed, familyId: f.id, values: c?.values || {}, designation: c ? c.designation : buildDesignation(f, {}).text, match: { confidence: 1, reasons: [{ key: 'choice', status: 'match', text: 'выбрано при импорте' }] } };
  };

  const apply = async () => {
    if (!plan) return;
    setBusy('Записываю…');
    try {
      const upserts: Array<Partial<SelectionItemData>> = [];
      for (const i of take) {
        const e = plan.entries[i];
        const prop = proposedOf(i);
        if (e.action === 'new') upserts.push({ ...prop, id: newItemId() });
        if (e.action === 'update' && e.itemId) {
          const cur = items.find((x) => x.id === e.itemId)!;
          const next: SelectionItemData = { ...cur };
          for (const ch of e.changes) {
            // Правленное руками остаётся, если человек не выбрал «из файла»
            if (ch.overridden && !fromFile.has(`${i}:${ch.field}`)) continue;
            if (ch.field === 'tags') next.tags = prop.tags || cur.tags;
            else if (ch.field === 'qty') next.qty = prop.qty ?? cur.qty;
            else if (ch.field === 'sourceText') next.sourceText = prop.sourceText;
            else if (ch.field === 'familyId') { next.familyId = prop.familyId; next.values = prop.values || {}; }
            else if (ch.field.startsWith('values.')) next.values = { ...next.values, [ch.field.slice(7)]: (prop.values || {})[ch.field.slice(7)] };
          }
          next.sourceRef = prop.sourceRef;
          next.match = prop.match;
          if (!next.designationManual && next.familyId) {
            const f = catalog.families.find((x) => x.id === next.familyId);
            if (f) next.designation = buildDesignation(f, next.values).text;
          }
          upserts.push(next);
        }
        // Семейство сменили руками — стоит запомнить, чтобы в следующий раз не спрашивать
        if (famOverride[i] && famOverride[i] !== e.proposed.familyId && e.row.description) {
          catalogService.learn({ classId, signature: signatureOf(textForMatch(e.row)), familyId: famOverride[i], values: prop.values || {} }).catch(() => undefined);
        }
      }
      await onApply(`Импорт ${book?.name || 'таблицы'}${rev ? ` (рев. ${rev})` : ''}: ${upserts.length} поз.`, upserts, [...removeTake]);
      onDone();
    } catch (e: any) { setError(e?.message || String(e)); } finally { setBusy(''); }
  };

  if (step === 'file') {
    return (
      <div className="flex flex-col gap-3 max-w-2xl">
        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) openFile(f); }}
          className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-700 px-6 py-10 cursor-pointer hover:border-emerald-400 text-center">
          <FileSpreadsheet className="w-8 h-8 text-emerald-600" />
          <b className="text-sm">Перетащите MTO или спецификацию сюда</b>
          <span className="text-xs text-slate-500 dark:text-slate-400">или нажмите, чтобы выбрать файл Excel (.xlsx, .xls, .csv). Файл читается на этом компьютере и никуда не загружается.</span>
          <input type="file" accept=".xlsx,.xls,.xlsm,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ''; }} />
          <span className="inline-flex items-center gap-1 text-2xs text-slate-400"><Upload className="w-3.5 h-3.5" /> Колонки определятся сами; формат запомнится для следующих файлов</span>
        </label>
        {busy && <div className="text-xs text-slate-500">{busy}</div>}
        {error && <div className="text-xs text-rose-600 dark:text-rose-400">{error}</div>}
      </div>
    );
  }

  if (step === 'columns' && book) {
    const header = rows[headerRow] || [];
    const preview = rows.slice(headerRow + 1, headerRow + 9);
    const colOptions = [{ value: '', label: '— нет —' }, ...header.map((h, i) => ({ value: String(i), label: `${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}: ${String(h).slice(0, 40) || '(без заголовка)'}` }))];
    return (
      <div className="flex flex-col gap-3 min-w-0">
        <div className="flex items-end gap-2 flex-wrap">
          <Field label="Файл"><b className="text-xs">{book.name}</b></Field>
          <Field label="Лист">
            <Select value={sheet} onChange={(v) => chooseSheet(book, v)} options={book.sheets.map((s) => ({ value: s.name, label: `${s.name} (${s.rows.length} стр.)` }))} />
          </Field>
          <Field label="Строка шапки"><Input type="number" min={1} value={headerRow + 1} onChange={(e) => setHeaderRow(Math.max(0, Number(e.target.value) - 1))} className="w-20 tabular-nums" /></Field>
          <Field label="Ревизия источника" hint="например AN3"><Input value={rev} onChange={(e) => setRev(e.target.value)} className="w-24" /></Field>
        </div>
        <div className="grid grid-cols-2 @[700px]:grid-cols-5 gap-2">
          {COLUMN_ROLES.map((r) => (
            <Field key={r.role} label={r.label}>
              <Select value={cols[r.role] === undefined ? '' : String(cols[r.role])} onChange={(v) => setCols({ ...cols, [r.role]: v === '' ? undefined : Number(v) } as ColumnMap)} options={colOptions} />
            </Field>
          ))}
        </div>
        {cols.tag === undefined && <div className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Колонка тегов не найдена: позиции без тегов не сравнить с ведомостью при следующей ревизии.</div>}
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <label className="inline-flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={onlyTagged} onChange={(e) => setOnlyTagged(e.target.checked)} /> Брать только строки с тегом</label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer" title="Позиции ведомости, которых нет в файле, будут предложены к удалению">
            <input type="checkbox" checked={fullDoc} onChange={(e) => setFullDoc(e.target.checked)} /> Это полный документ (не фрагмент)
          </label>
        </div>
        <div className="overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 max-h-72">
          <table className="text-2xs w-full">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr>{header.map((h, i) => {
                const role = (Object.entries(cols) as Array<[ColumnRole, number]>).find(([, c]) => c === i)?.[0];
                return <th key={i} className={`px-2 py-1 text-left align-bottom ${role ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400'}`}>{role ? `▸ ${COLUMN_ROLES.find((x) => x.role === role)?.label}` : ''}<div className="font-normal line-clamp-2">{h}</div></th>;
              })}</tr>
            </thead>
            <tbody>{preview.map((r, i) => <tr key={i} className="border-t border-slate-100 dark:border-slate-850">{header.map((_, c) => <td key={c} className="px-2 py-1 align-top max-w-[260px]"><div className="line-clamp-3">{r[c]}</div></td>)}</tr>)}</tbody>
          </table>
        </div>
        <div className="flex gap-2">
          <Btn onClick={() => { setStep('file'); setBook(null); }}><ArrowLeft className="w-3.5 h-3.5" /> Другой файл</Btn>
          <Btn tone="primary" onClick={buildPlan} disabled={!!busy || cols.description === undefined && cols.tag === undefined}>Разобрать и подобрать <ArrowRight className="w-3.5 h-3.5" /></Btn>
          {busy && <span className="text-xs text-slate-500 self-center">{busy}</span>}
        </div>
        {error && <div className="text-xs text-rose-600 dark:text-rose-400">{error}</div>}
      </div>
    );
  }

  if (step === 'plan' && plan) {
    const t = plan.totals;
    const shown = plan.entries.map((e, i) => ({ e, i })).filter(({ e }) => view === 'all' || e.action !== 'skip');
    const famOpts = [{ value: '', label: '— не подобрано —' }, ...catalog.families.filter((f) => f.classId === classId).map((f) => ({ value: f.id, label: f.code }))];
    return (
      <div className="flex flex-col gap-2 min-h-0 h-full">
        <div className="flex items-center gap-2 flex-wrap">
          <Chip tone="emerald">новых {t.new}</Chip><Chip tone="sky">изменится {t.update}</Chip><Chip>без изменений {t.same}</Chip>
          {t.conflict > 0 && <Chip tone="rose">конфликтов {t.conflict}</Chip>}<Chip>пропущено {t.skip}</Chip><Chip>штук {t.qty}</Chip>
          {plan.missing.length > 0 && <Chip tone="amber">нет в файле {plan.missing.length}</Chip>}
          <span className="flex-1" />
          <Seg label="Показать" value={view} onChange={setView} options={[{ value: 'act', label: 'позиции' }, { value: 'all', label: 'с пропущенными' }]} />
        </div>
        <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
          {!shown.length ? <Empty title="В файле нет подходящих строк" text="Проверьте колонки и отбор «только с тегом»." /> : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white dark:bg-slate-900 z-10">
                <tr className="text-left text-2xs uppercase tracking-wide text-slate-400">
                  <th className="px-2 py-1.5 w-7"></th><th className="px-2 py-1.5">Стр.</th><th className="px-2 py-1.5">Действие</th><th className="px-2 py-1.5">Теги</th>
                  <th className="px-2 py-1.5 text-right">Кол.</th><th className="px-2 py-1.5">Изделие</th><th className="px-2 py-1.5 hidden @[900px]:table-cell">Подбор</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ e, i }) => {
                  const prop = proposedOf(i);
                  const can = e.action === 'new' || e.action === 'update';
                  return (
                    <tr key={i} className={`border-t border-slate-100 dark:border-slate-850 align-top ${e.action === 'skip' ? 'opacity-50' : ''}`}>
                      <td className="px-2 py-1.5">{can && <input type="checkbox" checked={take.has(i)} onChange={() => { const n = new Set(take); n.has(i) ? n.delete(i) : n.add(i); setTake(n); }} aria-label="Брать строку" />}</td>
                      <td className="px-2 py-1.5 tabular-nums text-slate-400">{e.row.row}</td>
                      <td className="px-2 py-1.5"><Chip tone={ACTION[e.action].tone}>{ACTION[e.action].label}</Chip>{e.note && <div className="text-2xs text-slate-400 mt-0.5 max-w-[180px]">{e.note}</div>}</td>
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap">{e.row.tags.slice(0, 3).map((x) => <div key={x}>{x}</div>)}{e.row.tags.length > 3 && <div className="text-2xs text-slate-400">ещё {e.row.tags.length - 3}</div>}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{e.row.qty}</td>
                      <td className="px-2 py-1.5 min-w-[14rem]">
                        {e.action !== 'skip' && (
                          <>
                            <Select value={famOverride[i] ?? e.proposed.familyId ?? ''} onChange={(v) => setFamOverride({ ...famOverride, [i]: v })} options={famOpts} className="!w-auto font-mono" />
                            <div className="font-mono text-2xs text-slate-500 dark:text-slate-400 break-all mt-0.5">{prop.designation}</div>
                            {e.changes.map((c) => (
                              <div key={c.field} className={`text-2xs ${c.overridden ? 'text-rose-600 dark:text-rose-400' : 'text-sky-700 dark:text-sky-400'}`}>
                                {c.field}: {JSON.stringify(c.from)} → {JSON.stringify(c.to)}
                                {c.overridden && (
                                  <label className="ml-1 inline-flex items-center gap-1 cursor-pointer">
                                    <input type="checkbox" checked={fromFile.has(`${i}:${c.field}`)} onChange={() => { const k = `${i}:${c.field}`; const n = new Set(fromFile); n.has(k) ? n.delete(k) : n.add(k); setFromFile(n); }} />
                                    правлено руками — взять из файла
                                  </label>
                                )}
                              </div>
                            ))}
                          </>
                        )}
                        <div className="text-2xs text-slate-400 line-clamp-2 mt-0.5" title={e.row.description}>{e.row.description}</div>
                      </td>
                      <td className="px-2 py-1.5 hidden @[900px]:table-cell">{prop.match && <Confidence value={prop.match.confidence} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {plan.missing.length > 0 && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 p-2 text-xs max-h-40 overflow-auto">
            <b>Есть в ведомости, нет в файле</b> — отметьте то, что снять (по умолчанию ничего не снимается):
            {plan.missing.map((m) => (
              <label key={m.id} className="flex items-center gap-1.5 mt-1 cursor-pointer font-mono text-2xs">
                <input type="checkbox" checked={removeTake.has(m.id)} onChange={() => { const n = new Set(removeTake); n.has(m.id) ? n.delete(m.id) : n.add(m.id); setRemoveTake(n); }} />
                {m.tags.join(', ') || m.designation || m.id}
              </label>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-center">
          <Btn onClick={() => setStep('columns')}><ArrowLeft className="w-3.5 h-3.5" /> Колонки</Btn>
          <Btn tone="primary" onClick={apply} disabled={!!busy || (!take.size && !removeTake.size)}><Check className="w-3.5 h-3.5" /> Записать {take.size} поз.{removeTake.size ? `, снять ${removeTake.size}` : ''}</Btn>
          <span className="text-2xs text-slate-400">Запись отменяется одним действием (Ctrl+Z в ведомости)</span>
          {busy && <span className="text-xs text-slate-500">{busy}</span>}
        </div>
        {error && <div className="text-xs text-rose-600 dark:text-rose-400">{error}</div>}
      </div>
    );
  }
  return null;
}
