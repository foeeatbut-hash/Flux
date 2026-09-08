/**
 * «Свойства» — одно окно на любой значок стола.
 *
 * Отвечает на вопросы, которые в системе документации задают о документе, а не
 * о файле: где он лежит на самом деле, кто его видит, на какой он стадии, какая
 * ревизия и кто менял последним. Отсюда же меняется стадия — там, где на неё
 * смотрят, а не через Проводник.
 *
 * «Где лежит» показано словами, а не идентификатором папки: человеку надо
 * прийти туда самому, а не убедиться, что программа что-то знает.
 */
import React from 'react';
import { X } from 'lucide-react';
import { FILE_STATUSES, STATUS_ORDER, statusOf, formatSize } from '../explorer/FileItems';
import { isSystemKind, type DeskItem } from '../../lib/desktop';
import { titleOf } from './DeskIcon';

const KIND_NAME: Record<string, string> = {
  app: 'Раздел программы',
  bin: 'Корзина Проводника',
  folder: 'Папка',
  doc: 'Таблица Flux Office',
  text: 'Текстовый документ',
  note: 'Заметка',
  file: 'Файл',
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-start gap-3 py-1.5 border-b border-slate-100 dark:border-dark-border/60 last:border-0">
    <span className="w-32 shrink-0 text-2xs uppercase tracking-wider text-slate-400 pt-0.5">{label}</span>
    <span className="flex-1 min-w-0 text-sm text-slate-800 dark:text-slate-150 break-words">{children}</span>
  </div>
);

export default function DeskProperties({
  item, onClose, onStatus, onOpenPlace,
}: {
  item: DeskItem;
  onClose: () => void;
  onStatus: (code: string) => void;
  onOpenPlace: () => void;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sys = isSystemKind(item.kind);
  const place = sys
    ? 'Системный значок — в Проводнике его нет'
    : `Проводник → ${item.shared ? 'Общий' : 'Личный'} → Рабочий стол`;
  const when = item.updatedAt ? new Date(item.updatedAt) : null;

  return (
    <div
      role="dialog"
      aria-label={`Свойства: ${titleOf(item)}`}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[20] w-[420px] max-w-[calc(100%-2rem)]
                 rounded-2xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface shadow-2xl"
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-dark-border">
        <b className="flex-1 min-w-0 truncate text-sm font-semibold text-slate-800 dark:text-slate-150">
          Свойства: {titleOf(item)}
        </b>
        <button
          type="button" onClick={onClose} aria-label="Закрыть" title="Закрыть"
          className="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer text-slate-500
                     hover:bg-slate-200 dark:hover:bg-slate-850"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-4 py-2">
        <Row label="Что это">{KIND_NAME[item.kind] || 'Файл'}</Row>
        <Row label="Где лежит">
          {sys ? place : (
            <button type="button" onClick={onOpenPlace} className="text-left underline cursor-pointer hover:text-emerald-700 dark:hover:text-emerald-400">
              {place}
            </button>
          )}
        </Row>
        {!sys && <Row label="Кто видит">{item.shared ? 'Все в проекте' : 'Только вы'}</Row>}
        {!sys && item.kind !== 'folder' && (
          <>
            <Row label="Тег">{item.tag || <span className="text-slate-400">не привязан</span>}</Row>
            <Row label="Ревизия"><span className="font-mono tabular-nums">{item.revision || '1'}</span></Row>
            <Row label="Стадия">
              {/* Меняется здесь же: чаще всего стадию и меняют, закончив работу */}
              <span className="flex flex-wrap gap-1">
                {STATUS_ORDER.map((code) => {
                  const s = FILE_STATUSES[code];
                  const active = (item.status || 'D') === code;
                  return (
                    <button
                      key={code}
                      type="button"
                      onClick={() => onStatus(code)}
                      title={`Перевести в «${s.label}»`}
                      className={`inline-flex items-center gap-1 text-2xs font-bold px-1.5 py-0.5 rounded-full cursor-pointer
                                  ${active ? s.chip : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-450 hover:brightness-95'}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} /> {s.label}
                    </button>
                  );
                })}
              </span>
            </Row>
          </>
        )}
        {!sys && !!item.size && <Row label="Размер">{formatSize(item.size)}</Row>}
        {!sys && <Row label="Менял">{item.updatedBy || <span className="text-slate-400">неизвестно</span>}</Row>}
        {!sys && (
          <Row label="Когда">
            {when && !Number.isNaN(when.getTime())
              ? when.toLocaleString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
              : <span className="text-slate-400">неизвестно</span>}
          </Row>
        )}
        {sys && item.kind === 'app' && <Row label="Адрес"><span className="font-mono text-2xs">{item.path}</span></Row>}
      </div>

      <div className="px-4 py-3 border-t border-slate-200 dark:border-dark-border flex justify-end">
        <button
          type="button" onClick={onClose}
          className="h-8 px-3 rounded-lg cursor-pointer text-sm font-semibold
                     bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
        >
          Закрыть
        </button>
      </div>
    </div>
  );
}

export { statusOf };
