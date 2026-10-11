/** Compare-and-swap для JSON-массивов в AppSetting: параллельные сохранения не теряют строки. */
export async function mutateOfficeSettingArray<T>(args: {
  db: any;
  key: string;
  userId: string | null;
  parse: (raw: string | null | undefined) => T[];
  change: (current: T[]) => T[];
  conflictMessage: string;
}): Promise<T[]> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const record = await args.db.appSetting.findFirst({ where: { key: args.key, userId: args.userId } });
    const next = args.change(args.parse(record?.value));
    const value = JSON.stringify(next);
    if (!record) {
      try { await args.db.appSetting.create({ data: { key: args.key, userId: args.userId, value } }); return next; }
      catch { continue; }
    }
    const result = await args.db.appSetting.updateMany({ where: { id: record.id, value: record.value }, data: { value } });
    if (Number(result?.count) === 1) return next;
  }
  throw Object.assign(new Error(args.conflictMessage), { status: 409 });
}
