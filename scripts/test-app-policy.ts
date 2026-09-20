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
} from '../play/policy';
import { APP_PLAY, PLAY_GAMES, gameEntitlement, gameOfEntitlement, isPlayKey } from '../play/features';

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
  const granted = { [APP_PLAY]: { mode: 'ALLOW' as const } };

  const off = decide(who(granted), { enabled: false, supported: true }, APP_PLAY);
  ok('общий выключатель сильнее личной выдачи', !off.allowed && off.source === 'platform', off);

  const unsupported = decide(who(granted), { enabled: true, supported: false }, APP_PLAY);
  ok('неподдержанная база сильнее всего', !unsupported.allowed && unsupported.source === 'platform', unsupported);

  const disabled = decide(who(granted, {}, { active: false }), ON, APP_PLAY);
  ok('отключённый профиль сильнее платформы', !disabled.allowed && disabled.source === 'profile', disabled);

  const expiredProfile = decide(who(granted, {}, { validUntil: ago }), ON, APP_PLAY);
  ok('истёкший профиль — отказ', !expiredProfile.allowed && expiredProfile.source === 'profile', expiredProfile);

  const denyOverRole = decide(
    who({ [APP_PLAY]: { mode: 'DENY' } }, { [APP_PLAY]: { mode: 'ALLOW' } }), ON, APP_PLAY,
  );
  ok('личный запрет сильнее выдачи роли', !denyOverRole.allowed && denyOverRole.source === 'personal', denyOverRole);

  const allowOverRoleDeny = decide(
    who({ [APP_PLAY]: { mode: 'ALLOW' } }, { [APP_PLAY]: { mode: 'DENY' } }), ON, APP_PLAY,
  );
  ok('личная выдача сильнее запрета роли', allowOverRoleDeny.allowed && allowOverRoleDeny.source === 'personal', allowOverRoleDeny);

  const byRole = decide(who({}, { [APP_PLAY]: { mode: 'ALLOW' } }), ON, APP_PLAY);
  ok('роль отвечает, когда лично ничего не сказано', byRole.allowed && byRole.source === 'role', byRole);

  const nothing = decide(who(), ON, APP_PLAY);
  ok('ничего не сказано нигде — отказ по умолчанию', !nothing.allowed && nothing.source === 'default', nothing);
}

console.log('\n3. Должность доступа не даёт');
{
  // Роль администратора в правило вообще не входит: у неё нет отдельной
  // ветки. Проверяем именно это — что решение зависит только от прав
  const admin = who();
  ok('администратор без выдачи — отказ', !allows(admin, ON, APP_PLAY));
  ok('администратор с выдачей — доступ', allows(who({ [APP_PLAY]: { mode: 'ALLOW' } }), ON, APP_PLAY));
  const adminDenied = who({ [APP_PLAY]: { mode: 'DENY' } }, { [APP_PLAY]: { mode: 'ALLOW' } });
  ok('личный запрет действует и на администратора', !allows(adminDenied, ON, APP_PLAY));
}

console.log('\n4. Выключенную платформу есть кому включить');
{
  const manager = who({ 'play.admin': { mode: 'ALLOW' } });
  const off: PlatformState = { enabled: false, supported: true };
  ok('общий выключатель не отнимает право управления',
    allows(manager, off, 'play.admin', { ignoreSwitch: true }));
  ok('но обычный доступ он отнимает',
    !allows(who({ [APP_PLAY]: { mode: 'ALLOW' } }), off, APP_PLAY));
  // Неподдержанную базу не обходит даже управление: включать там нечего
  ok('неподдержанную базу не обходит и управление',
    !allows(manager, { enabled: false, supported: false }, 'play.admin', { ignoreSwitch: true }));
}

console.log('\n5. Умолчание — отказ');
ok('без состояния платформы доступа нет', !allows(who({ [APP_PLAY]: { mode: 'ALLOW' } }), PLATFORM_OFF, APP_PLAY));
ok('без профиля доступа нет', !allows(null, ON, APP_PLAY));
ok('PLATFORM_OFF выключена и не поддержана', !PLATFORM_OFF.enabled && !PLATFORM_OFF.supported);

console.log('\n6. Право на игру — отдельное от права на платформу');
{
  const onlyApp = who({ [APP_PLAY]: { mode: 'ALLOW' } });
  for (const g of PLAY_GAMES) {
    ok(`«${g.title}» не выдаётся вместе с платформой`, !allows(onlyApp, ON, gameEntitlement(g.id)));
  }
  const withGame = who({ [APP_PLAY]: { mode: 'ALLOW' }, [gameEntitlement('testgame')]: { mode: 'ALLOW' } });
  ok('выданная игра доступна', allows(withGame, ON, gameEntitlement('testgame')));
  ok('невыданная соседняя — нет', !allows(withGame, ON, gameEntitlement('fluxstrike')));
  ok('код игры читается из права обратно', gameOfEntitlement(gameEntitlement('fluxstrike')) === 'fluxstrike');
  ok('чужой код игрой не считается', gameOfEntitlement('log.view') === '');
}

console.log('\n7. Ключи платформы узнаются по имени');
ok('право платформы опознано', isPlayKey(APP_PLAY));
ok('право игры опознано', isPlayKey(gameEntitlement('fluxstrike')));
ok('рабочее право платформой не считается', !isPlayKey('log.view'));
ok('пустая строка не считается', !isPlayKey(''));

console.log('\n8. Разбор карты прав');
ok('строка JSON разбирается', toMap('{"a":{"enabled":true}}').a?.enabled === true);
ok('мусор не роняет разбор', Object.keys(toMap('не json')).length === 0);
ok('null даёт пустую карту', Object.keys(toMap(null)).length === 0);

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
