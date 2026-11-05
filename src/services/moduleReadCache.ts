// Одна общая карта на профиль/API: окна и разные контексты делят GET,
// но новый сеанс никогда не использует ответы предыдущего пользователя.
let scope = '';
let requests = new Map<string, Promise<any>>();
export function invalidateModuleReads() { requests = new Map(); }
export function sharedModuleReads(nextScope: string, load: (path: string) => Promise<any>) {
  if (scope !== nextScope) { scope = nextScope; invalidateModuleReads(); }
  const snapshot = requests;
  return (path: string) => {
    if (!snapshot.has(path)) {
      if (snapshot.size >= 128) snapshot.delete(snapshot.keys().next().value!);
      const request = load(path);
      snapshot.set(path, request);
      // Ошибка не отравляет все окна до следующего события. В одном цикле
      // её всё равно удержит локальная карта, без повторного шторма запросов.
      void request.catch(() => { if (snapshot.get(path) === request) snapshot.delete(path); });
    }
    return snapshot.get(path)!;
  };
}
