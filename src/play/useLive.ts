/**
 * Живая связь раздела с платформой: приветствие, сердцебиение, события.
 *
 * Порядок здесь задан ТЗ и важен целиком:
 *
 *   переавторизоваться → подписаться → получить снимок → применять события.
 *
 * Сначала `play:hello` (сервер заводит запись присутствия и вводит окно в его
 * комнаты) и только потом состояние. Наоборот нельзя: в щель между снимком и
 * подпиской помещаются события, которых окно не увидит никогда, — и человек
 * останется с лобби, где все давно готовы.
 *
 * Событие сокета несёт только «что-то поменялось». Состояние из него не
 * читается: присланному верить не приходится, а порядок доставки не
 * гарантирован никем. Поэтому событие — повод перечитать снимок.
 *
 * Сердцебиение продлевает аренду присутствия. Ответ «нет такой записи» —
 * это не мелочь: он означает, что для сервера нас уже нет, и молчаливо
 * продолжать значило бы показывать ложный онлайн. В этом случае мы честно
 * переходим в «связь восстанавливается» и здороваемся заново.
 */
import React from 'react';
import { useRealTimeSync } from '../components/SocketProvider';
import { usePlayStore } from '../store/playStore';
import { PLAY_LIMITS } from '../../play/contracts';

/** Одно устройство — одно окно программы. Переживает перезагрузку страницы. */
function deviceId(): string {
  const KEY = 'flux_play_device';
  try {
    const was = localStorage.getItem(KEY);
    if (was) return was;
    const made = `d-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    localStorage.setItem(KEY, made);
    return made;
  } catch (_) {
    // Приватный режим: устройство живёт до закрытия окна, и это нормально
    return `d-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export function useLive(enabled: boolean): void {
  const { socket, isConnected } = useRealTimeSync();
  const setLink = usePlayStore((s) => s.setLink);
  const refresh = usePlayStore((s) => s.refresh);
  const applySnapshot = usePlayStore((s) => s.applySnapshot);
  const touch = usePlayStore((s) => s.touch);

  React.useEffect(() => {
    if (!enabled) { setLink('idle'); return; }
    if (!socket || !isConnected) { setLink('reconnecting'); return; }

    let alive = true;
    let beat: ReturnType<typeof setInterval> | null = null;

    const hello = () => {
      socket.emit('play:hello', { deviceId: deviceId() }, (ack: any) => {
        if (!alive) return;
        if (!ack?.ok) { setLink('reconnecting'); return; }
        setLink('live');
        // Снимок ПОСЛЕ приветствия: комнаты уже наши, пропустить нечего
        socket.emit('play:snapshot', {}, (r: any) => {
          if (!alive) return;
          if (r?.ok && r.snapshot) applySnapshot(r.snapshot);
          else void refresh();
        });
      });
    };

    hello();

    beat = setInterval(() => {
      socket.emit('play:heartbeat', {}, (ack: any) => {
        if (!alive) return;
        // Записи больше нет — для сервера нас нет. Здороваемся заново, а не
        // делаем вид, что всё хорошо
        if (!ack?.ok) { setLink('reconnecting'); hello(); return; }
        // Удар прошёл — значит, изменения до нас дошли бы. Показанное свежее,
        // и объявлять его устаревшим только потому, что ничего не случилось,
        // было бы придиркой, а не честностью
        setLink('live');
        touch();
      });
    }, PLAY_LIMITS.heartbeatMs);

    /** Любое событие платформы — повод перечитать состояние целиком. */
    const touched = () => { void refresh(); };
    for (const name of ['play:party', 'play:lobby', 'play:session', 'play:invite']) {
      socket.on(name, touched);
    }

    return () => {
      alive = false;
      if (beat) clearInterval(beat);
      for (const name of ['play:party', 'play:lobby', 'play:session', 'play:invite']) {
        socket.off(name, touched);
      }
    };
  }, [enabled, socket, isConnected, setLink, refresh, applySnapshot, touch]);
}
