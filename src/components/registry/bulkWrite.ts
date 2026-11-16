/**
 * Массовая запись из «Закупок» (этап всем выбранным, назначение шаблона): версии
 * записей, «всё или ничего» и показ того, что изменили коллеги.
 *
 * Экран отправляет `bulk-metadata`, в каждой записи — версия тега, которую он видел.
 * Хоть один тег изменён или удалён — сервер не записал ничего и прислал `changed` /
 * `gone`: человек видит перечень по записям, экран перечитывает данные, повтор — по
 * новым данным и новым решением человека. Без React: наборы гоняют это с подставным fetch.
 */
import type { Dispatch, SetStateAction } from 'react';
import { bulkMetadataRequest, rememberVersions } from './tagWrite';
import { bulkRefusalOf, type TagRefusal } from './tagRefusal';
import type { TagNames } from './changeRules';

export interface BulkDeps {
  setTags: Dispatch<SetStateAction<any[]>>;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** Показать отказ окном с перечнем по записям */
  showRefusal: (title: string, refusal: TagRefusal) => void;
  names: TagNames;
  /** Перечитать данные: после отказа и сбоя экран показывает чужое, а не свои ожидания */
  reload: () => void;
}

/**
 * Записать пачку. `shown` — теги, какими их видел экран ДО локального обновления.
 * Возвращает, записано ли всё; при отказе ничего не записано.
 */
export async function runBulkWrite(
  updates: Array<{ id: string; metadata: unknown }>, shown: Map<string, any>, extra: Record<string, unknown>,
  deps: BulkDeps, failText: string,
): Promise<boolean> {
  const outcome = await bulkMetadataRequest(updates, shown, extra);
  if (outcome.kind === 'ok') {
    rememberVersions(outcome.data?.versions, deps.setTags);
    return true;
  }
  if (outcome.kind === 'conflict') {
    deps.showRefusal('Изменения не записаны', bulkRefusalOf(outcome.data, shown, deps.names));
  } else {
    deps.addToast(failText, 'error');
  }
  deps.reload();
  return false;
}

/**
 * Записать раскладку (только x, y) пачкой. Версию тега раскладка не сверяет, но
 * удалённый тег режет всю пачку (`gone`): убираем такие из пачки и повторяем, чтобы
 * остальные места записались; сколько тегов оказалось удалено — в `gone`.
 */
export async function writeLayoutBatch(
  updates: Array<{ id: string; metadata: unknown }>, setTags: Dispatch<SetStateAction<any[]>>,
): Promise<{ ok: boolean; gone: number }> {
  let rest = updates;
  let gone = 0;
  for (let attempt = 0; attempt < 2 && rest.length; attempt++) {
    const res = await bulkMetadataRequest(rest, new Map());
    if (res.kind === 'ok') { rememberVersions(res.data?.versions, setTags); return { ok: true, gone }; }
    const ids = new Set<string>(res.kind === 'conflict' && Array.isArray(res.data?.gone) ? res.data.gone.map(String) : []);
    if (!ids.size) return { ok: false, gone };
    gone += ids.size;
    rest = rest.filter((u) => !ids.has(u.id));
  }
  return { ok: rest.length === 0, gone };
}
