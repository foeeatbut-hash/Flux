/**
 * Каталог прав игровой платформы Flux Play.
 *
 * Почему отдельно от `src/lib/permissions.ts`. Восемнадцать рабочих прав
 * («Правка характеристик», «Реестр ВДР») описывают работу инженера, и их видно
 * в карточке сотрудника всем администраторам. Игровые права устроены иначе:
 *
 *   1. их **не видно**, пока у человека нет доступа к самой платформе —
 *      сотрудник без `app.play` не должен узнать о её существовании даже по
 *      пустой группе галочек в чужой карточке;
 *   2. роль администратора их **не обходит**. `can()` первой же строкой
 *      отвечает `true` для ADMIN — для рабочих прав это правильно (админ и так
 *      может всё), а для игр это означало бы «платформа сама включилась
 *      руководителю»;
 *   3. у них есть третье состояние — «не сказано». Рабочее право либо выдано,
 *      либо нет; игровое умеет ещё и запрещать явно, поверх роли.
 *
 * Поэтому каталог, правило (`src/lib/appPolicy.ts`) и хранение у платформы
 * свои. Общего с рабочими правами — только карта `PermMap`, в которой они
 * лежат: заводить вторую таблицу прав в базе ради этого не нужно.
 */

/** Доступ к самой платформе. Нет его — нет и платформы: ни следа, нигде. */
export const APP_PLAY = 'app.play';

/** Управление платформой: сборки, каналы, обслуживание, разбор зависших матчей. */
export const PLAY_ADMIN = 'play.admin';

export interface PlayEntitlementDef {
  id: string;
  label: string;
  desc: string;
  group: string;
  /** Право опасное: выдавать осознанно. */
  risky?: boolean;
}

/**
 * Право на игру собирается из её кода, а не перечисляется руками: игр будет
 * больше одной, и список, который надо править в двух местах, разъедется.
 */
export const gameEntitlement = (gameId: string): string => `game.${gameId}.play`;

/** Код игры обратно из права — для карточки сотрудника и для сервера. */
export function gameOfEntitlement(id: string): string {
  const m = /^game\.(.+)\.play$/.exec(String(id || ''));
  return m ? m[1] : '';
}

export interface PlayGameDef {
  id: string;
  title: string;
  /** Короткое имя для узкого окна и панели группы */
  short: string;
  desc: string;
  /**
   * Сколько человек в команде и сколько команд — по этому числу лобби
   * понимает, набрано оно или нет.
   */
  teamSize: number;
  teams: number;
  /**
   * Игры ещё нет на диске у сотрудника — платформа умеет её поставить.
   * Проверочная игра (`testgame`) идёт вместе с программой и не ставится.
   */
  installable: boolean;
  /** Код адаптера на сервере: server/play/adapters/<adapter>.ts */
  adapter: string;
  /**
   * Где живёт игра.
   *
   * `external` — отдельный процесс на машине в сети: платформа выделяет сервер
   * и принимает подписанный результат. `builtin` — доска считается тем же
   * сервером, что и всё остальное: ставить нечего, запускать нечего, и окно
   * открывается прямо в разделе.
   */
  kind: 'external' | 'builtin';
  /** Одиночная игра: лобби и соперник ей не нужны */
  solo?: boolean;
}

/**
 * Игры платформы.
 *
 * `testgame` — не витрина, а инструмент: отдельный процесс, который принимает
 * билет, подтверждает подключение и присылает доверенный результат. На нём
 * проверяется весь цикл целиком, без «а на моках работало».
 *
 * `fluxstrike` — целевая игра; её собирают отдельно, и пока её нет, платформа
 * честно показывает «сборка не опубликована», а не делает вид, что установит.
 */
export const PLAY_GAMES: PlayGameDef[] = [
  {
    id: 'testgame',
    title: 'Проверочная игра',
    short: 'Проверка',
    desc: 'Служебная игра платформы: проверяет билет, подключение и доставку результата',
    teamSize: 1,
    teams: 2,
    installable: false,
    adapter: 'testgame',
    kind: 'external',
  },
  // ── Встроенные: доска считается сервером, ставить и запускать нечего ──
  {
    id: 'reversi',
    title: 'Реверси',
    short: 'Реверси',
    desc: 'Классическая доска 8×8 на двоих: кто перевернул больше, тот и выиграл',
    teamSize: 1,
    teams: 2,
    installable: false,
    adapter: 'reversi',
    kind: 'builtin',
  },
  {
    id: 'g2048',
    title: '2048',
    short: '2048',
    desc: 'Одиночная: складывайте одинаковые плитки, пока есть куда двигать',
    teamSize: 1,
    teams: 1,
    installable: false,
    adapter: 'g2048',
    kind: 'builtin',
    solo: true,
  },
  {
    id: 'sudoku',
    title: 'Судоку',
    short: 'Судоку',
    desc: 'Одиночная: сетка 9×9, у которой решение ровно одно',
    teamSize: 1,
    teams: 1,
    installable: false,
    adapter: 'sudoku',
    kind: 'builtin',
    solo: true,
  },
  {
    id: 'checkers',
    title: 'Русские шашки',
    short: 'Шашки',
    desc: 'Доска 8×8 на двоих по русским правилам: бить обязательно и до конца',
    teamSize: 1,
    teams: 2,
    installable: false,
    adapter: 'checkers',
    kind: 'builtin',
  },
  {
    id: 'fluxstrike',
    title: 'Flux Strike',
    short: 'Strike',
    desc: 'Командный шутер: две команды по пять человек',
    teamSize: 5,
    teams: 2,
    installable: true,
    adapter: 'fluxstrike',
    kind: 'external',
  },
];

export const gameById = (id: string): PlayGameDef | null =>
  PLAY_GAMES.find((g) => g.id === id) || null;

/**
 * Права платформы.
 *
 * Порядок здесь — порядок в карточке сотрудника: сначала сама платформа, потом
 * игры, потом отдельные действия, потом управление. Человек, выдающий доступ,
 * читает список сверху вниз и не должен искать главный выключатель в середине.
 */
export const PLAY_ENTITLEMENTS: PlayEntitlementDef[] = [
  {
    id: APP_PLAY,
    group: 'Платформа',
    label: 'Доступ к Flux Play',
    desc: 'Видеть раздел и заходить в него. Без этого права платформы для сотрудника не существует',
  },
  ...PLAY_GAMES.map((g) => ({
    id: gameEntitlement(g.id),
    group: 'Игры',
    label: g.title,
    desc: g.desc,
  })),
  {
    id: 'play.party.create',
    group: 'Действия',
    label: 'Собирать группу',
    desc: 'Создавать группу и приглашать в неё сотрудников',
  },
  {
    id: 'play.session.start',
    group: 'Действия',
    label: 'Запускать матч',
    desc: 'Переводить готовое лобби в матч',
  },
  {
    id: PLAY_ADMIN,
    group: 'Управление',
    label: 'Управление платформой',
    risky: true,
    desc: 'Публиковать сборки, менять каналы, включать обслуживание, разбирать зависшие матчи',
  },
];

export const PLAY_GROUPS = Array.from(new Set(PLAY_ENTITLEMENTS.map((e) => e.group)));

export const playEntitlementById = (id: string): PlayEntitlementDef | null =>
  PLAY_ENTITLEMENTS.find((e) => e.id === id) || null;

/** Все коды платформы одним множеством — по нему их отличают от рабочих прав. */
export const PLAY_KEYS = new Set(PLAY_ENTITLEMENTS.map((e) => e.id));

/**
 * Право относится к платформе.
 *
 * Нужно там, где карту прав отдают наружу: строки платформы вырезаются из
 * ответа сотруднику без `app.play` целиком, вместе с ключами.
 */
export const isPlayKey = (id: string): boolean =>
  PLAY_KEYS.has(id) || /^game\..+\.play$/.test(String(id || ''));
