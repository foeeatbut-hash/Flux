/**
 * Права на проекты, настройки, уведомления и группы чата — чистая логика.
 *
 * Закрываем дефекты внешней проверки безопасности: состав проекта менял любой
 * вошедший, пустой состав и сбой проверки открывали закрытый проект, общие
 * настройки (в том числе ключ издателя игр и якорь времени) писал кто угодно,
 * чужую группу чата можно было забрать, не передав userId.
 * Сервер не поднимаем: подставные объекты и функции из server/projectAccess.ts.
 *
 * Запуск: npx tsx scripts/test-project-access.ts
 */
import {
  visibleByMembers, hiddenProjectIds, projectIdsOfRequest, isRealProjectId, actorMay,
  judgeMembersChange, isTrustKey, isServerKey, validSettingKey, globalWriteRule,
  bookmarksProjectOf, settingScope, mayEditGroup, ownerForNewGroup,
} from '../server/projectAccess';

let ok = 0;
let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { ok++; return; }
  fail++;
  console.error(`  ✗ ${name} — получили ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`);
};

async function main() {
  console.log('Видимость проекта по составу');
  eq('администратор видит закрытый', visibleByMembers(['a'], 'x', true), true);
  eq('администратор видит и при сбое', visibleByMembers(null, 'x', true), true);
  eq('пустой состав — виден всем', visibleByMembers([], 'x', false), true);
  eq('участник видит', visibleByMembers(['a', 'x'], 'x', false), true);
  eq('посторонний не видит', visibleByMembers(['a'], 'x', false), false);
  eq('сбой проверки — отказ', visibleByMembers(null, 'x', false), false);
  eq('без личности состав закрытого не пускает', visibleByMembers(['a'], '', false), false);
  eq('скрытые проекты: только с составом без меня',
    hiddenProjectIds([
      { projectId: 'p1', userId: 'a' }, { projectId: 'p1', userId: 'x' },
      { projectId: 'p2', userId: 'a' },
    ], 'x'), ['p2']);
  eq('без строк состава скрывать нечего', hiddenProjectIds([], 'x'), []);

  console.log('Какие проекты назвал запрос');
  eq('из адреса', projectIdsOfRequest('/api/projects/p1/tags', {}, {}), ['p1']);
  eq('из ?projectId=', projectIdsOfRequest('/api/vdr/list', { projectId: 'p2' }, {}), ['p2']);
  eq('из тела', projectIdsOfRequest('/api/tags/generate', {}, { projectId: 'p3' }), ['p3']);
  eq('все три — без повторов', projectIdsOfRequest('/api/projects/p1/x', { projectId: 'p1' }, { projectId: 'p4' }), ['p1', 'p4']);
  eq('«default» и «null» — не проект', projectIdsOfRequest('/api/projects/default/tags', { projectId: 'null' }, {}), []);
  eq('сам проект без хвоста страж не трогает', projectIdsOfRequest('/api/projects/p1', {}, {}), []);
  eq('массив в query — не строка', projectIdsOfRequest('/api/x', { projectId: ['p1', 'p2'] }, {}), []);
  eq('isRealProjectId: пусто', isRealProjectId('  '), false);
  eq('isRealProjectId: id', isRealProjectId('abc'), true);

  console.log('Изменение состава проекта');
  const base = { isAdmin: false, canManage: false, actorId: 'm1', before: ['m1', 'm2'], next: ['m1', 'm2'] };
  eq('администратор очищает', judgeMembersChange({ ...base, isAdmin: true, next: [] }).ok, true);
  eq('управляющий очищает', judgeMembersChange({ ...base, canManage: true, next: [] }).ok, true);
  eq('посторонний очистить не может', judgeMembersChange({ ...base, actorId: 'z', next: [] }).ok, false);
  eq('посторонний не зовёт никого', judgeMembersChange({ ...base, actorId: 'z', next: ['m1', 'm2', 'z'] }).ok, false);
  eq('участник зовёт коллегу', judgeMembersChange({ ...base, next: ['m1', 'm2', 'n'] }).ok, true);
  eq('участник не убирает коллегу', judgeMembersChange({ ...base, next: ['m1'] }).ok, false);
  eq('участник не очищает список', judgeMembersChange({ ...base, next: [] }).ok, false);
  eq('участник без изменений — можно', judgeMembersChange(base).ok, true);
  eq('открытому проекту состав задаёт не любой', judgeMembersChange({ ...base, before: [], next: ['m1'] }).ok, false);
  eq('открытому проекту состав задаёт управляющий', judgeMembersChange({ ...base, canManage: true, before: [], next: ['m1'] }).ok, true);
  eq('без личности — отказ', judgeMembersChange({ ...base, actorId: '', next: ['m1', 'm2'] }).ok, false);

  console.log('Право «Управление проектами»');
  const grants = (map: Record<string, string | null>) => async (code: string) => map[code] ?? null;
  const on = JSON.stringify({ 'project.manage': { enabled: true, until: null } });
  const off = JSON.stringify({ 'project.manage': { enabled: false, until: null } });
  eq('администратор — всегда', await actorMay({ id: 'a', role: 'ADMIN' }, grants({})), true);
  eq('нет входа — нет права', await actorMay(null, grants({})), false);
  eq('право от роли', await actorMay({ id: 'u', role: 'PM' }, grants({ PM: on })), true);
  eq('по умолчанию у сотрудника нет', await actorMay({ id: 'u', role: 'ENG' }, grants({})), false);
  eq('личный запрет сильнее роли', await actorMay({ id: 'u', role: 'PM', permissions: off }, grants({ PM: on })), false);
  eq('личная надбавка', await actorMay({ id: 'u', role: 'ENG', permissions: on }, grants({})), true);
  eq('отключённый профиль — нет', await actorMay({ id: 'u', role: 'PM', isActive: false }, grants({ PM: on })), false);
  eq('сбой чтения роли — отказ', await actorMay({ id: 'u', role: 'PM' }, async () => { throw new Error('база'); }), false);
  eq('старое project.create тоже управляет',
    await actorMay({ id: 'u', role: 'PM' }, grants({ PM: JSON.stringify({ 'project.create': { enabled: true, until: null } }) })), true);

  console.log('Ключи настроек');
  eq('ключ издателя — доверенный', isTrustKey('play.publisher.key'), true);
  eq('якорь времени — доверенный', isTrustKey('time_anchor'), true);
  eq('security.* — доверенный', isTrustKey('security.legacy_passwords_hashed'), true);
  eq('play_enabled — доверенный', isTrustKey('play_enabled'), true);
  eq('обычная настройка — нет', isTrustKey('registry_link_mode'), false);
  eq('подписанты документа — служебный, но не тайна', [isServerKey('office_signers:abc'), isTrustKey('office_signers:abc')], [true, false]);
  eq('вид категории — обычный ключ', isServerKey('equip_view:AHU'), false);
  eq('ключ с пробелом не проходит', validSettingKey('a b'), false);
  eq('слишком длинный ключ', validSettingKey('a'.repeat(121)), false);
  eq('ключ вида equip_view:AHU проходит', validSettingKey('equip_view:AHU'), true);
  eq('закладки — общее право проекта', globalWriteRule('browser_bookmarks_p1'), { project: true });
  eq('этапы закупки — право procurement.setup', globalWriteRule('procurement_templates'), { perm: 'procurement.setup' });
  eq('переключатель конфликтов — только администратор', globalWriteRule('equip_conflict_mode'), null);
  eq('проект из ключа закладок', bookmarksProjectOf('browser_bookmarks_p1'), 'p1');

  console.log('Чья настройка');
  eq('без userId — общая', settingScope('me', false, null), { kind: 'global' });
  eq('пустой userId — общая', settingScope('me', false, ''), { kind: 'global' });
  eq('свой userId — личная', settingScope('me', false, 'me'), { kind: 'personal', userId: 'me' });
  eq('чужой userId от сотрудника — своя', settingScope('me', false, 'other'), { kind: 'personal', userId: 'me' });
  eq('чужой userId от администратора — чужая', settingScope('adm', true, 'other'), { kind: 'personal', userId: 'other' });

  console.log('Группы чата');
  eq('владелец правит', mayEditGroup('o', false, 'o'), true);
  eq('чужой не правит', mayEditGroup('x', false, 'o'), false);
  eq('администратор правит любую', mayEditGroup('adm', true, 'o'), true);
  eq('группа без владельца — не сотруднику', mayEditGroup('x', false, null), false);
  eq('группа без владельца — администратору', mayEditGroup('adm', true, null), true);
  eq('без личности не правит', mayEditGroup('', false, ''), false);
  eq('владелец новой группы — создающий', ownerForNewGroup('me', false, 'other'), 'me');
  eq('администратор назначает другого', ownerForNewGroup('adm', true, 'other'), 'other');
  eq('администратор без выбора — сам', ownerForNewGroup('adm', true, ''), 'adm');

  console.log(fail ? `\nПровалено: ${fail}, пройдено: ${ok}` : `\nВсё в порядке: ${ok}`);
  process.exit(fail ? 1 : 0);
}

main();
