import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, Save, Bold, Italic, AlignLeft, AlignCenter, AlignRight, Eye, Sigma, X, Image as ImageIcon, Table } from 'lucide-react';
import { useToastStore } from '../store/toastStore';
import { TITLE_FIELDS, fieldChipHtml, namedChipHtml, renderTitleHtml } from './titleTemplate';
import { fetchFormulaCatalog } from './TitlePanel';
import type { Formula } from '../lib/docFormula';
import FormulaManager from '../components/FormulaManager';

// ── Редактор шаблона титула ────────────────────────────────────────────────
// A4-полотно (contenteditable): свободный текст + «ссылки» (чипы полей) и
// формулы. Сохраняется в документ kind=TEMPLATE, bindings={subtype:'title',html}.
// Присваивается документу в редакторе Ворда — там подставятся значения.

const SAMPLE = {
  'doc.name': 'Пояснительная записка', 'doc.code': 'ПЗ-001', 'doc.revision': 'B', 'doc.title': 'Система вентиляции',
  'project.code': 'PRJ-2026', 'project.name': 'АБК завода', 'project.customer': 'ООО «Заказчик»', 'project.contractor': 'ООО «Подрядчик»',
  author: 'Иванов И.И.', date: new Date().toLocaleDateString('ru-RU'), dateTime: new Date().toLocaleString('ru-RU'),
  year: String(new Date().getFullYear()), page: '1', pages: '3',
  // ФИО по частям — чтобы в предпросмотре формулы «Инициалы» было видно
  // «Иванов И.И.», а не пустое место
  'person.author.name': 'Иванов Иван Иванович',
  'person.author.lastName': 'Иванов', 'person.author.firstName': 'Иван', 'person.author.middleName': 'Иванович',
  'person.current.name': 'Иванов Иван Иванович',
  'person.current.lastName': 'Иванов', 'person.current.firstName': 'Иван', 'person.current.middleName': 'Иванович',
};

export default function TitleTemplateEditor({ docId, onClose }: { docId: string; onClose: () => void }) {
  const { addToast } = useToastStore();
  const editorRef = useRef<HTMLDivElement>(null);
  const htmlRef = useRef<string>('');
  const savedRange = useRef<Range | null>(null);
  const [doc, setDoc] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [fxOpen, setFxOpen] = useState(false);
  const [catalog, setCatalog] = useState<Record<string, Formula>>({});
  const projectId: string = doc?.projectId || '';

  // Каталог формул проекта — для предпросмотра. Перечитываем при закрытии
  // справочника: там формулу могли создать или перенастроить.
  useEffect(() => {
    if (!projectId || fxOpen) return;
    let dead = false;
    fetchFormulaCatalog(projectId).then(c => { if (!dead) setCatalog(c); });
    return () => { dead = true; };
  }, [projectId, fxOpen]);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch(`/api/constructor/docs/${docId}`);
        if (!r.ok) { addToast('Не удалось открыть шаблон', 'error'); onClose(); return; }
        const { doc: loaded } = await r.json();
        if (dead) return;
        setDoc(loaded);
        let html = '';
        try { html = JSON.parse(loaded.bindings || '{}')?.html || ''; } catch { html = ''; }
        htmlRef.current = html || defaultTemplate();
        setLoading(false);
      } catch (_) { addToast('Ошибка загрузки', 'error'); onClose(); }
    })();
    return () => { dead = true; };
  }, [docId]);

  // Наполняем полотно после его монтирования (в режиме правки): при загрузке и
  // при возврате из предпросмотра (полотно пересоздаётся — data-populated сброшен)
  useEffect(() => {
    if (loading || preview) return;
    const el = editorRef.current;
    if (el && el.dataset.populated !== '1') { el.innerHTML = htmlRef.current; el.dataset.populated = '1'; }
  }, [loading, preview]);

  const togglePreview = () => {
    if (!preview && editorRef.current) htmlRef.current = editorRef.current.innerHTML;
    setPreview((v) => !v);
  };

  const rememberCaret = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editorRef.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  };

  const insertHtmlAtCaret = (html: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (savedRange.current) { sel?.removeAllRanges(); sel?.addRange(savedRange.current); }
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const frag = document.createRange().createContextualFragment(html + ' ');
    if (range && el.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      range.insertNode(frag);
      range.collapse(false);
    } else {
      el.appendChild(frag);
    }
    rememberCaret();
  };

  const cmd = (c: string, v?: string) => { editorRef.current?.focus(); document.execCommand(c, false, v); rememberCaret(); };

  // Размер в pt: execCommand умеет только шкалу 1-7 — ставим 7 как маркер,
  // затем меняем созданные <font size="7"> на точный размер в пунктах
  const setFontSizePt = (pt: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    document.execCommand('fontSize', false, '7');
    el.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement('span');
      span.style.fontSize = `${pt}pt`;
      span.innerHTML = (f as HTMLElement).innerHTML;
      f.replaceWith(span);
    });
    rememberCaret();
  };

  // Логотип/картинка: файл → base64 внутрь шаблона (самодостаточный HTML)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const insertImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => insertHtmlAtCaret(`<img src="${reader.result}" style="max-width:55%;height:auto;" alt="" />`);
    reader.readAsDataURL(file);
  };

  // Штамп (основная надпись): таблица с ссылками внизу титула
  const insertStamp = () => {
    const el = editorRef.current;
    if (!el) return;
    el.insertAdjacentHTML('beforeend', stampTemplate());
    rememberCaret();
  };

  const save = async () => {
    if (!preview && editorRef.current) htmlRef.current = editorRef.current.innerHTML;
    const html = htmlRef.current || '';
    setSaving(true);
    try {
      const r = await fetch(`/api/constructor/docs/${docId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindings: JSON.stringify({ subtype: 'title', html }) }),
      });
      if (r.ok) { setDoc((await r.json()).doc); addToast('Шаблон титула сохранён', 'success'); }
      else addToast('Не удалось сохранить', 'error');
    } catch (_) { addToast('Ошибка сохранения', 'error'); }
    setSaving(false);
  };

  // Предпросмотр — с каталогом формул проекта: иначе плашки показывались
  // зачёркнутыми, как будто формулу удалили
  const previewHtml = () => renderTitleHtml(htmlRef.current || '', SAMPLE as any, catalog);

  const grouped = TITLE_FIELDS.reduce((acc, f) => { (acc[f.group] ||= []).push(f); return acc; }, {} as Record<string, typeof TITLE_FIELDS>);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <button type="button" onClick={async () => { await save(); onClose(); }} className="flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-white cursor-pointer">
          <ArrowLeft className="w-4 h-4" /> Закрыть
        </button>
        <input
          value={doc?.name || ''}
          onChange={(e) => setDoc((d: any) => ({ ...d, name: e.target.value }))}
          onBlur={(e) => { const v = e.target.value.trim(); if (v) fetch(`/api/constructor/docs/${docId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: v }) }); }}
          className="font-bold text-slate-800 dark:text-white bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-500 focus:outline-none px-1 py-0.5 min-w-40 max-w-md"
        />
        <span className="px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 text-xs font-bold">Шаблон титула</span>
        <div className="flex-1" />
        {/* Форматирование */}
        <div className="flex items-center gap-0.5">
          <select onMouseDown={rememberCaret} onChange={(e) => cmd('fontName', e.target.value)} defaultValue="Times New Roman"
            className="h-8 px-1 max-w-36 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-300 text-xs cursor-pointer" title="Шрифт">
            {['Times New Roman', 'Arial', 'Calibri', 'Georgia', 'Verdana', 'Courier New'].map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </select>
          <select onMouseDown={rememberCaret} onChange={(e) => setFontSizePt(e.target.value)} defaultValue="12"
            className="h-8 px-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-300 text-xs cursor-pointer" title="Размер, pt">
            {['9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '36', '48'].map((s) => <option key={s} value={s}>{s} pt</option>)}
          </select>
          <button onMouseDown={(e) => { e.preventDefault(); cmd('bold'); }} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer" title="Жирный"><Bold className="w-4 h-4" /></button>
          <button onMouseDown={(e) => { e.preventDefault(); cmd('italic'); }} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer" title="Курсив"><Italic className="w-4 h-4" /></button>
          <button onMouseDown={(e) => { e.preventDefault(); cmd('justifyLeft'); }} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer" title="Слева"><AlignLeft className="w-4 h-4" /></button>
          <button onMouseDown={(e) => { e.preventDefault(); cmd('justifyCenter'); }} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer" title="По центру"><AlignCenter className="w-4 h-4" /></button>
          <button onMouseDown={(e) => { e.preventDefault(); cmd('justifyRight'); }} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer" title="Справа"><AlignRight className="w-4 h-4" /></button>
          <button onMouseDown={(e) => { e.preventDefault(); fileInputRef.current?.click(); }} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer" title="Вставить логотип/картинку"><ImageIcon className="w-4 h-4" /></button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) insertImage(f); e.target.value = ''; }} />
        </div>
        <button type="button" onClick={togglePreview} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${preview ? 'bg-emerald-600 text-white' : 'border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-850'}`}>
          <Eye className="w-3.5 h-3.5" /> Предпросмотр
        </button>
        <button type="button" onClick={save} disabled={saving} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold cursor-pointer">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Сохранить
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Палитра ссылок */}
        {!preview && (
          <div className="w-60 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-y-auto p-3 space-y-3">
            {Object.entries(grouped).map(([group, fields]) => (
              <div key={group}>
                <div className="text-2xs font-bold text-slate-400 mb-1">{group}</div>
                <div className="flex flex-wrap gap-1.5">
                  {fields.map((f) => (
                    <button key={f.key} onMouseDown={(e) => { e.preventDefault(); insertHtmlAtCaret(fieldChipHtml(f.key)); }}
                      className="px-2 py-1 rounded-md bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 text-xs font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-950/60 cursor-pointer">
                      {f.title}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
              <button onMouseDown={(e) => { e.preventDefault(); insertStamp(); }} className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-bold hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer" title="Таблица основной надписи внизу титула">
                <Table className="w-3.5 h-3.5" /> Вставить штамп
              </button>
              <button type="button" onClick={() => setFxOpen((v) => !v)}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 text-xs font-bold hover:bg-emerald-100 dark:hover:bg-emerald-950/60 cursor-pointer">
                <Sigma className="w-3.5 h-3.5" /> Вставить формулу
              </button>
            </div>
          </div>
        )}

        {/* Справочник формул: выбрать готовую или завести новую, не уходя из
            документа. Компонент тот же, что в Настройках, — второй карточки
            настройки нет намеренно. */}
        {fxOpen && projectId && (
          <div className="absolute inset-0 z-30 bg-black/25 flex items-center justify-center p-6"
            onMouseDown={() => setFxOpen(false)}>
            <div className="w-full max-w-4xl h-[560px] sheet bg-white dark:bg-slate-950 shadow-modal"
              onMouseDown={(e) => e.stopPropagation()}>
              <FormulaManager
                projectId={projectId}
                onClose={() => setFxOpen(false)}
                onInsert={(f) => {
                  insertHtmlAtCaret(namedChipHtml(f));
                  setFxOpen(false);
                }}
              />
            </div>
          </div>
        )}

        {/* A4-полотно */}
        <div className="flex-1 min-h-0 overflow-auto bg-slate-100 dark:bg-slate-950 p-6 flex justify-center">
          <style>{`
            .tt-a4 { width: 210mm; min-height: 297mm; background: #fff; color: #0f172a; padding: 25mm 20mm; box-shadow: 0 8px 30px rgba(0,0,0,.12); font-family: 'Times New Roman', serif; }
            .tt-a4 img { max-width: 100%; }
            .tt-a4 .tt-chip { display: inline-block; padding: 0 5px; margin: 0 1px; border-radius: 5px; background: #d1fae5; color: #047857; font-weight: 600; font-size: .95em; }
            .tt-a4 .tt-chip-fx { background: #e0e7ff; color: #4338ca; }
            .tt-a4:focus { outline: none; }
          `}</style>
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 pt-20"><Loader2 className="w-5 h-5 animate-spin" /> Загрузка…</div>
          ) : preview ? (
            <div className="tt-a4" dangerouslySetInnerHTML={{ __html: previewHtml() }} />
          ) : (
            <div ref={editorRef} className="tt-a4" contentEditable suppressContentEditableWarning onKeyUp={rememberCaret} onMouseUp={rememberCaret} />
          )}
        </div>
      </div>
    </div>
  );
}

function defaultTemplate(): string {
  return `<div style="text-align:center;font-family:'Times New Roman',serif">
    <p style="font-size:12pt">${fieldChipHtml('project.customer')}</p>
    <p style="margin-top:60px;font-size:20pt;font-weight:bold">${fieldChipHtml('doc.title')}</p>
    <p style="margin-top:20px;font-size:12pt">Шифр: ${fieldChipHtml('doc.code')} · Ревизия: ${fieldChipHtml('doc.revision')}</p>
    <p style="margin-top:120px;font-size:11pt">Проект: ${fieldChipHtml('project.name')} (${fieldChipHtml('project.code')})</p>
    <p style="font-size:11pt">Разработал: ${fieldChipHtml('author')}</p>
    <p style="margin-top:40px;font-size:11pt">${fieldChipHtml('year')}</p>
  </div>`;
}

// Основная надпись (упрощённый штамп в духе ГОСТ 21.1101): таблица с ссылками.
// Ячейки редактируются как обычный текст — размеры/подписи можно править.
function stampTemplate(): string {
  const td = 'border:0.5pt solid #0f172a;padding:2px 6px;font-size:9pt;vertical-align:middle';
  return `<table contenteditable="true" style="width:100%;border-collapse:collapse;margin-top:24px;font-family:'Times New Roman',serif;color:#0f172a">
    <tr>
      <td style="${td};width:18%">Шифр</td>
      <td style="${td};width:22%;text-align:center">${fieldChipHtml('doc.code')}</td>
      <td style="${td};width:36%;text-align:center" rowspan="3">${fieldChipHtml('doc.title')}</td>
      <td style="${td};width:12%">Рев.</td>
      <td style="${td};width:12%;text-align:center">${fieldChipHtml('doc.revision')}</td>
    </tr>
    <tr>
      <td style="${td}">Разработал</td>
      <td style="${td};text-align:center">${fieldChipHtml('author')}</td>
      <td style="${td}">Дата</td>
      <td style="${td};text-align:center">${fieldChipHtml('date')}</td>
    </tr>
    <tr>
      <td style="${td}">Проект</td>
      <td style="${td};text-align:center">${fieldChipHtml('project.code')}</td>
      <td style="${td}">Лист</td>
      <td style="${td};text-align:center">${fieldChipHtml('page')} / ${fieldChipHtml('pages')}</td>
    </tr>
  </table>`;
}
