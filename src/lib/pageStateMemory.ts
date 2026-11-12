// Без импортов: store.ts вызывает clear при выходе из профиля, и цикла зависимостей быть не должно
/**
 * Состояние страницы хранится в памяти Flux и общее для окон одной программы одного канала выпуска у одного пользователя
 * (так окна программы видят одно и то же); на диск не пишется и пропадает при выходе из профиля и закрытии Flux.
 */
const states = new Map<string, Record<string, unknown>>();
export const pageStateKey = (userId: string, moduleId: string, channel: string) => `${userId}\u0000${moduleId}\u0000${channel}`;
export const pageState = {
  load: (key: string): Record<string, unknown> => states.get(key) ?? {},
  keep: (key: string, state: Record<string, unknown>) => { states.set(key, state); },
  /** Вызывается при выходе из профиля и смене пользователя: чужое состояние не должно достаться следующему */
  clear: () => { states.clear(); },
};
