/**
 * «Надёжное время»: срок действия профиля проверяется не по одним часам машины.
 *
 * Локальные часы легко перевести назад, поэтому берётся максимум из локальных
 * часов, монотонного якоря (самое позднее замеченное время; лежит в скрытом
 * файле машины и в общей базе) и сетевого времени. Якорь только растёт: часы,
 * отставшие от него больше чем на 6 часов, считаются переведёнными назад.
 *
 * Зачем отдельный модуль: правила якоря проверяются без поднятого сервера
 * (scripts/test-trusted-time.ts), а в server.ts им было тесно.
 *
 * ЧЕГО НЕЛЬЗЯ ДЕЛАТЬ с якорем в общей базе. Часы клиента — не источник истины:
 * одна машина с часами «вперёд» раньше записывала свой якорь в общую базу, и у
 * всех сотрудников со сроком профиль объявлялся «истёкшим» или «часы переведены
 * назад», а сбросить это было нечем, кроме правки базы вручную. Поэтому, когда
 * у базы есть собственные часы (PostgreSQL, MariaDB — сервер компании), якорь
 * принимается и записывается, только если он не дальше «времени базы + запас».
 * У локальной SQLite часы базы — те же часы машины, подтвердить ими нечего:
 * там остаётся прежнее правило, а выручает сброс якоря владельцем.
 */
import fs from 'node:fs';
import https from 'node:https';
import type { Express, Request, Response } from 'express';
import { requireOwnerMiddleware } from './accessPolicy.js';

/** Допуск на смену пояса и дрейф: меньшее расхождение с якорем перевода часов не означает */
const BACK_TOLERANCE_MS = 6 * 3600_000;
/** Насколько часы машины могут опережать время базы и всё ещё считаться верными */
const AHEAD_TOLERANCE_MS = 10 * 60_000;
const PERSIST_EVERY_MS = 60_000;
/** После полного отказа сети следующая попытка не раньше: закрытая сеть не ждёт таймаута на каждом входе */
const NETWORK_RETRY_MS = 5 * 60_000;
const ANCHOR_KEY = 'time_anchor';

export type Dialect = 'sqlite' | 'postgresql' | 'mysql';

export interface TrustedTimeDeps {
  prisma: () => any;
  dialect: () => Dialect;
  upsertSetting: (key: string, userId: string | null, value: string) => Promise<unknown>;
  anchorFile: string;
  /** Заголовок Date внешних HTTPS-серверов; null, если сети нет */
  networkTime: () => Promise<number | null>;
  now?: () => number;
  /** Журнал сброса и отказов; по умолчанию молчит */
  log?: (message: string) => void;
}

/** Часы самой базы, мс; null — у базы нет собственных часов (SQLite) или она не ответила */
export async function databaseClockMs(prisma: any, dialect: Dialect): Promise<number | null> {
  try {
    const sql = dialect === 'postgresql'
      ? 'SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT) AS t'
      : dialect === 'mysql' ? 'SELECT CAST(UNIX_TIMESTAMP(NOW(3)) * 1000 AS UNSIGNED) AS t' : '';
    if (!sql) return null;
    const rows = await prisma.$queryRawUnsafe(sql);
    const value = Number(rows?.[0]?.t);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (_) { return null; }
}

export function createTrustedTime(deps: TrustedTimeDeps) {
  const clock = deps.now || Date.now;
  const log = deps.log || (() => {});
  let anchor = 0;
  let loadedFile = false;
  let lastPersist = 0;
  /** Время базы минус часы машины на момент последнего замера; null — замера нет */
  let skew: number | null = null;
  let networkFailedAt = 0;

  const readFile = (): number => {
    try { const v = parseInt(fs.readFileSync(deps.anchorFile, 'utf-8').trim(), 36); return Number.isFinite(v) ? v : 0; } catch { return 0; }
  };
  const readDb = async (): Promise<number> => {
    try {
      const row = await deps.prisma().appSetting.findFirst({ where: { key: ANCHOR_KEY, userId: null } });
      const v = row ? parseInt(String(row.value), 36) : 0;
      return Number.isFinite(v) ? v : 0;
    } catch { return 0; }
  };
  /** Верхняя граница правдоподобного времени по часам базы; Infinity, если сверить не с чем */
  const ceiling = (): number => (skew === null ? Infinity : clock() + skew + AHEAD_TOLERANCE_MS);

  async function persist(ms: number): Promise<void> {
    try { fs.writeFileSync(deps.anchorFile, ms.toString(36), 'utf-8'); } catch (_) { /* домашняя папка только для чтения */ }
    try { await deps.upsertSetting(ANCHOR_KEY, null, ms.toString(36)); } catch (_) { /* база недоступна: файл остался */ }
  }

  /** Быстрая оценка (проверки прав): двигает якорь вперёд, но не дальше времени базы с запасом */
  function sync(): number {
    const now = clock();
    if (anchor === 0 && !loadedFile) { loadedFile = true; anchor = readFile(); }
    const limit = ceiling();
    if (now >= anchor) {
      const next = Math.min(now, limit);
      // Часы машины опережают базу: якорь не двигаем и в общую базу не пишем
      if (next >= anchor) {
        anchor = next;
        if (now - lastPersist > PERSIST_EVERY_MS && now <= limit) { lastPersist = now; void persist(next); }
      }
      return now;
    }
    return anchor;
  }

  /** Часы переведены назад: не хранимый флаг, а вывод из текущих часов — исправленные часы снимают его сами */
  const tampered = (): boolean => anchor - clock() > BACK_TOLERANCE_MS;

  async function measureSkew(): Promise<void> {
    const db = await databaseClockMs(deps.prisma(), deps.dialect());
    if (db !== null) skew = db - clock();
  }

  /** Полная проверка (вход): якорь из базы, часы базы, сетевое время */
  async function full(): Promise<{ now: number; tampered: boolean; source: string }> {
    await measureSkew();
    sync();
    const fromDb = await readDb();
    if (fromDb > anchor) {
      // Якорь из общей базы принимается, только если его подтверждают часы базы
      if (fromDb <= ceiling()) anchor = fromDb;
      else log(`[Время] Якорь времени в базе (${new Date(fromDb).toISOString()}) опережает часы базы: не принят. Владелец может сбросить его в настройках.`);
    }
    // Свой якорь, ушедший вперёд часов базы (часы этой машины когда-то спешили), подтягивается к времени базы
    if (anchor > ceiling()) { anchor = Math.max(0, clock() + (skew ?? 0)); lastPersist = 0; }
    let source = skew === null ? 'local' : 'database';
    let now = sync();
    let behindNetwork = false;

    // Закрытая сеть: после отказа до следующей попытки полчаса не ждём таймаута
    const netTime = clock() - networkFailedAt < NETWORK_RETRY_MS ? null : await deps.networkTime().catch(() => null);
    if (!netTime && clock() - networkFailedAt >= NETWORK_RETRY_MS) networkFailedAt = clock();
    if (netTime) {
      networkFailedAt = 0;
      source = 'network';
      // Сетевое время авторитетно: если часы отстают от него больше чем на 10 минут — переведены назад
      if (netTime - clock() > 10 * 60_000) behindNetwork = true;
      if (netTime > now) now = netTime;
      if (netTime > anchor && netTime <= ceiling()) {
        anchor = netTime;
        lastPersist = clock();
        await persist(netTime);
      }
    }
    return { now, tampered: tampered() || behindNetwork, source };
  }

  /** Сброс якоря владельцем: удаляет файл и запись в базе, дальше якорь строится заново от текущих часов */
  async function reset(): Promise<void> {
    anchor = 0; loadedFile = true; lastPersist = 0; skew = null; networkFailedAt = 0;
    try { fs.unlinkSync(deps.anchorFile); } catch (_) { /* файла могло не быть */ }
    await deps.prisma().appSetting.deleteMany({ where: { key: ANCHOR_KEY } });
    log('[Время] Якорь времени сброшен владельцем.');
    sync();
  }

  return { sync, full, reset, isTampered: () => { sync(); return tampered(); }, anchorMs: () => anchor };
}

/** Сброс якоря — только владелец; запись остаётся в журнале действий. */
export function registerTimeAnchorRoutes(app: Express, time: ReturnType<typeof createTrustedTime>, getPrisma: () => any): void {
  app.post('/api/admin/time-anchor/reset', requireOwnerMiddleware, async (req: Request, res: Response) => {
    try {
      await time.reset();
      const user = (req as any).authUser;
      try {
        await getPrisma().actionLog.create({ data: { userId: String(user?.id || ''), userName: String(user?.name || 'Владелец'), what: 'Сброс якоря времени', target: 'Защита от перевода часов', route: '/api/admin/time-anchor/reset' } });
      } catch (_) { /* журнала может не быть в старой базе: сброс всё равно выполнен */ }
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: 'Не удалось сбросить якорь времени: ' + String(error?.message || error) });
    }
  });
}

/**
 * Сетевое время: заголовок Date от нескольких независимых HTTPS-серверов.
 *
 * Это единственное место, где Flux ходит наружу сам (описано в README): запрос
 * HEAD / без каких-либо данных Flux на www.google.com, ya.ru и
 * www.cloudflare.com, и только когда входит профиль со сроком действия. Отказ
 * сети тихий (null) и быстрый: полторы секунды на всё, дальше работает якорь.
 */
export function fetchNetworkTimeMs(timeoutMs = 1500): Promise<number | null> {
  const hosts = ['www.google.com', 'ya.ru', 'www.cloudflare.com'];
  const tryHost = (host: string) => new Promise<number | null>((resolve) => {
    try {
      const req = https.request({ host, method: 'HEAD', path: '/', timeout: timeoutMs }, (r) => {
        const d = r.headers && r.headers.date ? Date.parse(r.headers.date) : NaN;
        r.resume();
        resolve(Number.isFinite(d) ? d : null);
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    } catch {
      resolve(null);
    }
  });
  return new Promise((resolve) => {
    let settled = false;
    let pending = hosts.length;
    const done = (v: number | null) => {
      if (v !== null && !settled) { settled = true; resolve(v); }
      else if (--pending === 0 && !settled) resolve(null);
    };
    hosts.forEach(h => tryHost(h).then(done));
    setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, timeoutMs + 300).unref();
  });
}
