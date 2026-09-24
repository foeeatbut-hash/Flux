import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  X, Plus, Trash2, Image as ImageIcon, Check, Loader2, AlertTriangle,
  Bold, Italic, Link2, Palette,
} from 'lucide-react';
import {
  mailService, type MailAccount, type MailSignature, type MailSignatureImage,
} from '../../services/mailService';
import { useEscapeClose } from '../../lib/useDismiss';
import { useToastStore } from '../../store/toastStore';

/**
 * Подписи сотрудника.
 *
 * Подпись личная: у каждого своя, и их может быть несколько. С общей почты
 * компании человек подписывается иначе, чем со своей, поэтому подпись можно
 * привязать к ящику — а можно оставить общей для всех.
 *
 * Картинки (логотип компании, скан подписи) лежат у нас на диске и в разделе
 * показываются по ссылке. В отправленном письме та же картинка уходит частью
 * письма с Content-ID: ссылка на наш сервер снаружи не откроется, а картинку
 * в data: почтовые службы вырезают как подозрительную. Подмену делает сервер
 * при отправке — здесь об этом думать не нужно.
 */

interface Props {
  accounts: MailAccount[];
  onClose: () => void;
}

const btn =
  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ' +
  'text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800';

export default function MailSignatures({ accounts, onClose }: Props) {
  const { addToast } = useToastStore();
  const [list, setList] = useState<MailSignature[]>([]);
  const [images, setImages] = useState<MailSignatureImage[]>([]);
  const [pickedId, setPickedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEscapeClose(true, () => { if (!busy) onClose(); });

  const picked = list.find((s) => s.id === pickedId) || null;

  const load = async () => {
    try {
      const r = await mailService.signatures();
      setList(r.signatures);
      setImages(r.images);
      setPickedId((prev) => prev || r.signatures[0]?.id || '');
    } catch (err: any) {
      setError(err?.message || 'Не удалось загрузить подписи');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  // Разметку в поле правки кладём при смене подписи, а не на каждой отрисовке:
  // иначе курсор прыгал бы в начало на каждом нажатии клавиши
  useEffect(() => {
    if (editorRef.current && picked) editorRef.current.innerHTML = picked.html || '';
  }, [pickedId]);

  const patch = (id: string, data: Partial<MailSignature>) =>
    setList((prev) => prev.map((s) => (s.id === id ? { ...s, ...data } : s)));

  const create = async () => {
    setBusy(true);
    try {
      const r = await mailService.addSignature({
        name: `Подпись ${list.length + 1}`,
        html: '<div>С уважением,</div>',
        isDefault: !list.length,
      });
      setList((prev) => [...prev, r.signature]);
      setPickedId(r.signature.id);
    } catch (err: any) {
      setError(err?.message || 'Не удалось создать подпись');
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (!picked) return;
    setBusy(true);
    setError('');
    try {
      const html = editorRef.current?.innerHTML || '';
      const r = await mailService.updateSignature(picked.id, {
        name: picked.name, html, accountId: picked.accountId, isDefault: picked.isDefault,
      });
      patch(picked.id, r.signature);
      // Главная подпись одна на ящик — остальные сбрасываем и у себя
      if (r.signature.isDefault) {
        setList((prev) => prev.map((s) =>
          s.id !== r.signature.id && s.accountId === r.signature.accountId ? { ...s, isDefault: false } : s));
      }
      addToast('Подпись сохранена', 'success');
    } catch (err: any) {
      setError(err?.message || 'Не удалось сохранить подпись');
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await mailService.removeSignature(id);
      setList((prev) => prev.filter((s) => s.id !== id));
      if (pickedId === id) setPickedId('');
    } catch (err: any) {
      setError(err?.message || 'Не удалось удалить подпись');
    } finally { setBusy(false); }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const data: string = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(new Error('Файл не читается'));
        fr.readAsDataURL(file);
      });
      const r = await mailService.addSignatureImage({
        fileName: file.name, mimeType: file.type, data, width: 180,
      });
      setImages((prev) => [r.image, ...prev]);
      addToast('Картинка загружена — нажмите на неё, чтобы вставить', 'success');
    } catch (err: any) {
      setError(err?.message || 'Не удалось загрузить картинку');
    } finally { setBusy(false); }
  };

  /** Вставка в место курсора: подпись собирают вокруг логотипа, а не после него. */
  const insert = (html: string) => {
    const box = editorRef.current;
    if (!box) return;
    box.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount && box.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const frag = range.createContextualFragment(html);
      range.insertNode(frag);
      sel.collapseToEnd();
    } else {
      box.innerHTML += html;
    }
  };

  const wrap = (cmd: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd);
  };

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto" role="dialog" aria-modal="true" aria-label="Подписи">
      <div className="fixed inset-0 fx-backdrop" onClick={() => !busy && onClose()} />
      <div className="flex min-h-full items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="fx-dialog @container relative w-full max-w-4xl max-h-[90vh] flex flex-col"
        >
          <div className="shrink-0 flex items-center justify-between gap-2 px-5 py-3 border-b border-slate-200 dark:border-slate-800">
            <h3 className="flex-1 min-w-0 truncate text-base font-semibold text-slate-900 dark:text-white">Подпись в письмах</h3>
            <button
              type="button" title="Закрыть" aria-label="Закрыть" onClick={onClose} disabled={busy}
              className="p-1 shrink-0 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {loading ? (
            <div className="flex-1 flex items-center justify-center gap-2 p-10 text-slate-500 dark:text-slate-400 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Загружаем…
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col @[720px]:flex-row overflow-hidden">
              {/* Список подписей */}
              <div className="shrink-0 @[720px]:w-56 flex @[720px]:flex-col gap-1 p-2 border-b @[720px]:border-b-0 @[720px]:border-r border-slate-200 dark:border-slate-800 overflow-auto scrollbar-thin">
                {list.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setPickedId(s.id)}
                    className={`group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left cursor-pointer shrink-0 @[720px]:shrink
                      ${s.id === pickedId
                        ? 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200 font-semibold'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-850'}`}
                  >
                    <span className="flex-1 min-w-0 truncate text-sm">{s.name}</span>
                    {s.isDefault && <Check className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                  </button>
                ))}
                <button type="button" onClick={create} disabled={busy} className={`${btn} shrink-0`}>
                  <Plus className="w-3.5 h-3.5" /> Новая подпись
                </button>
              </div>

              {/* Правка выбранной */}
              {picked ? (
                <div className="flex-1 min-w-0 flex flex-col gap-2.5 p-4 overflow-y-auto scrollbar-thin">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={picked.name}
                      onChange={(e) => patch(picked.id, { name: e.target.value })}
                      aria-label="Название подписи"
                      className="flex-1 min-w-[10rem] px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                    <select
                      value={picked.accountId}
                      onChange={(e) => patch(picked.id, { accountId: e.target.value })}
                      aria-label="Для какого ящика"
                      className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white text-xs cursor-pointer"
                    >
                      <option value="">Для всех ящиков</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.label || a.email}</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-400 cursor-pointer">
                      <input
                        type="checkbox" checked={picked.isDefault}
                        onChange={(e) => patch(picked.id, { isDefault: e.target.checked })}
                        className="w-4 h-4 accent-emerald-600 cursor-pointer"
                      />
                      Подставлять
                    </label>
                  </div>

                  {/* Простые средства правки: жирный, наклонный, ссылка, цвет */}
                  <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 p-1">
                    <button type="button" title="Полужирный" onClick={() => wrap('bold')} className={btn}><Bold className="w-3.5 h-3.5" /></button>
                    <button type="button" title="Наклонный" onClick={() => wrap('italic')} className={btn}><Italic className="w-3.5 h-3.5" /></button>
                    <button
                      type="button" title="Ссылка" className={btn}
                      onClick={() => {
                        const url = window.prompt('Адрес ссылки', 'https://');
                        if (url) { editorRef.current?.focus(); document.execCommand('createLink', false, url); }
                      }}
                    ><Link2 className="w-3.5 h-3.5" /></button>
                    <label className={`${btn} relative`} title="Цвет текста">
                      <Palette className="w-3.5 h-3.5" />
                      <input
                        type="color" aria-label="Цвет текста"
                        onChange={(e) => { editorRef.current?.focus(); document.execCommand('foreColor', false, e.target.value); }}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                      />
                    </label>
                    <span className="mx-1 w-px h-4 bg-slate-300 dark:bg-slate-700" />
                    <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className={btn}>
                      <ImageIcon className="w-3.5 h-3.5" /> Загрузить картинку
                    </button>
                    <input
                      ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) void upload(f);
                      }}
                    />
                  </div>

                  <div
                    ref={editorRef}
                    contentEditable={!busy}
                    suppressContentEditableWarning
                    role="textbox"
                    aria-multiline="true"
                    aria-label="Разметка подписи"
                    className="min-h-[9rem] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500 [&_img]:max-w-full"
                  />

                  {images.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-2xs font-semibold text-slate-500 dark:text-slate-400">
                        Картинки — нажмите, чтобы вставить
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {images.map((img) => (
                          <div key={img.id} className="group relative rounded-lg border border-slate-200 dark:border-slate-800 p-1 bg-white dark:bg-slate-950">
                            <button
                              type="button"
                              title={`Вставить ${img.fileName}`}
                              onClick={() => insert(`<img src="${img.url}" alt="${img.fileName}" width="${img.width || 180}" style="max-width:100%">`)}
                              className="block cursor-pointer"
                            >
                              <img src={img.url} alt={img.fileName} className="h-12 w-auto max-w-[9rem] object-contain" />
                            </button>
                            <button
                              type="button"
                              title="Удалить картинку"
                              aria-label={`Удалить ${img.fileName}`}
                              onClick={async () => {
                                await mailService.removeSignatureImage(img.id).catch(() => null);
                                setImages((prev) => prev.filter((i) => i.id !== img.id));
                              }}
                              className="absolute -top-1.5 -right-1.5 p-0.5 rounded-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-400 hover:text-rose-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {error && (
                    <div className="flex items-start gap-2 rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                      <span className="flex-1 min-w-0">{error}</span>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                    <button
                      type="button" onClick={() => remove(picked.id)} disabled={busy}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" /> Удалить
                    </button>
                    <button
                      type="button" onClick={save} disabled={busy}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-semibold shadow-md cursor-pointer disabled:opacity-60"
                    >
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      Сохранить
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex-1 blank">
                  <ImageIcon className="w-10 h-10 text-slate-300 dark:text-slate-700 mb-3" />
                  <p className="blank-title">Подписи пока нет</p>
                  <p className="blank-text">Заведите её — она будет подставляться в новые письма и ответы.</p>
                </div>
              )}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
