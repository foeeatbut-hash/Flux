/**
 * Файл расчёта → разобранное дерево.
 *
 * Отдельным модулем, а не в `server.ts`: то же чтение нужно фоновой очереди
 * (`server/importJobs.ts`), а копия означала бы, что однажды они разойдутся —
 * и файл, который открывается через предпросмотр, перестанет открываться в
 * фоне, причём по непонятной причине.
 *
 * Отказы здесь со словами и с советом: «файл .docx этим способом не
 * импортируется» человек читает и понимает, что делать, а «ошибка импорта» —
 * нет. Форма отказа общая с маршрутами (`{ status, error }`).
 */

import { getPrisma } from './context.js';
import { fileBytes } from './routes/fileChunks.js';
import { parseEquipmentXML, parseEquipmentExcel } from './equipmentParser.js';
import { importPolicyOfProject } from './routes/tagPolicy.js';
import type { KindMap } from './vezaDict.js';
import type { VezaOptions } from './vezaXml.js';

/** Общая настройка компании: виды узлов выгрузки, отнесённые к ролям людьми. */
export const KIND_MAP_KEY = 'veza_kind_map';

export async function kindMap(): Promise<KindMap> {
  try {
    const row = await getPrisma().appSetting.findFirst({ where: { key: KIND_MAP_KEY, userId: null } });
    const parsed = row?.value ? JSON.parse(row.value) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) { return {}; }
}

/**
 * Что разбору нужно знать о проекте: код проекта (по нему ищутся теги) и
 * правило написания. Без проекта файл тоже читается — для просмотра.
 */
export async function parseOptionsFor(projectId?: string): Promise<VezaOptions> {
  const [policy, kinds] = await Promise.all([
    projectId ? importPolicyOfProject(projectId) : Promise.resolve(undefined),
    kindMap(),
  ]);
  return { ...(policy ? { policy } : {}), kinds };
}

/** Что умеет этот путь. PDF, Word и сканы идут через мастер распознавания. */
export const CALC_EXTENSIONS = ['xlsx', 'xls', 'xml', 'csv'];

export async function readEquipmentFile(fileId: string, projectId?: string): Promise<{ result: any; fileName: string }> {
  const prisma = getPrisma();
  const fileNode = await prisma.fileNode.findUnique({ where: { id: fileId } });
  if (!fileNode) throw { status: 404, error: 'Файл не найден' };
  const buffer = await fileBytes(fileNode);
  if (!buffer.length) throw { status: 400, error: 'Содержимое файла пустое' };
  const extension = fileNode.name.split('.').pop()?.toLowerCase();

  if (!CALC_EXTENSIONS.includes(extension || '')) {
    throw {
      status: 400,
      error: `Файл .${extension} этим способом не импортируется. Откройте «Оборудование» → «Импорт из документов» — там поддерживаются PDF, Word, Excel и XML с распознаванием.`,
    };
  }

  let result;
  try {
    result = (extension === 'xml')
      ? parseEquipmentXML(buffer.toString('utf-8'), await parseOptionsFor(projectId))
      : parseEquipmentExcel(buffer);
  } catch {
    throw { status: 400, error: 'Не удалось прочитать файл как расчёт. Для бланков и опросных листов используйте «Оборудование» → «Импорт из документов».' };
  }
  if (!result.units.length) {
    throw { status: 400, error: 'Не удалось распознать оборудование в файле. Проверьте формат расчёта.' };
  }
  return { result, fileName: fileNode.name };
}
