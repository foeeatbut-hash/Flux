/**
 * Обновления программы: публикация, раздача и отзыв.
 *
 * Главное решение этого модуля — ФАЙЛ ЕДЕТ В ОБЩУЮ БАЗУ.
 *
 * В отделе, для которого программа писалась, сервера приложения нет: общая у
 * сотрудников только база, а свой встроенный сервер поднимает программа
 * каждого. Пока запись о релизе ложилась в общую базу, а сам exe оставался на
 * диске того, кто публиковал, все остальные видели «доступна новая версия» и
 * получали «файла этой версии нет». Обновиться не мог никто, кроме автора
 * публикации, — и выглядело это как поломка обновлений.
 *
 * Поэтому файл кладётся туда же, где и запись о нём: кусками по два мегабайта,
 * потому что 130 мегабайт одним запросом не проходят — у MariaDB есть предел
 * размера пакета, и он обычно меньше. Диск остаётся быстрым путём для того,
 * кто публиковал; все прочие берут файл из базы.
 */
import type { Express, Request, Response } from 'express';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { ensureTables as ensureDbTables, getDialect } from './ddl.js';

/**
 * Какой релиз предлагать и о каких сказать, что они пусты.
 *
 * Отдельной функцией, потому что это и есть суть починки: до неё предлагался
 * просто последний по дате, и одна неудачная публикация закрывала обновления
 * всему отделу — у всех горело «доступна новая версия», а нажатие отвечало
 * «файла этой версии нет».
 *
 * `list` — релизы от свежего к старому, `ok` — есть ли у релиза файл.
 */
export function pickRelease<T extends { version: string }>(
  list: T[],
  ok: (r: T) => { ok: boolean; why: string },
): { release: T | null; broken: { version: string; why: string }[] } {
  const broken: { version: string; why: string }[] = [];
  for (const r of list) {
    const a = ok(r);
    if (a.ok) return { release: r, broken };
    broken.push({ version: r.version, why: a.why });
  }
  return { release: null, broken };
}

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

export interface UpdateDeps {
  /** Клиент базы берётся лениво: он пересоздаётся при переключении базы */
  getPrisma: () => any;
  /** Папка данных сервера — там же лежит быстрый диск-кэш файлов */
  dataDir: string;
  notifyAll: (category: string, title: string, body: string, route: string, by: string) => Promise<void>;
  broadcast: (event: string, payload: unknown) => void;
}

export function registerUpdateRoutes(app: Express, deps: UpdateDeps): void {
  const ventAppDataPath = deps.dataDir;
  // ── Обновления приложения: публикация и раздача через сервер ────────────────
  // Админ загружает новый exe прямо на сервер (или указывает внешнюю ссылку),
  // сотрудники проверяют и скачивают обновление с того же сервера, на котором
  // работают — никакого стороннего хостинга. Файлы лежат в папке данных сервера.
  const updatesDir = path.join(ventAppDataPath, 'updates');
  const sanitizeVersion = (v: unknown): string => String(v || '').trim().replace(/[^0-9a-zA-Z.\-]/g, '').slice(0, 40);
  const updateFilePath = (version: string) => path.join(updatesDir, `Flux-${version}.exe`);

  /**
   * Есть ли у релиза файл, который сотрудник действительно получит.
   *
   * Проверять приходится потому, что запись о релизе и файл живут порознь:
   * запись создаётся отдельным запросом и остаётся в общей базе навсегда, даже
   * если загрузка файла не удалась или её вовсе не делали. Тогда у всех горит
   * «доступно обновление», а нажатие отвечает «файла этой версии нет» — и так
   * до тех пор, пока запись не уберут руками. Именно в этом состоянии отдел и
   * просидел два выпуска.
   */
  const availability = async (version: string, fileUrl: string): Promise<{ ok: boolean; size: number; why: string }> => {
    // Внешнюю ссылку проверить нечем — она на чужом сервере, верим на слово
    if (/^https?:\/\//i.test(String(fileUrl || ''))) return { ok: true, size: 0, why: '' };
    const local = updateFilePath(version);
    if (fs.existsSync(local)) return { ok: true, size: fs.statSync(local).size, why: '' };
    try {
      await ensureUpdateChunks();
      const n = await deps.getPrisma().appUpdateChunk.count({ where: { version } });
      if (n > 0) return { ok: true, size: await chunkedSize(version), why: '' };
      return {
        ok: false, size: 0,
        why: 'файл не загружен в общую базу — сотрудники его не скачают',
      };
    } catch (e: any) {
      return { ok: false, size: 0, why: `файл недоступен: ${e?.message || e}` };
    }
  };

  /**
   * Последний релиз, который РЕАЛЬНО можно поставить.
   *
   * Не просто последний по дате: если у самого свежего нет файла, предлагается
   * предыдущий рабочий, а про пропущенные говорится отдельным списком. Иначе
   * одна неудачная публикация закрывает обновления всему отделу.
   */
  app.get('/api/updates/latest', async (_req: Request, res: Response) => {
    try {
      const list = await deps.getPrisma().appUpdate.findMany({ orderBy: { createdAt: 'desc' }, take: 10 });
      // Наличие файла спрашивается заранее: выбор релиза — правило, и живёт оно
      // отдельной функцией, которую можно проверить скриптом
      const state = new Map<string, { ok: boolean; size: number; why: string }>();
      for (const upd of list) state.set(upd.version, await availability(upd.version, upd.fileUrl));
      const { release, broken } = pickRelease(list, (r: any) => state.get(r.version)!);
      if (!release) return res.json({ version: null, broken });
      res.json({
        version: release.version, changelog: release.changelog, fileUrl: release.fileUrl,
        size: state.get(release.version)?.size || 0, createdAt: release.createdAt, broken,
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Не удалось получить сведения об обновлении' });
    }
  });

  /**
   * Дошёл ли файл этой версии до сервера — вопросом, а не скачиванием.
   *
   * Публикация обязана проверять себя: раньше она этого не делала, и о том, что
   * релиз опубликован без файла, узнавали через день от сотрудников. Проверять
   * запросом самого файла нельзя — это 130 мегабайт по сети ради двух байтов.
   */
  app.get('/api/updates/check/:version', async (req: Request, res: Response) => {
    const version = sanitizeVersion(req.params.version);
    if (!version) return res.status(400).json({ error: 'Не указана версия' });
    const upd = await deps.getPrisma().appUpdate.findFirst({ where: { version } }).catch(() => null);
    const a = await availability(version, upd?.fileUrl || '');
    res.json({ version, ...a });
  });

  // Загрузка файла exe на сервер (только админ). Тело запроса — сырые байты файла,
  // потому что base64-через-JSON упирается в лимит парсера, а exe весит >100 МБ.
  /**
   * Загрузка exe: на диск этого сервера И В ОБЩУЮ БАЗУ.
   *
   * База — единственное, что есть общего у всех сотрудников: сервера приложения
   * у них нет, программа каждого поднимает свой встроенный. Пока запись о релизе
   * ложилась в общую базу, а сам файл — на диск того, кто публиковал, все
   * остальные видели «доступна новая версия» и получали «файла этой версии нет».
   *
   * Кусками, потому что целиком 130 МБ одним запросом не проходят — у MariaDB
   * есть предел размера пакета (`max_allowed_packet`).
   *
   * Размер куска НЕ ВЫБИРАЕТСЯ НАУГАД. Двух мегабайтов хватало в проверках, но
   * у живого сервера отдела предел оказался меньше — и MariaDB на слишком
   * большой пакет не отвечает ошибкой, а РАЗРЫВАЕТ СОЕДИНЕНИЕ. Со стороны
   * программы это выглядело как «Cannot execute new commands: connection
   * closed» — сообщение, по которому причину не угадать никогда. Поэтому предел
   * спрашивается у самой базы, а если куски всё равно не проходят, они
   * уменьшаются вдвое и попытка повторяется.
   */
  /** Предел размера пакета у сервера базы; 0 — спросить не удалось */
  const packetLimit = async (): Promise<number> => {
    if (getDialect() !== 'mysql') return 0;
    try {
      const rows: any = await deps.getPrisma().$queryRawUnsafe('SELECT @@max_allowed_packet AS n');
      return Number(rows?.[0]?.n || 0);
    } catch (_) {
      return 0;
    }
  };


  /**
   * Таблица кусков может отсутствовать — или быть НЕПОЛНОЙ.
   *
   * Второе и случилось: автомиграция общей базы не знала двоичного типа и
   * создала таблицу без самой колонки с файлом. Проверка «сколько строк»
   * при этом проходила успешно — таблица-то есть, — а вставка падала на «нет
   * такой колонки», и файл обновления не попадал в общую базу никогда.
   *
   * Поэтому спрашивается именно колонка с данными: она и есть смысл таблицы.
   */
  let updateChunksReady = false;
  const ensureUpdateChunks = async (): Promise<void> => {
    if (updateChunksReady) return;
    try {
      await deps.getPrisma().appUpdateChunk.findFirst({ select: { data: true } });
      updateChunksReady = true;
    } catch (_) {
      const why = await ensureDbTables(deps.getPrisma(), [{
        table: 'AppUpdateChunk',
        cols: [
          { name: 'id', kind: 'text', pk: true },
          { name: 'version', kind: 'text', notNull: true, def: '', indexed: true },
          { name: 'idx', kind: 'int', notNull: true, def: 0 },
          { name: 'data', kind: 'blob', notNull: true },
        ],
        indexes: [{ name: 'AppUpdateChunk_version_idx_key', cols: ['version', 'idx'], unique: true }],
      }], (m) => console.error('[Обновление]', m));
      if (why) throw new Error(why);
      updateChunksReady = true;
    }
  };

  /**
   * Размер файла, собранного из кусков. Нужен, чтобы человек видел, сколько
   * качается, а не полосу, стоящую на нуле: у потока из базы нет заголовка с
   * длиной, взять её больше неоткуда.
   */
  const chunkedSize = async (version: string): Promise<number> => {
    const len = getDialect() === 'postgresql' ? 'octet_length("data")' : 'LENGTH(`data`)';
    const table = getDialect() === 'postgresql' ? '"AppUpdateChunk"' : '`AppUpdateChunk`';
    const col = getDialect() === 'postgresql' ? '"version"' : '`version`';
    try {
      const rows: any = await deps.getPrisma().$queryRawUnsafe(
        `SELECT SUM(${len}) AS total FROM ${table} WHERE ${col} = ?`.replace('?', `'${version.replace(/'/g, "''")}'`),
      );
      return Number(rows?.[0]?.total || 0);
    } catch (_) {
      return 0;
    }
  };

  app.post('/api/updates/upload', express.raw({ type: () => true, limit: '800mb' }), async (req: Request, res: Response) => {
    const u = (req as any).authUser;
    if (!u || u.role !== 'ADMIN') return res.status(403).json({ error: 'Публикация обновлений доступна только администратору' });
    const version = sanitizeVersion(req.query.version);
    if (!version) return res.status(400).json({ error: 'Укажите версию (?version=1.2.3)' });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 1024) return res.status(400).json({ error: 'Файл обновления пуст или не передан' });
    try {
      if (!fs.existsSync(updatesDir)) fs.mkdirSync(updatesDir, { recursive: true });
      fs.writeFileSync(updateFilePath(version), body);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'Не удалось сохранить файл обновления' });
    }
    try {
      await ensureUpdateChunks();
      const limit = await packetLimit();
      let piece = chunkSizeFor(limit);
      let lastErr: any = null;

      // Попытки с уменьшающимся куском. Разрыв соединения на большом пакете
      // ошибкой о размере не сопровождается — только «соединение закрыто», —
      // поэтому единственный надёжный ответ на неудачу: взять кусок поменьше
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await deps.getPrisma().appUpdateChunk.deleteMany({ where: { version } });
          for (let i = 0, idx = 0; i < body.length; i += piece, idx++) {
            await deps.getPrisma().appUpdateChunk.create({
              data: { version, idx, data: body.subarray(i, Math.min(i + piece, body.length)) },
            });
          }
          // Записанное перечитывается: «вставка не упала» и «файл в базе
          // целиком» — разные вещи, а сотруднику достанется то, что в базе
          const stored = await chunkedSize(version);
          if (stored !== body.length) throw new Error(`в общую базу дошло ${stored} байт из ${body.length}`);
          lastErr = null;
          break;
        } catch (e: any) {
          lastErr = e;
          console.error(`[Обновление] Кусок ${Math.round(piece / 1024)} КБ не прошёл: ${e?.message || e}`);
          // Таблица могла испортиться уже ПОСЛЕ проверки — например, её правили
          // руками при работающем сервере. Пока «проверено» помнилось до
          // перезапуска, починка в таком случае не запускалась никогда, и
          // каждая следующая загрузка падала одинаково. Забываем и проверяем
          // заново — это дешевле перезапуска сервера
          if (/no such column|Unknown column|does not exist|no such table/i.test(String(e?.message || ''))) {
            updateChunksReady = false;
            await ensureUpdateChunks().catch(() => {});
            continue;
          }
          if (piece <= CHUNK_MIN) break;
          piece = Math.max(CHUNK_MIN, Math.floor(piece / 2));
          // База после разрыва соединения приходит в себя не мгновенно
          await new Promise((r) => setTimeout(r, 700));
        }
      }
      if (lastErr) {
        const hint = limit
          ? ` У сервера базы предел размера пакета — ${Math.round(limit / 1024)} КБ.`
          : '';
        throw new Error(`${lastErr?.message || lastErr}.${hint}`);
      }

      // Старые версии из базы убираем: держать по 130 МБ на каждый выпуск
      // незачем, а место в общей базе — общее
      const keep = await deps.getPrisma().appUpdate.findMany({ orderBy: { createdAt: 'desc' }, take: 2, select: { version: true } });
      const keepList = [version, ...keep.map((k: any) => k.version)];
      await deps.getPrisma().appUpdateChunk.deleteMany({ where: { version: { notIn: keepList } } });
      // В журнал — чтобы в следующий раз было видно, каким куском прошло и
      // какой предел у базы: по одному «соединение закрыто» этого не понять
      console.log(`[Обновление] Версия ${version} (${body.length} Б) записана в общую базу `
        + `кусками по ${Math.round(piece / 1024)} КБ; предел пакета у базы `
        + `${limit ? Math.round(limit / 1024) + ' КБ' : 'неизвестен'}`);
      res.json({ success: true, version, size: body.length, shared: true, chunk: piece });
    } catch (e: any) {
      // Недописанное убираем сразу. Обрезанный exe хуже отсутствующего: он
      // выглядит как файл, скачивается и ложится на место работающей программы
      try { await deps.getPrisma().appUpdateChunk.deleteMany({ where: { version } }); } catch (_) {}
      // На диске файл уже есть — этот сервер обновление раздаст, но остальные
      // сотрудники его не увидят. Молчать об этом нельзя
      console.error('[Обновление] Файл не попал в общую базу:', e?.message || e);
      const lost = /connection closed|lost connection|ECONNRESET|socket|closed state/i.test(String(e?.message || e));
      res.json({
        success: true, version, size: body.length, shared: false,
        warning: 'Файл сохранён только на этой машине: в общую базу он не записался. '
          + 'Сотрудники его не скачают. Причина: ' + (e?.message || e)
          + (lost
            ? ' Программа уже пробовала уменьшать куски — не помогло. Так ведёт себя MariaDB, '
              + 'когда пакет больше разрешённого: администратору базы нужно поднять max_allowed_packet '
              + '(достаточно 16 МБ) или проверить, не рвёт ли соединение что-то между программой и базой.'
            : ''),
      });
    }
  });

  // Публикация релиза (только админ): создаёт/обновляет запись AppUpdate.
  // Если файл этой версии уже загружен на сервер — ссылка ставится на сервер,
  // иначе используется внешняя прямая ссылка из формы.
  app.post('/api/updates', async (req: Request, res: Response) => {
    const u = (req as any).authUser;
    if (!u || u.role !== 'ADMIN') return res.status(403).json({ error: 'Публикация обновлений доступна только администратору' });
    const version = sanitizeVersion(req.body?.version);
    if (!version) return res.status(400).json({ error: 'Укажите номер версии' });
    // «90» вместо «0.90.0» — это не придирка к форме записи: файл на сервере
    // лежит под настоящим номером, и по выдуманному его не найдёт никто
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
      return res.status(400).json({
        error: `«${version}» — не номер версии. Версия пишется тремя числами через точку: 0.90.0.`,
      });
    }
    const changelog = String(req.body?.changelog || '').slice(0, 20000);
    const external = String(req.body?.fileUrl || '').trim();
    /**
     * Оповещение не уходит, пока файл не лежит там, откуда его возьмут.
     *
     * Раньше хватало файла на диске того, кто публикует. Но у сотрудников свои
     * серверы, и его диск для них — чужая машина: они получали «файла этой
     * версии нет». Теперь запись о релизе создаётся только вместе с настоящей
     * возможностью его скачать.
     */
    const inDb = await deps.getPrisma().appUpdateChunk.count({ where: { version } }).catch(() => 0);
    const onDisk = fs.existsSync(updateFilePath(version));
    if (!external && !inDb) {
      return res.status(400).json({
        error: onDisk
          ? 'Файл сохранён только на этой машине — в общую базу он не попал, и сотрудники его не скачают. '
            + 'Загрузите exe заново; если не выходит, причина будет в журнале сервера.'
          : 'Загрузите файл exe на сервер или укажите прямую ссылку',
      });
    }
    const fileUrl = (onDisk || inDb) ? `/api/updates/download/${version}` : external;
    try {
      const update = await deps.getPrisma().appUpdate.upsert({
        where: { version },
        update: { changelog, fileUrl },
        create: { version, changelog, fileUrl },
      });
      // Мгновенное оповещение всем, кто сейчас онлайн
      deps.broadcast('app:update-published', { version, changelog });
      // И запись в уведомления — чтобы узнал и тот, кто был не в программе
      await deps.notifyAll('СИСТЕМА', `Вышла версия ${version}`,
        String(changelog || '').split('\n')[0].slice(0, 120),
        '/settings?section=updates', String(u.id || ''));
      res.json({ success: true, update });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Не удалось опубликовать релиз' });
    }
  });

  /**
   * Отозвать опубликованный релиз (только админ).
   *
   * Опубликовать не тот файл или не ту версию — обычное дело, а до этой правки
   * отозвать публикацию было нечем: запись жила в базе навсегда, и у всех
   * сотрудников горел значок обновления, которое ставить не надо.
   */
  app.delete('/api/updates/:version', async (req: Request, res: Response) => {
    const u = (req as any).authUser;
    if (!u || u.role !== 'ADMIN') return res.status(403).json({ error: 'Отзыв релиза доступен только администратору' });
    const version = sanitizeVersion(req.params.version);
    if (!version) return res.status(400).json({ error: 'Не указана версия' });
    try {
      await deps.getPrisma().appUpdate.deleteMany({ where: { version } });
      // Файл убираем вместе с записью: раздавать его больше некому. И с диска,
      // и из общей базы — иначе отозванный релиз так и лежит там сотней
      // мегабайт, а место в общей базе общее
      try { if (fs.existsSync(updateFilePath(version))) fs.unlinkSync(updateFilePath(version)); } catch (_) {}
      try {
        await ensureUpdateChunks();
        await deps.getPrisma().appUpdateChunk.deleteMany({ where: { version } });
      } catch (_) { /* таблицы кусков может не быть — тогда и убирать нечего */ }
      res.json({ success: true, version });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Не удалось отозвать релиз' });
    }
  });

  // Скачивание exe с сервера (токен обязателен — проверяет общий middleware)
  /**
   * Раздача exe: сначала с диска этого сервера, потом из общей базы.
   *
   * Диск — быстрый путь для того, кто публиковал. Все остальные берут файл из
   * общей базы: у них на диске его нет и взяться ему неоткуда.
   */
  app.get('/api/updates/download/:version', async (req: Request, res: Response) => {
    const version = sanitizeVersion(req.params.version);
    if (!version) return res.status(404).json({ error: 'Версия не указана' });

    const filePath = updateFilePath(version);
    if (fs.existsSync(filePath)) return res.download(filePath, `Flux ${version}.exe`);

    try {
      await ensureUpdateChunks();
      const parts = await deps.getPrisma().appUpdateChunk.findMany({
        where: { version }, orderBy: { idx: 'asc' }, select: { idx: true },
      });
      if (!parts.length) {
        return res.status(404).json({
          error: 'Файла этой версии нет ни на этом сервере, ни в общей базе. '
            + 'Администратору нужно опубликовать релиз заново.',
        });
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="Flux ${version}.exe"`);
      // Длина потока — чтобы у человека шла полоса загрузки, а не стояла на нуле
      const total = await chunkedSize(version);
      if (total > 0) res.setHeader('Content-Length', String(total));
      // По куску за раз: 130 МБ целиком в память сервера класть незачем
      for (const p of parts) {
        const row = await deps.getPrisma().appUpdateChunk.findFirst({
          where: { version, idx: p.idx }, select: { data: true },
        });
        if (row?.data) res.write(Buffer.from(row.data));
      }
      res.end();
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Не удалось отдать файл обновления' });
    }
  });

}
