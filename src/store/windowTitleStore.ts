/**
 * Слот заголовка окна: кто его занял и куда вставлять.
 *
 * Заголовок окна общий для всех разделов, но Проводнику нужна своя полоса
 * вкладок высотой 38. Рама окна кладёт сюда свой пустой узел-место (`hosts`), а
 * раздел объявляет, что занимает его (`claims`), и вставляет в узел порталом.
 * Состояние здесь, а не в контексте React, чтобы слот можно было занять и
 * проверить снаружи раздела — по одному номеру окна.
 *
 * Хранилище не знает ни рамы окна, ни раздела: оно держит только узлы и числа.
 */
import { create } from 'zustand';

export interface TitleClaim {
  /** Высота заголовка, пока слот занят: у Проводника 38, у обычного окна 34 */
  height: number;
  /** Фон и разделитель полосы: их задаёт раздел, потому что полоса — его */
  className: string;
}

interface TitleSlots {
  hosts: Record<string, HTMLElement>;
  claims: Record<string, TitleClaim>;
  setHost: (winId: string, el: HTMLElement | null) => void;
  claim: (winId: string, claim: TitleClaim) => void;
  release: (winId: string) => void;
}

export const useWindowTitleStore = create<TitleSlots>((set, get) => ({
  hosts: {},
  claims: {},
  setHost: (winId, el) => {
    const cur = get().hosts[winId];
    if (el === (cur || null)) return;
    const { [winId]: _gone, ...rest } = get().hosts;
    set({ hosts: el ? { ...rest, [winId]: el } : rest });
  },
  claim: (winId, claim) => {
    const cur = get().claims[winId];
    // Тот же ответ записываем один раз: иначе рама перерисовывалась бы на каждый кадр раздела
    if (cur && cur.height === claim.height && cur.className === claim.className) return;
    set({ claims: { ...get().claims, [winId]: claim } });
  },
  release: (winId) => {
    if (!(winId in get().claims)) return;
    const { [winId]: _gone, ...rest } = get().claims;
    set({ claims: rest });
  },
}));
