import { randomUUID } from 'node:crypto';

/**
 * Непрозрачные идентификаторы для того, что Windows отдаёт main'у, а renderer
 * видеть не должен: элементы корзины, программы «Открыть с помощью», сеансы
 * классического меню. Renderer получает случайную строку и может вернуть только
 * её; настоящее значение (разбираемое имя Shell, путь) остаётся в main.
 *
 * Хранилище привязано к окну (owner) и к виду списка (scope): чужое окно не
 * может погасить или подставить идентификатор другого, а новый снимок списка
 * заменяет прежний целиком, так что устаревший id не оживает после обновления.
 */
export class OpaqueIds<T> {
  private scopes = new Map<string, { at: number; values: Map<string, T> }>();
  constructor(private ttlMs = 10 * 60_000, private limit = 20_000, private now: () => number = Date.now) {}
  private key(owner: number, scope: string) { return `${owner}:${scope}`; }
  /** Заменяет прежний снимок области и возвращает id по порядку значений. */
  replace(owner: number, scope: string, values: T[]): string[] {
    if (values.length > this.limit) throw new RangeError('Слишком много элементов для выдачи идентификаторов.');
    const map = new Map<string, T>(); const ids: string[] = [];
    for (const value of values) { const id = randomUUID(); map.set(id, value); ids.push(id); }
    this.scopes.set(this.key(owner, scope), { at: this.now(), values: map });
    return ids;
  }
  /** Выдаёт один id, не трогая остальные в области — для сеансов меню. */
  add(owner: number, scope: string, value: T): string {
    const key = this.key(owner, scope);
    let entry = this.scopes.get(key);
    if (!entry || this.now() - entry.at > this.ttlMs) { entry = { at: this.now(), values: new Map() }; this.scopes.set(key, entry); }
    if (entry.values.size >= 64) entry.values.delete(entry.values.keys().next().value!);
    const id = randomUUID(); entry.values.set(id, value); entry.at = this.now(); return id;
  }
  get(owner: number, scope: string, id: unknown): T | undefined {
    if (typeof id !== 'string' || id.length > 64) return undefined;
    const entry = this.scopes.get(this.key(owner, scope));
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) { this.scopes.delete(this.key(owner, scope)); return undefined; }
    return entry.values.get(id);
  }
  delete(owner: number, scope: string, id: string) { this.scopes.get(this.key(owner, scope))?.values.delete(id); }
  closeOwner(owner: number) { for (const key of [...this.scopes.keys()]) if (key.startsWith(`${owner}:`)) this.scopes.delete(key); }
}
