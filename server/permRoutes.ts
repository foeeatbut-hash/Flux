/**
 * Какое право нужно для записи по какому маршруту.
 *
 * Вынесено из server.ts: таблица проверяется без поднятого сервера
 * (scripts/test-permission-routes.ts), а новый маршрут записи, не попавший в
 * неё, оставался бы открытым любому вошедшему — как это было с генератором
 * тегов и ручным снятием конфликта.
 */
import { VDR_PERM_RULES } from './vdrPermissions.js';

export type PermRequirement = { perm: string; title: string };
export type PermRule = PermRequirement & { method: RegExp; path: RegExp; also?: PermRequirement[] };
export const PERM_ROUTES: PermRule[] = [
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/projects\/?$|^\/api\/projects\/[^/]+$/,
    perm: 'project.manage', title: 'Управление проектами' },
  { method: /^(POST|PUT|PATCH)$/, path: /^\/api\/projects\/[^/]+\/tags(?:\/|$)/,
    perm: 'tags.manage', title: 'Создание и правка тегов' },
  { method: /^(PUT|PATCH)$/, path: /^\/api\/tags\//, perm: 'tags.manage', title: 'Создание и правка тегов' },
  // Генератор создаёт тег, и право то же, что у правки: раньше POST сюда не доходил ни одно правило
  { method: /^POST$/, path: /^\/api\/tags\/generate\/?$/, perm: 'tags.manage', title: 'Создание и правка тегов' },
  { method: /^DELETE$/, path: /^\/api\/tags\//, perm: 'tags.delete', title: 'Удаление тегов' },
  { method: /^(POST|PUT|DELETE|PATCH)$/, path: /^\/api\/dictionaries|^\/api\/projects\/[^/]+\/(dictionaries|tag-template)/,
    perm: 'dictionaries.manage', title: 'Справочники и шаблоны' },
  { method: /^POST$/, path: /^\/api\/(equipment\/import|import\/)/,
    perm: 'equipment.import', title: 'Импорт из бланков' },
  { method: /^(PUT|PATCH)$/, path: /^\/api\/(components|equipment|monoblocks|systems)\//,
    perm: 'equipment.manage', title: 'Правка характеристик оборудования' },
  // Ручное снятие конфликта меняет компонент так же, как правка, но ходит методом POST
  { method: /^POST$/, path: /^\/api\/components\/[^/]+\/resolve-conflict\/?$/,
    perm: 'equipment.manage', title: 'Правка характеристик оборудования' },
  { method: /^POST$/, path: /^\/api\/(files|folders)(?:\/|$)/, perm: 'files.upload', title: 'Загрузка файлов' },
  // Писать обращения и прикладывать к ним файлы — одно право: вложение без
  // обращения никому не нужно, а обращение без вложения бывает часто
  { method: /^(POST|PUT|DELETE)$/, path: /^\/api\/feedback\/(reports|uploads|drafts)/,
    perm: 'feedback.create', title: 'Писать обращения' },
  { method: /^DELETE$/, path: /^\/api\/(files|folders)(?:\/|$)/, perm: 'files.delete', title: 'Удаление файлов и папок' },
  { method: /^(POST|PUT|DELETE)$/, path: /^\/api\/settings\/(procurement_stages|procurement_templates|stage_templates)/,
    perm: 'procurement.setup', title: 'Настройка этапов закупки' },
  ...VDR_PERM_RULES, // ВДР: таблица в server/vdrPermissions.ts — её же читает проверка прав
  // Каталог правят немногие, а учится он у всех: запомненный выбор подбора —
  // побочный продукт работы в Конструкторе, а не правка справочника
  { method: /^(POST|PUT|DELETE)$/, path: /^\/api\/blank-templates/, perm: 'blanks.manage', title: 'Шаблоны бланков' },
  { method: /^POST$/, path: /^\/api\/builder\/lists\/[^/]+\/issues(?:\/|$)/, perm: 'builder.issue', title: 'Выпуск бланков' },
  // Применение связей меняет и теги проекта, и ведомость: нужны оба права.
  { method: /^POST$/, path: /^\/api\/builder\/lists\/[^/]+\/tag-apply(?:\/|$)/, perm: 'tags.manage', title: 'Создание и правка тегов', also: [{ perm: 'builder.edit', title: 'Ведомости Конструктора' }] },
  // План тегов ничего не записывает, а выпуск проверен отдельным правом.
  { method: /^(POST|PUT|DELETE)$/, path: /^\/api\/builder\/(?!lists\/[^/]+\/(?:issues|tag-plan)(?:\/|$))/, perm: 'builder.edit', title: 'Ведомости Конструктора' },
];

/** Правило для запроса или null, если запись по этому маршруту не требует отдельного права. */
export function permRuleFor(method: string, route: string): PermRule | null {
  return PERM_ROUTES.find(r => r.method.test(method) && r.path.test(route)) ?? null;
}
