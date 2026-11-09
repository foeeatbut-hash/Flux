/**
 * Смена своего пароля: прямой запрос к серверу, мимо dataService.
 *
 * dataService.request при любой ошибке (в том числе при 403 «неверный текущий
 * пароль») переключается на локальную автономную базу и отвечает успехом.
 * Для смены пароля это недопустимо: человек увидел бы «пароль изменён», когда
 * сервер его не менял. Поэтому здесь отказ сервера остаётся отказом.
 */
import { ENV_CONFIG } from '../config/env';

/** Исключение с русским текстом причины — его показывает форма */
export class PasswordChangeError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function changeOwnPassword(userId: string, currentPassword: string, password: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${ENV_CONFIG.apiUrl}/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, currentPassword }),
    });
  } catch {
    throw new PasswordChangeError('Нет связи с сервером. Пароль не изменён, повторите позже.', 0);
  }
  if (response.ok) return;
  const body: any = await response.json().catch(() => ({}));
  const said = String(body?.message || body?.error || '');
  throw new PasswordChangeError(said || `Сервер отказал в смене пароля (код ${response.status}).`, response.status);
}
