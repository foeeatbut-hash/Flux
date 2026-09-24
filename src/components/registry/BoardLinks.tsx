/**
 * Слой связей на холсте тегов: линии между родителем и его составом.
 *
 * Вынесено из Registry по двум причинам, и обе — про то, что было сломано.
 *
 * Первая: наведение на линию жило в состоянии экрана (`hoveredConnection`).
 * Экран перебирает все теги, чтобы нарисовать и карточки, и линии, — значит
 * подсветка ОДНОЙ линии перерисовывала весь холст. На пятистах тегах это
 * чувствуется рукой. Здесь подсветка сделана наведением CSS: браузер умеет её
 * сам, без единой перерисовки.
 *
 * Вторая: цвета линий были вписаны шестнадцатеричными числами — `#6366f1` и
 * `#4f46e5`. Это indigo, второй акцент, которого в программе никто не
 * объявлял. Проверка палитры видит только классы Tailwind, поэтому чужой
 * оттенок и дожил до сегодня. Теперь цвет задаётся классами: он и по палитре,
 * и на виду у проверки.
 *
 * Стрелки на концах — не украшение. Когда карточки растащены руками, «кто
 * кому родитель» по одной линии не читается вовсе, а состав установки — это
 * первое, что по холсту и смотрят.
 */
import React from 'react';
import { linkPath, linkMid, type TreeAxis, type LayoutBox, type Point } from '../../lib/tagLayout';

export interface BoardLink {
  sourceId: string;
  targetId: string;
  /** Код родителя и ребёнка — для подсказки и сообщения об удалении */
  sourceName: string;
  targetName: string;
  from: Point;
  to: Point;
}

export interface BoardLinksProps {
  links: BoardLink[];
  axis: TreeAxis;
  box: LayoutBox;
  selected: { sourceId: string; targetId: string } | null;
  /** Рамка видимой части холста: за её пределами линии не рисуются */
  frame: { active: boolean; x0: number; y0: number; x1: number; y1: number };
  /** Бегущая точка показывает направление, но на больших графах её гасят */
  showFlowDots: boolean;
  onSelect: (sourceId: string, targetId: string) => void;
  onRemove: (link: BoardLink) => void;
}

function Links({ links, axis, box, selected, frame, showFlowDots, onSelect, onRemove }: BoardLinksProps) {
  return (
    <svg
      className="absolute pointer-events-none overflow-visible"
      style={frame.active
        ? {
          left: `${frame.x0}px`,
          top: `${frame.y0}px`,
          width: `${Math.max(1, frame.x1 - frame.x0)}px`,
          height: `${Math.max(1, frame.y1 - frame.y0)}px`,
        }
        : { inset: 0, width: '100%', height: '100%' }}
      viewBox={frame.active
        ? `${frame.x0} ${frame.y0} ${Math.max(1, frame.x1 - frame.x0)} ${Math.max(1, frame.y1 - frame.y0)}`
        : undefined}
    >
      {/* Наконечник объявлен один раз на весь слой: по стрелке на связь
          съедало бы столько же узлов, сколько самих связей */}
      <defs>
        <marker id="tag-link-arrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="fill-emerald-600 dark:fill-emerald-400" />
        </marker>
        <marker id="tag-link-arrow-on" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="fill-sky-600 dark:fill-sky-400" />
        </marker>
      </defs>

      {links.map((l) => {
        const d = linkPath(l.from, l.to, axis, box);
        const on = !!selected && selected.sourceId === l.sourceId && selected.targetId === l.targetId;
        const mid = linkMid(l.from, l.to, axis, box);
        return (
          <g key={`${l.sourceId}-${l.targetId}`} className="pointer-events-auto group">
            {/* Широкая прозрачная линия — только чтобы попадать по тонкой */}
            <path
              id={`path-overlay-${l.sourceId}-${l.targetId}`}
              d={d} fill="none" stroke="transparent" strokeWidth="16"
              className="cursor-pointer" style={{ pointerEvents: 'stroke' }}
              onClick={(e) => { e.stopPropagation(); onSelect(l.sourceId, l.targetId); }}
            />

            {/* Ореол при наведении: показывает браузер, состояние не трогается */}
            <path
              d={d} fill="none" strokeWidth="6"
              className={`transition-opacity duration-150 ${on
                ? 'opacity-70 stroke-sky-500'
                : 'opacity-0 group-hover:opacity-40 stroke-emerald-500'}`}
            />

            <path
              id={`path-${l.sourceId}-${l.targetId}`}
              d={d} fill="none"
              strokeWidth={on ? 3 : 2.5}
              markerEnd={`url(#tag-link-arrow${on ? '-on' : ''})`}
              className={`cursor-pointer transition-colors duration-150 ${on
                ? 'stroke-sky-600 dark:stroke-sky-400'
                : 'stroke-emerald-600 dark:stroke-emerald-400'}`}
              onClick={(e) => { e.stopPropagation(); onSelect(l.sourceId, l.targetId); }}
            >
              <title>{`${l.sourceName} → ${l.targetName}`}</title>
            </path>

            {showFlowDots && (
              <circle
                id={`flow-dot-${l.sourceId}-${l.targetId}`} r="3.5"
                className={on ? 'fill-sky-400' : 'fill-emerald-400'}
              >
                <animateMotion path={d} dur="6s" repeatCount="indefinite" />
              </circle>
            )}

            {/* Крестик садится на саму линию: у кривой середина не полусумма
                концов, и раньше он отъезжал тем дальше, чем круче изгиб */}
            <foreignObject
              x={mid.x - 10} y={mid.y - 10} width={20} height={20}
              className={`overflow-visible transition-opacity duration-150 ${on ? '' : 'opacity-0 group-hover:opacity-100'}`}
            >
              <button
                type="button"
                title="Разорвать связь"
                onClick={(e) => { e.stopPropagation(); onRemove(l); }}
                className="fx-btn fx-btn-danger-fill w-5 justify-center"
              >
                ×
              </button>
            </foreignObject>
          </g>
        );
      })}

      {/* Линия, которую сейчас тянут: одна на весь холст, её `d` пишется
          напрямую в DOM — состояние на каждое движение мыши не переживёт */}
      <path
        id="active-drag-path" d="" fill="none" strokeWidth="2.5" strokeDasharray="4 4"
        className="stroke-emerald-600 dark:stroke-emerald-400" style={{ display: 'none' }}
      />
    </svg>
  );
}

export default React.memo(Links);
