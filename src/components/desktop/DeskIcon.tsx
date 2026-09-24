/**
 * Один значок рабочего стола: картинка, пометки и подпись.
 *
 * Пометки — не украшение. Значок с одним именем отвечает только на «как
 * называется», а в системе документации спрашивают другое: на какой он стадии,
 * какая ревизия, чей тег и видят ли его коллеги. Всё это на значке и стоит,
 * иначе за каждым ответом придётся открывать документ.
 *
 * Картинки те же, что в Проводнике (FILE_STATUSES оттуда же): один документ
 * обязан выглядеть одинаково там и там, иначе его примут за разные файлы.
 */
import React from 'react';
import {
  Folder, FileSpreadsheet, FileText, File as FileIcon, StickyNote, Users, Shapes, Trash2,
} from 'lucide-react';
import { SECTIONS } from '../../workspace/sections';
import { FILE_STATUSES, statusOf } from '../explorer/FileItems';
import { isSystemKind, type DeskItem } from '../../lib/desktop';
import { deskMetric, type DeskMetric } from '../../lib/metrics';

function Glyph({ item, size }: { item: DeskItem; size: number }) {
  // Папка-виджет показывает, что в ней лежит: четыре точки вместо картинки
  // папки. Иначе две папки на столе неразличимы, пока их не открыть
  if (item.kind === 'group') {
    const count = Math.min(4, (item.members || []).length);
    return (
      <span
        style={{ width: size, height: size }}
        className="grid grid-cols-2 gap-[2px] p-[3px] rounded-[6px] bg-slate-200/80 dark:bg-slate-800"
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <span key={i} className={`rounded-[2px] ${i < count ? 'bg-emerald-500/80' : 'bg-slate-300 dark:bg-slate-700'}`} />
        ))}
      </span>
    );
  }
  if (item.kind === 'app') {
    const Icon = SECTIONS.find((s) => s.path === item.path)?.icon as any;
    return Icon
      ? <Icon size={size} className="text-emerald-600 dark:text-emerald-400" />
      : <Shapes size={size} />;
  }
  if (item.kind === 'bin') return <Trash2 size={size} className="text-slate-500 dark:text-slate-400" />;
  if (item.kind === 'folder') return <Folder size={size} className="text-amber-500 fill-amber-200" />;
  if (item.kind === 'note') return <StickyNote size={size} className="text-amber-500" />;
  if (item.kind === 'text') return <FileText size={size} className="text-emerald-600" />;
  if (item.kind === 'doc') return <FileSpreadsheet size={size} className="text-emerald-600" />;
  return <FileIcon size={size} className="text-slate-400" />;
}

export const titleOf = (item: DeskItem): string =>
  item.kind === 'app' ? (SECTIONS.find((s) => s.path === item.path)?.title || item.path || '') : item.name;

/** Подсказка при наведении: то же, что в «Свойствах», но одной строкой */
export function hintOf(item: DeskItem): string {
  const t = titleOf(item);
  if (isSystemKind(item.kind)) return t;
  const parts = [t];
  if (item.tag) parts.push(`тег ${item.tag}`);
  if (item.kind !== 'folder') parts.push(`${statusOf(item.status).label}, ревизия ${item.revision || '1'}`);
  if (item.shared) parts.push('на общем столе');
  if (item.updatedBy) parts.push(`менял: ${item.updatedBy}`);
  return parts.join(' · ');
}

export default function DeskIcon({
  item, x, y, selected, dragged, renaming, badge, metric = deskMetric(),
  onRenameChange, onRenameCommit, onRenameCancel, ...rest
}: {
  item: DeskItem;
  x: number; y: number;
  selected: boolean;
  dragged: boolean;
  renaming: string | null;
  /** Размер клетки и значка: крупные, обычные или мелкие */
  metric?: DeskMetric;
  /** Число на значке — сейчас только у корзины */
  badge?: number;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
} & Pick<
  React.HTMLAttributes<HTMLDivElement>,
  'onPointerDown' | 'onDoubleClick' | 'onContextMenu' | 'onDragStart' | 'onDragEnd' | 'draggable'
>) {
  const st = statusOf(item.status);
  const showStatus = !isSystemKind(item.kind) && item.kind !== 'folder';
  // Мелкие значки живут без строки ревизии: в клетку 60×68 она не встаёт, а
  // подпись важнее — без неё значок перестаёт быть значком документа
  const showRevision = showStatus && metric.icon >= 32;
  /**
   * Поле переименования само решает, чем кончилось: Enter — сохранить, Escape —
   * отменить. Без этой отметки уход фокуса, который случается сразу после
   * Escape, доводил правку до сохранения — то есть отмена сохраняла.
   */
  const finished = React.useRef(false);
  React.useEffect(() => { if (renaming === null) finished.current = false; }, [renaming]);

  return (
    <div
      {...rest}
      style={{ left: x, top: y, width: metric.w, height: metric.h, zIndex: dragged ? 5 : 1 }}
      title={hintOf(item)}
      className={`absolute flex flex-col items-center gap-1 pt-2 px-1 rounded-lg cursor-default
                  ${dragged ? 'opacity-70' : ''}
                  ${selected ? 'bg-emerald-500/15 ring-1 ring-emerald-500/50' : 'hover:bg-slate-500/10'}`}
    >
      <span className="relative shrink-0">
        <Glyph item={item} size={metric.icon} />

        {/* Метка общего доступа: без неё «положил на стол» и «выложил всем»
            неразличимы, а это разные поступки */}
        {item.shared && !isSystemKind(item.kind) && (
          <span
            aria-label="Лежит на общем столе"
            className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center
                       bg-sky-600 text-white border-2 border-slate-100 dark:border-dark-bg"
          >
            <Users className="w-2 h-2" />
          </span>
        )}

        {/* Стадия документа — точкой того же цвета, что чип в Проводнике */}
        {showStatus && (
          <span
            aria-label={st.label}
            className={`absolute -top-0.5 -left-0.5 w-2.5 h-2.5 rounded-full ${st.dot}
                        border-2 border-slate-100 dark:border-dark-bg`}
          />
        )}

        {badge !== undefined && badge > 0 && (
          <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-slate-600 text-white text-xs font-medium tabular-nums flex items-center justify-center">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>

      {renaming !== null ? (
        <input
          autoFocus
          value={renaming}
          onChange={(e) => onRenameChange(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={() => { if (!finished.current) { finished.current = true; onRenameCommit(); } }}
          /* Клавиши поля дальше не идут: иначе Escape, отменяющий переименование,
             доходил до стола и снимал заодно выделение — а значок после отмены
             обязан остаться выбранным, чтобы можно было тут же нажать F2 снова */
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { finished.current = true; onRenameCommit(); }
            if (e.key === 'Escape') { finished.current = true; onRenameCancel(); }
          }}
          className="w-full text-2xs text-center rounded border border-emerald-500 outline-none px-1
                     bg-white dark:bg-slate-900 text-slate-900 dark:text-white select-text"
        />
      ) : (
        <span
          style={{ fontSize: metric.label }}
          /* Две строки и обрыв: «Ведомость оборудования системы В-1» не должна
             наезжать на соседний значок */
          className={`w-full text-center leading-tight line-clamp-2 break-words ${
            selected ? 'text-emerald-900 dark:text-emerald-100 font-semibold' : 'text-slate-700 dark:text-slate-150'
          }`}
        >
          {titleOf(item)}
        </span>
      )}

      {/* Ревизия под подписью: инженер спрашивает «какая версия» чаще, чем
          «как называется». Место под неё занято всегда, чтобы подписи соседних
          значков стояли на одной линии */}
      {showRevision && renaming === null && (
        <span className="text-2xs tabular-nums leading-none text-slate-400 dark:text-slate-500">
          {item.tag ? `${item.tag} · ` : ''}ред. {item.revision || '1'}
        </span>
      )}
    </div>
  );
}

export { FILE_STATUSES };
