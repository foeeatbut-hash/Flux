import { getDialect } from './ddl.js';

// Явное удаление всего, что принадлежит проекту.
//
// Зачем руками: в локальной SQLite внешние ключи есть у 4 таблиц из 103 (и то
// лишь у скрытых таблиц связей «многие ко многим»; у остальных связь — просто
// строка projectId/systemId/elementId), и каскад из схемы Prisma там не
// срабатывает. Одно `project.delete` оставляло
// теги, установки, моноблоки, позиции, источники XML, файлы и папки висеть без
// владельца, хотя уведомление обещало «всё удалено вместе с проектом».
//
// Работает на любом движке одинаково: только deleteMany по спискам id, порядок —
// от листьев к корню, поэтому настоящие внешние ключи MariaDB/PostgreSQL
// ничему не мешают, а их каскад просто не находит, что удалять.
//
// Чего НЕ трогаем (не принадлежит проекту): пользователей, справочники каталога
// (классы, производителей, семейства, бланки, профили импорта), заготовки
// таблиц и видов, общие настройки, обращения в обратную связь (там projectId —
// лишь контекст жалобы), журнал действий, личные заметки, Equipment.

export type RemovedCounts = Record<string, number>;

/** Ниже предела числа переменных в одном запросе SQLite (32766) с большим запасом. */
const CHUNK = 400;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

class Eraser {
  readonly removed: RemovedCounts = {};
  constructor(private readonly tx: any) {}

  private count(model: string, n: number) {
    if (n) this.removed[model] = (this.removed[model] || 0) + n;
  }

  /** Удалить по готовому условию */
  async where(model: string, where: any): Promise<void> {
    const r = await this.tx[model].deleteMany({ where });
    this.count(model, r.count);
  }

  /** Удалить строки, у которых поле входит в список (кусками — длинный IN ломает SQLite) */
  async within(model: string, field: string, ids: string[]): Promise<void> {
    for (const part of chunks(ids)) await this.where(model, { [field]: { in: part } });
  }

  /** Идентификаторы по условию */
  async ids(model: string, where: any): Promise<string[]> {
    const rows = await this.tx[model].findMany({ where, select: { id: true } });
    return rows.map((row: { id: string }) => row.id);
  }

  async idsWithin(model: string, field: string, ids: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const part of chunks(ids)) out.push(...(await this.ids(model, { [field]: { in: part } })));
    return out;
  }
}

/**
 * Связи «многие ко многим» Prisma держит в скрытых таблицах _X(A,B). В локальной
 * SQLite каскад по ним зависит от настройки соединения, поэтому чистим сами; на
 * серверных базах их внешние ключи настоящие, и лишний сырой запрос не нужен
 * (а ошибка в нём оборвала бы всю транзакцию PostgreSQL).
 */
async function dropJoinRows(tx: any, table: string, column: 'A' | 'B', ids: string[]): Promise<void> {
  if (getDialect() !== 'sqlite') return;
  for (const part of chunks(ids)) {
    await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "${column}" IN (${part.map(() => '?').join(',')})`, ...part);
  }
}

/**
 * Удаляет проект и всё его содержимое. Вызывать внутри транзакции; повторный
 * вызов для уже удалённого проекта ничего не находит и ничего не ломает.
 * `forgetFile` — освободить публикацию файла (таблицы общего доступа создаются
 * отдельным кодом, схемы Prisma их не знает).
 */
export async function deleteProjectData(
  tx: any,
  projectId: string,
  forgetFile?: (tx: any, fileId: string) => Promise<void>,
): Promise<RemovedCounts> {
  const e = new Eraser(tx);

  // ── Что принадлежит проекту: списки id, пока строки ещё на месте ──
  const tagIds = await e.ids('tag', { projectId });
  const systemIds = await e.ids('equipmentSystem', { projectId });
  const monoblockIds = await e.idsWithin('monoblock', 'systemId', systemIds);
  const elementIds = await e.idsWithin('componentElement', 'monoblockId', monoblockIds);
  const folderIds = await e.ids('folder', { projectId });
  const fileIds = await e.idsWithin('fileNode', 'folderId', folderIds);
  const docIds = await e.ids('constructorDoc', { projectId });
  const registerIds = await e.ids('docRegister', { projectId });
  const dictionaryIds = await e.ids('dictionary', { projectId });
  const xmlSourceIds = await e.ids('equipmentXmlSource', { projectId });
  const e3ProjectIds = await e.ids('e3Project', { fluxProjectId: projectId });
  const selectionListIds = await e.ids('selectionList', { projectId });
  const importBatchIds = await e.ids('importBatch', { projectId });
  const eventIds = await e.ids('calEvent', { projectId });
  const groupIds = await e.ids('chatGroup', { projectId });
  const groupMessageIds = await e.idsWithin('chatMessage', 'chatGroupId', groupIds);

  // ── Файлы и всё, что висит на файле ──
  const markupIds = await e.idsWithin('pdfMarkup', 'fileId', fileIds);
  await e.within('pdfMarkupTransfer', 'markupId', markupIds);
  await e.within('pdfMarkupTransfer', 'fileId', fileIds);
  await e.within('pdfMarkup', 'fileId', fileIds);
  await e.within('fileChunk', 'fileId', fileIds);
  await e.within('fileVersion', 'fileId', fileIds);
  await e.within('officeDocumentRevision', 'fileId', fileIds);
  await e.within('officeDocumentRevision', 'documentId', fileIds);
  await e.within('officeBlock', 'fileId', fileIds);
  await e.within('officeSession', 'fileId', fileIds);
  await e.within('officeEvent', 'fileId', fileIds);
  await e.within('officePeer', 'fileId', fileIds);
  await e.within('officeHolder', 'fileId', fileIds);
  if (forgetFile) for (const fileId of fileIds) await forgetFile(tx, fileId);
  await dropJoinRows(tx, '_FileMainTags', 'A', fileIds);
  await dropJoinRows(tx, '_FileAdditionalTags', 'A', fileIds);
  await e.within('fileNode', 'id', fileIds);
  await e.where('folder', { projectId });

  // ── Конструктор и реестр документов ──
  await e.within('constructorDocVersion', 'docId', docIds);
  await e.where('constructorDoc', { projectId });
  const itemIds = await e.ids('docRegisterItem', { projectId });
  itemIds.push(...(await e.idsWithin('docRegisterItem', 'registerId', registerIds)));
  await e.within('docRegisterItemRevision', 'itemId', [...new Set(itemIds)]);
  await e.where('docRegisterItem', { projectId });
  await e.within('docRegisterItem', 'registerId', registerIds);
  await e.where('docRegister', { projectId });

  // ── Справочники проекта ──
  await e.within('dictionaryItem', 'dictionaryId', dictionaryIds);
  await e.where('dictionary', { projectId });
  await e.where('tagTemplate', { projectId });
  await e.where('projectTagPolicy', { projectId });
  await e.where('docFormula', { projectId });

  // ── Оборудование: источники XML, позиции, моноблоки, установки ──
  await e.within('equipmentXmlApplication', 'sourceId', xmlSourceIds);
  await e.within('equipmentXmlApplication', 'elementId', elementIds);
  await e.where('equipmentXmlCandidate', { projectId });
  await e.within('equipmentXmlCandidate', 'sourceId', xmlSourceIds);
  await e.where('equipmentXmlSource', { projectId });
  await e.within('equipmentXmlSource', 'elementId', elementIds);
  await e.within('equipmentHistory', 'elementId', elementIds);
  // Сообщения чата со ссылкой на позицию остаются (схема: SetNull)
  for (const part of chunks(elementIds)) {
    await tx.chatMessage.updateMany({ where: { linkedElementId: { in: part } }, data: { linkedElementId: null } });
  }
  await dropJoinRows(tx, '_ComponentElementToTag', 'A', elementIds);
  await e.within('componentElement', 'monoblockId', monoblockIds);
  await e.within('monoblock', 'systemId', systemIds);
  await e.where('equipmentSystem', { projectId });

  // ── Теги, подбор, импорт, привязки к E3 ──
  await e.where('tagChange', { projectId });
  await e.within('tagChange', 'tagId', tagIds);
  await dropJoinRows(tx, '_ComponentElementToTag', 'B', tagIds);
  await dropJoinRows(tx, '_FileMainTags', 'B', tagIds);
  await dropJoinRows(tx, '_FileAdditionalTags', 'B', tagIds);
  await e.where('tag', { projectId });
  await e.where('selectionItem', { projectId });
  await e.where('selectionIssue', { projectId });
  await e.where('selectionBatch', { projectId });
  await e.within('selectionItem', 'listId', selectionListIds);
  await e.within('selectionIssue', 'listId', selectionListIds);
  await e.within('selectionBatch', 'listId', selectionListIds);
  await e.where('selectionList', { projectId });
  await e.where('importJob', { projectId });
  await e.within('importJob', 'batchId', importBatchIds);
  await e.where('importBatch', { projectId });
  await e.within('e3Binding', 'e3ProjectId', e3ProjectIds);
  await e.within('e3Export', 'e3ProjectId', e3ProjectIds);
  await e.where('e3Project', { fluxProjectId: projectId });

  // ── Перевод, календарь, помощник, состав ──
  await e.where('termEntry', { projectId });
  await e.where('tmUnit', { projectId });
  await e.where('transLink', { projectId });
  await e.within('calGuest', 'eventId', eventIds);
  await e.where('calEvent', { projectId });
  await e.where('assistantChat', { projectId });
  await e.where('projectMember', { projectId });

  // ── Чат проекта: группа и её переписка; личные сообщения лишь теряют ссылку ──
  await e.within('chatAttachment', 'messageId', groupMessageIds);
  await e.within('guideReply', 'messageId', groupMessageIds);
  await e.where('guideReply', { projectId });
  await e.within('chatMessage', 'chatGroupId', groupIds);
  await dropJoinRows(tx, '_GroupMembers', 'A', groupIds);
  await e.where('chatGroup', { projectId });
  await tx.chatMessage.updateMany({ where: { linkedProjectId: projectId }, data: { linkedProjectId: null } });

  // ── Настройки, привязанные к проекту или его позициям (AppSetting.key) ──
  await e.where('appSetting', { key: { in: [`e3_profile:${projectId}`, `e3_layout:${projectId}`] } });
  await e.within('appSetting', 'key', elementIds.map(id => `equipment_catalog_binding:${id}`));
  for (const part of chunks(elementIds, 100)) {
    await e.where('appSetting', { OR: part.map(id => ({ key: { startsWith: `equipment_catalog_history:${id}:` } })) });
  }

  // ── Сам проект ──
  await e.where('project', { id: projectId });
  return e.removed;
}
