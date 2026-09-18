/**
 * Чем закончилась запись документа.
 *
 * До этого модуля `saveNow` возвращал `void`. Отказ сервера, конфликт версий и
 * успешная запись были снаружи неотличимы, и разбор конфликта после `await`
 * безусловно показывал «Сохранено» — даже когда сервер ответил 500. Человек
 * закрывал единственную оставшуюся копию своей работы, веря сообщению.
 *
 * Поэтому исход стал значением: пять разных исходов, и каждый обязан быть
 * назван. Правила здесь чистые — разбор ответа, текст для человека и решение
 * «можно ли закрывать окно» — и проверяются скриптом; экранам остаётся показ.
 */

/** Чем закончилась попытка записи. */
export type SaveResult =
  /** Записано, сервер подтвердил и назвал новое время правки */
  | { kind: 'saved'; at: string }
  /** Писать было нечего: снимок тот же, что записан в прошлый раз */
  | { kind: 'unchanged'; reason: string }
  /** Документ изменился с тех пор, как его открыли: решает человек */
  | { kind: 'conflict'; who: string; at: string }
  /**
   * Сервер отказался писать поверх, потому что не смог сохранить чужую версию
   * в историю. Это НЕ ошибка сети: продолжать нельзя, но и правка человека цела
   */
  | { kind: 'blocked'; text: string }
  /** Сеть, права, сбой сервера */
  | { kind: 'error'; status: number; text: string };

/** Разобрать ответ сервера. `status = 0` — до сервера не дошли вовсе. */
export function readSaveResponse(status: number, body: any): SaveResult {
  if (status === 0) {
    return { kind: 'error', status: 0, text: 'Нет связи с сервером' };
  }
  if (status >= 200 && status < 300) {
    return { kind: 'saved', at: String(body?.doc?.updatedAt || body?.updatedAt || '') };
  }
  if (status === 409 && body?.conflict) {
    return { kind: 'conflict', who: String(body?.who || ''), at: String(body?.at || '') };
  }
  // Снимок предыдущей версии не удался — сервер не стал писать поверх
  if (status === 503 && body?.snapshotFailed) {
    return {
      kind: 'blocked',
      text: String(body?.error || 'Не удалось сохранить предыдущую версию в историю, поэтому запись поверх отменена'),
    };
  }
  return {
    kind: 'error',
    status,
    text: String(body?.error || `Сервер отказал (${status})`),
  };
}

/** Записано ли на самом деле. Только по этому показывать успех. */
export const isSaved = (r: SaveResult): r is Extract<SaveResult, { kind: 'saved' }> => r.kind === 'saved';

/**
 * Можно ли закрывать окно после такого исхода.
 *
 * «Нечего писать» — можно: работа уже на сервере. Всё остальное, кроме успеха,
 * означает, что единственная копия правок сейчас на экране, и закрыть окно
 * молча — значит её потерять.
 */
export const canCloseAfter = (r: SaveResult): boolean => r.kind === 'saved' || r.kind === 'unchanged';

/**
 * Что сказать человеку.
 *
 * Пустая строка у «нечего писать» намеренно: сообщать не о чем, и лишний тост
 * при каждом закрытии неизменённого документа только приучает их не читать.
 */
export function saveResultText(r: SaveResult): string {
  switch (r.kind) {
    case 'saved': return 'Сохранено';
    case 'unchanged': return '';
    case 'conflict': return r.who
      ? `Документ изменил(а) ${r.who} — нужно решить, чью правку оставить`
      : 'Документ изменился с тех пор, как вы его открыли';
    case 'blocked': return r.text;
    case 'error': return r.text;
  }
}

/** Тон сообщения — чтобы экраны не решали это каждый по-своему. */
export function saveResultTone(r: SaveResult): 'success' | 'error' | 'info' {
  if (r.kind === 'saved') return 'success';
  if (r.kind === 'unchanged') return 'info';
  return 'error';
}
