/**
 * «Надёжное время»: срок действия профиля проверяется не по одним часам машины.
 *
 * Локальные часы легко перевести назад, поэтому берётся максимум из локальных
 * часов, монотонного якоря (самое позднее замеченное время; лежит в скрытом
 * файле машины и в общей базе) и часов самой базы (сервер компании). Якорь только растёт: часы,
 * отставшие от него больше чем на 6 часов, считаются переведёнными назад.
 *
 * Зачем отдельный модуль: правила якоря проверяются без поднятого сервера
 * (scripts/test-review-auth.ts), а в server.ts им было тесно.
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
import type { Express, Request, Response } from 'express';
import { requireOwnerMiddleware } from './accessPolicy.js';

/** Допуск на смену пояса и дрейф: меньшее расхождение с якорем перевода часов не означает */
const BACK_TOLERANCE_MS = 6 * 3600_000;
/** Насколько часы машины могут опережать время базы и всё ещё считаться верными */
const AHEAD_TOLERANCE_MS = 10 * 60_000;
const PERSIST_EVERY_MS = 60_000;
/** Насколько часы могут отставать от часов базы, прежде чем считаются переведёнными назад */
const DB_BEHIND_MS = 10 * 60_000;
/** Как часто часы базы перемеряются в фоне (проверки сессии синхронные, им нужен свежий замер) */
const MEASURE_EVERY_MS = 60_000;
const ANCHOR_KEY = 'time_anchor';

export type Dialect = 'sqlite' | 'postgresql' | 'mysql';

export interface TrustedTimeDeps {
  prisma: () => any;
  dialect: () => Dialect;
  upsertSetting: (key: string, userId: string | null, value: string) => Promise<unknown>;
  anchorFile: string;
  now?: () => number;
  /** Монотонные часы (мс): не зависят от перевода системных часов; нужны, чтобы помнить замер часов базы */
  mono?: () => number;
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
  const mono = deps.mono || (() => performance.now());
  const log = deps.log || (() => {});
  let anchor = 0;
  let loadedFile = false;
  let lastPersist = 0;
  /** Время базы минус часы машины на момент последнего замера; null — замера нет */
  let skew: number | null = null;
  /** Последний замер часов базы и момент (по монотонным часам), когда он сделан */
  let dbRef: { db: number; mono: number } | null = null;
  let measuring = false;

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

  async function persist(requested: number): Promise<void> {
    let ms = requested;
    const shared = deps.dialect() !== 'sqlite';
    if (shared) {
      // Часы базы замеряются перед каждой записью якоря. Нет замера — в общую
      // базу не пишем вовсе (только локальный файл): иначе машина с часами
      // «вперёд» травила бы общий якорь, пока не было первого входа со сроком
      await measureSkew();
      if (skew !== null) {
        ms = Math.min(ms, ceiling());
        if (anchor > ms) anchor = ms;
      }
    }
    try { fs.writeFileSync(deps.anchorFile, ms.toString(36), 'utf-8'); } catch (_) { /* домашняя папка только для чтения */ }
    if (shared && skew === null) return;
    try { await deps.upsertSetting(ANCHOR_KEY, null, ms.toString(36)); } catch (_) { /* база недоступна: файл остался */ }
  }

  /** Быстрая оценка (проверки прав): двигает якорь вперёд, но не дальше времени базы с запасом */
  function sync(): number {
    const now = clock();
    if (anchor === 0 && !loadedFile) { loadedFile = true; anchor = readFile(); }
    // Часы базы перемеряются в фоне: откат на 1-5 часов якорь не видит, его видят только они
    if (deps.dialect() !== 'sqlite' && !measuring && (!dbRef || mono() - dbRef.mono > MEASURE_EVERY_MS)) void measureSkew();
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

  /**
   * Часы переведены назад: не хранимый флаг, а вывод из текущих часов —
   * исправленные часы снимают его сами. Два признака: отставание от якоря больше
   * 6 часов и отставание больше 10 минут от часов базы (где они есть: откат на
   * 1-5 часов якорем не виден). Замер часов базы «движется» по монотонным
   * часам, поэтому исправленные системные часы догоняют его и признак снимается.
   * У локальной SQLite часов базы нет, там работает только якорь.
   */
  const tampered = (): boolean => {
    if (anchor - clock() > BACK_TOLERANCE_MS) return true;
    return !!dbRef && dbRef.db + (mono() - dbRef.mono) - clock() > DB_BEHIND_MS;
  };

  async function measureSkew(): Promise<void> {
    measuring = true;
    try {
      // Монотонные часы снимаются до запроса: ответ базы старше момента, когда он отправлен, не бывает
      const m = mono();
      const t0 = clock();
      const db = await databaseClockMs(deps.prisma(), deps.dialect());
      if (db !== null) { skew = db - t0; dbRef = { db, mono: m }; }
    } finally { measuring = false; }
  }

  /** Полная проверка (вход): якорь из базы и часы базы */
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
    const source = skew === null ? 'local' : 'database';
    return { now: sync(), tampered: tampered(), source };
  }

  /** Сброс якоря владельцем: удаляет файл и запись в базе, дальше якорь строится заново от текущих часов */
  async function reset(): Promise<void> {
    anchor = 0; loadedFile = true; lastPersist = 0; skew = null; dbRef = null;
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
      const user = (req as any).authUser;
      // Сначала журнал: сброс снимает защиту от перевода часов, и без следа в
      // журнале его делать нельзя. Не записалось — отвечаем 500 и ничего не сбрасываем
      try {
        await getPrisma().actionLog.create({ data: { userId: String(user?.id || ''), userName: String(user?.name || 'Владелец'), what: 'Сброс якоря времени', target: 'Защита от перевода часов', route: '/api/admin/time-anchor/reset' } });
      } catch (error: any) {
        return res.status(500).json({ error: 'Сброс не выполнен: не удалось записать его в журнал действий. ' + String(error?.message || error) });
      }
      await time.reset();
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: 'Не удалось сбросить якорь времени: ' + String(error?.message || error) });
    }
  });
}
