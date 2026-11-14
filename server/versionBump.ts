/**
 * Целая версия записи: её двигает клиент базы, а не каждый маршрут
 * (docs/roadmap/offline-work.md, 0.4).
 *
 * Версия нужна, чтобы запись по устаревшей карточке не затирала чужую правку
 * (server/versionGuard.ts сверяет её с тем, что видел клиент). Пока каждый
 * маршрут поднимал её сам, достаточно было забыть один путь записи — массовый,
 * импорт, будущий — и версия переставала быть правдой: сверка пропускала бы
 * чужую правку как «ничего не менялось». Поэтому расширение клиента Prisma
 * добавляет `version: { increment: 1 }` ко всякому `update`, `updateMany`,
 * `updateManyAndReturn` и к ветке `update` у `upsert` по моделям из
 * VERSIONED_MODELS. Инкремент делает база, а не чтение с прибавкой: две правки
 * подряд не сольются в одну версию.
 *
 * Уважается явная воля записи:
 *  • в данных уже есть `version` (`withBump` у позиций, `guardedWrite`) —
 *    расширение не трогает, двойного роста нет;
 *  • `keepVersion(data)` — осознанно без роста (перенос карточки тега по холсту:
 *    положение никому не дорого, а ложный конфликт у коллеги дорог).
 *
 * Мимо расширения идут сырой SQL и вложенные записи
 * (`data: { tags: { update: … } }` — расширение видит только корневую
 * операцию). Эти места перечислены в храповике scripts/test-architecture.ts:
 * новое место в нём — причина разбора, а не отметка «проверено».
 */

/** Модели с колонкой `version Int @default(1)` — «целая версия записи» (имена как в schema.prisma). */
export const VERSIONED_MODELS: readonly string[] = [
  'Project', 'Tag', 'EquipmentSystem', 'Monoblock', 'ComponentElement',
  'DocRegister', 'DocRegisterItem', 'ConstructorDoc', 'FileNode',
  'Dictionary', 'DictionaryItem', 'TagTemplate',
];

/**
 * Метка «версию не двигать» — служебный ключ данных, который расширение снимает
 * до запроса. Символ не годится: Prisma копирует аргументы запроса и теряет
 * символьные ключи. Без расширения на клиенте метка дошла бы до Prisma, и та
 * отказала бы неизвестным полем — громко, а не тихим ростом версии.
 */
const KEEP = '__fluxKeepVersion';

/**
 * Данные записи, которая осознанно не двигает версию. Метка переживает
 * копирование данных (`{ ...data }`, `withCodeKey`), но работает только на
 * клиенте с расширением и только у моделей из VERSIONED_MODELS: иначе Prisma
 * откажет неизвестным полем — громко, а не тихим ростом версии.
 */
export function keepVersion<T extends object>(data: T): T {
  return { ...data, [KEEP]: true } as T;
}

/**
 * Данные записи вместе с ростом версии, если запись сама не решила иначе.
 * Расширение зовёт её на каждой записи; общее место сверки (versionGuard.ts)
 * — чтобы его запись росла и на клиенте без расширения (заглушки, проверки).
 */
export function bumpedData(data: any): any {
  if (!data || typeof data !== 'object') return data;
  // Метку снимает само расширение (stripKeep): здесь она остаётся, чтобы ниже по цепочке версию не двинули
  if (data[KEEP] || data.version !== undefined) return data;
  return { ...data, version: { increment: 1 } };
}

/** Снять метку keepVersion перед запросом: Prisma не знает такого поля. */
function stripKeep(data: any): any {
  if (!data || typeof data !== 'object' || !data[KEEP]) return data;
  const { [KEEP]: _keep, ...rest } = data;
  return rest;
}

const isEmpty = (data: any) => !!data && typeof data === 'object' && Object.keys(data).length === 0;

const inList = (model: string | undefined) => !!model && VERSIONED_MODELS.includes(model);

/**
 * Клиент с ростом версии. Расширение стоит в цепочке рядом с `traceDatabase`
 * и работает так же в обеих формах `$transaction`. Не получилось расширить —
 * ошибка, а не молчание: клиент без роста версии тихо портит сверку.
 */
export function withVersionBump<T>(client: T): T {
  if (typeof (client as any)?.$extends !== 'function') {
    throw new Error('Клиент базы не умеет расширения: версия записей не будет расти.');
  }
  return (client as any).$extends({
    name: 'flux-version-bump',
    query: {
      $allModels: {
        update: ({ model, args, query }: any) =>
          query(inList(model) ? { ...args, data: stripKeep(bumpedData(args.data)) } : args),
        updateMany: ({ model, args, query }: any) =>
          query(inList(model) ? { ...args, data: stripKeep(bumpedData(args.data)) } : args),
        updateManyAndReturn: ({ model, args, query }: any) =>
          query(inList(model) ? { ...args, data: stripKeep(bumpedData(args.data)) } : args),
        // create-ветка получает версию по умолчанию (1); растёт только update. Пустой `update: {}` —
        // приём «создай, если нет»: менять нечего, значит и версия не растёт
        upsert: ({ model, args, query }: any) =>
          query(inList(model) ? { ...args, update: isEmpty(args.update) ? args.update : stripKeep(bumpedData(args.update)) } : args),
      },
    },
  }) as T;
}
