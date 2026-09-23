/**
 * Таблицы платформы и правила, которые держит база, а не код.
 *
 * Автомиграция (`server/schema-sync.ts`) читает схему Prisma и создаёт таблицы
 * и колонки, но **не создаёт индексов**. Для большинства разделов это стоило бы
 * лишь скорости, здесь — правильности: на индексах держатся все инварианты
 * платформы, и держатся они там намеренно.
 *
 * Почему не проверкой в коде. Сервер у каждого сотрудника свой, а база одна.
 * Двое нажали «Начать матч» в одну и ту же секунду — и проверка «а нет ли уже
 * незавершённого» ответит «нет» обоим: каждый читал ДО того, как записал
 * другой. Матча станет два, половина группы уйдёт не туда, и разбираться с
 * этим будет некому. База отвечает на такой вопрос одна и один раз.
 *
 * Частичный индекс, а не обычный UNIQUE. «Одна активная группа на человека»
 * значит «одна ОДНОВРЕМЕННО». Обычный UNIQUE по `userId` запретил бы человеку
 * вторую группу навсегда — то есть вторую игру в жизни. Условие
 * `leftAt IS NULL` ограничивает уникальность живой частью таблицы.
 *
 * В MariaDB частичного индекса нет. Вместо него DDL создаёт вычисляемые
 * колонки и уникальный индекс по ним: у закрытых записей значение NULL.
 *
 * Расхождение с Prisma-схемой ловит `scripts/test-play-ddl.ts`: два списка без
 * проверки разъезжаются за пару выпусков.
 */

import { ensureTables, type Col, type TableSpec } from '../ddl.js';
import { getPrisma, onDatabaseSwapped } from '../context.js';

const id = (): Col => ({ name: 'id', kind: 'text', pk: true, indexed: true });
const key = (name: string): Col => ({ name, kind: 'text', notNull: true, indexed: true });
const opt = (name: string): Col => ({ name, kind: 'text', indexed: true });
const text = (name: string, def = ''): Col => ({ name, kind: 'longtext', def });
const int = (name: string, def = 0): Col => ({ name, kind: 'int', notNull: true, def });
const bool = (name: string, def = false): Col => ({ name, kind: 'bool', notNull: true, def });
const at = (name: string): Col => ({ name, kind: 'time', notNull: true, def: 'now' });
const when = (name: string): Col => ({ name, kind: 'time' });

/** Живая запись: та, из которой ещё не вышли. */
const ALIVE = '"leftAt" IS NULL';

export const PLAY_TABLES: TableSpec[] = [
  {
    table: 'PlayCommand',
    cols: [
      id(), key('actorId'), key('key'), key('requestHash'), key('kind'),
      key('status'), text('resultJson', '{}'), opt('errorCode'), at('createdAt'), at('expiresAt'),
    ],
    indexes: [
      // На этом индексе держится «повтор не делает действие дважды»
      { name: 'PlayCommand_actor_key', cols: ['actorId', 'key'], unique: true },
      { name: 'PlayCommand_expires_idx', cols: ['expiresAt'] },
    ],
  },
  {
    table: 'PlayEvent',
    cols: [
      id(), key('aggregate'), key('aggregateId'),
      { name: 'version', kind: 'int', notNull: true, def: 0, indexed: true },
      key('kind'), text('dataJson', '{}'), at('createdAt'),
    ],
    indexes: [
      // Одно событие на версию: история без пропусков и без двойников, иначе
      // клиент после обрыва досчитается не до того состояния
      { name: 'PlayEvent_version_key', cols: ['aggregate', 'aggregateId', 'version'], unique: true },
      { name: 'PlayEvent_stream_idx', cols: ['aggregate', 'aggregateId', 'createdAt'] },
    ],
  },
  {
    table: 'PlayOutbox',
    cols: [
      id(), key('dedupeKey'), key('recipientId'), key('kind'), text('payloadJson', '{}'),
      key('state'), int('attempt'), at('availableAt'), when('leaseUntil'), opt('leaseOwner'), at('createdAt'),
    ],
    indexes: [
      { name: 'PlayOutbox_dedupe_key', cols: ['dedupeKey'], unique: true },
      { name: 'PlayOutbox_queue_idx', cols: ['state', 'availableAt'] },
      { name: 'PlayOutbox_recipient_idx', cols: ['recipientId'] },
    ],
  },
  {
    table: 'PlayPresence',
    cols: [
      id(), key('userId'), key('deviceId'), key('connectionId'),
      { name: 'generation', kind: 'int', notNull: true, def: 0, indexed: true },
      key('status'), key('activity'), opt('gameId'),
      at('expiresAt'), at('createdAt'), at('updatedAt'),
    ],
    indexes: [
      { name: 'PlayPresence_connection_key', cols: ['connectionId'], unique: true },
      { name: 'PlayPresence_user_idx', cols: ['userId', 'expiresAt'] },
      // По нему выметаются протухшие аренды: без индекса каждый проход читал
      // бы таблицу целиком
      { name: 'PlayPresence_expires_idx', cols: ['expiresAt'] },
    ],
  },
  {
    table: 'PlayParty',
    cols: [
      id(), key('leaderId'), opt('gameId'), key('state'), int('revision', 1),
      at('createdAt'), at('updatedAt'), when('closedAt'),
    ],
    indexes: [
      { name: 'PlayParty_leader_idx', cols: ['leaderId', 'state'] },
      { name: 'PlayParty_state_idx', cols: ['state', 'updatedAt'] },
    ],
  },
  {
    table: 'PlayPartyMember',
    cols: [id(), key('partyId'), key('userId'), key('role'), at('joinedAt'), when('leftAt')],
    indexes: [
      // «Человек одновременно в одной группе». Условие обязательно: без него
      // второй группы у человека не было бы никогда
      { name: 'PlayPartyMember_one_active_key', cols: ['userId'], unique: true, where: ALIVE },
      // И в одну группу он входит один раз, а не дважды
      { name: 'PlayPartyMember_pair_key', cols: ['partyId', 'userId'], unique: true, where: ALIVE },
      { name: 'PlayPartyMember_party_idx', cols: ['partyId', 'leftAt'] },
      { name: 'PlayPartyMember_user_idx', cols: ['userId', 'leftAt'] },
    ],
  },
  {
    table: 'PlayInvite',
    cols: [
      id(), key('partyId'), key('fromUserId'), key('toUserId'), key('state'),
      opt('clientRequestId'), at('expiresAt'), at('createdAt'), when('respondedAt'),
    ],
    indexes: [
      // Одно живое приглашение на пару: двойное нажатие не шлёт второго
      { name: 'PlayInvite_pending_key', cols: ['partyId', 'toUserId'], unique: true, where: `"state" = 'PENDING'` },
      { name: 'PlayInvite_inbox_idx', cols: ['toUserId', 'state'] },
      { name: 'PlayInvite_party_idx', cols: ['partyId', 'state'] },
      { name: 'PlayInvite_expiry_idx', cols: ['state', 'expiresAt'] },
    ],
  },
  {
    table: 'PlayLobby',
    cols: [id(), key('partyId'), key('gameId'), key('state'), int('revision', 1), at('createdAt'), at('updatedAt')],
    indexes: [
      // Одно живое лобби на группу
      {
        name: 'PlayLobby_active_key',
        cols: ['partyId'],
        unique: true,
        where: `"state" IN ('FORMING','READY','STARTED')`,
      },
      { name: 'PlayLobby_party_idx', cols: ['partyId', 'state'] },
      { name: 'PlayLobby_state_idx', cols: ['state', 'updatedAt'] },
    ],
  },
  {
    table: 'PlayLobbySlot',
    cols: [id(), key('lobbyId'), key('userId'), int('team', 1), bool('ready'), at('updatedAt')],
    indexes: [
      { name: 'PlayLobbySlot_pair_key', cols: ['lobbyId', 'userId'], unique: true },
      { name: 'PlayLobbySlot_team_idx', cols: ['lobbyId', 'team'] },
    ],
  },
  {
    table: 'PlaySession',
    cols: [
      id(), key('lobbyId'), key('gameId'), key('state'),
      { name: 'serverAddr', kind: 'text', notNull: true, def: '' },
      int('revision', 1), at('createdAt'), when('startedAt'), when('finishedAt'),
    ],
    indexes: [
      // Один незавершённый матч на лобби: повторное «Начать» не заводит второй
      {
        name: 'PlaySession_active_key',
        cols: ['lobbyId'],
        unique: true,
        where: `"state" IN ('ALLOCATING','RUNNING')`,
      },
      { name: 'PlaySession_lobby_idx', cols: ['lobbyId', 'state'] },
      { name: 'PlaySession_state_idx', cols: ['state', 'createdAt'] },
    ],
  },
  {
    table: 'PlaySessionMember',
    cols: [id(), key('sessionId'), key('userId'), int('team', 1), key('state'), at('joinedAt')],
    indexes: [
      { name: 'PlaySessionMember_pair_key', cols: ['sessionId', 'userId'], unique: true },
      // Человек одновременно не более чем в одном незавершённом матче
      {
        name: 'PlaySessionMember_one_active_key',
        cols: ['userId'],
        unique: true,
        where: `"state" = 'ACTIVE'`,
      },
      { name: 'PlaySessionMember_user_idx', cols: ['userId', 'state'] },
    ],
  },
  {
    table: 'PlayTicket',
    cols: [id(), key('sessionId'), key('userId'), key('tokenHash'), at('issuedAt'), at('expiresAt'), when('usedAt')],
    indexes: [
      { name: 'PlayTicket_token_key', cols: ['tokenHash'], unique: true },
      { name: 'PlayTicket_pair_key', cols: ['sessionId', 'userId'], unique: true },
      { name: 'PlayTicket_expiry_idx', cols: ['expiresAt'] },
    ],
  },
  {
    table: 'PlayResult',
    cols: [
      id(), key('sessionId'), text('payloadJson', '{}'),
      { name: 'signature', kind: 'text', notNull: true, def: '' },
      at('createdAt'),
    ],
    indexes: [
      // Один результат на матч: повтор доставки не удваивает счёт
      { name: 'PlayResult_session_key', cols: ['sessionId'], unique: true },
    ],
  },
  {
    table: 'PlayMatch',
    cols: [
      id(), key('sessionId'), key('gameId'),
      { name: 'seed', kind: 'text', notNull: true, def: '' },
      text('seatsJson', '[]'), text('stateJson', '{}'),
      int('revision', 1), opt('resignedBy'), at('createdAt'), at('updatedAt'),
    ],
    indexes: [
      // Одна доска на матч. Вторая означала бы, что партию начали заново
      // поверх сделанных ходов, и заметил бы это только тот, кто ходил
      { name: 'PlayMatch_session_key', cols: ['sessionId'], unique: true },
      { name: 'PlayMatch_gameId_idx', cols: ['gameId'] },
    ],
  },
  {
    table: 'PlayBuild',
    cols: [
      id(), key('gameId'), key('channel'), key('version'),
      { name: 'url', kind: 'text', notNull: true, def: '' },
      key('sha256'), int('sizeBytes'), text('manifestJson', '{}'),
      opt('publishedById'), at('publishedAt'),
    ],
    indexes: [
      { name: 'PlayBuild_version_key', cols: ['gameId', 'channel', 'version'], unique: true },
      { name: 'PlayBuild_channel_idx', cols: ['gameId', 'channel', 'publishedAt'] },
    ],
  },
];

let ready = false;

/**
 * Один раз за жизнь клиента базы убедиться, что таблицы на месте.
 *
 * Проба идёт по настоящей колонке, а не по существованию таблицы: таблица,
 * созданная прошлой версией программы, бывает неполной, и «она есть» тогда
 * значит «дальше упадёт вставка».
 */
export async function ensurePlayTables(prisma: any, log?: (m: string) => void): Promise<string> {
  if (ready) return '';
  // Проба двух таблиц недостаточна: они могли быть созданы автомиграцией без
  // индексов. Здесь уникальные ограничения — часть корректности игры.
  const failure = await ensureTables(prisma, PLAY_TABLES, log, true);
  if (!failure) ready = true;
  return failure;
}

/**
 * То же, но клиент базы берётся сам.
 *
 * Зовётся из двух мест — заслона HTTP и приветствия сокета, — потому что
 * входов в платформу тоже два, и первым может оказаться любой. После первого
 * успеха проверка ничего не стоит.
 */
export async function ensurePlayReady(log?: (m: string) => void): Promise<string> {
  const prisma = getPrisma();
  if (!prisma) return 'База недоступна';
  return ensurePlayTables(prisma, log);
}

/** Смена базы: у новой свои таблицы, и проверять их надо заново. */
export function resetPlayTables(): void {
  ready = false;
}

onDatabaseSwapped(resetPlayTables);
