/**
 * Ключ разработчика без лишних слов: создаётся сам при первом входе (в защищённом хранилище ОС), человеку видно только
 * состояние права публиковать — «запрос не отправлен / отправлен / выдано / отказано» — и одна кнопка «Запросить право публиковать».
 * Выдаёт право по-прежнему только владелец.
 */
import { useCallback, useEffect, useState } from 'react';
import { call, type KeyInfo } from '../call';

export type Right = 'unknown' | 'nostorage' | 'damaged' | 'none' | 'requested' | 'issued' | 'revoked' | 'foreign';

/** Слова состояния: «отказано» — отзыв выданного права (отказ на запрос владелец даёт возвратом запроса в очередь) */
export const RIGHT_TEXT: Record<Right, string> = {
  unknown: 'Проверяем право публиковать…',
  nostorage: 'Защищённое хранилище этого компьютера недоступно: ключ не создан. Войдите в Windows своей учётной записью.',
  damaged: 'Файл ключа повреждён. Сохраните копию developer-key.json из каталога данных Studio и обратитесь к владельцу.',
  none: 'Право публиковать не запрошено', requested: 'Запрос отправлен владельцу', issued: 'Право публиковать выдано',
  revoked: 'Право публиковать отозвано владельцем', foreign: 'Ключ выдан другому профилю: обратитесь к владельцу',
};
export const RIGHT_TONE: Record<Right, 'slate' | 'amber' | 'emerald' | 'rose'> = {
  unknown: 'slate', nostorage: 'rose', damaged: 'rose', none: 'amber', requested: 'amber', issued: 'emerald', revoked: 'rose', foreign: 'rose',
};

export function useKey() {
  const [right, setRight] = useState<Right>('unknown');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const info = await call<KeyInfo>('keyEnsure');
      if (info.damaged) { setRight('damaged'); return; }
      if (!info.exists) { setRight(info.available ? 'unknown' : 'nostorage'); return; }
      const cert = await call<{ status: string }>('keyCertificate');
      setRight((['none', 'requested', 'issued', 'revoked', 'foreign'].includes(cert.status) ? cert.status : 'none') as Right);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const request = async () => {
    setBusy(true); setError('');
    try { await call('keyRequestSend'); await refresh(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return { right, error, busy, refresh, request };
}
