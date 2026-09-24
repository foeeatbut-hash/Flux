import React, { useEffect, useMemo, useState } from 'react';
import { X, ChevronRight, Maximize2 } from 'lucide-react';
import { buildViews, todayWords } from '../art/views';

const KEY = 'flux_art_index';

/**
 * Сцена и подпись.
 *
 * Вокруг сцены — поля из фона самой панели: 8 по бокам и сверху. Полка от
 * этого стала выше на 12 точек, и они окупаются тем, ради чего затевалось, —
 * см. рассуждение о границах ниже.
 */
const SCENE_H = 96;
const LABEL_H = 22;

interface Props {
  onClose: () => void;
  /** Разговор переезжает в окно программы; нет обработчика — нет и кнопки */
  onExpand?: () => void;
}

/**
 * Полка видов в шапке помощника — на месте, где раньше жил робот.
 *
 * Что изменилось после первой версии и почему.
 *
 * Было мелко. Полоса 380×88 отдавала холсту 56 точек по высоте, а подпись
 * лежала поверх сцены табличкой в левом нижнем углу и закрывала собой то
 * самое место, где у половины сцен стоял человек или лежала тень. Получалось
 * вдвойне плохо: и картина маленькая, и часть её не видно.
 *
 * Стало так. Подпись съехала из сцены в собственную строку под ней — теперь
 * она ничего не закрывает и читается на любом виде без подложек и подгонки
 * цвета. Освободившийся низ отдан сцене, и холст вырос с 56 до 74 точек. Полка
 * подросла с 88 до 120: 96 на вид, 24 на подпись. Тридцать две точки — это
 * примерно одна строка переписки, и они окупаются тем, что на картину стало
 * можно смотреть.
 *
 * Кроме картин на полке живут пейзажи: время года и время суток настоящие,
 * сегодняшние, погода перебирается по кругу (см. src/art/scenery.tsx). Ленте
 * 4:1 пейзаж подходит идеально — там нет холста, который надо куда-то
 * вставлять, вид занимает всё поле целиком.
 *
 * Какой вид показать. При каждом открытии панели — следующий по кругу, и номер
 * запоминается. Не случайно: случайный выбор время от времени показывает одно
 * и то же дважды подряд, и это читается как поломка. Не само собой по таймеру:
 * полка стоит вплотную к переписке, и вид, меняющийся сам во время чтения,
 * дёргает взгляд. Хочется другой — нажатие переключает.
 *
 * Границы. Сцена была во всю ширину панели, встык: тёплая стена галереи
 * упиралась в белую панель программы, и полка читалась как чужой прямоугольник,
 * вклеенный в интерфейс. Хуже того, снизу шли три жёстких линии подряд — край
 * сцены, рамка над подписью и рамка под всей полкой, — и получалась лесенка из
 * полос поперёк панели.
 *
 * Теперь сцена — карточка со скруглёнными углами, вокруг неё поля из фона
 * панели, а вместо рамки волосяное кольцо в шесть процентов чёрного и мягкая
 * тень. Кольцо не читается линией: оно только не даёт светлой сцене слиться с
 * белой панелью. Подпись стоит на фоне панели, без своей подложки и без рамки
 * сверху — так она читается подписью под картиной, а не второй плашкой.
 */
export default function ArtShelf({ onClose, onExpand }: Props) {
  // Список собирается при открытии: он зависит от сегодняшних даты и часа
  const views = useMemo(() => buildViews(), []);

  const [i, setI] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem(KEY) || '', 10);
      return Number.isFinite(v) ? v + 1 : 0;
    } catch (_) { return 0; }
  });

  useEffect(() => {
    try { localStorage.setItem(KEY, String(i)); } catch (_) { /* приватный режим — просто не помним */ }
  }, [i]);

  const n = views.length;
  const at = ((i % n) + n) % n;
  const v = views[at];

  return (
    <div className="shrink-0 select-none px-2 pt-2 pb-1">
      {/* Сцена карточкой. key — чтобы при смене вида анимации начинались
          заново, а не подхватывались на середине от предыдущего */}
      <div
        className="relative overflow-hidden rounded-xl shadow-sm
                   ring-1 ring-black/[0.06] dark:ring-white/[0.07]"
        style={{ height: SCENE_H }}
        role="img"
        aria-label={`${v.title}. ${v.sub}`}
      >
        <div key={v.id} className="absolute inset-0 flux-art-enter">
          {v.render()}
        </div>

        {/* Следующий вид */}
        <button
          type="button"
          onClick={() => setI((x) => x + 1)}
          title={`Следующий вид (${at + 1} из ${n}) · сейчас ${todayWords()}`}
          aria-label="Следующий вид"
          className="absolute right-8 top-1.5 p-1 rounded-lg cursor-pointer transition-ui
                     bg-black/20 hover:bg-black/35 ring-1 ring-white/20 text-white/90 backdrop-blur-sm"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        {/* Разговор в окно: помощник — такая же программа, как остальные, и
            в тесной панели ему бывает мало места */}
        {onExpand && (
          <button
            type="button"
            onClick={onExpand}
            title="Открыть окном"
            aria-label="Открыть окном"
            className="absolute right-[52px] top-1.5 p-1 rounded-lg cursor-pointer transition-ui
                       bg-black/20 hover:bg-black/35 ring-1 ring-white/20 text-white/90 backdrop-blur-sm"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        )}

        {/* Закрыть помощника — кнопка та же, что была у робота */}
        <button
          type="button"
          onClick={onClose}
          title="Закрыть"
          aria-label="Закрыть помощника"
          className="absolute right-1.5 top-1.5 p-1 rounded-lg cursor-pointer transition-ui
                     bg-black/20 hover:bg-black/35 ring-1 ring-white/20 text-white/90 backdrop-blur-sm"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Подпись под картиной: на фоне панели, без подложки и без рамки.
          Название и уточнение в одной строке — на 380 точках две строки
          съели бы вдвое больше места ради того же смысла. */}
      <div
        className="flex items-baseline gap-1.5 px-1 pt-1"
        style={{ height: LABEL_H }}
      >
        <span className="text-xs font-medium text-slate-800 dark:text-slate-100 shrink-0 max-w-[58%] truncate">
          {v.title}
        </span>
        <span className="text-2xs text-slate-500 dark:text-slate-400 min-w-0 truncate">
          {v.sub}
        </span>
      </div>
    </div>
  );
}
