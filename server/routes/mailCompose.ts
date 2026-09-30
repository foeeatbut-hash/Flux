import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getPrisma, sendError } from '../context.js';
import { readableAccount, addActivity } from '../mail/access.js';
import { sendMail, replySubject, forwardSubject, splitAddrs } from '../mail/send.js';

/**
 * Написать и отправить письмо, а также подписи сотрудника.
 *
 * Подпись личная: сотрудник заводит её себе сам и может завести несколько —
 * с общей почты компании подписываются иначе, чем со своей. Подпись с общего
 * ящика тоже личная: письмо ушло от компании, но написал его человек, и
 * получателю важно знать, кто именно.
 */

const str = (v: any, max = 300) => String(v ?? '').trim().slice(0, max);
const bigStr = (v: any, max = 200000) => String(v ?? '').slice(0, max);

export interface ComposeDeps { userDataPath: string }

const sigDir = (base: string) => path.join(base, 'mail_sig');

/** Разрешённые картинки подписи: только настоящие изображения. */
const IMAGE_TYPES: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg',
};

export function registerMailComposeRoutes(app: Express, deps: ComposeDeps): void {
  // ── Подписи ───────────────────────────────────────────────────────────────
  app.get('/api/mail/signatures', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.json({ signatures: [], images: [] });
      const [signatures, images] = await Promise.all([
        prisma.mailSignature.findMany({ where: { ownerId: me.id }, orderBy: { createdAt: 'asc' } }),
        prisma.mailSignatureImage.findMany({ where: { ownerId: me.id }, orderBy: { createdAt: 'desc' } }),
      ]);
      res.json({
        signatures,
        images: images.map((i: any) => ({
          id: i.id, fileName: i.fileName, mimeType: i.mimeType, size: i.size, width: i.width,
          url: `/mail_sig/${i.id}/${encodeURIComponent(i.fileName)}`,
        })),
      });
    } catch (err) { sendError(res, err); }
  });

  app.post('/api/mail/signatures', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const isDefault = req.body?.isDefault === true;
      const accountId = str(req.body?.accountId, 60);
      // Подпись по умолчанию одна на ящик: две «главных» — это ошибка,
      // из которой потом непонятно, какая подставится
      if (isDefault) {
        await prisma.mailSignature.updateMany({
          where: { ownerId: me.id, accountId }, data: { isDefault: false },
        });
      }
      const sig = await prisma.mailSignature.create({
        data: {
          ownerId: me.id,
          accountId,
          name: str(req.body?.name, 80) || 'Подпись',
          html: bigStr(req.body?.html, 20000),
          isDefault,
        },
      });
      res.json({ signature: sig });
    } catch (err) { sendError(res, err); }
  });

  app.put('/api/mail/signatures/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      const sig = await prisma.mailSignature.findUnique({ where: { id: req.params.id } });
      if (!sig || !me || sig.ownerId !== me.id) return res.status(404).json({ error: 'Подпись не найдена' });

      const data: any = {};
      const b = req.body || {};
      if (b.name !== undefined) data.name = str(b.name, 80) || 'Подпись';
      if (b.html !== undefined) data.html = bigStr(b.html, 20000);
      if (b.accountId !== undefined) data.accountId = str(b.accountId, 60);
      if (b.isDefault !== undefined) {
        data.isDefault = b.isDefault === true;
        if (data.isDefault) {
          await prisma.mailSignature.updateMany({
            where: { ownerId: me.id, accountId: data.accountId ?? sig.accountId, id: { not: sig.id } },
            data: { isDefault: false },
          });
        }
      }
      const next = await prisma.mailSignature.update({ where: { id: sig.id }, data });
      res.json({ signature: next });
    } catch (err) { sendError(res, err); }
  });

  app.delete('/api/mail/signatures/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      const sig = await prisma.mailSignature.findUnique({ where: { id: req.params.id } });
      if (!sig || !me || sig.ownerId !== me.id) return res.status(404).json({ error: 'Подпись не найдена' });
      await prisma.mailSignature.delete({ where: { id: sig.id } });
      res.json({ ok: true });
    } catch (err) { sendError(res, err); }
  });

  /** Картинка для подписи: логотип компании, скан подписи. */
  app.post('/api/mail/signatures/image', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const mimeType = str(req.body?.mimeType, 60);
      const ext = IMAGE_TYPES[mimeType];
      if (!ext) return res.status(400).json({ error: 'Такие картинки не подходят: нужен PNG, JPEG, GIF, WebP или SVG' });

      const base64 = String(req.body?.data || '').replace(/^data:[^,]+,/, '');
      const buf = Buffer.from(base64, 'base64');
      if (!buf.length) return res.status(400).json({ error: 'Пустой файл' });
      // Логотип в письме — это килобайты, а не мегабайты: большая картинка
      // раздувает каждое отправленное письмо и часть служб её обрежет
      if (buf.length > 512 * 1024) {
        return res.status(400).json({ error: 'Картинка тяжелее 512 КБ. Для логотипа в письме это много — уменьшите её.' });
      }

      const id = crypto.randomUUID();
      const safeName = (str(req.body?.fileName, 80) || `logo${ext}`).replace(/[\\/:*?"<>|]/g, '_');
      const dir = path.join(sigDir(deps.userDataPath), id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, safeName), buf);

      const img = await prisma.mailSignatureImage.create({
        data: {
          id, ownerId: me.id, fileName: safeName, mimeType, size: buf.length,
          filePath: path.join(id, safeName),
          width: Math.max(0, Math.min(1200, Number(req.body?.width) || 0)),
        },
      });
      res.json({ image: { id: img.id, fileName: img.fileName, size: img.size, width: img.width, url: `/mail_sig/${img.id}/${encodeURIComponent(img.fileName)}` } });
    } catch (err) { sendError(res, err); }
  });

  app.delete('/api/mail/signatures/image/:id', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      const img = await prisma.mailSignatureImage.findUnique({ where: { id: req.params.id } });
      if (!img || !me || img.ownerId !== me.id) return res.status(404).json({ error: 'Картинка не найдена' });
      await prisma.mailSignatureImage.delete({ where: { id: img.id } });
      try { fs.rmSync(path.join(sigDir(deps.userDataPath), img.id), { recursive: true, force: true }); } catch (_) { /* уже удалена */ }
      res.json({ ok: true });
    } catch (err) { sendError(res, err); }
  });

  // ── Заготовка ответа ──────────────────────────────────────────────────────
  //
  // Кому, тема и цитата считаются на сервере: там лежат заголовки письма и
  // адрес самого ящика, без которого «ответить всем» отправит письмо и себе.
  app.get('/api/mail/compose/prepare', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      const mode = str(req.query.mode as string, 20) || 'NEW';
      const accountId = str(req.query.accountId as string, 60);
      const access = await readableAccount(req, accountId);
      if (!access || !me) return res.status(404).json({ error: 'Ящик не найден' });

      // Подпись: своя для этого ящика, иначе общая своя
      const sigs = await prisma.mailSignature.findMany({ where: { ownerId: me.id } });
      const signature =
        sigs.find((s: any) => s.accountId === accountId && s.isDefault)
        || sigs.find((s: any) => !s.accountId && s.isDefault)
        || null;

      if (mode === 'NEW') {
        return res.json({ draft: { to: '', cc: '', subject: '', quote: '', mode }, signature });
      }

      const src = await prisma.mailMessage.findUnique({ where: { id: str(req.query.messageId as string, 60) } });
      if (!src || src.accountId !== accountId) return res.status(404).json({ error: 'Письмо не найдено' });

      const mine = String(access.acc.email || '').toLowerCase();
      const notMe = (a: string) => a && !a.toLowerCase().includes(mine);

      let to = '';
      let cc = '';
      if (mode === 'REPLY') {
        to = src.fromAddr ? `${src.fromName ? `${src.fromName} <${src.fromAddr}>` : src.fromAddr}` : '';
      } else if (mode === 'REPLY_ALL') {
        to = src.fromAddr || '';
        // Себя из копии убираем: иначе каждый ответ приходит и себе самому
        cc = [...splitAddrs(src.toAddrs), ...splitAddrs(src.ccAddrs)].filter(notMe).join(', ');
      }

      const subject = mode === 'FORWARD' ? forwardSubject(src.subject) : replySubject(src.subject);
      const when = new Date(src.sentAt).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });
      // Имя и адрес отправителя пишет сам отправитель — это чужой текст, как
      // и тема. Без экранирования имя вида «<img onerror=…>» становилось
      // разметкой в окне ответа и выполнялось в программе
      const who = src.fromName
        ? `${escapeHtml(src.fromName)} &lt;${escapeHtml(src.fromAddr || '')}&gt;`
        : escapeHtml(src.fromAddr || '');
      const quote = mode === 'FORWARD'
        ? `<p>---------- Пересланное письмо ----------<br>От: ${who}<br>Дата: ${when}<br>Тема: ${escapeHtml(src.subject)}</p>`
        : `<p>${when}, ${who} пишет:</p>`;

      res.json({
        draft: {
          to, cc, subject, quote, mode,
          inReplyToId: src.id,
        },
        signature,
      });
    } catch (err) { sendError(res, err); }
  });

  // ── Отправка ──────────────────────────────────────────────────────────────
  app.post('/api/mail/send', async (req: Request, res: Response) => {
    try {
      const prisma = getPrisma();
      const me = (req as any).authUser;
      if (!me) return res.status(401).json({ error: 'Требуется вход' });

      const accountId = str(req.body?.accountId, 60);
      const access = await readableAccount(req, accountId);
      if (!access) return res.status(404).json({ error: 'Ящик не найден' });

      const inReplyToId = str(req.body?.inReplyToId, 60);
      const src = inReplyToId
        ? await prisma.mailMessage.findUnique({ where: { id: inReplyToId } })
        : null;

      const files = Array.isArray(req.body?.files)
        ? req.body.files.slice(0, 20).map((f: any) => ({
            fileName: str(f?.fileName, 200) || 'файл',
            filePath: String(f?.filePath || ''),
            mimeType: str(f?.mimeType, 80),
          })).filter((f: any) => f.filePath && fs.existsSync(f.filePath))
        : [];

      const result = await sendMail(accountId, {
        to: bigStr(req.body?.to, 2000),
        cc: bigStr(req.body?.cc, 2000),
        bcc: bigStr(req.body?.bcc, 2000),
        subject: str(req.body?.subject, 300),
        html: bigStr(req.body?.html, 500000),
        files,
        replyTo: src ? { messageId: src.messageId, refs: src.refs, subject: src.subject } : null,
      }, sigDir(deps.userDataPath));

      if (!result.ok) return res.status(400).json({ error: result.error });

      // Ответ помечаем и у себя: в списке сразу видно, что письмо отвечено
      if (src) {
        await prisma.mailMessage.update({ where: { id: src.id }, data: { answered: true } }).catch(() => null);

        // Общий ящик: девять остальных должны видеть, кто ответил — иначе
        // на письмо ответят дважды или не ответят вовсе
        if (access.shared && src.threadKey) {
          const state = await prisma.mailThreadState.findFirst({
            where: { accountId, threadKey: src.threadKey },
          });
          const data = {
            repliedById: me.id, repliedByName: me.name || me.symbol || '',
            repliedAt: new Date(), status: 'ANSWERED',
          };
          if (state) await prisma.mailThreadState.update({ where: { id: state.id }, data });
          else await prisma.mailThreadState.create({ data: { accountId, threadKey: src.threadKey, ...data } });
          await addActivity(accountId, src.threadKey, me, 'REPLIED', str(req.body?.subject, 200));
        }
      }

      res.json({
        ok: true,
        messageId: result.messageId,
        appended: result.appended,
        // Письмо ушло, но копия в «Отправленные» не легла — это стоит сказать
        warning: result.appended ? '' : 'Письмо отправлено, но копия в «Отправленные» не сохранилась.',
      });
    } catch (err) { sendError(res, err); }
  });
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
