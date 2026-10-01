/**
 * Публикация и отзыв обновлений доступны только владельцу Flux.
 * Подписанный exe хранится целиком в общей БД, поэтому сотрудники скачивают
 * проверенные байты независимо от дискового кэша. Внешние ссылки не публикуются.
 */
import { requireOwnerMiddleware } from './accessPolicy.js';
import type { Express, Request, Response } from 'express';
import { CHUNK_MAX, CHUNK_MIN, chunkSizeFor } from './limits.js';
import express from 'express';
import crypto from 'crypto';
import { readUpdateSignature } from '../electron/updateSignature.js';
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

// Размер куска переехал в server/limits.ts: им пользуются и обновления, и
// файлы Проводника, а два одинаковых расчёта однажды разошлись бы

export interface UpdateDeps {
  /** Клиент базы берётся лениво: он пересоздаётся при переключении базы */
  getPrisma: () => any;
  /** Папка данных сервера — там же лежит быстрый диск-кэш файлов */
  dataDir: string;
  notifyAll: (category: string, title: string, body: string, route: string, by: string) => Promise<void>;
  broadcast: (event: string, payload: unknown) => void;
}

/**
 * Проверочный ключ наборов (scripts/fixtures/update-test-key.txt) — только для
 * сервера, запущенного из исходников. Собранный server.cjs его не принимает, а
 * программа сотрудника не примет выпуск с ним ни при каком сервере: окончательно
 * подпись проверяет она, своим зашитым ключом (electron/updateSignature.ts).
 */
const TEST_UPDATE_KEY_HEX = '9d155f2aa7bb2b9ec4b8e271c8181cd9d289b2c4e264fec77848963e1a6b0215';
const FROM_SOURCE = /\.ts$/.test(__filename);

export function registerUpdateRoutes(app: Express, deps: UpdateDeps): void {
  const ventAppDataPath = deps.dataDir;
  // ── Обновления приложения: публикация и раздача через сервер ────────────────
  // Владелец загружает exe в общую базу. Подпись проверяется до публикации;
  // сотрудники получают только опубликованный выпуск с того же сервера.
  const updatesDir = path.join(ventAppDataPath, 'updates');
  const sanitizeVersion = (v: unknown): string => String(v || '').trim().replace(/[^0-9a-zA-Z.\-]/g, '').slice(0, 40);
  const updateFilePath = (version: string) => path.join(updatesDir, `Flux-${version}.exe`);
  const pending = new Set<string>();
  const mutationLock = (req: Request, res: Response, next: () => void) => {
    const version = sanitizeVersion(req.params.version || req.query.version || req.body?.version);
    if (pending.has(version)) return res.status(409).json({ error: 'Выпуск уже обрабатывается. Дождитесь окончания операции.' });
    pending.add(version);
    const release = () => pending.delete(version);
    res.once('finish', release); res.once('close', release);
    next();
  };


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
  const availability = async (version: string, _fileUrl: string): Promise<{ ok: boolean; size: number; why: string }> => {
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
      const sig = await deps.getPrisma().appSetting.findFirst({ where: { key: `update.sig.${release.version}`, userId: null } }).catch(() => null);
      res.json({
        version: release.version, changelog: release.changelog, fileUrl: `/api/updates/download/${release.version}`,
        size: state.get(release.version)?.size || 0, createdAt: release.createdAt, broken,
        signature: sig?.value || '',
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

  // Загрузка файла exe на сервер (только владелец). Тело запроса — сырые байты файла,
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

  app.post('/api/updates/upload', requireOwnerMiddleware, express.raw({ type: () => true, limit: '800mb' }), mutationLock, async (req: Request, res: Response) => {
    const u = (req as any).authUser;
    if (!u || u.role !== 'OWNER') return res.status(403).json({ error: 'Публикация обновлений доступна только владельцу программы' });
    const version = sanitizeVersion(req.query.version);
    if (!version) return res.status(400).json({ error: 'Укажите версию (?version=1.2.3)' });
    try {
      const alreadyPublished = await deps.getPrisma().appUpdate.findUnique({ where: { version } });
      if (alreadyPublished) return res.status(409).json({ error: 'Опубликованный выпуск нельзя перезаписать. Выпустите новую версию.' });
    } catch (_) { return res.status(503).json({ error: 'База обновлений временно недоступна' }); }
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
      try { fs.unlinkSync(updateFilePath(version)); } catch (_) {}
      res.status(503).json({ success: false, version, shared: false, error: 'Файл не записан полностью в общую базу. Публикация отменена; повторите загрузку.' });
    }
  });

  // Владелец публикует только подписанный exe, целиком записанный в общую базу.
  app.post('/api/updates', requireOwnerMiddleware, mutationLock, async (req: Request, res: Response) => {
    const u = (req as any).authUser;
    if (!u || u.role !== 'OWNER') return res.status(403).json({ error: 'Публикация обновлений доступна только владельцу программы' });
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
    // Сотрудники получают именно проверенные байты из общей базы.
    if (req.body?.fileUrl) return res.status(400).json({ error: 'Обновление публикуется только через общую базу; внешние ссылки не принимаются' });
    const inDb = await deps.getPrisma().appUpdateChunk.count({ where: { version } }).catch(() => 0);
    if (!inDb) return res.status(400).json({ error: 'Сначала загрузите файл обновления в общую базу' });
    const fileUrl = `/api/updates/download/${version}`;
    /**
     * Подпись владельца обязательна. Проверяет её главный процесс каждого
     * сотрудника перед запуском — здесь она сверяется заранее, чтобы
     * публикующий узнал о негодной подписи сразу, а не от всего отдела.
     * Хранится рядом с выпуском: подделать её, дописав в базу, нельзя — нужен
     * закрытый ключ, которого на сервере нет.
     */
    const signature = String(req.body?.signature || '').trim();
    const signed = readUpdateSignature(signature) || (FROM_SOURCE ? readUpdateSignature(signature, TEST_UPDATE_KEY_HEX) : null);
    if (!signed) {
      return res.status(400).json({ error: 'Нужна подпись выпуска владельца программы (файл .flux-sig из tools/update-sign.mjs). Без неё обновление никто не поставит.' });
    }
    if (signed.version !== version) {
      return res.status(400).json({ error: `Подпись относится к версии ${signed.version}, а публикуется ${version}.` });
    }
    const hash = crypto.createHash('sha256');
    let size = 0;
    const parts = await deps.getPrisma().appUpdateChunk.findMany({ where: { version }, orderBy: { idx: 'asc' }, select: { idx: true, data: true } });
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].idx !== i) return res.status(400).json({ error: 'В базе неполный файл обновления. Загрузите его заново.' });
      const bytes = Buffer.from(parts[i].data); hash.update(bytes); size += bytes.length;
    }
    if (size !== signed.size || hash.digest('hex') !== signed.sha256) return res.status(400).json({ error: 'Подпись не подходит к файлу в общей базе' });

    try {
      // Уникальность по (key, userId=NULL) базы понимают по-разному — поэтому
      // не upsert, а «убрать прежнюю и записать»
      await deps.getPrisma().appSetting.deleteMany({ where: { key: `update.sig.${version}`, userId: null } });
      await deps.getPrisma().appSetting.create({ data: { key: `update.sig.${version}`, userId: null, value: signature } });
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
   * Отозвать опубликованный релиз (только владелец).
   *
   * Опубликовать не тот файл или не ту версию — обычное дело, а до этой правки
   * отозвать публикацию было нечем: запись жила в базе навсегда, и у всех
   * сотрудников горел значок обновления, которое ставить не надо.
   */
  app.delete('/api/updates/:version', requireOwnerMiddleware, mutationLock, async (req: Request, res: Response) => {
    const u = (req as any).authUser;
    if (!u || u.role !== 'OWNER') return res.status(403).json({ error: 'Отзыв релиза доступен только владельцу программы' });
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
   * Раздача опубликованного exe только из общей базы. Дисковый кэш
   * не участвует: публикация сверила подпись именно с байтами в БД.
   */
  app.get('/api/updates/download/:version', async (req: Request, res: Response) => {
    const version = sanitizeVersion(req.params.version);
    if (!version) return res.status(404).json({ error: 'Версия не указана' });

    try {
      const published = await deps.getPrisma().appUpdate.findUnique({ where: { version } });
      if (!published) return res.status(404).json({ error: 'Выпуск не опубликован или отозван' });
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

// Прежние имена остаются: проверки обновлений спрашивают их отсюда
export { CHUNK_MAX, CHUNK_MIN, chunkSizeFor };
