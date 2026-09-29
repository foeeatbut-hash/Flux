/**
 * Панель над холстом «Схемы»: масштаб, «По размеру», «Центрировать»,
 * «Упорядочить» с выбором оси и «Отменить».
 *
 * Вынесена из Registry.tsx как есть. Масштаб, ось и раскладка живут в
 * Registry: их читает и двигает сам холст (колесо, клавиши, меню правой
 * кнопки), поэтому панель только показывает их и вызывает обработчики.
 */
import React from 'react';
import { ZoomIn, ZoomOut, Maximize2, RefreshCw, Network, ChevronDown, Check, Undo2 } from 'lucide-react';
import { clampZoom, type TreeAxis } from '../../lib/tagLayout';
import { parseTagMetadata } from './tagMeta';

export interface BoardControlsProps {
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  /** Подпись масштаба: колесо мыши пишет в неё напрямую, минуя состояние */
  zoomLabelRef: React.RefObject<HTMLSpanElement | null>;
  fitCanvasToCenter: () => void;
  centerPickerOpen: boolean;
  setCenterPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** Теги без входящих связей — кандидаты в «главные родители» */
  rootTags: any[];
  centerTreeOfRoot: (rootId: string) => void;
  axis: TreeAxis;
  axisPickerOpen: boolean;
  setAxisPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  chooseAxis: (axis: TreeAxis) => void;
  arrangeTreeLayout: (dir?: TreeAxis) => Promise<void>;
  isArranging: boolean;
  /** Координаты до последней раскладки; пусто — откатывать нечего */
  undoArrange: Record<string, { x: number; y: number }> | null;
  undoArrangeLayout: () => Promise<void>;
}

export default function BoardControls({
  zoom, setZoom, zoomLabelRef, fitCanvasToCenter, centerPickerOpen, setCenterPickerOpen, rootTags,
  centerTreeOfRoot, axis, axisPickerOpen, setAxisPickerOpen, chooseAxis, arrangeTreeLayout, isArranging,
  undoArrange, undoArrangeLayout,
}: BoardControlsProps) {
  // Overlaid Zoom and Canvas Controls on the top-right
  return (
    <div className="absolute top-4 right-4 z-40 flex items-center gap-2 bg-white/90 dark:bg-slate-950/90 backdrop-blur-md p-1.5 rounded-xl border border-slate-200 dark:border-slate-800/80 shadow-md">
      <div className="flex bg-slate-100 dark:bg-slate-900 p-0.5 rounded-lg border border-slate-200/50 dark:border-slate-800">
        <button type="button"
          onClick={() => setZoom((z) => clampZoom(z - 0.1))}
          title="Отдалить"
          className="p-1 px-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 rounded transition-colors cursor-pointer"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span ref={zoomLabelRef} className="px-2 py-0.5 text-xs font-mono font-medium text-slate-600 dark:text-slate-400 self-center tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button type="button"
          onClick={() => setZoom((z) => clampZoom(z + 0.1))}
          title="Приблизить"
          className="p-1 px-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 rounded transition-colors cursor-pointer"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="w-[1px] h-5 bg-slate-200 dark:bg-slate-800" />

      {/* «По размеру» отдельной кнопкой. Раньше это был ВТОРОЙ щелчок
          по «Центрировать» с таймером в 260 мс: задержка чувствуется
          на каждом обычном нажатии, а научиться такому неоткуда */}
      <button type="button"
        onClick={fitCanvasToCenter}
        title="Вписать весь холст (F)"
        className="fx-btn fx-btn-sm"
      >
        <Maximize2 className="w-3 h-3 text-emerald-600" />
        По размеру
      </button>

      <div className="relative">
        <button type="button"
          onClick={(e) => { e.stopPropagation(); setCenterPickerOpen((v) => !v); }}
          title="Показать дерево выбранной установки целиком"
          className="fx-btn fx-btn-sm"
        >
          <RefreshCw className="w-3 h-3 text-emerald-600" />
          Центрировать
        </button>

        {/* Выбор главного родителя: его дерево выделяется и центрируется */}
        {centerPickerOpen && (
          <div
            className="absolute top-full right-0 mt-1.5 w-72 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl z-50 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-2 text-xs font-medium text-slate-400 border-b border-slate-100 dark:border-slate-850">
              Главные родители ({rootTags.length})
            </div>
            <div className="max-h-64 overflow-y-auto p-1.5 space-y-0.5">
              {rootTags.length === 0 ? (
                <div className="text-center text-xs text-slate-400 py-4">Нет корневых тегов</div>
              ) : rootTags.map(rt => (
                <button type="button"
                  key={rt.id}
                  onClick={() => centerTreeOfRoot(rt.id)}
                  className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-950/30 text-xs flex items-center justify-between gap-2 cursor-pointer"
                >
                  <span className="font-mono font-medium text-emerald-700 dark:text-emerald-400 truncate">{rt.identifier}</span>
                  <span className="text-slate-400 truncate max-w-[120px]">{parseTagMetadata(rt).mainName || ''}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Упорядочить — с выбором оси. Ось меняет и раскладку, и то,
          как идут линии: холст выглядит так, как его последний раз
          разложили */}
      <div className="relative flex">
        <button type="button"
          onClick={() => { void arrangeTreeLayout(); }}
          disabled={isArranging}
          title={axis === 'down'
            ? 'Разложить: родитель сверху, дети под ним, следующее дерево правее'
            : 'Разложить: родитель слева, дети правее, следующее дерево правее'}
          className="fx-btn fx-btn-primary fx-btn-sm"
        >
          <Network className={`w-3 h-3 ${isArranging ? 'animate-pulse' : ''}`} />
          {isArranging ? 'Раскладка…' : 'Упорядочить'}
        </button>
        <button type="button"
          onClick={(e) => { e.stopPropagation(); setAxisPickerOpen((v) => !v); }}
          disabled={isArranging}
          title="Как раскладывать дерево"
          aria-label="Выбрать раскладку"
          className="px-1.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-r-lg border-l border-emerald-500 transition-colors cursor-pointer"
        >
          <ChevronDown className="w-3 h-3" />
        </button>

        {axisPickerOpen && (
          <div
            className="absolute top-full right-0 mt-1.5 w-64 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl z-50 overflow-hidden p-1.5 space-y-0.5"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {([
              { id: 'down' as const, title: 'Сверху вниз', hint: 'Родитель сверху, состав под ним' },
              { id: 'right' as const, title: 'Слева направо', hint: 'Родитель слева, состав правее' },
            ]).map((o) => (
              <button type="button"
                key={o.id}
                /* Выбор сразу и раскладывает: переключатель, которому
                   нужно второе нажатие, читается как несработавший */
                onClick={() => { chooseAxis(o.id); setAxisPickerOpen(false); void arrangeTreeLayout(o.id); }}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs cursor-pointer flex items-center gap-2 ${
                  axis === o.id
                    ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                    : 'hover:bg-slate-100 dark:hover:bg-slate-850 text-slate-700 dark:text-slate-300'}`}
              >
                <Check className={`w-3 h-3 shrink-0 ${axis === o.id ? '' : 'opacity-0'}`} />
                <span className="min-w-0">
                  <span className="block font-medium">{o.title}</span>
                  <span className="block text-2xs text-slate-400">{o.hint}</span>
                </span>
              </button>
            ))}
            <p className="px-2.5 pt-1 text-2xs text-slate-400">
              Деревья встают в ряд слева направо при обеих раскладках.
            </p>
          </div>
        )}
      </div>

      {/* Откат раскладки: она переписывает координаты всех тегов
          разом, и расставленное руками иначе теряется навсегда */}
      {undoArrange && !isArranging && (
        <button type="button"
          onClick={() => { void undoArrangeLayout(); }}
          title="Вернуть карточки туда, где они стояли до раскладки"
          className="fx-btn fx-btn-quiet fx-btn-sm"
        >
          <Undo2 className="w-3 h-3" />
          Отменить
        </button>
      )}
    </div>
  );
}
