/**
 * Запись пунктов справочника из экрана «Справочник»: версия показанного пункта,
 * запрос с ней и разбор отказа по коду.
 *
 * Зачем. Экран держит копию справочника, прочитанную при открытии. Пока человек
 * правил название, коллега мог изменить или удалить тот же пункт, и запись по
 * устаревшей копии молча затёрла бы его работу. Поэтому каждая правка и удаление
 * несут `expectedVersion` — целую `version` пункта, который экран показывал
 * (у DELETE — в строке запроса); создание сверять не с чем. Сервер сверяет версию и
 * отвечает отказом с полем `code` (`VERSION_CONFLICT` с текущей записью `current`,
 * `RECORD_GONE`, `RECORD_OPEN`): экран подменяет пункт свежим, показывает перечень
 * «было → стало», а набранное в поле не трогает — оно нужно для повтора.
 *
 * Тексты отказов приходят от сервера готовыми (словарь `lib/refusalTexts`) и здесь
 * не сочиняются; отказ узнаётся только по `code` и статусу, не по тексту.
 *
 * Модуль без React и браузера: наборы гоняют его с подставным `fetch`.
 */
import { writeVersioned, versionToSend, type WriteResult, type OpenHolder, type OpenRecordInfo } from '../equipment/versionedWrite';
import type { FieldChange } from '../../lib/recordChanges';
import { deleteGoneText } from '../../lib/refusalTexts';
import { dictChanges, type DictNames } from './changeRules';
import type { DictCtx } from './types';

export type DictRefusalKind = 'conflict' | 'gone' | 'open' | 'plain';

export interface DictRefusal {
  kind: DictRefusalKind;
  message: string;
  /** Перечень «было → стало» (может быть пустым: показанное не затронуто) */
  changes?: FieldChange[];
  holders?: OpenHolder[];
  record?: OpenRecordInfo | null;
}

const ITEMS = '/api/dictionaries/items';

/**
 * Версии, которые это окно получило от сервера после собственных записей. Копия
 * справочника на экране обновляется не мгновенно, а вторая правка того же пункта не
 * должна получить конфликт с первой, своей.
 */
const known = new Map<string, number>();
/** Записи одного пункта идут по очереди: вторая, отправленная до ответа на первую, ушла бы со старой версией. */
const queue = new Map<string, Promise<unknown>>();

/** Версия пункта, как её знает это окно: своя запись обгоняет копию на экране. */
export function versionOf(shown: any, id: string): number | undefined {
  const a = versionToSend(shown?.version);
  const b = known.get(id);
  if (a === undefined) return b;
  return b === undefined ? a : Math.max(a, b);
}

function remember(id: string, outcome: WriteResult): void {
  if (outcome.kind === 'ok') {
    const v = versionToSend(outcome.data?.item?.version);
    if (v !== undefined) known.set(id, v);
  } else if (outcome.kind === 'conflict') {
    const v = versionToSend(outcome.current?.version);
    if (v !== undefined) known.set(id, v);
  } else if (outcome.kind === 'gone') {
    known.delete(id);
  }
}

function inTurn(id: string, run: () => Promise<WriteResult>): Promise<WriteResult> {
  const turn = (queue.get(id) || Promise.resolve()).then(run, run);
  queue.set(id, turn);
  return turn;
}

/** Правка пункта. `shown` — пункт, как его видел экран в момент действия (до подмены свежим). */
export function putItem(id: string, shown: any, payload: { code?: string; nameRu?: string; parentId?: string | null }): Promise<WriteResult> {
  return inTurn(id, async () => {
    const outcome = await writeVersioned(`${ITEMS}/${encodeURIComponent(id)}`, 'PUT', payload, versionOf(shown, id));
    remember(id, outcome);
    return outcome;
  });
}

/** Удаление пункта вместе с потомками: версия — в строке запроса (у DELETE тела нет). */
export function deleteItem(id: string, shown: any): Promise<WriteResult> {
  return inTurn(id, async () => {
    const outcome = await writeVersioned(`${ITEMS}/${encodeURIComponent(id)}`, 'DELETE', undefined, versionOf(shown, id));
    if (outcome.kind === 'ok') known.delete(id);
    else remember(id, outcome);
    return outcome;
  });
}

/** Создание пункта в справочнике: сверять нечего; справочника уже нет — отказ `gone` с текстом сервера. */
export function createItem(projectId: string, dictionaryId: string, payload: { code: string; nameRu: string; parentId?: string | null }): Promise<WriteResult> {
  return writeVersioned(`/api/projects/${encodeURIComponent(projectId)}/dictionaries/${encodeURIComponent(dictionaryId)}/items`, 'POST', payload, undefined);
}

/** Отказ → что показать; принятая запись — `null`. `shown` — пункт, какой его видел экран до подмены. */
export function refusalOf(outcome: WriteResult, shown: unknown, names: DictNames, fallback: string): DictRefusal | null {
  switch (outcome.kind) {
    case 'ok':
      // Повторное удаление сервер принимает (200), а человеку надо сказать, что делать было нечего
      return outcome.data?.alreadyGone ? { kind: 'gone', message: deleteGoneText('dictionaryItem') } : null;
    case 'conflict': return { kind: 'conflict', message: outcome.message, changes: dictChanges(shown, outcome.current, names) };
    case 'gone': return { kind: 'gone', message: outcome.message };
    case 'open': return { kind: 'open', message: outcome.message, holders: outcome.holders, record: outcome.record };
    case 'offline': return { kind: 'plain', message: outcome.message };
    default: return { kind: 'plain', message: outcome.message || fallback };
  }
}

/** Нужно ли после отказа перечитать справочники: пункт изменили или удалили (или удалять было нечего) — экран устарел. */
export const needsReread = (o: WriteResult): boolean => o.kind === 'conflict' || o.kind === 'gone' || (o.kind === 'ok' && !!o.data?.alreadyGone);

/** Пункт в справочниках экрана: по идентификатору, во всех справочниках */
export function findItem(dictionaries: any[], id: string): any | undefined {
  for (const d of dictionaries || []) {
    const item = (d?.items || []).find((i: any) => i.id === id);
    if (item) return item;
  }
  return undefined;
}

/** Справочники с подменённым пунктом (запись коллеги из отказа или ответ на свою запись); остальные справочники — те же объекты. */
export function withItem(dictionaries: any[], fresh: any): any[] {
  if (!fresh?.id) return dictionaries;
  return dictionaries.map((d) => (d.items?.some((i: any) => i.id === fresh.id)
    ? { ...d, items: d.items.map((i: any) => (i.id === fresh.id ? { ...i, ...fresh } : i)) }
    : d));
}

export interface SettleOptions {
  /** Где показать объяснённый отказ: правка — над содержимым экрана, удаление и создание — окном */
  mode: 'edit' | 'dialog';
  title: string;
  /** Текст, если сервер своего не прислал (сбой, не отказ) */
  fallback: string;
  names: DictNames;
  /** Перечитать справочники при любом отказе: на экране уже стоит неподтверждённое (порядок, сдвинутый на месте) */
  rereadAlways?: boolean;
}

/**
 * Итог запроса для экрана: принят — подменяет пункт ответом (чтобы следующая правка шла
 * со свежей версией) и возвращает `true`; отказан — подменяет пункт записью из отказа,
 * просит перечитать справочники и показывает отказ, возвращает `false`. Набранное человеком
 * здесь не трогается: сбрасывать его вызывающий вправе только после `true`.
 */
export function settleWrite(outcome: WriteResult, shown: unknown, ctx: DictCtx, o: SettleOptions): boolean {
  const refusal = refusalOf(outcome, shown, o.names, o.fallback);
  if (outcome.kind === 'ok' && !refusal) {
    if (outcome.data?.item) ctx.setDictionaries((prev) => withItem(prev, outcome.data.item));
    return true;
  }
  if (outcome.kind === 'conflict' && outcome.current) ctx.setDictionaries((prev) => withItem(prev, outcome.current));
  if (needsReread(outcome) || o.rereadAlways) void ctx.fetchDictionaries();
  if (refusal) ctx.showRefusal(refusal, o.mode, o.title);
  return false;
}
