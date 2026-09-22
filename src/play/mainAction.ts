/**
 * Одна главная кнопка и все её состояния (ТЗ §13.2).
 *
 * Почему кнопка одна. У карточки игры есть десяток возможных действий —
 * установить, докачать, обновить, начать, отметиться готовым, вернуться в
 * матч, переподключиться, — и показывать их все сразу значит заставлять
 * человека выбирать между ними. В любой момент времени осмысленно ровно одно,
 * и оно определяется состоянием, а не желанием: в матче нельзя «начать», без
 * установленной игры нельзя «играть».
 *
 * Модуль чистый: ни React, ни запросов. На вход состояние, на выход — что
 * написать на кнопке, что она сделает и можно ли её нажать. Так это и
 * проверяется скриптом: состояний много, и ошибиться в них глазом легко.
 *
 * Порядок важнее списка. Правила идут сверху вниз, и первое сработавшее —
 * ответ. Самое срочное наверху: потерянная связь важнее незавершённой
 * закачки, а идущий матч важнее всего остального.
 */

/**
 * Состояние связи с платформой.
 *
 * Объявлено здесь, а не взято из хранилища: модуль чистый, и тянуть ради
 * одного типа целое хранилище значило бы сделать его непригодным для проверки
 * скриптом.
 */
export type Link = 'idle' | 'live' | 'reconnecting';

/**
 * Что с игрой на этой машине. Заполняет локальный менеджер игр.
 *
 * Ось общая с оболочкой (`play/builds.ts`): состояние считает тот, кто видит
 * диск, а окно только рисует. Своя копия перечисления здесь означала бы, что
 * однажды оболочка пришлёт состояние, которого окно не знает, и кнопка молча
 * станет ничем.
 */
export type { InstallState } from '../../play/builds';
import type { InstallState } from '../../play/builds';

export interface ActionInput {
  link: Link;
  /** Обслуживание: заходить можно, начинать новое нельзя */
  maintenance: boolean;
  install: InstallState;
  session: { state: string } | null;
  lobby: { state: string } | null;
  party: { leaderId: string } | null;
  meId: string;
  /** Отмечен ли готовым сам человек */
  iAmReady: boolean;
  /** Готовы ли все в лобби */
  allReady: boolean;
  /** Показанному больше нельзя верить */
  stale: boolean;
  /**
   * Есть ли на этой машине менеджер игр.
   *
   * Раздел открывается и в обычном браузере. Ставить игру там нечем, и сказать
   * об этом надо прямо: «сборка не опубликована» в браузере было бы враньём —
   * сборка может быть опубликована, просто поставить её отсюда нельзя.
   */
  manager?: boolean;
  /**
   * Игра встроенная: доска считается сервером, ставить нечего.
   *
   * Без этого признака встроенная игра попала бы в «Сборка не опубликована» и
   * не запустилась бы никогда: состояние установки у неё не бывает готовым,
   * потому что устанавливать нечего.
   */
  builtin?: boolean;
}

export type ActionId =
  | 'reconnect' | 'return' | 'connecting'
  | 'unavailable' | 'install' | 'pause' | 'resume' | 'update' | 'restore'
  | 'maintenance' | 'prepare' | 'ready' | 'unready' | 'waitOthers' | 'waitLeader' | 'start';

export interface ActionView {
  id: ActionId;
  label: string;
  /** Пояснение под кнопкой: почему именно это и что будет дальше */
  hint: string;
  tone: 'primary' | 'quiet' | 'warn';
  disabled: boolean;
}

/**
 * Что делать прямо сейчас.
 *
 * `stale` не меняет надписи — он гасит кнопку. Подменять действие на
 * «Обновить состояние» было бы враньём: человек хочет не обновить состояние,
 * а начать матч, и сказать ему надо именно «подождите, данные устарели».
 */
export function mainAction(input: ActionInput): ActionView {
  const gate = (v: ActionView): ActionView => (
    input.stale && !v.disabled
      ? { ...v, disabled: true, hint: 'Данные устарели — подождите, состояние вот-вот обновится' }
      : v
  );

  // 1. Связи нет. Всё остальное сейчас неважно: любое действие уйдёт в никуда
  if (input.link === 'reconnecting') {
    return {
      id: 'reconnect',
      label: 'Переподключиться',
      hint: 'Связь потеряна. Показанное ещё может быть верным, но действовать по нему нельзя',
      tone: 'warn',
      disabled: false,
    };
  }

  // 2. Матч идёт — человеку нужно в него, а не в меню
  if (input.session?.state === 'RUNNING') {
    return gate({
      id: 'return',
      label: 'Вернуться в игру',
      hint: 'Матч идёт. Кнопка выдаст новый пропуск и откроет игру',
      tone: 'primary',
      disabled: false,
    });
  }

  if (input.session?.state === 'ALLOCATING') {
    return {
      id: 'connecting',
      label: 'Подключение…',
      hint: 'Ищем сервер для матча. Это занимает несколько секунд',
      tone: 'quiet',
      disabled: true,
    };
  }

  // 3. Игра на этой машине. Играть в неустановленное нельзя, и предлагать
  //    «Начать матч» в этом состоянии — значит обещать несбыточное.
  //    Встроенной игры это не касается: она уже здесь
  switch (input.builtin ? 'ready' : input.install) {
    case 'unavailable':
      return input.manager === false
        ? {
          id: 'unavailable',
          label: 'Игра ставится из программы',
          hint: 'Раздел открыт в браузере: здесь видно состав, готовность и матч, '
            + 'но установить игру можно только из программы Flux',
          tone: 'quiet',
          disabled: true,
        }
        : {
          id: 'unavailable',
          label: 'Сборка не опубликована',
          hint: 'Устанавливать пока нечего. Кнопка оживёт, когда администратор выложит сборку',
          tone: 'quiet',
          disabled: true,
        };
    case 'absent':
      return gate({
        id: 'install', label: 'Установить',
        hint: 'Игра ещё не установлена на этом компьютере', tone: 'primary', disabled: false,
      });
    case 'downloading':
      return {
        id: 'pause', label: 'Пауза',
        hint: 'Идёт загрузка. Остановить можно в любой момент — скачанное не пропадёт',
        tone: 'quiet', disabled: false,
      };
    case 'paused':
      return gate({
        id: 'resume', label: 'Продолжить',
        hint: 'Загрузка остановлена. Продолжится с того же места', tone: 'primary', disabled: false,
      });
    case 'outdated':
      return gate({
        id: 'update', label: 'Обновить',
        hint: 'Установлена старая версия. С ней в матч не пустят', tone: 'primary', disabled: false,
      });
    case 'broken':
      return gate({
        id: 'restore', label: 'Восстановить',
        hint: 'Файлы игры не сходятся с описью. Повреждённое будет скачано заново',
        tone: 'warn', disabled: false,
      });
    default:
      break; // 'ready' — идём дальше
  }

  // 4. Обслуживание: зайти можно, начать новое — нет
  if (input.maintenance) {
    return {
      id: 'maintenance',
      label: 'Идёт обслуживание',
      hint: 'Новые матчи временно не начинаются. Уже идущие продолжаются',
      tone: 'quiet',
      disabled: true,
    };
  }

  // 5. Подготовка. Лобби нет — его надо открыть
  if (!input.lobby || input.lobby.state === 'CLOSED') {
    return gate({
      id: 'prepare', label: 'Подготовиться',
      hint: 'Соберёт лобби по составу группы. Играть можно и одному', tone: 'primary', disabled: false,
    });
  }

  const leader = !!input.party && input.party.leaderId === input.meId;

  if (!input.iAmReady) {
    return gate({
      id: 'ready', label: 'Готов',
      hint: 'Матч начнётся, когда отметятся все', tone: 'primary', disabled: false,
    });
  }

  if (!input.allReady) {
    return gate({
      id: 'unready', label: 'Отменить готовность',
      hint: 'Ждём остальных. Передумали — снимите отметку', tone: 'quiet', disabled: false,
    });
  }

  if (leader) {
    return gate({
      id: 'start', label: 'Начать матч',
      hint: 'Все готовы. Группа уйдёт на один сервер', tone: 'primary', disabled: false,
    });
  }

  return {
    id: 'waitLeader',
    label: 'Ждём ведущего',
    hint: 'Все готовы. Матч начинает ведущий группы',
    tone: 'quiet',
    disabled: true,
  };
}
