/**
 * Подпись сотрудника: получить картинку, очистить и сохранить в профиль.
 *
 * Четыре способа положить подпись, потому что у людей по-разному:
 *  • выбрать файл — если есть сканер;
 *  • перетащить в окно — если файл уже на рабочем столе;
 *  • вставить из буфера (Ctrl+V) — сфотографировал телефоном и скинул себе;
 *  • нарисовать мышью прямо здесь — если сканера нет вовсе. Это не игрушка:
 *    иначе человек без сканера просто не заведёт подпись.
 *
 * Обработка: порог фона подбирается по самой картинке (не вслепую), поля
 * скана обрезаются по штриху — иначе подпись в документе выйдет крошечной,
 * потому что высота в миллиметрах задаётся всей картинке вместе с полями.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, ClipboardPaste, PenLine, RotateCw, Trash2, X, AlertTriangle, Check } from 'lucide-react';
import {
  cutBackground, inkBounds, suggestThreshold, looksEmpty, checkFile,
  fitToHeight, STORE_HEIGHT_PX, DEFAULT_THRESHOLD,
} from '../lib/signature';
import { formatName } from '../lib/docFormula';
import { useToastStore } from '../store/toastStore';
import { useModalStore } from '../store/modalStore';
import { useEscapeClose } from '../lib/useDismiss';

interface Props {
  /** Чью подпись правим */
  userId: string;
  userName: string;
  /** ФИО по частям — чтобы в предпросмотре стояли настоящие инициалы владельца,
      а не чужой пример: человек должен увидеть свою строку штампа */
  nameParts?: { lastName?: string; firstName?: string; middleName?: string; name?: string };
  /** Что уже сохранено */
  value?: string | null;
  heightMm?: number;
  /** Можно ли править: свою — всегда, чужую — только управляющему сотрудниками */
  canEdit: boolean;
  /**
   * Внутри страницы, а не окном поверх всего.
   *
   * Своя подпись живёт в Настройках — это настройка человека, и открывать ради
   * неё модальное окно незачем. Правка чужой подписи администратором осталась
   * окном: она приходит из списка сотрудников, поверх него и возвращается.
   */
  inline?: boolean;
  onSaved: (signature: string | null, heightMm: number) => void;
  onClose: () => void;
}

type Source = 'none' | 'image' | 'draw';

/** Миллиметр в точках при 96 dpi — для предпросмотра «как в документе» */
const MM = 3.7795;

export default function SignatureEditor({ userId, userName, nameParts, value, heightMm = 8, canEdit, inline = false, onSaved, onClose }: Props) {
  useEscapeClose(!inline, onClose);

  // «Раупов Х.Х.» — так строка и попадёт в штамп
  const initials = formatName(nameParts || { name: userName }, 'initialsAfter') || userName;
  const { addToast } = useToastStore();
  const [source, setSource] = useState<Source>(value ? 'image' : 'none');
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [height, setHeight] = useState(heightMm);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);

  /** Исходник как загрузили — все правки идут от него, а не поверх прошлых */
  const originalRef = useRef<HTMLCanvasElement | null>(null);
  /** Что показываем и что сохраним */
  const [result, setResult] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  // ── Обработка исходника: порог → обрезка полей → уменьшение ──────────────
  const apply = useCallback((thr: number) => {
    const src = originalRef.current;
    if (!src) return;
    const w = src.width, h = src.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d', { willReadFrequently: true })!;
    tctx.drawImage(src, 0, 0);
    const img = tctx.getImageData(0, 0, w, h);
    cutBackground(img.data, thr);

    if (looksEmpty(img.data)) {
      setWarn('При таком пороге от подписи ничего не осталось — сдвиньте ползунок влево.');
      setResult(null);
      return;
    }
    const b = inkBounds(img.data, w, h, Math.max(2, Math.round(h * 0.02)));
    if (!b) { setWarn('Подпись не найдена на картинке.'); setResult(null); return; }
    setWarn(null);

    // Кладём обрезанное на новый холст и уменьшаем до разумной высоты
    tctx.putImageData(img, 0, 0);
    const fit = fitToHeight(b.w, b.h, STORE_HEIGHT_PX);
    const out = document.createElement('canvas');
    out.width = fit.w; out.height = fit.h;
    const octx = out.getContext('2d')!;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(tmp, b.x, b.y, b.w, b.h, 0, 0, fit.w, fit.h);
    setResult(out.toDataURL('image/png'));
  }, []);

  /** Принять картинку: подобрать порог по ней самой и сразу показать результат */
  const takeImage = useCallback((img: HTMLImageElement) => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d')!.drawImage(img, 0, 0);
    originalRef.current = c;
    setSource('image');
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const t = suggestThreshold(ctx.getImageData(0, 0, c.width, c.height).data);
    setThreshold(t);
    setTimeout(() => apply(t), 0);
  }, [apply]);

  const takeFile = useCallback((file: File) => {
    const err = checkFile(file);
    if (err) { addToast(err, 'error'); return; }
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => takeImage(img);
      img.onerror = () => addToast('Не удалось прочитать картинку', 'error');
      img.src = String(fr.result);
    };
    fr.readAsDataURL(file);
  }, [addToast, takeImage]);

  // Вставка из буфера — сфотографировал телефоном, скинул, Ctrl+V
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (!item) return;
      const f = item.getAsFile();
      if (f) { e.preventDefault(); takeFile(f); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [takeFile]);

  const rotate = () => {
    const src = originalRef.current;
    if (!src) return;
    const out = document.createElement('canvas');
    out.width = src.height; out.height = src.width;
    const ctx = out.getContext('2d')!;
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    originalRef.current = out;
    apply(threshold);
  };

  // ── Рисование мышью ──────────────────────────────────────────────────────
  const startDraw = () => {
    setSource('draw');
    setResult(null);
    setWarn(null);
    setTimeout(() => {
      const c = drawRef.current;
      if (!c) return;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1e3a5f';   // тёмно-синий, как шариковая ручка
    }, 0);
  };

  const drawPos = (e: React.PointerEvent) => {
    const c = drawRef.current!;
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  };
  const onDown = (e: React.PointerEvent) => {
    if (!canEdit) return;
    drawing.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);
    const ctx = drawRef.current!.getContext('2d')!;
    const p = drawPos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = drawRef.current!.getContext('2d')!;
    const p = drawPos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };
  const onUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    // Нарисованное уже без фона — обрезаем поля и берём как есть
    const c = drawRef.current!;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    if (looksEmpty(img.data)) return;
    const b = inkBounds(img.data, c.width, c.height, 6);
    if (!b) return;
    const out = document.createElement('canvas');
    const fit = fitToHeight(b.w, b.h, STORE_HEIGHT_PX);
    out.width = fit.w; out.height = fit.h;
    out.getContext('2d')!.drawImage(c, b.x, b.y, b.w, b.h, 0, 0, fit.w, fit.h);
    setResult(out.toDataURL('image/png'));
    setWarn(null);
  };

  // Что уже сохранено, подтягиваем отдельным запросом: в списке сотрудников
  // картинок нет намеренно — он тянется на многих экранах
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch(`/api/users/${userId}/signature`);
        const j = await r.json();
        if (dead) return;
        if (j?.signature) { setResult(j.signature); setSource('image'); }
        if (j?.signatureHeightMm) setHeight(j.signatureHeightMm);
      } catch (_) {} finally { if (!dead) setLoaded(true); }
    })();
    return () => { dead = true; };
  }, [userId]);

  // Показ результата на клетчатой подложке
  useEffect(() => {
    const c = viewRef.current;
    if (!c || !result) return;
    const img = new Image();
    img.onload = () => {
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, c.width, c.height);
      const k = Math.min(c.width / img.width, c.height / img.height, 1);
      const w = img.width * k, h = img.height * k;
      ctx.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
    };
    img.src = result;
  }, [result]);

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/users/${userId}/signature`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signatureImage: result, signatureHeightMm: height }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'не удалось сохранить');
      addToast('Подпись сохранена', 'success');
      onSaved(result, height);
      onClose();
    } catch (e: any) {
      addToast(String(e?.message || e), 'error');
    } finally { setBusy(false); }
  };

  const clear = async () => {
    const yes = await useModalStore.getState().openConfirm(
      'Убрать подпись?',
      `Подпись ${userName} будет удалена из профиля. В документах, где стоит формула «Подпись», останется пустое место.`,
    );
    if (!yes) return;
    setBusy(true);
    try {
      await fetch(`/api/users/${userId}/signature`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signatureImage: null, signatureHeightMm: height }),
      });
      setResult(null);
      originalRef.current = null;
      setSource('none');
      onSaved(null, height);
      addToast('Подпись убрана', 'success');
    } finally { setBusy(false); }
  };

  const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer disabled:opacity-40';

  const inner = (
    <>
      {!inline && (
        <div className="stamp">
          <span className="stamp-title">Подпись</span>
          <span className="stamp-sub truncate">{userName}</span>
          <div className="stamp-right">
            <button type="button" onClick={onClose} title="Закрыть" className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

        <div className="p-4 space-y-4">
          {!canEdit && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Чужую подпись менять нельзя — она как личная печать. Свою можно в своём профиле.
            </p>
          )}

          {/* Способы получить картинку */}
          <div className="flex flex-wrap items-center gap-2">
            <label className={`${btn} ${!canEdit ? 'pointer-events-none opacity-40' : ''}`}>
              <Upload className="w-3.5 h-3.5" /> Выбрать файл
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) takeFile(f); e.currentTarget.value = ''; }} />
            </label>
            <button type="button" className={btn} disabled={!canEdit} onClick={startDraw}>
              <PenLine className="w-3.5 h-3.5" /> Нарисовать
            </button>
            <span className="text-2xs text-slate-400 inline-flex items-center gap-1">
              <ClipboardPaste className="w-3.5 h-3.5" /> или перетащите файл сюда, или Ctrl+V из буфера
            </span>
            {source === 'image' && (
              <button type="button" className={`${btn} ml-auto`} disabled={!canEdit} onClick={rotate} title="Повернуть на 90°">
                <RotateCw className="w-3.5 h-3.5" /> Повернуть
              </button>
            )}
          </div>

          {/* Область: рисование или предпросмотр на клетке */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault(); setDrag(false);
              const f = e.dataTransfer.files?.[0];
              if (f && canEdit) takeFile(f);
            }}
            className={`rounded-lg border border-dashed p-3 ${drag ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20' : 'border-slate-300 dark:border-slate-700'}`}
            style={{
              backgroundImage: source === 'draw' ? undefined :
                'repeating-conic-gradient(oklch(96% 0.003 163) 0% 25%, transparent 0% 50%)',
              backgroundSize: '14px 14px',
            }}
          >
            {source === 'draw' ? (
              <canvas ref={drawRef} width={640} height={200}
                onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
                className="w-full h-[200px] bg-white dark:bg-slate-950 rounded-md border border-slate-200 dark:border-slate-800 cursor-crosshair touch-none" />
            ) : result ? (
              <canvas ref={viewRef} width={640} height={200} className="w-full h-[200px]" />
            ) : (
              <div className="h-[200px] flex flex-col items-center justify-center gap-1 text-center px-6">
                <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">Подписи пока нет</div>
                <div className="text-2xs text-slate-400 max-w-sm">
                  Распишитесь на белом листе и сфотографируйте или отсканируйте — фон уберём сами.
                  Либо нарисуйте мышью прямо здесь.
                </div>
              </div>
            )}
          </div>

          {warn && (
            <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {warn}
            </p>
          )}

          {/* Порог фона — только для загруженной картинки: нарисованное чисто */}
          {source === 'image' && (
            <div>
              <label className="graf block mb-1.5">Убрать фон</label>
              <div className="flex items-center gap-3">
                <input type="range" min={0} max={100} value={threshold} disabled={!canEdit}
                  onChange={(e) => { const v = Number(e.target.value); setThreshold(v); apply(v); }}
                  className="flex-1 accent-emerald-600" />
                <span className="data text-2xs text-slate-400 w-8 text-right">{threshold}</span>
              </div>
              <p className="text-2xs text-slate-400 mt-1">
                Порог подобран по самой картинке. Влево — оставить больше, вправо — убрать больше.
                Поля скана обрезаются по росчерку сами.
              </p>
            </div>
          )}

          {/* Высота в документе + предпросмотр в натуральную величину */}
          <div>
            <label className="graf block mb-1.5">Высота в документе</label>
            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
                {[6, 8, 10, 12].map((mm, i) => (
                  <button key={mm} type="button" disabled={!canEdit} onClick={() => setHeight(mm)}
                    className={`px-2.5 py-1 text-xs cursor-pointer ${i > 0 ? 'border-l border-slate-200 dark:border-slate-800' : ''} ${
                      height === mm ? 'bg-emerald-600 text-white font-medium' : 'bg-white dark:bg-slate-950 text-slate-600 dark:text-slate-300'
                    }`}>{mm} мм</button>
                ))}
              </div>
              {result && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                  <span className="text-2xs text-slate-400">в строке:</span>
                  <span className="text-xs">{initials}</span>
                  <img src={result} alt="подпись" style={{ height: `${height * MM}px` }} />
                </div>
              )}
            </div>
            <p className="text-2xs text-slate-400 mt-1">
              Хранится в миллиметрах, поэтому подпись не зависит от разрешения скана.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 py-3 rule-t">
          {loaded && result && (
            <button type="button" onClick={clear} disabled={!canEdit || busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-slate-500 hover:text-rose-600 cursor-pointer disabled:opacity-40">
              <Trash2 className="w-3.5 h-3.5" /> Убрать подпись
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {/* «Отмена» закрывает окно. В Настройках закрывать нечего:
                раздел никуда не уезжает, и кнопка бы врала */}
            {!inline && <button type="button" onClick={onClose} className={btn}>Отмена</button>}
            <button type="button" onClick={save} disabled={!canEdit || busy || !result}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium cursor-pointer disabled:opacity-40">
              <Check className="w-3.5 h-3.5" /> Сохранить
            </button>
          </div>
        </div>
    </>
  );

  if (inline) {
    return (
      <div className="max-w-2xl bg-white dark:bg-dark-surface border border-slate-200 dark:border-dark-border rounded-lg">
        {inner}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-6" onMouseDown={onClose}>
      <div className="w-full max-w-2xl bg-white dark:bg-dark-surface border border-slate-200 dark:border-dark-border rounded-lg shadow-modal"
        onMouseDown={(e) => e.stopPropagation()}>
        {inner}
      </div>
    </div>
  );
}
