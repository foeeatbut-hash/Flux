/**
 * Принесённый файл становится документом Конструктора.
 *
 * Отдельным модулем, потому что здесь встретились два пути и один из них
 * оказался сломан навсегда.
 *
 * Разбор офисных файлов теперь делает окно (src/lib/officeOpen.ts): здешняя
 * ветка для docx звала библиотеку из зависимостей для разработки, а сервер
 * берёт библиотеки из папки зависимостей во время работы — и в собранной
 * программе их там нет. У сотрудника эта ветка отвечала «разбор недоступен в
 * этой сборке» ВСЕГДА, у разработчика работала: поломка не показывалась тому,
 * кто её сделал. Поэтому если окно прислало разобранное — верим ему и второй
 * раз не разбираем.
 *
 * Серверный разбор остаётся запасным путём: им пользуется «Редактировать
 * копию» для таблиц и текстовых файлов, где разбор в базе не подводит.
 */
import type { Express, Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { getPrisma, resolveProjectId, sendError } from '../context.js';

export interface ImportFileDeps {
  /** Зеркало документа в Проводнике: документ должен быть виден и там */
  syncMirror: (doc: any) => void;
  /** Кто спрашивает — берётся из проверенного токена, а не из тела запроса */
  authUserOf: (req: Request) => any;
}

export function registerImportFileRoute(app: Express, deps: ImportFileDeps): void {
  const { syncMirror, authUserOf } = deps;

  // ── «Редактировать копию»: документ студии из файла Проводника ──
  // Исходный файл не изменяется — регистр выданной документации неприкосновенен.
  // xlsx/xlsm/csv → таблица (DOC), txt/md → текст (TEXT, содержимое вставит
  // редактор при первом открытии), docx → текст без сложной вёрстки (mammoth).
  /**
   * Разобранное окном приходит готовым.
   *
   * Разбор офисных файлов переехал в окно (src/lib/officeOpen.ts): здешняя
   * ветка для docx звала библиотеку из зависимостей для разработки, которых в
   * собранной программе нет, — и у сотрудника отвечала «разбор недоступен в
   * этой сборке» всегда, а у разработчика работала. Серверный разбор остаётся
   * запасным путём (им пользуется «Редактировать копию» для txt и csv), но
   * если окно прислало готовое — верим ему и не разбираем второй раз.
   */
  app.post('/api/constructor/docs/import-file', async (req: Request, res: Response) => {
    try {
      const me = authUserOf(req);
      const prisma = getPrisma();
      const file = await prisma.fileNode.findUnique({ where: { id: String(req.body?.fileId || '') } });
      if (!file || !file.content) return res.status(404).json({ error: 'Файл не найден или пуст' });
      const projectId = await resolveProjectId(String(req.body?.projectId || ''));

      const readyBook = typeof req.body?.workbook === 'string' ? req.body.workbook : '';
      const readyText = typeof req.body?.importText === 'string' ? req.body.importText : '';
      if (readyBook || readyText) {
        const named = String(req.body?.name || file.name.replace(/\.[^.]+$/, ''));
        const doc = await prisma.constructorDoc.create({
          data: {
            projectId,
            name: named,
            named: true,
            kind: readyBook ? 'DOC' : 'TEXT',
            scope: (file as any).scope === 'PERSONAL' ? 'PERSONAL' : 'SHARED',
            ownerId: (file as any).ownerId || me?.id || null,
            createdById: me?.id || null,
            updatedById: me?.id || null,
            workbook: readyBook,
            ...(readyText ? { bindings: JSON.stringify({ importText: readyText }) } : {}),
          },
        });
        // Файл и документ связываются навсегда: без этого каждое открытие
        // заводило бы новую копию, и вчерашних правок человек бы не нашёл —
        // он открыл бы «тот же файл» и увидел исходник
        try {
          await prisma.fileNode.update({ where: { id: file.id }, data: { refId: doc.id, type: 'CONSTRUCTOR' } });
        } catch (_) { /* связь — удобство, а не условие открытия */ }
        syncMirror(doc);
        return res.json({ doc });
      }

      let b64 = String(file.content);
      if (b64.includes(',')) b64 = b64.split(',')[1];
      const buf = Buffer.from(b64, 'base64');
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const baseName = file.name.replace(/\.[^.]+$/, '');

      let kind = 'TEXT';
      let workbook = '';
      let bindings = '';

      if (['xlsx', 'xlsm', 'xls', 'csv'].includes(ext)) {
        // Таблица: SheetJS → минимальный снапшот книги Univer (значения ячеек)
        kind = 'DOC';
        const wb = XLSX.read(buf, { type: 'buffer' });
        const sheets: any = {};
        const order: string[] = [];
        wb.SheetNames.forEach((sn, i) => {
          const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sn], { header: 1, blankrows: true, defval: '' }) as any[][];
          const id = `s${i + 1}`;
          const cellData: any = {};
          let maxC = 0;
          aoa.forEach((row, r) => (row || []).forEach((v, c) => {
            if (v !== undefined && v !== null && v !== '') {
              (cellData[r] ||= {})[c] = { v };
              if (c > maxC) maxC = c;
            }
          }));
          sheets[id] = { id, name: sn || `Лист${i + 1}`, cellData, rowCount: Math.max(100, aoa.length + 30), columnCount: Math.max(26, maxC + 10) };
          order.push(id);
        });
        workbook = JSON.stringify({ name: baseName, sheetOrder: order, sheets });
      } else if (['txt', 'md', 'log', 'json'].includes(ext)) {
        // Текст: содержимое вставит редактор при первом открытии (appendText)
        bindings = JSON.stringify({ importText: buf.toString('utf-8') });
      } else if (ext === 'docx') {
        try {
          const mammoth = require('mammoth');
          const r = await mammoth.extractRawText({ buffer: buf });
          bindings = JSON.stringify({ importText: String(r?.value || '') });
        } catch (e: any) {
          return res.status(400).json({ error: 'Разбор DOCX недоступен в этой сборке — сложная вёрстка будет в следующей фазе' });
        }
      } else {
        return res.status(400).json({ error: `Формат .${ext} пока не открывается в Flux Office` });
      }

      const doc = await prisma.constructorDoc.create({
        data: {
          projectId,
          name: `${baseName} (копия)`,
          named: true,
          kind,
          scope: 'SHARED',
          ownerId: me?.id || null,
          createdById: me?.id || null,
          updatedById: me?.id || null,
          workbook,
          ...(bindings ? { bindings } : {}),
        },
      });
      syncMirror(doc);
      res.json({ doc });
    } catch (err: any) { sendError(res, err); }
  });
}
