/**
 * Чертёж ПДФ: просмотр и пометки.
 *
 * Раньше присланный чертёж можно было только посмотреть в Проводнике, а
 * замечания писали в письме или на бумаге — и через полгода никто не мог
 * сказать, к чему относилось «поправить узел в осях 3-4».
 *
 * Здесь замечания живут в проекте: пометка знает автора, время и ревизию, на
 * которой поставлена. Сам файл не меняется никогда — это главное свойство
 * присланного документа, и терять его нельзя.
 *
 * Страницу рисует pdf.js в канву, пометки лежат слоем поверх (components/pdf).
 */
import React, { useEffect, useRef, useState } from 'react';
import { useRibbonFold } from '../components/ribbon/useRibbonFold';
import { useSearchParams } from 'react-router-dom';
import { FileText, Loader2, Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import EditorFrame from '../components/ribbon/EditorFrame';
import MarkupLayer, { type Markup } from '../components/pdf/MarkupLayer';
import MarkupList from '../components/pdf/MarkupList';
import PageThumbs from '../components/pdf/PageThumbs';
import { findInPages, stepHit, hitsLabel, type Hit, type PageText } from '../lib/pdfSearch';
import {
  SCALES, PT_TO_MM, measureLabel, scaleLabel, type Sheet,
} from '../lib/pdfMeasure';
import { pdfRibbon, MARKUP_COLORS } from '../lib/ribbonPdf';
import { openPdf } from '../import/pdfShared';
import { useToastStore } from '../store/toastStore';
import { useModalStore } from '../store/modalStore';
import { useWindowTitle } from '../lib/paneTitle';
import { rememberDoc } from '../store/recentStore';
import { useStore } from '../store/store';
import { signCaption, signBox, NO_SIGNATURE, DEFAULT_AT } from '../lib/signStamp';
import { roleByCode } from '../lib/roles';

const { openPrompt, openConfirm } = useModalStore.getState();

/** Инструмент пометки: какой кнопкой ленты он включается */
const TOOLS: Record<string, Markup['kind']> = {
  'pdf.cloud': 'CLOUD', 'pdf.rect': 'RECT', 'pdf.arrow': 'ARROW', 'pdf.note': 'NOTE',
};

/** base64 из data:URL, которым Проводник хранит содержимое файла */
function dataUrlToBytes(content: string): ArrayBuffer | null {
  try {
    const b64 = content.includes(',') ? content.split(',')[1] : content;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  } catch (_) { return null; }
}

export default function PdfEditor() {
  const [params, setParams] = useSearchParams();
  const fileId = params.get('file') || '';
  const { addToast } = useToastStore();

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfRef = useRef<any>(null);

  const [file, setFile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [rotate, setRotate] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [invert, setInvert] = useState(false);
  const [thumbs, setThumbs] = useState(false);
  // ── Поиск по тексту документа ──
  // Текст страниц вынимается один раз на файл: на сорока листах разбор идёт
  // заметное время, и делать его на каждую букву запроса нельзя
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [hitAt, setHitAt] = useState(-1);
  const [reading, setReading] = useState(false);
  const textRef = useRef<PageText[] | null>(null);

  const [markups, setMarkups] = useState<Markup[]>([]);
  const [scope, setScope] = useState<'current' | 'all'>('all');
  const [tool, setTool] = useState<Markup['kind'] | null>(null);
  const [color, setColor] = useState(MARKUP_COLORS[0]);
  const [stroke, setStroke] = useState(2);
  const [selected, setSelected] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [fileOpen, setFileOpen] = useState(false);
  const [tab, setTab] = useState('Главная');
  // Свёрнутая лента помнится между документами и программами семьи
  const [folded, setFolded] = useRibbonFold();
  /**
   * Подписи людей по их идентификатору.
   *
   * В самой пометке подпись не хранится: копия в каждой пометке значила бы,
   * что смена подписи в профиле не доходит до документов, а старые росчерки
   * живут вечно. Здесь только то, что нужно нарисовать открытый лист.
   */
  const [signs, setSigns] = useState<Record<string, { src: string; heightMm: number }>>({});
  const me = useStore((st) => st.user);
  /** Настоящий размер листа в точках ПДФ — по нему считается место подписи */
  const pageSizePt = useRef<{ w: number; h: number } | null>(null);
  /**
   * Измерения: масштаб листа и что намерили последним.
   *
   * Масштаб — свойство документа, а не пометки: на чертеже он один и стоит в
   * штампе. Спрашивать его на каждое измерение значило бы спрашивать одно и
   * то же по десять раз за разбор одного листа.
   */
  const [measure, setMeasure] = useState<'length' | 'area' | null>(null);
  const [sheetScale, setSheetScale] = useState(1);
  const [measured, setMeasured] = useState('');

  const tabs = React.useMemo(() => pdfRibbon(), []);
  const revision = String(file?.revision || '1');

  // Имя окна — имя чертежа с ревизией: их открывают по нескольку сразу
  useWindowTitle(file?.name ? `${file.name} · ред. ${revision}` : '');

  // Чертёж — такая же вещь в списке недавних, как таблица и записка: человек
  // ищет «то, что смотрел вчера», не разбирая, какой это программой открывалось
  useEffect(() => {
    if (!file?.name) return;
    rememberDoc({ href: `/pdf?file=${fileId}`, title: file.name, kind: 'pdf', at: Date.now() });
  }, [fileId, file?.name]);

  // ── Загрузка файла и его пометок ──
  useEffect(() => {
    if (!fileId) { setLoading(false); return; }
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/files/${fileId}`);
        if (!r.ok) throw new Error('файл не найден');
        const f = (await r.json()).file || (await r.json());
        if (!alive) return;
        setFile(f);
        const bytes = f?.content ? dataUrlToBytes(f.content) : null;
        if (!bytes) { addToast('У файла нет содержимого', 'error'); setLoading(false); return; }
        const pdf = await openPdf(bytes);
        if (!alive) return;
        pdfRef.current = pdf;
        setPages(pdf.numPages || 1);
        setLoading(false);
      } catch (e) {
        if (alive) { addToast('Не удалось открыть чертёж', 'error'); setLoading(false); }
      }
    })();
    return () => { alive = false; };
  }, [fileId]);

  const loadMarkups = async () => {
    if (!fileId) return;
    try {
      const r = await fetch(`/api/files/${fileId}/markups`);
      if (r.ok) setMarkups((await r.json()).markups || []);
    } catch (_) { /* сеть отвалилась — список останется прежним */ }
  };
  useEffect(() => { loadMarkups(); }, [fileId]);

  // ── Отрисовка страницы ──
  useEffect(() => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await pdf.getPage(Math.min(Math.max(1, page), pdf.numPages));
        if (cancelled) return;
        const viewport = p.getViewport({ scale: zoom / 100, rotation: rotate });
        // Размер листа берём при масштабе 1: на нём считается место подписи, а
        // оно не должно зависеть от того, как человек приблизил чертёж
        const real = p.getViewport({ scale: 1, rotation: 0 });
        pageSizePt.current = { w: real.width, h: real.height };
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        setSize({ w: canvas.width, h: canvas.height });
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        await p.render({ canvasContext: ctx, viewport }).promise;
      } catch (e: any) {
        // Отмену рендера новым масштабом молчим — она штатная; остальное видно
        if (e?.name !== 'RenderingCancelledException') console.error('[ПДФ] Страница не отрисована:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [page, zoom, rotate, loading]);

  /** Вписать лист: по ширине окна или целиком */
  const fit = (mode: 'width' | 'page') => {
    const pdf = pdfRef.current;
    const box = wrapRef.current;
    if (!pdf || !box) return;
    pdf.getPage(page).then((p: any) => {
      const v = p.getViewport({ scale: 1, rotation: rotate });
      const kw = (box.clientWidth - 48) / v.width;
      const kh = (box.clientHeight - 48) / v.height;
      setZoom(Math.round(100 * (mode === 'width' ? kw : Math.min(kw, kh))));
    }).catch(() => {});
  };

  // ── Пометки: постановка мышью ──
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const rel = (e: React.MouseEvent) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onDown = (e: React.MouseEvent) => {
    if (measure) { startRef.current = rel(e); setMeasured(''); return; }
    if (!tool) return;
    startRef.current = rel(e);
    setDraft({ ...startRef.current, w: 0, h: 0, kind: tool, color });
  };
  const onMove = (e: React.MouseEvent) => {
    // Измерение показывается на ходу: человек тянет и сразу видит число, а не
    // узнаёт его после отпускания, когда поправить уже нечего
    if (measure && startRef.current) {
      const p = rel(e);
      const s0 = startRef.current;
      setMeasured(measureLabel(measure,
        { dx: Math.abs(p.x - s0.x), dy: Math.abs(p.y - s0.y) }, sheetOf()));
      setDraft({
        x: Math.min(s0.x, p.x), y: Math.min(s0.y, p.y),
        w: Math.abs(p.x - s0.x), h: Math.abs(p.y - s0.y),
        kind: 'RECT', color: '#0369a1',
      });
      return;
    }
    if (!tool || !startRef.current) return;
    const p = rel(e);
    const s = startRef.current;
    setDraft({
      x: Math.min(s.x, p.x), y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y),
      kind: tool, color,
    });
  };
  const onUp = async (e: React.MouseEvent) => {
    if (measure) { startRef.current = null; setDraft(null); return; }
    if (!tool || !startRef.current) return;
    const s = startRef.current;
    const p = rel(e);
    startRef.current = null;
    setDraft(null);
    const box = {
      x: Math.min(s.x, p.x), y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y),
    };
    // Записка и стрелка ставятся одним щелчком, обводка — рамкой. Случайный
    // щелчок обводкой не превращаем в пометку размером в точку
    if ((tool === 'CLOUD' || tool === 'RECT') && (box.w < 0.01 || box.h < 0.01)) return;
    const text = await openPrompt('Замечание', 'Коротко: что не так и что сделать',
      'например: уточнить отметку низа воздуховода');
    if (text === null) return;
    await addMarkup(tool, box, text || '');
  };

  const addMarkup = async (kind: Markup['kind'], box: any, text: string) => {
    try {
      const r = await fetch(`/api/files/${fileId}/markups`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...box, kind, page, color, strokeWidth: stroke, text }),
      });
      if (!r.ok) { addToast('Не удалось поставить пометку', 'error'); return; }
      const { markup } = await r.json();
      setMarkups((list) => [...list, markup]);
      setSelected(markup.id);
    } catch (_) { addToast('Не удалось поставить пометку', 'error'); }
  };

  const patchMarkup = async (id: string, data: any) => {
    try {
      const r = await fetch(`/api/pdf-markups/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      if (!r.ok) return;
      const { markup } = await r.json();
      setMarkups((list) => list.map((m) => (m.id === id ? markup : m)));
    } catch (_) { /* молча: список перечитается при следующем открытии */ }
  };

  const removeMarkup = async (id: string) => {
    if (!await openConfirm('Снять пометку?', 'Замечание уйдёт из списка. Историю переписки это не меняет.', { confirmLabel: 'Снять' })) return;
    try {
      await fetch(`/api/pdf-markups/${id}`, { method: 'DELETE' });
      setMarkups((list) => list.filter((m) => m.id !== id));
      if (selected === id) setSelected(null);
    } catch (_) { addToast('Не удалось снять пометку', 'error'); }
  };

  /**
   * Подписи всех, кто подписал этот чертёж.
   *
   * Тянем по мере появления пометок и по одному разу на человека: подписанный
   * лист бывает подписан несколькими, и запрашивать росчерк на каждую пометку
   * значило бы дёргать сервер по десятку раз ради одной картинки.
   */
  useEffect(() => {
    const need = [...new Set(markups.filter((m) => m.kind === 'SIGN' && m.createdBy?.id)
      .map((m) => String(m.createdBy!.id)))].filter((id) => !signs[id]);
    if (!need.length) return;
    let alive = true;
    (async () => {
      const got: Record<string, { src: string; heightMm: number }> = {};
      for (const id of need) {
        try {
          const r = await fetch(`/api/users/${id}/signature`);
          const j = r.ok ? await r.json() : null;
          if (j?.signature) got[id] = { src: String(j.signature), heightMm: Number(j.signatureHeightMm) || 8 };
        } catch (_) { /* без росчерка нарисуется линия для подписи от руки */ }
      }
      if (alive && Object.keys(got).length) setSigns((all) => ({ ...all, ...got }));
    })();
    return () => { alive = false; };
  }, [markups]);

  /** Текст всех страниц — один раз на документ */
  const readText = async (): Promise<PageText[]> => {
    if (textRef.current) return textRef.current;
    const pdf = pdfRef.current;
    if (!pdf) return [];
    setReading(true);
    const out: PageText[] = [];
    try {
      for (let i = 1; i <= (pdf.numPages || 1); i++) {
        const p = await pdf.getPage(i);
        const content = await p.getTextContent();
        out.push({ page: i, text: (content.items || []).map((x: any) => x.str || '').join(' ') });
      }
      textRef.current = out;
    } catch (_) {
      // Скан без текстового слоя — искать в нём нечем, и это надо сказать
    } finally { setReading(false); }
    return out;
  };

  const runSearch = async (q: string) => {
    const pagesText = await readText();
    const found = findInPages(pagesText, q);
    setHits(found);
    const first = stepHit(found.length, -1, 1);
    setHitAt(first);
    if (first >= 0) setPage(found[first].page);
    else if (q.trim()) {
      addToast(pagesText.length && pagesText.some((p) => p.text.trim())
        ? 'Совпадений нет'
        : 'В этом файле нет текстового слоя — это скан. Искать в нём нечем', 'info');
    }
  };

  const goHit = (dir: 1 | -1) => {
    const next = stepHit(hits.length, hitAt, dir);
    setHitAt(next);
    if (next >= 0) setPage(hits[next].page);
  };

  /** Штамп на лист: то же замечание, только с готовым текстом и в углу */
  const stamp = (text: string) =>
    addMarkup('STAMP', { x: 0.72, y: 0.04, w: 0.24, h: 0.06 }, text);

  /**
   * Подписать лист.
   *
   * Подпись берётся из профиля человека — той самой, которую он завёл и
   * почистил от фона. Размер считается из её высоты в миллиметрах и размеров
   * листа: подпись, заданная в 8 мм, обязана выйти в 8 мм и на A4, и на A1.
   *
   * Это НЕ электронная подпись. Скан живого росчерка значит на документе ровно
   * то же, что подпись от руки на распечатке, — и говорить об этом надо прямо.
   */
  const signSheet = async () => {
    if (!me?.id) return;
    let mine = signs[me.id];
    if (!mine) {
      try {
        const r = await fetch(`/api/users/${me.id}/signature`);
        const j = r.ok ? await r.json() : null;
        if (j?.signature) {
          mine = { src: String(j.signature), heightMm: Number(j.signatureHeightMm) || 8 };
          setSigns((all) => ({ ...all, [me.id]: mine as any }));
        }
      } catch (_) { /* ниже скажем словами */ }
    }
    if (!mine) { addToast(NO_SIGNATURE, 'error'); return; }
    const box = signBox(mine.heightMm, DEFAULT_AT, mmOfPage());
    const line = signCaption({
      lastName: (me as any).lastName, firstName: (me as any).firstName,
      middleName: (me as any).middleName, name: me.name,
      position: roleByCode(String(me.role || '')).name,
    });
    await addMarkup('SIGN', box, line);
  };

  /** Лист для измерений: настоящие миллиметры и масштаб из штампа */
  const sheetOf = (): Sheet | null => {
    const v = pageSizePt.current;
    return v ? { wMm: v.w * PT_TO_MM, hMm: v.h * PT_TO_MM, scale: sheetScale } : null;
  };

  /** Размеры открытого листа в миллиметрах — по ним считается место подписи */
  const mmOfPage = (): { wMm?: number; hMm?: number } => {
    // Точки ПДФ — 1/72 дюйма; в миллиметрах это 25.4/72
    const k = 25.4 / 72;
    const v = pageSizePt.current;
    return v ? { wMm: v.w * k, hMm: v.h * k } : {};
  };

  /** Замечания текстом — вставить в письмо поставщику */
  const copyRemarks = async () => {
    const lines = shown
      .filter((m) => m.text)
      .map((m, i) => `${i + 1}. Стр. ${m.page}, ред. ${m.revision} — ${m.text} (${m.createdBy?.name || 'автор неизвестен'})`);
    if (!lines.length) { addToast('Замечаний с текстом пока нет', 'error'); return; }
    const text = `Замечания по чертежу «${file?.name || ''}»\n\n${lines.join('\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      addToast(`Скопировано замечаний: ${lines.length}`, 'success');
    } catch (_) { addToast('Буфер обмена недоступен', 'error'); }
  };

  const shown = markups.filter((m) => m.page === page && (scope === 'all' || m.revision === revision));

  const runCommand = (id: string, value?: string) => {
    // Мерить и обводить одновременно нельзя: мышь одна, и человек не поймёт,
    // почему обводка вдруг ничего не поставила
    if (TOOLS[id]) { setMeasure(null); setTool((t) => (t === TOOLS[id] ? null : TOOLS[id])); return; }
    switch (id) {
      case 'pdf.prev': return setPage((p) => Math.max(1, p - 1));
      case 'pdf.next': return setPage((p) => Math.min(pages, p + 1));
      case 'pdf.zoom': return setZoom((z) => Math.min(400, Math.max(25, z + (value === '+' ? 10 : -10))));
      case 'pdf.fitWidth': return fit('width');
      case 'pdf.fitPage': return fit('page');
      case 'pdf.rotateLeft': return setRotate((r) => (r + 270) % 360);
      case 'pdf.rotateRight': return setRotate((r) => (r + 90) % 360);
      case 'pdf.download': {
        if (!file?.content) return;
        const a = document.createElement('a');
        a.href = file.content; a.download = file.name || 'чертёж.pdf';
        document.body.appendChild(a); a.click(); a.remove();
        return;
      }
      case 'pdf.print': {
        const w = window.open('', '_blank');
        if (!w) { addToast('Всплывающее окно заблокировано', 'error'); return; }
        w.document.write(`<iframe src="${file?.content}" style="border:0;width:100%;height:100%"></iframe>`);
        w.document.close();
        setTimeout(() => { try { w.print(); } catch (_) {} }, 800);
        return;
      }
      case 'pdf.color': { if (value) setColor(value); return; }
      case 'pdf.width': return setStroke((s) => Math.min(12, Math.max(1, s + (value === '+' ? 1 : -1))));
      case 'pdf.sign': return signSheet();
      case 'pdf.stampOk': return stamp('Проверено');
      case 'pdf.stampWork': return stamp('В работу');
      case 'pdf.stampNo': return stamp('Отменено');
      case 'pdf.list': return setListOpen((v) => !v);
      case 'pdf.copy': return copyRemarks();
      case 'pdf.scope': return setScope(value === 'current' ? 'current' : 'all');
      case 'pdf.status': return addToast('Стадия меняется в Проводнике — там же, где у остальных файлов', 'info');
      case 'pdf.thumbs': return setThumbs((v) => !v);
      case 'pdf.find': return setFindOpen((v) => !v);
      case 'pdf.length': setTool(null); return setMeasure((v) => (v === 'length' ? null : 'length'));
      case 'pdf.area': setTool(null); return setMeasure((v) => (v === 'area' ? null : 'area'));
      case 'pdf.scale': return setSheetScale(Number(value) || 1);
      case 'pdf.invert': return setInvert((v) => !v);
      default: return undefined;
    }
  };

  const organState: Record<string, boolean | string> = {
    'pdf.zoom': `${zoom} %`,
    'pdf.width': `${stroke} пт`,
    'pdf.color': color,
    'pdf.scope': scope,
    'pdf.list': listOpen,
    'pdf.thumbs': thumbs,
    'pdf.find': findOpen,
    'pdf.length': measure === 'length',
    'pdf.area': measure === 'area',
    'pdf.scale': String(sheetScale),
    'pdf.invert': invert,
    'pdf.cloud': tool === 'CLOUD',
    'pdf.rect': tool === 'RECT',
    'pdf.arrow': tool === 'ARROW',
    'pdf.note': tool === 'NOTE',
  };
  const organDisabled: Record<string, string> = {};
  if (page <= 1) organDisabled['pdf.prev'] = 'Это первая страница';
  if (page >= pages) organDisabled['pdf.next'] = 'Это последняя страница';
  if (!shown.some((m) => m.text)) organDisabled['pdf.copy'] = 'Замечаний с текстом на этой странице нет';

  if (!fileId) {
    return (
      <div className="h-full flex items-center justify-center text-slate-400 text-sm">
        Откройте чертёж из Проводника — двойным нажатием по файлу PDF.
      </div>
    );
  }

  return (
    <div className="h-full">
      <EditorFrame
        doc={{
          icon: <FileText className="w-3.5 h-3.5 text-rose-600" />,
          name: file?.name || '',
          onRename: () => {},
          onClose: () => { window.location.hash = '#/explorer'; },
          revision,
          tag: null,
          saveState: 'saved',
          menu: [
            { label: 'Открыть в Проводнике', hint: 'Карточка файла, стадия и ревизии', run: () => { window.location.hash = '#/explorer'; } },
          ],
        }}
        tabs={tabs} active={tab} onActive={setTab}
        state={organState} disabled={organDisabled} onCommand={runCommand}
        folded={folded} onFold={setFolded}
        fileOpen={fileOpen} onFileOpen={setFileOpen}
        statusLeft={<>страница {page} из {pages || 1} · пометок {shown.length}
          {tool ? ' · обведите место на чертеже' : ''}
          {measure ? ` · ${measure === 'length' ? 'протяните' : 'обведите'} по чертежу, масштаб ${scaleLabel(sheetScale)}` : ''}</>}
        statusRight={<>{zoom} %</>}
      >
        <div ref={wrapRef} className="absolute inset-0 overflow-auto bg-slate-200 dark:bg-slate-950 flex">
          {thumbs && !loading && (
            <PageThumbs pdf={pdfRef.current} pages={pages} page={page} onPick={setPage} />
          )}
          {/* Полоса поиска — поверх листа, у верхнего края: так её видно и
              она не съедает место у самого чертежа */}
          {findOpen && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-2 py-1.5
                            rounded-xl border border-slate-300 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg">
              <Search className="w-4 h-4 text-slate-400 shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => { setQuery(e.target.value); setHits([]); setHitAt(-1); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); hits.length ? goHit(e.shiftKey ? -1 : 1) : runSearch(query); }
                  if (e.key === 'Escape') { e.preventDefault(); setFindOpen(false); }
                }}
                placeholder="Найти в документе"
                className="w-56 bg-transparent outline-none text-sm text-slate-800 dark:text-slate-150 placeholder:text-slate-400"
              />
              <span className="text-2xs text-slate-400 w-20 text-right shrink-0">
                {reading ? 'читаю…' : query.trim() ? hitsLabel(hits.length, hitAt) : ''}
              </span>
              <button type="button" title="Предыдущее совпадение" onClick={() => (hits.length ? goHit(-1) : runSearch(query))}
                className="p-1 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
                <ChevronUp className="w-4 h-4" />
              </button>
              <button type="button" title="Следующее совпадение" onClick={() => (hits.length ? goHit(1) : runSearch(query))}
                className="p-1 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-850 cursor-pointer">
                <ChevronDown className="w-4 h-4" />
              </button>
              <button type="button" title="Закрыть поиск" onClick={() => setFindOpen(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Намеренное — крупно и рядом с чертежом: число нужно прочитать,
              не отводя глаз от того места, которое меряют */}
          {measure && measured && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-xl
                            bg-sky-700 text-white text-sm font-bold shadow-lg">
              {measured}
            </div>
          )}

          <div className="flex-1 min-w-0 flex items-start justify-center p-6">
            <div className="relative shadow-2xl" style={{ width: size.w, height: size.h }}
              onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}>
              <canvas ref={canvasRef}
                className="block bg-white"
                style={{ filter: invert ? 'invert(1) hue-rotate(180deg)' : undefined, cursor: tool ? 'crosshair' : 'default' }} />
              {size.w > 0 && (
                <MarkupLayer
                  markups={shown} width={size.w} height={size.h}
                  currentRevision={revision} selectedId={selected} onSelect={setSelected} draft={draft}
                  signatures={signs}
                />
              )}
            </div>
          </div>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-slate-950/70">
              <div className="flex items-center gap-3 text-slate-500 text-sm">
                <Loader2 className="w-5 h-5 animate-spin" /> Открываю чертёж…
              </div>
            </div>
          )}
          {listOpen && (
            <MarkupList
              markups={markups.filter((m) => scope === 'all' || m.revision === revision)}
              currentRevision={revision}
              selectedId={selected}
              onSelect={(id) => {
                const m = markups.find((x) => x.id === id);
                if (m) setPage(m.page);
                setSelected(id);
              }}
              onState={(id, state) => patchMarkup(id, { state })}
              onRemove={removeMarkup}
              onClose={() => setListOpen(false)}
            />
          )}
        </div>
      </EditorFrame>
    </div>
  );
}
