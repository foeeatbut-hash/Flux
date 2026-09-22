/**
 * Один запрос: «что мне сейчас можно».
 *
 * Права раньше приезжали единственный раз — в ответе на вход, — и снятое право
 * продолжало действовать до перезапуска программы. Для рабочих прав это
 * переживаемо, для доступа к встроенным программам нет: его выдают и отбирают
 * точечно, и отобранный обязан исчезнуть сразу.
 *
 * Поэтому у профиля появился свой лёгкий запрос. Он не отдаёт ни списка
 * сотрудников, ни чужих прав — только свой доступ и состояние платформы, и
 * коды платформы вырезаются на сервере, если доступа к ней нет.
 */
import { ENV_CONFIG, getAuthToken } from '../config/env';
import type { PolicyBootstrap } from '../store/policyStore';

const authHeaders = (): Record<string, string> => {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export async function fetchPolicyBootstrap(): Promise<PolicyBootstrap> {
  const res = await fetch(`${ENV_CONFIG.apiUrl}/me/bootstrap`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
  const data = await res.json();
  return data && typeof data === 'object' ? data : {};
}
