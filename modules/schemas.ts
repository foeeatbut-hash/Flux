import Ajv from 'ajv';
import { resources, themeKeys } from './contract';
import { HTTP_METHODS, CONNECT_ERROR_CODES } from './connections/model';
import { permissionsValid } from './permissions/registry';
import { parseExports, PROGRAM_ERROR_CODES } from './programs/model';
import { COMPUTE_ERROR_CODES, LANGUAGES, PLATFORMS, SOURCE_LANGUAGES, LOGIC_FILES } from './engine/types';

import { text, id, nullableId, array, object, dataSchemas } from './dataSchemas';
export { dataSchemas };
const envelope = { flux: { const: 'module' }, v: { const: 1 }, session: id };
const encoding = { enum: ['utf8', 'base64'] };
const dlgText = (max: number) => ({ type: 'string', minLength: 1, maxLength: max });
const socketId = { type: 'string', minLength: 1, maxLength: 64 };
const memberName = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$' };
const comArgs = { type: 'array', maxItems: 32 };
const handle = { type: 'integer', minimum: 1, maximum: 1_000_000 };
const callSchema = (op: string, properties: Record<string, object>, required: string[] = []) =>
  object({ op: { const: op }, ...properties }, ['op', ...required]);
// Вызов подключения: ровно эти формы. Адрес в вызове не передаётся вовсе — только путь внутри объявленного префикса
export const connectCallSchemas = [
  callSchema('http', { method: { enum: [...HTTP_METHODS] }, path: { type: 'string', maxLength: 2048 }, headers: { type: 'object', maxProperties: 32 },
    body: { type: 'string', maxLength: 700_000 }, encoding }, ['method', 'path']),
  callSchema('ws-open', { path: { type: 'string', maxLength: 2048 } }, ['path']),
  callSchema('ws-send', { socket: socketId, data: { type: 'string', maxLength: 700_000 }, encoding }, ['socket', 'data']),
  callSchema('ws-recv', { socket: socketId, timeoutMs: { type: 'integer', minimum: 0, maximum: 25_000 } }, ['socket']),
  callSchema('ws-close', { socket: socketId }, ['socket']),
  callSchema('com-open', {}),
  callSchema('com-call', { handle, name: memberName, args: comArgs }, ['handle', 'name']),
  callSchema('com-get', { handle, name: memberName, args: comArgs }, ['handle', 'name']),
  callSchema('com-set', { handle, name: memberName, value: {}, args: comArgs }, ['handle', 'name', 'value']),
  callSchema('com-release', { handle }, ['handle']),
  callSchema('com-batch', { calls: { type: 'array', minItems: 1, maxItems: 200, items: object({ kind: { enum: ['call', 'get', 'set'] }, handle, name: memberName, args: comArgs, value: {} }, ['kind', 'handle', 'name']) } }, ['calls']),
];

// Эти JSON Schema — источник проверки сообщений и будущих типов редактора Studio.
export const messageSchemas = {
  ready: object({ ...envelope, type: { const: 'ready' } }),
  failure: object({ ...envelope, type: { const: 'failure' }, kind: { enum: ['crash', 'timeout', 'memory', 'bridge', 'controls', 'connection'] } }),
  read: object({ ...envelope, id, type: { const: 'read' }, resource: { enum: resources }, entityId: id }, ['flux', 'v', 'session', 'id', 'type', 'resource']),
  write: object(
    { ...envelope, id, type: { const: 'write' }, resource: { enum: resources }, entityId: id, data: {} },
    ['flux', 'v', 'session', 'id', 'type'],
  ),
  result: { anyOf: resources.map(resource => object({
    ...envelope, id, type: { const: 'result' }, resource: { const: resource }, data: dataSchemas[resource],
  })) },
  // Расчёт на любом языке: модуль присылает вход, Flux выбирает механизм по подписанному манифесту,
  // проверяет выход по схеме и возвращает его (modules/engine). Какой язык — модуль не указывает.
  compute: object({ ...envelope, id, type: { const: 'compute' }, input: { type: 'object' } }),
  'compute-result': object({
    ...envelope, id, type: { const: 'compute-result' },
    output: object({ state: { type: 'object' }, calc: object({ out: { type: 'object' } }) }),
  }),
  // Сообщение самой программы в журнал (flux.log): уровень и короткая строка, ответа нет
  log: object({ ...envelope, type: { const: 'log' }, level: { enum: ['info', 'warn', 'error'] }, text: { type: 'string', maxLength: 200 } }),
  // Подключение к внешней программе (этап 3б): подключение названо по `id` из манифеста, сквозной вызов идёт как есть
  connect: object({ ...envelope, id, type: { const: 'connect' }, connection: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' }, call: { oneOf: connectCallSchemas } }),
  // Обращение по полному адресу (flux.net.fetch(url)): нужен `internet` или `lan` в манифесте; какой именно — решает адрес, в который разрешилось имя
  // Метод лежит внутри `call`, как у connect: верхний уровень с POST/PUT мост принял бы за запись в данные Flux
  net: object({ ...envelope, id, type: { const: 'net' }, call: object({ url: { type: 'string', minLength: 8, maxLength: 2048 }, method: { enum: [...HTTP_METHODS] },
    headers: { type: 'object', maxProperties: 32 }, body: { type: 'string', maxLength: 700_000 }, encoding }, ['url', 'method']) }),
  // Обращение к другой программе (flux.programs.call): метод лежит внутри `call`, а не на верхнем уровне — как у net
  program: object({ ...envelope, id, type: { const: 'program' }, call: object({ program: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
    method: { type: 'string', pattern: '^[a-z][A-Za-z0-9]{0,39}$' }, data: {} }, ['program', 'method']) }),
  'program-result': object({ ...envelope, id, type: { const: 'program-result' }, data: {} }),
  'program-error': object({ ...envelope, id, type: { const: 'program-error' }, code: { enum: [...PROGRAM_ERROR_CODES] } }),
  'connect-result': object({ ...envelope, id, type: { const: 'connect-result' }, data: {} }),
  'connect-error': object({ ...envelope, id, type: { const: 'connect-error' }, code: { enum: [...CONNECT_ERROR_CODES] } }),
  'compute-error': object({ ...envelope, id, type: { const: 'compute-error' }, code: { enum: [...COMPUTE_ERROR_CODES] } }),
  // Действия страницы (договор v2): состояние окна, файл пользователю, сигнал «жива»
  page: { oneOf: [
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'state-load' } }),
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'state-keep' }, state: { type: 'object' } }),
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'file-offer' }, name: { type: 'string', minLength: 1, maxLength: 100 },
      mime: { type: 'string', maxLength: 100 }, data: { type: 'string', maxLength: 700_000 }, encoding }, ['flux', 'v', 'session', 'id', 'type', 'op', 'name', 'data', 'encoding']),
    // Прикрепить результат к проекту (заложено): форма как у file-offer; обрабатывает только отказом (FORBIDDEN / UNAVAILABLE)
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'attach' }, name: { type: 'string', minLength: 1, maxLength: 100 },
      mime: { type: 'string', maxLength: 100 }, data: { type: 'string', maxLength: 700_000 }, encoding }, ['flux', 'v', 'session', 'id', 'type', 'op', 'name', 'data', 'encoding']),
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'file-pick' }, accept: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^\\.[A-Za-z0-9]{1,10}$' } } }, ['flux', 'v', 'session', 'id', 'type', 'op']),
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'beat' } }),
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'window-open' }, page: { type: 'string', maxLength: 160 }, params: { type: 'object' },
      options: object({ title: { type: 'string', maxLength: 80 }, width: { type: 'integer', minimum: 320, maximum: 16_384 }, height: { type: 'integer', minimum: 240, maximum: 16_384 } }, []) }, ['flux', 'v', 'session', 'id', 'type', 'op', 'page']),
    // Диалоги и заголовок окна (добавлено к v2). Пределы длины — DIALOG_LIMITS / WINDOW_OPTION_LIMITS в modules/page/model.ts
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'dialog-confirm' }, title: dlgText(80), text: { type: 'string', maxLength: 600 },
      ok: dlgText(30), cancel: dlgText(30), danger: { type: 'boolean' } }, ['flux', 'v', 'session', 'id', 'type', 'op', 'title', 'text']),
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'dialog-alert' }, title: dlgText(80), text: { type: 'string', maxLength: 600 } },
      ['flux', 'v', 'session', 'id', 'type', 'op', 'title', 'text']),
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'dialog-prompt' }, title: dlgText(80), text: { type: 'string', maxLength: 600 }, label: dlgText(80),
      value: { type: 'string', maxLength: 1000 }, maxLength: { type: 'integer', minimum: 1, maximum: 1000 } }, ['flux', 'v', 'session', 'id', 'type', 'op', 'title', 'label']),
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'window-title' }, text: { type: 'string', maxLength: 80 } }, ['flux', 'v', 'session', 'id', 'type', 'op', 'text']),
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'window-unsaved' }, unsaved: { type: 'boolean' }, text: { type: 'string', maxLength: 200 } }, ['flux', 'v', 'session', 'id', 'type', 'op', 'unsaved']),
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'params-load' } }),
    object({ ...envelope, id, type: { const: 'page' }, op: { const: 'channel-send' }, data: {} }),
  ] },
  'page-message': object({ ...envelope, type: { const: 'page-message' }, data: {} }),
  'page-result': object({ ...envelope, id, type: { const: 'page-result' }, data: {} }),
  'page-error': object({ ...envelope, id, type: { const: 'page-error' }, code: { enum: ['DENIED', 'LIMIT', 'FAILED', 'CANCELLED', 'FORBIDDEN', 'UNAVAILABLE'] } }),
  error: object({ ...envelope, id, type: { const: 'error' }, code: { enum: ['READ_ONLY', 'DENIED', 'NO_PROJECT', 'FAILED', 'LIMIT'] } }),
  event: object({
    ...envelope, type: { const: 'event' }, event: { enum: ['opened', 'project-changed', 'changed'] },
    context: object({ projectId: nullableId, entry: { enum: ['start', 'equipment', 'tag'] }, entityId: nullableId }),
    theme: object(Object.fromEntries(themeKeys.map(key => [key, { type: 'string', maxLength: 200 }]))),
  }),
};
const ajv = new Ajv({ allErrors: false, strict: false });
const validators = Object.fromEntries(Object.entries(messageSchemas).map(([key, schema]) => [key, ajv.compile(schema)]));
export function validMessage(type: keyof typeof messageSchemas, value: unknown): boolean {
  return !!validators[type](value);
}
const shortText = (max: number) => ({ type: 'string', maxLength: max });
const storeBlock = object({
  category: { enum: ['calc', 'link', 'docs', 'reports', 'other'] }, summary: shortText(200), description: shortText(4000),
  color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
  requires: object({
    flux: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' }, platform: { enum: ['any', 'windows'] },
    external: { type: 'array', maxItems: 10, items: shortText(80) },
  }, []),
  dependsOn: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' } },
  roles: { type: 'array', maxItems: 20, uniqueItems: true, items: shortText(64) },
  screenshots: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: '^store/[A-Za-z0-9_-]{1,40}\\.(png|jpg|webp)$' } },
}, ['category', 'summary']);
export const manifestSchema = object({
  id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }, name: text, author: text,
  version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' }, contractVersion: { enum: [1, 2, 3] },
  entries: { type: 'array', uniqueItems: true, items: { enum: ['start', 'equipment', 'tag'] } },
  reads: { type: 'array', uniqueItems: true, items: { enum: resources } }, logic: { enum: Object.values(LOGIC_FILES) },
  language: { enum: [...LANGUAGES] }, sourceLanguage: { enum: [...SOURCE_LANGUAGES] }, platform: { enum: [...PLATFORMS] },
  store: storeBlock,
  // Форма каждого подключения и запрет опасных объектов проверяет parseConnections (modules/connections/model.ts): схема тут только отсекает не массив
  connections: { type: 'array', maxItems: 8, items: { type: 'object' } },
  // Форму каждого разрешения проверяет реестр (modules/permissions/registry.ts)
  permissions: { type: 'array', maxItems: 16, items: { type: 'object' } },
  // Методы для других программ (modules/programs/model.ts): форму каждого проверяет parseExports
  exports: { type: 'array', maxItems: 16, items: { type: 'object' } },
  ui: { const: 'page' },
  pages: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', pattern: '^(?:[A-Za-z0-9_][A-Za-z0-9_-]{0,63}/){0,4}[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\\.html$' } },
}, ['id', 'name', 'author', 'version', 'contractVersion', 'entries', 'reads', 'logic']);
// Файл логики обязан соответствовать языку: иначе подпись покрывала бы один файл, а запускался другой
const languageIs = (language: string) => ({ required: ['language'], properties: { language: { const: language } } });
(manifestSchema as any).allOf = [
  // Страница — договор v2; v1 её не знает, и старый Flux такой выпуск не запустит
  { if: { required: ['ui'] }, then: { properties: { contractVersion: { enum: [2, 3] } } } },
  // Раздел permissions — договор v3: схема старого Flux его не знает и отвергла бы выпуск, поэтому версия обязана сказать об этом честно
  { if: { required: ['permissions'] }, then: { properties: { contractVersion: { const: 3 } } } },
  { if: { required: ['exports'] }, then: { properties: { contractVersion: { const: 3 } } } },
  { if: { required: ['pages'] }, then: { required: ['ui'] } },
  { if: languageIs('python'), then: { properties: { logic: { const: LOGIC_FILES.python } }, not: { required: ['sourceLanguage'] } } },
  { if: languageIs('wasm'), then: { properties: { logic: { const: LOGIC_FILES.wasm } }, required: ['sourceLanguage'] } },
  { if: { not: { required: ['language'], properties: { language: { enum: ['python', 'wasm'] } } } },
    then: { properties: { logic: { const: LOGIC_FILES.typescript } }, not: { required: ['sourceLanguage'] } } },
];
const validShape = ajv.compile(manifestSchema);
/** Схема плюс разбор объявлений по реестру разрешений: подключение с чужой схемой, путём в адресе или запрещённым COM-объектом, разрешение без человеческого текста манифестом не считается */
export const validManifest = (value: unknown): boolean => !!validShape(value) && permissionsValid(value) && parseExports((value as { exports?: unknown }).exports) !== null;
