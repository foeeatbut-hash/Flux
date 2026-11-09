/**
 * Политика администратора: какие подключения запрещены роли этого человека. Сервер
 * хранит и проверяет правила, окно передаёт их главному процессу, где они сильнее
 * выбора человека. Политика только запрещает, поэтому подмена окном доступ не расширяет.
 */
import { bridge, call } from './moduleReleaseService';

export async function syncConnectionPolicy(): Promise<void> {
  const ipc = bridge();
  if (!ipc) return;
  try {
    const policy = await call<{ denied: Array<{ moduleId: string; connection: string }> }>('GET', '/connection-policy');
    await ipc.invoke('modules:policy', { denied: policy.denied });
  } catch { /* без связи действует то, что главный процесс получил в прошлый раз */ }
}
