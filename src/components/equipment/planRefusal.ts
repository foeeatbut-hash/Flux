/**
 * Отказ записи по предпросмотру оборудования: «позиции изменили, пока вы смотрели».
 *
 * Импорт расчёта, ввоз распознанного документа, отмена импорта и решения по XML-ревизии
 * пишут по тому, что человек видел в предпросмотре. Запись присылает `seen` — целые версии
 * позиций, которые предпросмотр читал, а сервер сверяет их в транзакции до первой записи
 * (`server/planGuard.ts`) и при расхождении отвечает 409 `VERSION_CONFLICT` с перечнем
 * `changed: [{ id, current }]` и `gone: [id]`; не записано ничего.
 *
 * Здесь — что экран делает с таким отказом: перечень «поле: было → стало» по позициям
 * (правила полей — `changeRules.ts`, показ — общий `ConflictNotice`). «Было» — поля позиции,
 * как их прочитал сервер при построении предпросмотра (`seenRows`): экран сам их не хранит.
 * Без React и без сети: наборы гоняют это на голых объектах.
 */
import type { ConflictGroup } from '../ui/ConflictNotice';
import type { FieldChange } from '../../lib/recordChanges';
import { conflictOf } from './versionedWrite';
import { equipmentChanges, specRows } from './changeRules';

export interface PlanRefusal {
  /** Текст отказа — готовым от сервера */
  message: string;
  /** Перечень по позициям */
  groups: ConflictGroup[];
}

/** Сведения о позиции, как их читал предпросмотр, и название для перечня. */
export interface PlanShown {
  /** Поля позиции на момент чтения (`seenRows` ответа) */
  rows: Record<string, any>;
  /** Название позиции для заголовка группы: «Установка · Блок»; нет — берётся из записи */
  titleOf: (id: string, record: any) => string;
}

/** Отказ записи — «версии устарели»: ровно по коду и по наличию перечня, а не по тексту. */
export function planConflictOf(status: number, body: any): boolean {
  return !!conflictOf(status, body) && (Array.isArray(body?.changed) || Array.isArray(body?.gone));
}

/** Версии для запроса: только позиции, которых коснётся запись (снятые с выбора блоки не сверяются). */
export function pickSeen(seen: Record<string, number> | undefined, ids: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const v = seen?.[id];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) out[id] = v;
  }
  return out;
}

/** Нет различий в показанных полях, а версия выросла: правили то, чего перечень не показывает. */
const OTHER_DETAILS: FieldChange = { label: 'Другие сведения', was: 'как в предпросмотре', now: 'изменены' };

/** Перечень по позициям: изменённая — «было → стало», удалённая — «есть → удалена». */
export function planRefusalOf(data: any, shown: PlanShown): PlanRefusal {
  const groups: ConflictGroup[] = [];
  for (const c of Array.isArray(data?.changed) ? data.changed : []) {
    if (!c || typeof c !== 'object') continue;
    const id = String(c.id ?? c.current?.id ?? '');
    const before = shown.rows[id];
    const changes = before ? equipmentChanges('component', before, c.current) : [{ label: 'Позиция', was: 'не было', now: 'появилась после предпросмотра' }];
    groups.push({ title: shown.titleOf(id, before || c.current), changes: changes.length ? changes : [OTHER_DETAILS] });
  }
  for (const id of Array.isArray(data?.gone) ? data.gone : []) {
    groups.push({ title: shown.titleOf(String(id), shown.rows[String(id)]), changes: [{ label: 'Позиция', was: 'есть', now: 'удалена' }] });
  }
  return { message: String(data?.error || 'Позиции изменили, пока вы смотрели. Ничего не записано.'), groups };
}

/** Название позиции по её записи: «Название (обозначение)»; нет ни того ни другого — идентификатор. */
export const recordTitle = (id: string, record: any): string => {
  const name = String(record?.name ?? '').trim();
  const code = String(record?.itemCode ?? '').trim();
  return name && code && name !== code ? `${name} (${code})` : name || code || id;
};

/** Строка сравнения XML, как её видел экран: какая характеристика какой позиции и что было «текущим». */
export interface XmlShownChange {
  targetId?: string;
  targetLabel?: string;
  group: string;
  key: string;
  current?: { value: unknown; unit?: string };
}

const unitText = (v?: { value: unknown; unit?: string }) => (v ? [String(v.value ?? ''), v.unit ?? ''].map((x) => x.trim()).filter(Boolean).join(' ') : '');

/**
 * Отказ решения по XML-ревизии: экран показывал не позиции целиком, а строки сравнения, поэтому
 * сравниваются только они — характеристика за характеристикой, как их видел человек («текущее»), с тем,
 * что в позиции сейчас, и название позиции. Правка того, чего перечень не показывает, — «Другие сведения».
 */
export function xmlPlanRefusalOf(data: any, shown: readonly XmlShownChange[]): PlanRefusal {
  const groups: ConflictGroup[] = [];
  const labelOf = (id: string) => shown.find((c) => c.targetId === id && c.targetLabel)?.targetLabel;
  for (const c of Array.isArray(data?.changed) ? data.changed : []) {
    if (!c || typeof c !== 'object') continue;
    const id = String(c.id ?? c.current?.id ?? '');
    const live = new Map(specRows(c.current).map((r) => [r.label, String(r.value ?? '')]));
    const changes: FieldChange[] = [];
    const title = labelOf(id);
    if (title && c.current?.name && String(c.current.name) !== title) changes.push({ label: 'Название', was: title, now: String(c.current.name) });
    for (const row of shown.filter((x) => (x.targetId || id) === id)) {
      const label = `${row.group} · ${row.key}`;
      const was = unitText(row.current);
      const now = live.get(label);
      if (now !== undefined && now !== was) changes.push({ label, was: was || '—', now: now || '—' });
      else if (now === undefined) changes.push({ label, was: was || '—', now: 'нет' });
    }
    groups.push({ title: title || recordTitle(id, c.current), changes: changes.length ? changes : [OTHER_DETAILS] });
  }
  for (const id of Array.isArray(data?.gone) ? data.gone : []) {
    groups.push({ title: labelOf(String(id)) || String(id), changes: [{ label: 'Позиция', was: 'есть', now: 'удалена' }] });
  }
  return { message: String(data?.error || 'Позиции изменили, пока вы смотрели. Ничего не записано.'), groups };
}
