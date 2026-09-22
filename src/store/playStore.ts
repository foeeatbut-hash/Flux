/**
 * Подтверждённое состояние платформы: то, что сказал сервер.
 *
 * Здесь лежит ТОЛЬКО оно. Всё, что человек нажал, но сервер ещё не подтвердил,
 * живёт отдельно (`playPendingStore`), и это главное решение этого файла.
 * Смешав их, мы получили бы состояние, в котором «Приглашение отправлено»
 * написано раньше, чем оно отправлено, — а после отказа сервера его пришлось
 * бы забирать обратно, и человек видел бы, как программа передумывает.
 *
 * Событие сокета несёт только «что-то поменялось», без содержимого. Читать
 * состояние из события нельзя по двум причинам: присланному верить не
 * приходится, а порядок доставки событий не гарантирован никем. Поэтому
 * событие — повод перечитать снимок, а снимок — единственный источник.
 *
 * Снимок помнит, когда он взят. Старше тридцати пяти секунд (ТЗ) — на экране
 * появляется пометка: показанное остаётся, но с честным «ему уже нельзя
 * верить». Стирать его нельзя — пока связь восстанавливается, оно ещё верно.
 */
import { create } from 'zustand';
import { PLAY_LIMITS, type PlaySnapshot } from '../../play/contracts';
import * as play from '../services/playService';
import type { Link } from '../play/mainAction';

export type { Link };

export interface PlayState {
  /** Состояние связи с платформой — не с сервером вообще */
  link: Link;
  /** Когда снят показанный снимок; 0 — ещё ничего не показано */
  at: number;
  loading: boolean;
  failure: string;

  party: any | null;
  lobby: any | null;
  session: any | null;
  invites: any[];
  presence: any[];
  /** Результат последнего матча, если он уже пришёл */
  result: Record<string, unknown> | null;
  /** Идентификатор матча, к которому относится показанный результат */
  resultOf: string;

  setLink: (link: Link) => void;
  /**
   * Сервер подтвердил, что мы на связи.
   *
   * Устаревание — это «мы перестали получать обновления», а не «ничего не
   * происходило». Пока сердцебиение проходит, изменения до нас дошли бы; так
   * что удачный удар сердца делает показанное свежим, не перечитывая снимок.
   */
  touch: () => void;
  /** Перечитать состояние целиком. Зовётся и по событию, и при открытии */
  refresh: () => Promise<void>;
  /** Принять снимок, пришедший по сокету при переподключении */
  applySnapshot: (snapshot: PlaySnapshot) => void;
  reset: () => void;
}

/** Показанному больше нельзя верить. Предел общий с сервером (ТЗ). */
export const isStale = (at: number, now = Date.now()): boolean =>
  at > 0 && now - at > PLAY_LIMITS.staleAfterMs;

const empty = {
  at: 0,
  loading: false,
  failure: '',
  party: null,
  lobby: null,
  session: null,
  invites: [] as any[],
  presence: [] as any[],
  result: null as Record<string, unknown> | null,
  resultOf: '',
};

/** Два запроса подряд не нужны: второй догонит первый и покажет то же самое. */
let inflight: Promise<void> | null = null;

export const usePlayStore = create<PlayState>((set, get) => ({
  link: 'idle',
  ...empty,

  setLink: (link) => set({ link }),

  touch: () => { if (get().at) set({ at: Date.now() }); },

  refresh: async () => {
    if (inflight) return inflight;
    set({ loading: true });
    inflight = (async () => {
      const res = await play.fetchState();
      if (!res.ok) {
        /**
         * «Такого нет» — это не поломка, а снятый доступ: платформа отвечает
         * так же, как на выдуманный адрес. Показывать красную плашку здесь
         * значило бы сообщить человеку о существовании того, что от него
         * скрыто. Просто очищаемся.
         */
        if (res.code === 'NOT_FOUND') { set({ ...empty }); return; }
        set({ loading: false, failure: String(res.message || 'Платформа не отвечает') });
        return;
      }
      get().applySnapshot(res.result as PlaySnapshot);
    })().finally(() => { inflight = null; });
    return inflight;
  },

  applySnapshot: (snapshot) => {
    const s = snapshot || ({} as PlaySnapshot);
    const session: any = s.session || null;
    const done = s.result || null;
    set({
      at: Number(s.at) || Date.now(),
      loading: false,
      failure: '',
      party: s.party || null,
      lobby: s.lobby || null,
      session,
      invites: Array.isArray(s.invites) ? s.invites : [],
      presence: Array.isArray(s.presence) ? s.presence : [],
      /**
       * Итог матча берётся из снимка, а не помнится окном.
       *
       * Сервер сам решает, когда его показывать и когда убрать: пока лобби то
       * же и новый матч не начат — показывать, дальше — нет. Окно, помнившее
       * бы счёт самостоятельно, теряло бы его при перезагрузке страницы и
       * держало бы чужой матч на экране после выхода из группы.
       */
      result: done ? done.payload : null,
      resultOf: done ? String(done.sessionId) : '',
    });
  },

  reset: () => set({ link: 'idle', ...empty }),
}));
