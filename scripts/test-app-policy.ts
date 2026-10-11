/**
 * Правило доступа к встроенным программам: порядок, сроки и должности.
 *
 * Проверяется то, из-за чего правило и пришлось писать отдельно от `can()`:
 *
 *   — порядок из ТЗ §3.1 сверху вниз, и каждая ступень сильнее следующей;
 *   — «ничего не сказано» — это НЕ запрет: ответ ищется в правах роли;
 *   — запись с истёкшим сроком равна её отсутствию, и выдача, и запрет;
 *   — администратор доступа сам по себе не получает;
 *   — пока сервер не ответил, платформы нет.
 *
 * Запуск: npx tsx scripts/test-app-policy.ts
 */
import {
  decide, entryMode, allows, toMap, PLATFORM_OFF,
  type PlatformState, type PolicyMap, type PolicySubject,
} from '../shared/appPolicy';
const APP_FEATURE = 'app.fixture';
import { sectionAccess, visibleSections } from '../src/lib/appPolicy';
import { SECTIONS } from '../src/workspace/sections';
import { hasAdminRole } from '../src/lib/permissions';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d) : '')));

const ON: PlatformState = { enabled: true, supported: true };
const ago = new Date(Date.now() - 86400000).toISOString();
const soon = new Date(Date.now() + 86400000).toISOString();

const who = (personal: PolicyMap = {}, fromRole: PolicyMap = {}, extra: Partial<PolicySubject> = {}): PolicySubject => ({
  active: true, validUntil: null, personal, fromRole, ...extra,
});

console.log('1. Что сказано в одной записи');
ok('пусто — ничего не сказано', entryMode(undefined) === 'INHERIT');
ok('enabled:true читается как выдача', entryMode({ enabled: true }) === 'ALLOW');
ok('enabled:false читается как запрет', entryMode({ enabled: false }) === 'DENY');
ok('явный DENY сильнее enabled:true', entryMode({ enabled: true, mode: 'DENY' }) === 'DENY');
ok('явный ALLOW сильнее enabled:false', entryMode({ enabled: false, mode: 'ALLOW' }) === 'ALLOW');
ok('истёкшая выдача равна отсутствию', entryMode({ mode: 'ALLOW', until: ago }) === 'INHERIT');
ok('истёкший запрет тоже равен отсутствию', entryMode({ mode: 'DENY', until: ago }) === 'INHERIT');
ok('срок в будущем ничего не отменяет', entryMode({ mode: 'ALLOW', until: soon }) === 'ALLOW');

console.log('\n2. Порядок проверок из ТЗ §3.1');
{
  const granted = { [APP_FEATURE]: { mode: 'ALLOW' as const } };

  const off = decide(who(granted), { enabled: false, supported: true }, APP_FEATURE);
  ok('общий выключатель сильнее личной выдачи', !off.allowed && off.source === 'platform', off);

  const unsupported = decide(who(granted), { enabled: true, supported: false }, APP_FEATURE);
  ok('неподдержанная база сильнее всего', !unsupported.allowed && unsupported.source === 'platform', unsupported);

  const disabled = decide(who(granted, {}, { active: false }), ON, APP_FEATURE);
  ok('отключённый профиль сильнее платформы', !disabled.allowed && disabled.source === 'profile', disabled);

  const expiredProfile = decide(who(granted, {}, { validUntil: ago }), ON, APP_FEATURE);
  ok('истёкший профиль — отказ', !expiredProfile.allowed && expiredProfile.source === 'profile', expiredProfile);

  const denyOverRole = decide(
    who({ [APP_FEATURE]: { mode: 'DENY' } }, { [APP_FEATURE]: { mode: 'ALLOW' } }), ON, APP_FEATURE,
  );
  ok('личный запрет сильнее выдачи роли', !denyOverRole.allowed && denyOverRole.source === 'personal', denyOverRole);

  const allowOverRoleDeny = decide(
    who({ [APP_FEATURE]: { mode: 'ALLOW' } }, { [APP_FEATURE]: { mode: 'DENY' } }), ON, APP_FEATURE,
  );
  ok('личная выдача сильнее запрета роли', allowOverRoleDeny.allowed && allowOverRoleDeny.source === 'personal', allowOverRoleDeny);

  const byRole = decide(who({}, { [APP_FEATURE]: { mode: 'ALLOW' } }), ON, APP_FEATURE);
  ok('роль отвечает, когда лично ничего не сказано', byRole.allowed && byRole.source === 'role', byRole);

  const nothing = decide(who(), ON, APP_FEATURE);
  ok('ничего не сказано нигде — отказ по умолчанию', !nothing.allowed && nothing.source === 'default', nothing);
}

console.log('\n3. Должность доступа не даёт');
{
  // Роль администратора в правило вообще не входит: у неё нет отдельной
  // ветки. Проверяем именно это — что решение зависит только от прав
  const admin = who();
  ok('администратор без выдачи — отказ', !allows(admin, ON, APP_FEATURE));
  ok('администратор с выдачей — доступ', allows(who({ [APP_FEATURE]: { mode: 'ALLOW' } }), ON, APP_FEATURE));
  const adminDenied = who({ [APP_FEATURE]: { mode: 'DENY' } }, { [APP_FEATURE]: { mode: 'ALLOW' } });
  ok('личный запрет действует и на администратора', !allows(adminDenied, ON, APP_FEATURE));
}

console.log('\n3а. Владелец получает полные права встроенных программ');
{
  const owner = who({}, {}, { owner: true });
  ok('OWNER получает встроенный модуль без личной или ролевой выдачи', allows(owner, ON, APP_FEATURE));
  for (const feature of ['app.fixture', 'module.fixture']) {
    ok(`OWNER получает игру «${feature}»`, allows(owner, ON, feature));
  }
  ok('общий выключатель всё ещё выключает встроенный модуль владельцу',
    !allows(owner, { enabled: false, supported: true }, APP_FEATURE));
  ok('неподдержанная база блокирует встроенный модуль владельцу',
    !allows(owner, { enabled: true, supported: false }, APP_FEATURE));
  ok('отключённый профиль владельца не получает доступа',
    !allows({ ...owner, active: false }, ON, APP_FEATURE));
  ok('истёкший профиль владельца не получает доступа',
    !allows({ ...owner, validUntil: ago }, ON, APP_FEATURE));
  ok('ADMIN с выданным доступом сохраняет явную выдачу',
    allows(who({ [APP_FEATURE]: { mode: 'ALLOW' } }), ON, APP_FEATURE));
  ok('личный запрет сотрудника сохраняет приоритет',
    !allows(who({ [APP_FEATURE]: { mode: 'DENY' } }, { [APP_FEATURE]: { mode: 'ALLOW' } }), ON, APP_FEATURE));
}

console.log('\n4. Выключенную платформу есть кому включить');
{
  const manager = who({ 'module.admin': { mode: 'ALLOW' } });
  const off: PlatformState = { enabled: false, supported: true };
  ok('общий выключатель не отнимает право управления',
    allows(manager, off, 'module.admin', { ignoreSwitch: true }));
  ok('но обычный доступ он отнимает',
    !allows(who({ [APP_FEATURE]: { mode: 'ALLOW' } }), off, APP_FEATURE));
  // Неподдержанную базу не обходит даже управление: включать там нечего
  ok('неподдержанную базу не обходит и управление',
    !allows(manager, { enabled: false, supported: false }, 'module.admin', { ignoreSwitch: true }));
}

console.log('\n5. Умолчание — отказ');
ok('без состояния платформы доступа нет', !allows(who({ [APP_FEATURE]: { mode: 'ALLOW' } }), PLATFORM_OFF, APP_FEATURE));
ok('без профиля доступа нет', !allows(null, ON, APP_FEATURE));
ok('PLATFORM_OFF выключена и не поддержана', !PLATFORM_OFF.enabled && !PLATFORM_OFF.supported);

console.log('\n8. Разбор карты прав');
ok('строка JSON разбирается', (toMap('{"a":{"enabled":true}}').a as any)?.enabled === true);
// Голое `true` в карте прав — «выдано», а не «запрещено». Читая его как
// объект, мы отвечали ЗАПРЕЩЕНО, и выданное право работало запретом
ok('голое true означает «выдано»', entryMode(true as any) === 'ALLOW');
ok('голое false означает «не сказано»', entryMode(false as any) === 'INHERIT');
ok('мусор не роняет разбор', Object.keys(toMap('не json')).length === 0);
ok('null даёт пустую карту', Object.keys(toMap(null)).length === 0);

console.log('\n9. Роль владельца открывает административные разделы и встроенный модуль');
const administrativeSection = { path: '/users', adminOnly: true };
const unlicensedModuleSection = { path: '/fixture-module', entitlement: APP_FEATURE, accessMode: 'normal' as const };
const appCtx = (role: string) => ({ user: { role, isActive: true }, platform: ON });
ok('OWNER проходит adminOnly', sectionAccess(administrativeSection, appCtx('OWNER')) === 'open');
ok('ADMIN проходит adminOnly', sectionAccess(administrativeSection, appCtx('ADMIN')) === 'open');
ok('USER остаётся закрыт на adminOnly', sectionAccess(administrativeSection, appCtx('USER')) === 'hide');
ok('OWNER и ADMIN открывают UI-функции уровня управления', hasAdminRole({ role: 'OWNER' }) && hasAdminRole({ role: 'ADMIN' }));
ok('обычный сотрудник не получает UI-функции уровня управления', !hasAdminRole({ role: 'ENGINEER' }));
ok('OWNER открывает встроенный модуль и игру', sectionAccess(unlicensedModuleSection, appCtx('OWNER')) === 'open');
const ownerCtx = { user: { role: 'OWNER', isActive: true }, platform: ON };
const ownerVisible = visibleSections(SECTIONS, ownerCtx);
ok('OWNER видит все самостоятельные программы при включённой встроенный модуль',
  ownerVisible.length === SECTIONS.filter(section => !section.fileOnly).length && ownerVisible.every(section => sectionAccess(section, ownerCtx) === 'open'),
  { visible: ownerVisible.map(section => section.path), total: SECTIONS.length });
ok('скрытие встроенных редакторов не отнимает их открытие у владельца',
  SECTIONS.every(section => sectionAccess(section, ownerCtx) === 'open'));
const filePaths = ['/doc', '/sheet', '/pdf', '/archives'];
ok('встроенные файловые действия не обнаруживаются как программы',
  !visibleSections(SECTIONS, ownerCtx).some(section => filePaths.includes(section.path)));
const openFileWindows = visibleSections(SECTIONS, ownerCtx, ['/doc', '/pdf']);
ok('панель возвращает только действительно открытые файловые окна',
  filePaths.filter(path => openFileWindows.some(section => section.path === path)).join(',') === '/doc,/pdf');
const deniedFile = { path: '/private-file', fileOnly: true, adminOnly: true };
ok('открытое файловое окно не обходит ограничение доступа',
  visibleSections([deniedFile], appCtx('USER'), ['/private-file']).length === 0);
for (const role of ['ADMIN', 'USER']) {
  ok(`${role} без явного права остаётся без встроенный модуль`, sectionAccess(unlicensedModuleSection, appCtx(role)) === 'explain');
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
