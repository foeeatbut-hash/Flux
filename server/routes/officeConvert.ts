/**
 * Старая книга .xls и таблица .csv → копия .xlsx рядом, для Таблицы Flux Office.
 *
 * Таблица правит только .xlsx: её движок пишет журнал правок поверх частей
 * книги OOXML, а у .xls и .csv таких частей нет. Раньше эти файлы разбирал
 * Конструктор в свою запись в базе; его больше нет, и файл открывается так,
 * как сделал бы Excel с «Сохранить как»: рядом появляется «<имя>.xlsx», её и
 * открывает Таблица. Исходник не трогается — его могли прислать и ждать обратно
 * в том же виде.
 *
 * Повторное открытие не плодит копий: если рядом уже лежит «<имя>.xlsx», сделанная
 * из этого файла (метка в refId — ссылка «копия чего»), открывается она.
 *
 * Копия ложится рядом, если человек может писать в эту папку; иначе — в его
 * «Выгрузки»: смотреть чужую книгу можно и без права класть файлы к хозяину.
 */
import type { Express, Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { getPrisma, sendError } from '../context.js';
import { FILE_NOT_FOUND, canReadFile, personalScopeWhere, getMainAdminId } from '../fileAccess.js';
import { fileBytes } from './fileChunks.js';
import { createFileFromBytes, exportsHome, homeOfFile } from '../officeStore.js';

export interface OfficeConvertDeps {
  chunkBytes: () => Promise<number>;
  /** null — можно писать рядом с файлом; строка — почему нельзя */
  mayWrite: (req: Request, fileId: string) => Promise<string | null>;
}

const FROM = /\.(xls|csv)$/i;
const mark = (id: string) => `xlsx-of:${id}`;

/** Байты .xls/.csv → книга .xlsx. CSV читается как UTF-8, с разделителем по данным */
export function toXlsxBytes(name: string, bytes: Buffer): Buffer {
  const csv = /\.csv$/i.test(name);
  const wb = csv
    ? XLSX.read(bytes.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true })
    : XLSX.read(bytes, { type: 'buffer', cellStyles: true, cellDates: true });
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function registerOfficeConvertRoutes(app: Express, deps: OfficeConvertDeps): void {
  app.post('/api/office/files/:id/as-xlsx', async (req: Request, res: Response) => {
    const prisma = getPrisma();
    try {
      const user = (req as any).authUser;
      if (!user?.id) return res.status(401).json({ error: 'Требуется вход в систему' });
      const from = await prisma.fileNode.findUnique({ where: { id: String(req.params.id) } });
      // Чужой личный файл и файл закрытого проекта — «не найден»: ответ 403
      // подтверждал, что такой номер существует, а конвертация отдавала бы
      // содержимое чужого файла копией в свои «Выгрузки»
      if (!from || from.deletedAt || !(await canReadFile(prisma, user, from))) return res.status(404).json({ error: FILE_NOT_FOUND });
      if (!FROM.test(from.name || '')) return res.status(400).json({ error: 'Копию .xlsx делаем только из .xls и .csv' });

      const done = await prisma.fileNode.findFirst({
        where: { refId: mark(from.id), deletedAt: null, ...personalScopeWhere(user, await getMainAdminId(prisma)) },
        select: { id: true, name: true, folderId: true },
      });
      if (done) return res.json({ ...done, existed: true });

      let body: Buffer;
      try { body = toXlsxBytes(from.name, await fileBytes(from)); } catch (e: any) {
        return res.status(422).json({ error: `Файл не читается как таблица: ${e?.message || e}` });
      }
      const nearby = !(await deps.mayWrite(req, from.id));
      const home = (nearby && await homeOfFile(from.id)) || await exportsHome(user.id, null);
      const file = await createFileFromBytes({
        name: from.name.replace(FROM, '.xlsx'), body, home, userId: user.id, chunkBytes: await deps.chunkBytes(),
        type: 'XLSX', refId: mark(from.id),
      });
      res.json({ ...file, existed: false, nearby });
    } catch (err: any) { sendError(res, err); }
  });
}
