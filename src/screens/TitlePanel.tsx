import React, { useEffect, useState } from 'react';
import { Stamp, X, FileSpreadsheet, Unlink } from 'lucide-react';
import { renderTitleHtml, usedFormulaIds } from './titleTemplate';
import { formulaUserIds, type Formula } from '../lib/docFormula';
import VdrItemPicker from '../components/VdrItemPicker';

// ── Панель «Титул» (общая для Ворда и таблиц) ──
// Выбор шаблона титульного листа + реквизиты конкретного документа.
// Значения хранятся в ConstructorDoc.settings: { titleTemplateId, docMeta }.

export interface TitleSettings {
  titleTemplateId?: string;
  docMeta?: { code?: string; revision?: string; title?: string };
  pageSetup?: { header?: string; footer?: string; pageNumbers?: boolean };
  [k: string]: any;
}

const escHtml = (x: string) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Текст колонтитула → HTML-шаблон Chromium: {page}/{pages} становятся живыми
// счётчиками страниц, {date} и реквизиты — значениями этого документа
function hfLine(text: string, ctx: Record<string, string>): string {
  let out = escHtml(text);
  out = out.replace(/\{page\}/g, '<span class="pageNumber"></span>');
  out = out.replace(/\{pages\}/g, '<span class="totalPages"></span>');
  out = out.replace(/\{(\w[\w.]*)\}/g, (_m, k) => escHtml(ctx[k] ?? ''));
  return out;
}

// Колонтитулы для printToPDF (Electron). Возвращает undefined, если не заданы.
export async function buildPageTemplates(docId: string, settings: TitleSettings):
  Promise<{ headerTemplate?: string; footerTemplate?: string }> {
  const ps = settings.pageSetup || {};
  if (!ps.header && !ps.footer && !ps.pageNumbers) return {};
  let ctx: Record<string, string> = {};
  try {
    const r = await fetch(`/api/constructor/title/context?docId=${docId}`);
    if (r.ok) ctx = (await r.json()).context || {};
  } catch (_) {}
  const wrap = (inner: string) =>
    `<div style="width:100%;font-size:8pt;font-family:'Times New Roman',serif;color:#334155;padding:0 10mm;display:flex;align-items:center;justify-content:space-between">${inner}</div>`;
  const out: { headerTemplate?: string; footerTemplate?: string } = {};
  if (ps.header) out.headerTemplate = wrap(`<span></span><span>${hfLine(ps.header, ctx)}</span><span></span>`);
  if (ps.footer || ps.pageNumbers) {
    const left = ps.footer ? hfLine(ps.footer, ctx) : '';
    const right = ps.pageNumbers ? 'Стр. <span class="pageNumber"></span> из <span class="totalPages"></span>' : '';
    out.footerTemplate = wrap(`<span>${left}</span><span></span><span>${right}</span>`);
  }
  return out;
}

// Титульный лист документа: шаблон + контекст → готовый HTML для печати
/** Каталог формул проекта по идентификатору. Пустой — если формул нет. */
export async function fetchFormulaCatalog(projectId?: string): Promise<Record<string, Formula>> {
  if (!projectId) return {};
  try {
    const r = await fetch(`/api/projects/${projectId}/formulas`);
    if (!r.ok) return {};
    const list: Formula[] = (await r.json()).formulas || [];
    return Object.fromEntries(list.map(f => [f.id, f]));
  } catch (_) { return {}; }
}

/**
 * Титульный лист со значениями. Порядок важен: сначала шаблон, потом каталог
 * формул этого проекта, и только после — контекст, потому что список нужных
 * сотрудников известен лишь из формул, стоящих на листе. Без каталога плашки
 * печатались зачёркнутыми, без сотрудников подпись выходила пустой.
 */
export async function fetchTitlePageHtml(docId: string, templateId?: string): Promise<string> {
  if (!templateId) return '';
  try {
    const tplRes = await fetch(`/api/constructor/docs/${templateId}`);
    if (!tplRes.ok) return '';
    const tpl = (await tplRes.json()).doc;
    let html = '';
    try { html = JSON.parse(tpl.bindings || '{}')?.html || ''; } catch (_) {}
    if (!html) return '';

    const catalog = await fetchFormulaCatalog(tpl.projectId);
    const userIds = formulaUserIds(usedFormulaIds(html), catalog);
    const q = `docId=${encodeURIComponent(docId)}${userIds.length ? `&userIds=${encodeURIComponent(userIds.join(','))}` : ''}`;
    const ctxRes = await fetch(`/api/constructor/title/context?${q}`);
    if (!ctxRes.ok) return '';
    const ctx = (await ctxRes.json()).context;

    return `<div style="page-break-after:always;padding:10mm 0">${renderTitleHtml(html, ctx, catalog)}</div>`;
  } catch (_) { return ''; }
}

// «Второй лист» документа — RECORD OF REVISIONS / Учёт ревизий.
// Собирается из истории ревизий строки ВДР (settings.vdrItemId); вставляется
// отдельной страницей после титула при печати/PDF. Пустая история → ''.
export async function fetchRevisionsSheetHtml(settings: TitleSettings): Promise<string> {
  const itemId = settings?.vdrItemId;
  if (!itemId) return '';
  try {
    const r = await fetch(`/api/vdr/items/${itemId}/revisions`);
    if (!r.ok) return '';
    const revisions: any[] = (await r.json()).revisions || [];
    if (!revisions.length) return '';
    const esc = (x: any) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmtD = (d: any) => { const x = d ? new Date(d) : null; return x && !isNaN(x.getTime()) ? x.toLocaleDateString('ru-RU') : ''; };
    const td = 'border:0.5pt solid #0f172a;padding:3px 8px;font-size:9pt;vertical-align:top';
    const rows = revisions.map(v =>
      `<tr><td style="${td};text-align:center;font-weight:bold">${esc(v.revision)}</td><td style="${td};text-align:center">${fmtD(v.date)}</td><td style="${td}">${esc(v.place)}</td><td style="${td}">${esc(v.description || v.reason)}</td></tr>`).join('');
    return `<div style="page-break-after:always;font-family:'Times New Roman',serif;color:#0f172a;padding:10mm 0">
      <p style="text-align:center;font-size:13pt;font-weight:bold;margin:0 0 4px">RECORD OF REVISIONS</p>
      <p style="text-align:center;font-size:12pt;font-weight:bold;margin:0 0 14px">УЧЁТ РЕВИЗИЙ</p>
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <th style="${td};width:12%;background:#f1f5f9">Rev. /<br>Ревизия</th>
          <th style="${td};width:16%;background:#f1f5f9">Date /<br>Дата</th>
          <th style="${td};width:28%;background:#f1f5f9">Location of Change /<br>Место изменения</th>
          <th style="${td};background:#f1f5f9">Change description /<br>Описание изменения</th>
        </tr>${rows}
      </table></div>`;
  } catch (_) { return ''; }
}

export default function TitlePanel({ projectId, settings, onChange, onClose, docId }: {
  projectId: string;
  settings: TitleSettings;
  onChange: (next: TitleSettings, persist: boolean) => void;
  onClose: () => void;
  docId?: string; // текущий документ — для привязки к строке ВДР
}) {
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [vdrPickerOpen, setVdrPickerOpen] = useState(false);

  // Привязка документа к строке ВДР: сервер связывает обе стороны и кладёт
  // реквизиты строки в docMeta — здесь только синхронизируем локальное состояние
  const linkVdr = async (itemId: string | null, picked?: any) => {
    if (!docId) return;
    if (!itemId && settings.vdrItemId) {
      await fetch(`/api/vdr/items/${settings.vdrItemId}/link-doc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId: null }),
      }).catch(() => {});
      const next = { ...settings };
      delete next.vdrItemId;
      onChange(next, true);
      return;
    }
    if (!itemId) return;
    const r = await fetch(`/api/vdr/items/${itemId}/link-doc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId }),
    });
    if (r.ok) {
      onChange({
        ...settings,
        vdrItemId: itemId,
        docMeta: {
          ...settings.docMeta,
          code: picked?.contractorNo || settings.docMeta?.code,
          revision: picked?.revision || settings.docMeta?.revision,
          title: picked?.titleRu || picked?.titleEn || settings.docMeta?.title,
        },
      }, true);
    }
  };

  useEffect(() => {
    fetch(`/api/constructor/title/templates?projectId=${projectId}`)
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d) => setTemplates(d.templates || []))
      .catch(() => {});
  }, [projectId]);

  return (
    <div className="absolute right-4 top-14 z-40 w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-800">
        <span className="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-1.5"><Stamp className="w-4 h-4 text-emerald-600" /> Титульный лист</span>
        <button type="button" title="Закрыть титульный лист" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
      </div>
      <div className="p-4 space-y-3">
        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Шаблон титула</label>
          <select
            value={settings.titleTemplateId || ''}
            onChange={(e) => onChange({ ...settings, titleTemplateId: e.target.value || undefined }, true)}
            className="w-full px-2.5 py-1.5 text-sm border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-950 text-slate-800 dark:text-white cursor-pointer">
            <option value="">— без титула —</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {templates.length === 0 && (
            <p className="text-xs text-slate-400 mt-1">Создаются в «Таблице» → «Шаблон титула»</p>
          )}
        </div>
        <div className="pt-1 border-t border-slate-100 dark:border-slate-850 space-y-2">
          {([['code', 'Номер / шифр'], ['revision', 'Ревизия'], ['title', 'Наименование']] as const).map(([k, label]) => (
            <div key={k}>
              <label className="block text-xs font-bold text-slate-500 uppercase">{label}</label>
              <input
                value={settings.docMeta?.[k] || ''}
                onChange={(e) => onChange({ ...settings, docMeta: { ...settings.docMeta, [k]: e.target.value } }, false)}
                onBlur={() => onChange(settings, true)}
                className="w-full mt-0.5 px-2.5 py-1.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500" />
            </div>
          ))}
        </div>
        <div className="pt-1 border-t border-slate-100 dark:border-slate-850 space-y-2">
          <p className="text-2xs text-slate-400 font-mono">{'{page} {pages} {date} {doc.code} {doc.revision} {project.code}'}</p>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase">Верхний колонтитул</label>
            <input
              value={settings.pageSetup?.header || ''}
              onChange={(e) => onChange({ ...settings, pageSetup: { ...settings.pageSetup, header: e.target.value } }, false)}
              onBlur={() => onChange(settings, true)}
              placeholder="напр. {doc.code} · Рев. {doc.revision}"
              className="w-full mt-0.5 px-2.5 py-1.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500" />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase">Нижний колонтитул</label>
            <input
              value={settings.pageSetup?.footer || ''}
              onChange={(e) => onChange({ ...settings, pageSetup: { ...settings.pageSetup, footer: e.target.value } }, false)}
              onBlur={() => onChange(settings, true)}
              placeholder="напр. {project.code} · {date}"
              className="w-full mt-0.5 px-2.5 py-1.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-white focus:outline-none focus:border-emerald-500" />
          </div>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={!!settings.pageSetup?.pageNumbers}
              onChange={(e) => onChange({ ...settings, pageSetup: { ...settings.pageSetup, pageNumbers: e.target.checked } }, true)}
              className="w-4 h-4 accent-emerald-500" />
            Нумерация страниц (Стр. N из M)
          </label>
        </div>
        {docId && (
          <div className="pt-1 border-t border-slate-100 dark:border-slate-850">
            {settings.vdrItemId ? (
              <div className="flex items-center gap-2">
                <span className="flex-1 text-xs text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-500" /> Привязан к строке ВДР
                </span>
                <button type="button" onClick={() => linkVdr(null)} title="Отвязать от строки ВДР"
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 cursor-pointer"><Unlink className="w-3.5 h-3.5" /></button>
              </div>
            ) : (
              <button type="button" onClick={() => setVdrPickerOpen(true)}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 text-xs font-bold hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer">
                <FileSpreadsheet className="w-3.5 h-3.5" /> Привязать к строке ВДР…
              </button>
            )}
          </div>
        )}
      </div>
      {vdrPickerOpen && (
        <VdrItemPicker
          projectId={projectId}
          title="Привязать документ к строке ВДР"
          onClose={() => setVdrPickerOpen(false)}
          onPick={(it) => { setVdrPickerOpen(false); linkVdr(it.id, it); }}
        />
      )}
    </div>
  );
}
