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
  const settings = new Map<string, Row>();
  const links = new Set<string>(); // `${elementId}|${tagId}`

  const fits = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if (Array.isArray((v as any).in)) return (v as any).in.includes(row[k]);
      if ((v as any).gte instanceof Date) return new Date(row[k]).getTime() >= (v as any).gte.getTime();
      throw new Error(`memoryEquipmentDb: условие ${k} не поддержано`);
    }
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
  const asList = (x: any): any[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
  const patch = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (k === 'tags') {
        for (const t of asList((v as any).connect)) links.add(`${row.id}|${t.id}`);
        for (const t of asList((v as any).disconnect)) links.delete(`${row.id}|${t.id}`);
        continue;
      }
      // Рост версии делает «база», как настоящая: { increment: n }
      if (v && typeof v === 'object' && 'increment' in (v as any)) { row[k] = (row[k] ?? 0) + (v as any).increment; continue; }
      row[k] = v;
    }
    return row;
  };

  const prisma: any = {
    project: {
      findUnique: async ({ where }: any) => where.id === 'p1' ? { id: 'p1' } : null,
    },
    appSetting: {
      upsert: async ({ where, create }: any) => {
        const row = settings.get(where.id) || { ...create, updatedAt: new Date() };
        settings.set(where.id, row);
        return { ...row };
      },
      findUnique: async ({ where }: any) => { const row = settings.get(where.id); return row ? { ...row } : null; },
      updateMany: async ({ where, data }: any) => {
        const row = settings.get(where.id);
        if (!row || row.key !== where.key || row.userId !== where.userId || row.value !== where.value) return { count: 0 };
        Object.assign(row, data, { updatedAt: new Date() });
        return { count: 1 };
      },
    },
    equipmentSystem: {
      findUnique: async ({ where }: any) => { const r = systems.find(s => s.id === where.id); return r ? { id: r.id } : null; },
      findMany: async ({ where, include }: any) => systems.filter(s => fits(s, where)).map(s => ({
        ...s,
        ...(include?.monoblocks ? { monoblocks: monoblocks.filter(m => m.systemId === s.id).map(m => (include.monoblocks.include?.components
          ? { ...m, components: elements.filter(e => e.monoblockId === m.id).map(e => withTags(e, include.monoblocks.include.components.include)) }
          : { id: m.id })) } : {}),
      })),
      create: async ({ data }: any) => { const r = { id: id('sys'), createdAt: new Date(), ...data }; systems.push(r); return { ...r }; },
      update: async ({ where, data }: any) => ({ ...patch(systems.find(s => s.id === where.id)!, data) }),
      delete: async ({ where }: any) => { const i = systems.findIndex(s => s.id === where.id); if (i >= 0) systems.splice(i, 1); return {}; },
    },
    monoblock: {
      findUnique: async ({ where }: any) => { const r = monoblocks.find(m => m.id === where.id); return r ? { id: r.id } : null; },
      findFirst: async ({ where }: any) => { const r = monoblocks.find(m => fits(m, where)); return r ? { ...r } : null; },
      create: async ({ data }: any) => { const r = { id: id('mb'), createdAt: new Date(), ...data }; monoblocks.push(r); return { ...r }; },
      findMany: async ({ where, include }: any) => monoblocks.filter(m => fits(m, where)).map(m => ({
        ...m,
        components: elements.filter(e => e.monoblockId === m.id).map(e => withTags(e, include?.components?.include)),
      })),
      delete: async ({ where }: any) => { const i = monoblocks.findIndex(m => m.id === where.id); if (i >= 0) monoblocks.splice(i, 1); return {}; },
    },
    componentElement: {
      findUnique: async ({ where }: any) => { const r = elements.find(e => e.id === where.id); return r ? { id: r.id } : null; },
      create: async ({ data }: any) => {
        const { tags: t, ...rest } = data;
        const r: Row = { id: id('el'), createdAt: new Date(), hasConflict: false, manual: false, conflictLog: null, overrides: null, equipClass: null, equipKind: null, ...rest };
        elements.push(r);
        if (t) patch(r, { tags: t });
        return { ...r };
      },
      update: async ({ where, data }: any) => ({ ...patch(elements.find(e => e.id === where.id)!, data) }),
      findMany: async ({ where, include }: any) => elements.filter(e => fits(e, where)).map(e => ({
        ...e,
        ...(include?.monoblock ? { monoblock: { ...monoblocks.find(m => m.id === e.monoblockId)!, system: systems.find(s => s.id === monoblocks.find(m => m.id === e.monoblockId)?.systemId) } } : {}),
      })),
      delete: async ({ where }: any) => {
        const i = elements.findIndex(e => e.id === where.id);
        if (i >= 0) { for (const k of [...links]) if (k.startsWith(`${where.id}|`)) links.delete(k); elements.splice(i, 1); }
        return {};
      },
    },
    equipmentHistory: {
      findMany: async ({ where }: any) => history.filter(h => fits(h, where)).map(h => ({ ...h })),
      create: async ({ data }: any) => { const r = { id: id('h'), changedAt: new Date(), ...data }; history.push(r); return r; },
    },
    tag: {
      findMany: async ({ where, select }: any) => tags.filter(t => fits(t, where)).map(t => tagView(t, select?.componentElements)),
      findUnique: async ({ where, include }: any) => { const t = tags.find(x => x.id === where.id); return t ? tagView(t, include?.componentElements) : null; },
      create: async ({ data }: any) => { const r = { id: id('tag'), createdAt: new Date(), metadata: null, ...data }; tags.push(r); return { ...r }; },
      update: async ({ where, data }: any) => ({ ...patch(tags.find(t => t.id === where.id)!, data) }),
    },
  };
  // Транзакция на тех же данных: проверкам важна не откатываемость, а то, что запись идёт одним проходом
  prisma.$transaction = async (fn: (tx: any) => Promise<any>) => fn(prisma);
  return { prisma, systems, monoblocks, elements, tags, history, tagsOf };
}
