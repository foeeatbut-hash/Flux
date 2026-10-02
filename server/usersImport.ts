export const USER_IMPORT_FIELDS = ['symbol', 'lastName', 'firstName', 'middleName', 'name', 'role', 'position', 'department', 'email', 'password'] as const;
export type UserImportField = typeof USER_IMPORT_FIELDS[number];
export type UserImportMap = Partial<Record<UserImportField, number>>;

export function validateEmployeeImportMatrix(rows: unknown): rows is unknown[][] {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 5001) return false;
  let characters = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length > 100) return false;
    for (const cell of row) {
      if (cell !== null && cell !== undefined && !['string', 'number', 'boolean'].includes(typeof cell)) return false;
      const value = String(cell ?? '');
      if (value.length > 4096) return false;
      characters += value.length;
      if (characters > 10_000_000) return false;
    }
  }
  return true;
}

export interface UserImportRow {
  row: number;
  values: Record<UserImportField, string>;
  error?: string;
  action?: 'create' | 'update';
  existingId?: string;
}

export function mapEmployeeRows(rows: unknown[][], mapping: UserImportMap, existing: Array<{ id: string; symbol: string; role?: string }>, defaultRole: string, mode: 'create' | 'update', actorRole = '') {
  const bySymbol = new Map(existing.map((u) => [String(u.symbol).trim().toLocaleLowerCase(), u]));
  const seen = new Set<string>();
  return rows.slice(1, 5001).map((raw, index): UserImportRow => {
    const values = Object.fromEntries(USER_IMPORT_FIELDS.map((field) => [field, mapping[field] === undefined ? '' : String(raw[mapping[field]!] ?? '').trim()])) as Record<UserImportField, string>;
    const issues: string[] = [];
    const symbol = values.symbol;
    const key = symbol.toLocaleLowerCase();
    if (!symbol) issues.push('Укажите табельный номер / логин');
    if (symbol.toLocaleLowerCase() === 'flux.owner') issues.push('Логин владельца зарезервирован');
    if (seen.has(key) && key) issues.push('Повтор логина в файле');
    if (key) seen.add(key);
    if (mode === 'create' && !(values.name || (values.lastName && values.firstName))) issues.push('Укажите ФИО или фамилию и имя');
    const match = bySymbol.get(key);
    if (match && mode === 'create') issues.push('Логин уже существует; выберите режим обновления');
    if (!match && mode === 'update') issues.push('Сотрудник с таким логином не найден');
    if (mode === 'update' && match && match.role === 'OWNER') issues.push('Профиль владельца нельзя обновить импортом');
    if (mode === 'update' && match && match.role === 'ADMIN' && actorRole !== 'OWNER') issues.push('Профиль администратора меняет только владелец');
    if (mode === 'update' && values.password) issues.push('Пароль существующего сотрудника не меняется импортом');
    if (!values.role && mode === 'create') values.role = defaultRole;
    if (values.role === 'OWNER') issues.push('Роль владельца нельзя назначить импортом');
    return { row: index + 2, values, error: issues.join('; ') || undefined, action: match ? 'update' : 'create', existingId: match?.id };
  }).filter((r) => Object.values(r.values).some(Boolean));
}

export function employeeImportName(row: UserImportRow) {
  const v = row.values;
  if (v.lastName || v.firstName || v.middleName) return { lastName: v.lastName, firstName: v.firstName, middleName: v.middleName, name: [v.lastName, v.firstName, v.middleName].filter(Boolean).join(' ') };
  const parts = v.name.split(/\s+/).filter(Boolean);
  return { lastName: parts[0] || '', firstName: parts[1] || '', middleName: parts.slice(2).join(' '), name: parts.join(' ') };
}
