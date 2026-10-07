/**
 * База оборудования в памяти — ровно с теми вызовами Prisma, что делают план
 * и запись импорта.
 *
 * Нужна проверкам, где план и запись обязаны сойтись на одних и тех же данных:
 * заглушка из одной установки с одним блоком этого не покажет. Поддержаны
 * только те формы запроса, что реально встречаются в импорте; незнакомая форма
 * падает сразу, а не отдаёт молча пустое.
 */
type Row = Record<string, any>;

export interface MemoryDb {
  prisma: any;
  systems: Row[];
  monoblocks: Row[];
  elements: Row[];
  tags: Row[];
  history: Row[];
  /** Теги, стоящие на записи */
  tagsOf: (elementId: string) => string[];
}

export function memoryEquipmentDb(): MemoryDb {
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const systems: Row[] = [], monoblocks: Row[] = [], elements: Row[] = [], tags: Row[] = [], history: Row[] = [];
  const links = new Set<string>(); // `${elementId}|${tagId}`

  const fits = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object') throw new Error(`memoryEquipmentDb: условие ${k} не поддержано`);
    return row[k] === v;
  });
  const tagsOf = (elId: string) => tags.filter(t => links.has(`${elId}|${t.id}`)).map(t => t.identifier);
  const withTags = (e: Row, include?: any) => (include?.tags
    ? { ...e, tags: tags.filter(t => links.has(`${e.id}|${t.id}`)).map(t => ({ ...t })) }
    : { ...e });
  const tagView = (t: Row, shape?: any) => ({
    ...t,
    ...(shape ? { componentElements: elements.filter(e => links.has(`${e.id}|${t.id}`)).map(e => ({ id: e.id, name: e.name, itemCode: e.itemCode })) } : {}),
  });
  const patch = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (k === 'tags') { links.add(`${row.id}|${(v as any).connect.id}`); continue; }
      row[k] = v;
    }
    return row;
  };

  const prisma: any = {
    equipmentSystem: {
      findMany: async ({ where }: any) => systems.filter(s => fits(s, where)).map(s => ({ ...s })),
      create: async ({ data }: any) => { const r = { id: id('sys'), createdAt: new Date(), ...data }; systems.push(r); return { ...r }; },
      update: async ({ where, data }: any) => ({ ...patch(systems.find(s => s.id === where.id)!, data) }),
    },
    monoblock: {
      findFirst: async ({ where }: any) => { const r = monoblocks.find(m => fits(m, where)); return r ? { ...r } : null; },
      create: async ({ data }: any) => { const r = { id: id('mb'), createdAt: new Date(), ...data }; monoblocks.push(r); return { ...r }; },
      findMany: async ({ where, include }: any) => monoblocks.filter(m => fits(m, where)).map(m => ({
        ...m,
        components: elements.filter(e => e.monoblockId === m.id).map(e => withTags(e, include?.components?.include)),
      })),
    },
    componentElement: {
      create: async ({ data }: any) => {
        const { tags: t, ...rest } = data;
        const r: Row = { id: id('el'), createdAt: new Date(), hasConflict: false, manual: false, conflictLog: null, overrides: null, equipClass: null, equipKind: null, ...rest };
        elements.push(r);
        if (t) patch(r, { tags: t });
        return { ...r };
      },
      update: async ({ where, data }: any) => ({ ...patch(elements.find(e => e.id === where.id)!, data) }),
    },
    equipmentHistory: {
      create: async ({ data }: any) => { const r = { id: id('h'), changedAt: new Date(), ...data }; history.push(r); return r; },
    },
    tag: {
      findMany: async ({ where, select }: any) => tags.filter(t => fits(t, where)).map(t => tagView(t, select?.componentElements)),
      findUnique: async ({ where, include }: any) => { const t = tags.find(x => x.id === where.id); return t ? tagView(t, include?.componentElements) : null; },
      create: async ({ data }: any) => { const r = { id: id('tag'), createdAt: new Date(), metadata: null, ...data }; tags.push(r); return { ...r }; },
      update: async ({ where, data }: any) => ({ ...patch(tags.find(t => t.id === where.id)!, data) }),
    },
  };
  return { prisma, systems, monoblocks, elements, tags, history, tagsOf };
}
