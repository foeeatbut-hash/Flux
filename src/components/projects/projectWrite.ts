/**
 * Запись проекта из экрана «Проекты»: отказ сервера → то, что покажет экран.
 *
 * `dataService.updateProject` и `deleteProject` шлют версию, которую экран показывал,
 * а отказ сервера отдают как `WriteRefusal` со статусом и телом целиком. Здесь он
 * разбирается ровно по полю `code` (общий разбор — `components/equipment/versionedWrite`,
 * словарь кодов и текстов — `lib/refusalTexts`): `VERSION_CONFLICT` — проект изменили,
 * `RECORD_GONE` — его уже удалили, `RECORD_OPEN` — проект или что-то в нём открыто у
 * коллеги. Текст приходит от сервера готовым; клиент добавляет только перечень
 * «было → стало», сравнивая показанную запись с `current` из отказа.
 *
 * Без React и без сети: наборы гоняют это на голых объектах.
 */
import { conflictOf, goneOf, openOf, failureText, type WriteResult } from '../equipment/versionedWrite';
import { plainRefusal, type Refusal } from '../equipment/conflictView';
import type { ProjectDraft } from '../ProjectFields';
import { projectChanges } from './changeRules';

/** Статус и тело отказа → исход записи (тот же вид, что у `writeVersioned`). */
export function resultOfRefusal(status: number, body: any, fallback: string): WriteResult {
  const conflict = conflictOf(status, body);
  if (conflict) return { kind: 'conflict', ...conflict, data: body };
  const gone = goneOf(status, body);
  if (gone) return { kind: 'gone', ...gone, data: body };
  const open = openOf(status, body);
  if (open) return { kind: 'open', ...open, data: body };
  return { kind: 'refused', status, message: String(body?.error || body?.message || fallback), data: body };
}

/** Выполнить запись и вернуть исход, не бросая: отказ сервера и сбой приходят результатом. */
export async function runWrite(write: () => Promise<any>, fallback: string): Promise<WriteResult> {
  try {
    return { kind: 'ok', data: await write() };
  } catch (err: any) {
    // Узнаём по имени, а не по классу: модуль остаётся чистым и не тянет за собой весь dataService
    if (err?.name === 'WriteRefusal' && typeof err.status === 'number') return resultOfRefusal(err.status, err.body, fallback);
    return { kind: 'refused', status: 0, message: String(err?.message || fallback), data: {} };
  }
}

/** Исход записи → что показать; принятая запись — `null`. `shown` — проект, какой его видел экран в момент действия (взять ДО перечитывания списка). */
export function projectRefusalOf(result: WriteResult, shown: unknown, fallback: string): Refusal | null {
  switch (result.kind) {
    case 'ok': return null;
    case 'conflict': return { kind: 'conflict', message: result.message, changes: projectChanges(shown, result.current) };
    case 'gone': return { kind: 'gone', message: result.message };
    case 'open': return { kind: 'open', message: result.message };
    default: return plainRefusal(failureText(result, fallback));
  }
}

/** Нужно ли после отказа перечитать список: проект изменили или удалили — экран устарел; чужая занятость и сбой его не меняют. */
export const needsReread = (result: WriteResult): boolean => result.kind === 'conflict' || result.kind === 'gone';

/**
 * Набранное в карточке после отказа по версии: свои правки остаются, нетронутые поля берутся у коллеги.
 *
 * Зачем. Повторное «Сохранить» шлёт карточку целиком. Если оставить в нетронутых полях то, что экран
 * показывал раньше, повтор молча вернул бы прежние значения поверх правки коллеги, хотя человек её даже
 * не трогал. Поле, которое человек менял, остаётся как набрано (в перечне над формой видно, что коллега
 * тоже менял его, — решает человек); остальные обновляются до текущей записи.
 */
export function mergeDraft(shown: ProjectDraft, typed: ProjectDraft, current: ProjectDraft): ProjectDraft {
  const out = { ...typed };
  for (const key of Object.keys(typed) as Array<keyof ProjectDraft>) {
    if (typed[key].trim() === shown[key].trim()) out[key] = current[key];
  }
  return out;
}
