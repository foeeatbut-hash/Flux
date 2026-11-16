/**
 * Что предпросмотр импорта оборудования видел в базе (docs/roadmap/offline-work.md,
 * решения владельца 15 ноября 2026, п. 3 и п. 7; общий договор — server/planGuard.ts).
 *
 * План читает позиции проекта и собирается их менять, заменять или снимать. Он
 * кладёт в ответ `seen` — версии этих позиций — и `seenRows`: поля, которые видит
 * человек, как они были при чтении. Запись присылает `seen` обратно и сверяется в
 * той же транзакции; при расхождении экран сравнивает `seenRows` с записью из
 * отказа и показывает «поле: было → стало». Версию нельзя вывести из показанного
 * самим экраном: ему нужны ровно те значения, которые читал план.
 */

/** Поля позиции, которые читают правила перечня (src/components/equipment/changeRules.ts). Тегов нет: отказ их не несёт. */
export interface ShownRow {
  name: string;
  itemCode: string;
  status: string;
  equipClass: string | null;
  equipKind: string | null;
  instanceNo: number | null;
  instanceCount: number | null;
  specs: string | null;
  overrides: string | null;
}

export const shownRowOf = (row: any): ShownRow => ({
  name: String(row?.name ?? ''),
  itemCode: String(row?.itemCode ?? ''),
  status: String(row?.status ?? ''),
  equipClass: row?.equipClass ?? null,
  equipKind: row?.equipKind ?? null,
  instanceNo: row?.instanceNo ?? null,
  instanceCount: row?.instanceCount ?? null,
  specs: row?.specs ?? null,
  overrides: row?.overrides ?? null,
});

/** Накопитель версий плана: каждая позиция записывается один раз, как её увидели первой. */
export class SeenCollector {
  readonly seen: Record<string, number> = {};
  readonly seenRows: Record<string, ShownRow> = {};

  add(row: any): void {
    const id = row?.id ? String(row.id) : '';
    if (!id || id in this.seen) return;
    this.seen[id] = Number(row.version || 1);
    this.seenRows[id] = shownRowOf(row);
  }
}
