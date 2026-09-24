/**
 * Права Конструктора и Каталога: кому открыто по умолчанию и как это запретить.
 *
 * Два дефекта, которые эта проверка держит закрытыми. Первый: право,
 * открытое по умолчанию, читалось «выдано», пока записи нет, — а карточка
 * сотрудника и редактор роли при снятии галочки запись удаляли, и запрет не
 * сохранялся никогда. Второй: правка общего Каталога и шаблонов была открыта
 * всем, хотя одна правка меняет подбор и бланки во всех проектах.
 *
 * Запуск: npx tsx scripts/test-builder-perms.ts
 */
import { can, entryOf, offEntry, defaultPermissions, OPEN_BY_DEFAULT, type PermMap } from '../src/lib/permissions';
import { cleanUserPermissions } from '../src/lib/userPermissions';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log('  ✓', name);
  else { failed++; console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail)); }
};
const user = (rolePermissions: PermMap, permissions: PermMap = {}) => ({ role: 'ENGINEER', isActive: true, rolePermissions, permissions });

console.log('1. Кому что открыто, пока в записи ничего нет');
{
  const old = user({ 'tags.manage': { enabled: true, until: null } });
  ok('ведомости — каждому', can(old, 'builder.edit'));
  ok('выпуск бланков — каждому', can(old, 'builder.issue'));
  ok('правка Каталога — только по выдаче', !can(old, 'catalog.manage'));
  ok('шаблоны бланков — только по выдаче', !can(old, 'blanks.manage'));
  ok('администратору — всё', can({ role: 'ADMIN' }, 'catalog.manage') && can({ role: 'ADMIN' }, 'blanks.manage'));
  const fresh = defaultPermissions();
  ok('новому сотруднику Каталог и шаблоны не выдаются', !fresh['catalog.manage'] && !fresh['blanks.manage'], fresh);
  ok('открыты по умолчанию ровно ведомости и выпуск', JSON.stringify(OPEN_BY_DEFAULT) === JSON.stringify(['builder.edit', 'builder.issue']));
}

console.log('2. Запрет из карточки сотрудника сохраняется');
{
  const saved = cleanUserPermissions({ 'builder.edit': { enabled: false, until: null }, 'files.upload': { enabled: false, until: null } });
  ok('снятая галочка открытого права — явный запрет', saved['builder.edit']?.enabled === false, saved);
  ok('снятая галочка обычного права — просто нет записи', !('files.upload' in saved), saved);
  ok('личный запрет сильнее роли', !can(user({ 'builder.edit': { enabled: true, until: null } }, saved), 'builder.edit'));
  ok('выданный лично Каталог работает', can(user({}, cleanUserPermissions({ 'catalog.manage': { enabled: true, until: null } })), 'catalog.manage'));
}

console.log('3. Запрет у роли сохраняется');
{
  ok('снятие открытого права у роли даёт запрет', JSON.stringify(offEntry('builder.issue')) === JSON.stringify({ enabled: false, until: null }));
  ok('снятие обычного права у роли — удаление записи', offEntry('tags.manage') === null);
  const role: PermMap = { 'builder.issue': offEntry('builder.issue')! };
  ok('роль с запретом — выпуска нет', !can(user(role), 'builder.issue'));
  ok('а ведомости у той же роли остаются', can(user(role), 'builder.edit'));
  ok('entryOf видит запись роли, а не умолчание', entryOf(role, 'builder.issue')?.enabled === false);
}

console.log(failed ? `\nПровалено: ${failed}` : '\nВсе проверки прав Конструктора пройдены');
process.exit(failed ? 1 : 0);
