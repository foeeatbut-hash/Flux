/**
 * Чей проект у записи журнала изменений (server/changeFeed.ts).
 *
 * Не у каждой версионной модели есть `projectId`: моноблок знает установку,
 * позиция — моноблок, пункт справочника — справочник, файл — папку. Журналу
 * проект нужен, чтобы коллега, открывший проект, читал только его изменения,
 * поэтому по цепочке родителей он добирается здесь. Не нашли (родитель уже
 * удалён, файл без папки) — пусто: журнал обязан писаться и без проекта.
 */

/** Как модель узнаёт проект: сама запись, свой `projectId` или родитель по полю */
type Scope = { self: true } | { own: string } | { via: string; to: string };

const SCOPE: Record<string, Scope> = {
  Project: { self: true },
  Tag: { own: 'projectId' },
  EquipmentSystem: { own: 'projectId' },
  Monoblock: { via: 'systemId', to: 'EquipmentSystem' },
  ComponentElement: { via: 'monoblockId', to: 'Monoblock' },
  DocRegister: { own: 'projectId' },
  DocRegisterItem: { own: 'projectId' },
  ConstructorDoc: { own: 'projectId' },
  FileNode: { via: 'folderId', to: 'Folder' },
  Dictionary: { own: 'projectId' },
  DictionaryItem: { via: 'dictionaryId', to: 'Dictionary' },
  TagTemplate: { own: 'projectId' },
  // Не версионная, но родитель файла: проект папки — проект файла
  Folder: { own: 'projectId' },
};

/** Делегат клиента по имени модели: `ComponentElement` → `componentElement` */
export const delegateOf = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1);

/** Поле записи, из которого берётся проект (или переход к родителю); у `Project` его нет */
export function scopeField(model: string): string | undefined {
  const s = SCOPE[model];
  if (!s || 'self' in s) return undefined;
  return 'own' in s ? s.own : s.via;
}

const CHUNK = 400;

/**
 * Проект каждой записи: id → projectId или `null`. Строки обязаны нести `id` и
 * поле из `scopeField`. Родители читаются пачками по уровням, а не по записи:
 * в массовой правке тысяч позиций моноблоков несколько десятков.
 */
export async function projectIdsOf(db: any, model: string, rows: Array<Record<string, any>>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const scope = SCOPE[model];
  if (!scope) { for (const r of rows) out.set(String(r.id), null); return out; }
  if ('self' in scope) { for (const r of rows) out.set(String(r.id), String(r.id)); return out; }
  if ('own' in scope) {
    for (const r of rows) out.set(String(r.id), typeof r[scope.own] === 'string' && r[scope.own] ? r[scope.own] : null);
    return out;
  }
  const parentOf = new Map<string, string>();
  for (const r of rows) {
    const p = r[scope.via];
    if (typeof p === 'string' && p) parentOf.set(String(r.id), p);
    else out.set(String(r.id), null);
  }
  const parentIds = [...new Set(parentOf.values())];
  const field = scopeField(scope.to);
  const parents: Array<Record<string, any>> = [];
  for (let i = 0; i < parentIds.length; i += CHUNK) {
    parents.push(...await db[delegateOf(scope.to)].findMany({
      where: { id: { in: parentIds.slice(i, i + CHUNK) } },
      select: { id: true, ...(field ? { [field]: true } : {}) },
    }));
  }
  const parentProject = await projectIdsOf(db, scope.to, parents);
  for (const [id, parent] of parentOf) out.set(id, parentProject.get(parent) ?? null);
  return out;
}
