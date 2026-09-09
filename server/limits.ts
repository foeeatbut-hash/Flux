/**
 * Чем ограничен размер файла — и почему больше почти ничем.
 *
 * Раньше здесь считался ПРЕДЕЛ. Содержимое файла хранилось строкой в записи
 * файла, а строка целиком едет в базу одним пакетом; у MariaDB размер пакета
 * ограничен (`max_allowed_packet`), и при скромной настройке на файл
 * оставалось около пяти мегабайт. База при этом на слишком большой пакет не
 * отвечает ошибкой, а разрывает соединение — программа видит «connection
 * closed» и причину угадать не может. Ровно на это уже потрачен день при
 * отправке файла обновления.
 *
 * Теперь содержимое едет кусками (server/routes/fileChunks.ts), и предел из
 * размера пакета выводится не на файл, а на КУСОК. Файл может быть любым;
 * остаются место на диске базы и время передачи — о них человеку говорится
 * честно, вопросом перед очень большим файлом, а не отказом.
 */
import type { Express, Request, Response } from 'express';
import { getDialect } from './ddl.js';

/**
 * Выше этого спрашиваем подтверждение, а не отказываем.
 *
 * «Бесконечной размерности» не бывает: файл на полгигабайта лежит в общей базе,
 * едет по сети отдела и попадает в резервную копию. Человек имеет право его
 * положить — но должен знать, что делает, поэтому программа спрашивает один
 * раз, а не запрещает.
 */
export const WARN_FILE_BYTES = 500 * 1024 * 1024;

/** Содержимое едет в base64: на диске 3 байта превращаются в 4 символа */
export const BASE64_GROWTH = 4 / 3;

/** Больше куска в базу не кладём: проверками этого хватало всегда */
export const CHUNK_MAX = 2 * 1024 * 1024;
/** Меньше уже бессмысленно: 130 МБ такими кусками — это тысячи запросов */
export const CHUNK_MIN = 64 * 1024;

/**
 * Размер куска под предел размера пакета у базы.
 *
 * Отдельной функцией, потому что именно на этом обновления встали в последний
 * раз. Два мегабайта проходили во всех проверках, а у живого сервера отдела
 * предел оказался меньше — и MariaDB на слишком большой пакет не отвечает
 * ошибкой, а разрывает соединение: программа видит «Cannot execute new
 * commands: connection closed» и угадать причину не может никогда.
 *
 * В пакет кроме самих данных едет ещё и запрос, а двоичное содержимое в
 * протоколе занимает больше, чем весит. Половина предела с запасом — размер,
 * который проходит наверняка. `limit` равный нулю значит «спросить не удалось».
 */
export function chunkSizeFor(limit: number): number {
  if (!limit) return CHUNK_MAX;
  return Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, Math.floor(limit / 2) - 64 * 1024));
}

/** Целевой размер куска вложения к обращению. */
export const FEEDBACK_CHUNK = 256 * 1024;
/** Ниже этого работать нельзя: значит база настроена так, что файл не проедет. */
export const FEEDBACK_CHUNK_MIN = 8 * 1024;

/**
 * Размер куска для вложений к обращениям.
 *
 * Формула другая, чем у файлов Проводника, и стоит рядом намеренно — иначе две
 * похожие разойдутся, и никто не вспомнит почему. Разница ровно в одном:
 * вложение едет двоичным телом запроса, а не строкой base64, поэтому делить на
 * четыре трети здесь не надо. Запас берётся больше (четверть предела вместо
 * половины), потому что куски мельче и лишний запас почти ничего не стоит.
 *
 * Если после запаса получилось меньше восьми килобайт — это не повод молча
 * взять минимум: база настроена так, что вложения через неё не проедут, и
 * человеку надо об этом сказать. Ноль здесь означает «настроить базу».
 */
export function feedbackChunkFor(limit: number): number {
  if (!limit) return FEEDBACK_CHUNK;
  const safe = Math.min(FEEDBACK_CHUNK, Math.floor(limit / 4) - 16 * 1024);
  return safe >= FEEDBACK_CHUNK_MIN ? safe : 0;
}

export function registerLimitRoutes(app: Express, getPrisma: () => any): {
  chunkBytes: () => Promise<number>;
  feedbackChunkBytes: () => Promise<number>;
} {
  // Ответ не меняется, пока работает программа: спрашивать базу на каждый
  // перенос незачем
  let cached = 0;

  /**
   * Размер куска под эту базу. base64 учтён здесь, а не в окне: про раздувание
   * на треть должно знать одно место, а не каждый отправитель.
   */
  const chunkBytes = async (): Promise<number> => {
    if (cached) return cached;
    let packet = 0;
    if (getDialect() === 'mysql') {
      try {
        const rows: any = await getPrisma().$queryRawUnsafe('SELECT @@max_allowed_packet AS n');
        packet = Number(rows?.[0]?.n || 0);
      } catch (_) { packet = 0; }
    }
    // У SQLite и PostgreSQL предела пакета нет — там берём привычные два мегабайта
    const raw = getDialect() === 'mysql' ? chunkSizeFor(packet) : CHUNK_MAX;
    cached = Math.max(CHUNK_MIN, Math.floor(raw / BASE64_GROWTH));
    return cached;
  };

  let cachedFeedback = -1;

  /** Тот же вопрос к базе, но для двоичных кусков вложений. */
  const feedbackChunkBytes = async (): Promise<number> => {
    if (cachedFeedback >= 0) return cachedFeedback;
    if (getDialect() !== 'mysql') { cachedFeedback = FEEDBACK_CHUNK; return cachedFeedback; }
    let packet = 0;
    try {
      const rows: any = await getPrisma().$queryRawUnsafe('SELECT @@max_allowed_packet AS n');
      packet = Number(rows?.[0]?.n || 0);
    } catch (_) { packet = 0; }
    cachedFeedback = feedbackChunkFor(packet);
    return cachedFeedback;
  };

  app.get('/api/limits', async (_req: Request, res: Response) => {
    res.json({ chunkBytes: await chunkBytes(), warnBytes: WARN_FILE_BYTES });
  });

  return { chunkBytes, feedbackChunkBytes };
}
