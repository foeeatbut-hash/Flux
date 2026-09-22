/**
 * Распоряжения администратора платформы.
 *
 * Всё, что здесь есть, делается по праву `play.admin` — и только по нему.
 * Должность не значит ничего, как и во всей этой оси прав; отказ молчаливый —
 * тот же нейтральный «такого нет», которым платформа отвечает всем чужим.
 *
 * Четыре вещи, которые нужны, чтобы платформой можно было управлять, а не
 * только включить её:
 *
 *   — **обслуживание**: доиграть можно, начать новое нельзя. Это не то же
 *     самое, что выключатель: выключатель убирает раздел вместе с идущими
 *     матчами, а обслуживание даёт им закончиться;
 *   — **ключ издателя**: открытая часть ключа, которым подписаны описи сборок.
 *     Без него менеджер игр ничего не поставит, и это правильно;
 *   — **публикация сборки**: опись проверяется подписью ПЕРЕД записью в базу.
 *     Сервер подделать подпись не может — и в этом всё дело: неподписанная
 *     сборка не попадёт даже в каталог;
 *   — **зависшие матчи**: матч, застрявший в «выделяем сервер», — это лобби,
 *     из которого больше никогда нельзя начать. Их видно списком и снимают
 *     кнопкой, а не запросом в базу руками.
 */

import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { broadcast, getPrisma, upsertSetting } from '../context.js';
import { PLAY_ADMIN } from '../../play/features.js';
import { parseManifest } from '../../play/builds.js';
import { verifyManifest } from '../../play/node/signature.js';
import { PLAY_MAINTENANCE_KEY, invalidatePlatform, notThere, platformState, verdict } from './access.js';
import { DEFAULT_CHANNEL, PUBLISHER_KEY_SETTING, publisherKey } from './builds.js';
import { cancelSession } from './sessions.js';

/** Матч, выделяющий сервер дольше этого, — зависший, а не медленный */
const STUCK_ALLOCATING_MS = 5 * 60 * 1000;
/** А идущий дольше этого — забытый: столько не играет никто */
const STUCK_RUNNING_MS = 6 * 60 * 60 * 1000;

/** Разрешение на распоряжения. Отказ молчаливый — как и везде в платформе. */
async function mayManage(req: Request, res: Response): Promise<boolean> {
  const may = await verdict((req as any).authUser, PLAY_ADMIN);
  if (may.allowed) return true;
  notThere(res);
  return false;
}

export function registerPlayAdmin(app: Express): void {
  /**
   * Обслуживание.
   *
   * Идущие матчи не трогаем сознательно: человек, которого выкинуло из матча
   * ради обновления сервера, запомнит это надолго. Запрет стоит там, где матч
   * заводится (`claimSession`), а не только на кнопке в окне.
   */
  app.put('/api/play/maintenance', async (req: Request, res: Response) => {
    if (!await mayManage(req, res)) return;
    try {
      const want = req.body?.on === true;
      await upsertSetting(PLAY_MAINTENANCE_KEY, null, want ? '1' : '0');
      invalidatePlatform();
      try { broadcast('capabilities:changed', { at: Date.now() }); } catch (_) { /* догонит опросом */ }
      return res.json({ platform: await platformState() });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось переключить обслуживание', details: e?.message });
    }
  });

  /**
   * Ключ издателя сборок — открытая часть.
   *
   * Подписывающая часть в программу не попадает никогда: она живёт у владельца,
   * рядом с ключом лицензии. Сюда кладут только то, чем ПРОВЕРЯЮТ.
   */
  app.put('/api/play/publisher-key', async (req: Request, res: Response) => {
    if (!await mayManage(req, res)) return;
    const key = String(req.body?.publicKey || '').trim().toLowerCase();
    if (key && !/^[0-9a-f]{64}$/.test(key)) {
      return res.status(400).json({ error: 'Ключ должен быть 64 знаками шестнадцатеричной записи (ed25519)' });
    }
    try {
      await upsertSetting(PUBLISHER_KEY_SETTING, null, key);
      return res.json({ publisherKey: key });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось сохранить ключ', details: e?.message });
    }
  });

  /**
   * Выложить сборку.
   *
   * Подпись проверяется здесь, до записи: каталог, в котором лежит сборка без
   * подписи, — это каталог, по которому однажды поставят что угодно. Сервер
   * подписать сам не может, и это ровно то, что нужно.
   */
  app.post('/api/play/builds', async (req: Request, res: Response) => {
    if (!await mayManage(req, res)) return;
    try {
      const parsed = parseManifest(req.body?.manifest);
      if (!parsed.manifest) return res.status(400).json({ error: `Опись не принята: ${parsed.problem}` });

      const key = await publisherKey();
      if (!key) {
        return res.status(409).json({
          error: 'Сначала задайте открытый ключ издателя — иначе подпись описи проверить нечем',
        });
      }
      if (!verifyManifest(parsed.manifest, key)) {
        return res.status(400).json({ error: 'Подпись описи не сходится с ключом издателя' });
      }

      const url = String(req.body?.url || '').trim();
      if (!url) return res.status(400).json({ error: 'Не указан адрес сборки' });
      const channel = String(req.body?.channel || DEFAULT_CHANNEL);
      const manifest = parsed.manifest;
      const sizeBytes = manifest.files.reduce((s, f) => s + f.size, 0);

      const prisma = getPrisma();
      const was = await prisma.playBuild.findFirst({
        where: { gameId: manifest.gameId, channel, version: manifest.version },
      });
      const data = {
        gameId: manifest.gameId,
        channel,
        version: manifest.version,
        url,
        sha256: '',
        sizeBytes,
        manifestJson: JSON.stringify(manifest),
        publishedById: String((req as any).authUser?.id || ''),
        publishedAt: new Date(),
      };
      // Повторная выкладка той же версии — это исправление, а не вторая сборка:
      // уникальный индекс всё равно не дал бы завести вторую
      const row = was
        ? await prisma.playBuild.update({ where: { id: was.id }, data })
        : await prisma.playBuild.create({ data: { id: randomUUID(), ...data } });

      return res.json({ build: { id: row.id, gameId: row.gameId, channel: row.channel, version: row.version } });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось выложить сборку', details: e?.message });
    }
  });

  /** Что выложено — списком, для окна администратора. */
  app.get('/api/play/admin/builds', async (req: Request, res: Response) => {
    if (!await mayManage(req, res)) return;
    try {
      const rows = await getPrisma().playBuild.findMany({ orderBy: { publishedAt: 'desc' }, take: 50 });
      return res.json({
        builds: rows.map((r: any) => ({
          id: r.id, gameId: r.gameId, channel: r.channel, version: r.version,
          sizeBytes: Number(r.sizeBytes) || 0, publishedAt: new Date(r.publishedAt).getTime(),
        })),
        publisherKey: await publisherKey(),
      });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось прочитать каталог сборок', details: e?.message });
    }
  });

  /**
   * Зависшие матчи.
   *
   * «Зависший» здесь — не мнение, а срок: пять минут на выделение сервера и
   * шесть часов на сам матч. Оба числа с запасом: лучше не показать
   * подозрительный матч, чем предложить снять идущий.
   */
  app.get('/api/play/admin/sessions', async (req: Request, res: Response) => {
    if (!await mayManage(req, res)) return;
    try {
      const now = Date.now();
      const rows = await getPrisma().playSession.findMany({
        where: { state: { in: ['ALLOCATING', 'RUNNING'] } },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      const list = rows.map((r: any) => {
        const startedAt = new Date(r.startedAt || r.createdAt).getTime();
        const age = now - new Date(r.createdAt).getTime();
        const stuck = r.state === 'ALLOCATING'
          ? age > STUCK_ALLOCATING_MS
          : now - startedAt > STUCK_RUNNING_MS;
        return {
          id: r.id, gameId: r.gameId, state: r.state, lobbyId: r.lobbyId,
          createdAt: new Date(r.createdAt).getTime(), ageMs: age, stuck,
        };
      });
      return res.json({ sessions: list, stuck: list.filter((s: any) => s.stuck).length });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось прочитать список матчей', details: e?.message });
    }
  });

  /** Снять матч. Места освобождаются, лобби возвращается в подготовку. */
  app.post('/api/play/admin/cancel/:id', async (req: Request, res: Response) => {
    if (!await mayManage(req, res)) return;
    try {
      await cancelSession(String(req.params.id || ''), 'снят администратором');
      return res.json({ cancelled: true });
    } catch (e: any) {
      return res.status(500).json({ error: 'Не удалось снять матч', details: e?.message });
    }
  });
}
