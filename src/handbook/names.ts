/**
 * Русские названия того, что хранит программа.
 *
 * Руководство пишется для инженера, а не для того, кто эту программу делал.
 * Инженеру нужно знать, что удаление проекта уносит с собой теги, папки и
 * закупки, — и совершенно не нужно знать, что внутри они называются Tag,
 * Folder и DocRegisterItem. Раньше в разделе «что хранится» стояли ровно эти
 * английские слова, и человек упирался в них на первой же статье.
 *
 * Английские имена при этом никуда не делись: они по-прежнему записаны в
 * статьях и по-прежнему сверяются с базой данных набором проверок
 * (scripts/test-handbook.ts). Переименовали таблицу — проверка падает, статью
 * правят. Просто человеку показывается перевод, а не исходное имя.
 *
 * Отсюда правило: у каждого имени, встречающегося в статьях, должен быть
 * перевод. Отсутствие перевода — тоже провал проверки, иначе английские слова
 * начнут просачиваться обратно по одному.
 */

/** Что хранится: имя в базе → как это называют люди. */
export const THING_RU: Record<string, string> = {
  AppSetting: 'настройка программы',
  AppUpdate: 'обновление программы',
  ChatAttachment: 'файл из чата',
  ChatGroup: 'группа чата',
  ChatMessage: 'сообщение чата',
  ComponentElement: 'элемент оборудования',
  ConstructorDoc: 'таблица или текстовый документ',
  ConstructorDocVersion: 'версия книги',
  Dictionary: 'справочник значений',
  DictionaryItem: 'значение справочника',
  DocFormula: 'формула документа',
  DocRegister: 'ведомость документов',
  DocRegisterItem: 'строка ведомости',
  DocRegisterItemRevision: 'ревизия строки ведомости',
  DocStandard: 'стандарт документооборота',
  Equipment: 'оборудование',
  EquipmentHistory: 'история оборудования',
  EquipmentSystem: 'система оборудования',
  FeedbackAttachment: 'вложение обращения',
  FeedbackComment: 'сообщение в обращении',
  FeedbackEvent: 'событие обращения',
  FeedbackOutbox: 'очередь уведомлений об обращениях',
  FeedbackReadState: 'личная отметка «прочитано» в обращении',
  FeedbackReport: 'обращение',
  FeedbackUpload: 'загружаемый файл обращения',
  FileNode: 'файл',
  PdfMarkup: 'пометка на чертеже',
  Folder: 'папка',
  MailAccount: 'почтовый ящик',
  MailActivity: 'событие в переписке',
  MailAttachment: 'вложение письма',
  MailDraft: 'черновик письма',
  MailFolder: 'папка почты',
  MailMessage: 'письмо',
  MailSeenLocal: 'личная отметка «прочитано»',
  MailSignature: 'подпись в письме',
  MailSignatureImage: 'картинка в подписи',
  MailThreadState: 'состояние переписки',
  Monoblock: 'моноблок',
  NoteShare: 'доступ к заметке',
  Notification: 'уведомление',
  Project: 'проект',
  Role: 'роль сотрудника',
  SystemChangeLog: 'запись журнала изменений',
  Tag: 'тег',
  TagTemplate: 'шаблон обозначения',
  User: 'сотрудник',
  UserNote: 'заметка',
};

/**
 * Чем связаны. Служебные имена полей заменяем на то, что связь означает.
 *
 * Пары, где связь описана словами уже в самой статье («вложенные папки»),
 * оставляем как есть: переводить там нечего.
 */
export const LINK_RU: Record<string, string> = {
  // Записи из нескольких полей — целиком: по отдельности они читаются хуже
  'mainTags и additionalTags': 'помечен этими тегами',
  'senderId и receiverId': 'от кого и кому',
  'authorId и assigneeId': 'кто написал и кто разбирает',
  'reportId и userId — личная отметка прочтения': 'к какому обращению и чья отметка',

  accountId: 'лежит в этом ящике',
  reportId: 'к какому обращению',
  chatGroupId: 'написано в этой группе',
  createdById: 'кто создал',
  updatedById: 'кто изменил',
  dictionaryId: 'из этого справочника',
  docId: 'относится к этой книге',
  elementId: 'описывает этот элемент',
  equipmentId: 'указывает на это оборудование',
  folderId: 'лежит в этой папке',
  linkedElementId: 'привязано к этому элементу',
  messageId: 'относится к этому письму',
  monoblockId: 'входит в этот моноблок',
  fileId: 'на каком файле стоит',
  noteId: 'относится к этой заметке',
  ownerId: 'чьё это',
  parentId: 'вложено сюда',
  projectId: 'принадлежит этому проекту',
  registerId: 'входит в эту ведомость',
  systemId: 'входит в эту систему',
};

/** Русское имя хранимого; неизвестное отдаём как есть. */
export function thingRu(name: string): string {
  return THING_RU[name] || name;
}

/**
 * Русское описание связи.
 *
 * В статьях встречаются и составные записи вида «createdById и updatedById»
 * или «parentId — вложенные папки». Разбираем их по частям: имя поля
 * переводим, пояснение по-русски оставляем как есть.
 */
export function linkRu(via: string): string {
  const src = String(via || '').trim();
  if (!src) return '';
  if (LINK_RU[src]) return LINK_RU[src];

  // Пояснение после тире уже написано для человека
  const dash = src.split(/\s+—\s+/);
  if (dash.length > 1) return dash.slice(1).join(' — ');

  const parts = src.split(/\s+и\s+/).map((p) => p.trim());
  const named = parts.map((p) => LINK_RU[p]).filter(Boolean);
  if (named.length === parts.length) return named.join(' и ');

  // Не поле, а фраза («mainTags и additionalTags») — оставляем как написано
  return src;
}

/** Имена, у которых ещё нет перевода. Для набора проверок. */
export function missingNames(used: string[]): string[] {
  return used.filter((n) => !THING_RU[n]);
}
