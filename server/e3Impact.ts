/**
 * Что ввоз расчёта задевает в схемах E3 (docs/e3-integration.md, 9.4).
 *
 * Позиция, стоящая в схеме КИП, — чужая работа: переподбор у ОВ её меняет, а КИП
 * об этом не знает. Поэтому предпросмотр импорта предупреждает «N позиций уже
 * в схеме КИП» (не запрет), а после записи тому, кто выгружал, уходит одно
 * уведомление на ввоз — не по уведомлению на позицию.
 *
 * Делегатов E3 в клиенте базы может не быть (клиент собран до моделей) —
 * тогда функции молча ничего не находят: импорт от E3 не зависит.
 */

export interface Bound { elementId: string; e3ProjectId: string; e3Name: string }

/** Позиции проекта, стоящие в схемах E3 (связь PLACED или с пометкой «снята во Flux») */
export async function boundElements(prisma: any, projectId: string): Promise<Bound[]> {
  if (!prisma?.e3Project?.findMany || !prisma?.e3Binding?.findMany) return [];
  const projects: { id: string; name: string }[] = await prisma.e3Project.findMany({ where: { fluxProjectId: projectId } });
  if (!projects.length) return [];
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const rows: { elementId: string; e3ProjectId: string; state: string }[] = await prisma.e3Binding.findMany({ where: { e3ProjectId: { in: projects.map((p) => p.id) } } });
  return rows.filter((r) => r.state === 'PLACED').map((r) => ({ elementId: r.elementId, e3ProjectId: r.e3ProjectId, e3Name: names.get(r.e3ProjectId) || '' }));
}

/** Предпросмотр: сколько из затрагиваемых позиций уже в схеме, и по установкам */
export async function inSchemeOf(
  prisma: any, projectId: string, touched: { elementId?: string; systemName?: string }[],
): Promise<{ count: number; bySystem: Record<string, number> }> {
  const bound = new Set((await boundElements(prisma, projectId)).map((b) => b.elementId));
  const bySystem: Record<string, number> = {};
  let count = 0;
  for (const t of touched) {
    if (!t.elementId || !bound.has(t.elementId)) continue;
    count++;
    if (t.systemName) bySystem[t.systemName] = (bySystem[t.systemName] || 0) + 1;
  }
  return { count, bySystem };
}

const plural = (n: number, one: string, few: string, many: string): string => {
  const m = n % 100; const l = n % 10;
  return m >= 11 && m <= 14 ? many : l === 1 ? one : l >= 2 && l <= 4 ? few : many;
};

/**
 * После записи ввоза: одно уведомление каждому, кто выгружал эти позиции. «Кто
 * выгружал» — автор последней завершённой выгрузки в тот проект E3. Тронутые
 * позиции берутся из истории партии, а не из разбора ввоза, поэтому сюда
 * попадают и обновлённые, и снятые, и переподобранные. Возвращает число
 * уведомлений.
 */
export async function notifyExporters(prisma: any, projectId: string, batchId: string, actorId?: string | null): Promise<number> {
  if (!prisma?.notification?.create || !prisma?.equipmentHistory?.findMany || !prisma?.e3Export?.findMany) return 0;
  const bound = await boundElements(prisma, projectId);
  if (!bound.length) return 0;
  const touched = new Set((await prisma.equipmentHistory.findMany({ where: { batchId }, select: { elementId: true } })).map((r: any) => r.elementId));
  const hit = bound.filter((b) => touched.has(b.elementId));
  if (!hit.length) return 0;
  const byProject = new Map<string, Bound[]>();
  for (const b of hit) byProject.set(b.e3ProjectId, [...(byProject.get(b.e3ProjectId) || []), b]);
  const exports: { e3ProjectId: string; by: string | null; at: any }[] = await prisma.e3Export.findMany({ where: { e3ProjectId: { in: [...byProject.keys()] }, state: 'DONE' }, orderBy: { at: 'desc' } });
  // Адресат — автор последней выгрузки в проект E3; сам импортирующий об этом знает
  const owners = new Map<string, Map<string, number>>();
  const seen = new Set<string>();
  for (const x of exports) {
    if (seen.has(x.e3ProjectId) || !x.by) continue;
    seen.add(x.e3ProjectId);
    if (x.by === actorId) continue;
    const list = owners.get(x.by) || new Map<string, number>();
    list.set(x.e3ProjectId, byProject.get(x.e3ProjectId)!.length);
    owners.set(x.by, list);
  }
  let made = 0;
  for (const [userId, projects] of owners) {
    const total = [...projects.values()].reduce((a, b) => a + b, 0);
    const names = [...projects.keys()].map((id) => `«${byProject.get(id)![0].e3Name || 'проект E3'}»`).join(', ');
    await prisma.notification.create({ data: {
      userId, category: 'ОБОРУДОВАНИЕ', targetRoute: '/e3flux',
      title: `${total % 10 === 1 && total % 100 !== 11 ? 'Изменилась' : 'Изменились'} ${total} ${plural(total, 'позиция', 'позиции', 'позиций')}, выгруженн${total % 10 === 1 && total % 100 !== 11 ? 'ая' : 'ые'} в ${names}`,
      body: 'Импорт оборудования задел позиции, которые уже стоят в схеме E3. Откройте E3Flux: они отмечены как изменившиеся после выгрузки.',
    } });
    made++;
  }
  return made;
}
