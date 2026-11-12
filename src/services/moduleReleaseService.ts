/**
 * Запросы окна Flux к маршрутам программ и мост к главному процессу.
 *
 * Проверку и кэш выпусков ведёт главный процесс (`modules:sync`). Запросы на публикацию, выпуски, сертификаты
 * и подпись владельца перенесены в Studio — Владелец (studio/owner): во Flux их больше нет.
 */
export async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/modules${url}`, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // status отличает отказ сервера по правилам от обрыва связи: первый отменяет действие, второй нет
  if (!res.ok) throw Object.assign(new Error(data?.error || `Запрос не выполнен (${res.status})`), { status: res.status });
  return data as T;
}

export const bridge = () => (window as any).electron?.ipcRenderer as { invoke: (channel: string, ...args: unknown[]) => Promise<any> } | undefined;
