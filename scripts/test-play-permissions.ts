import assert from 'node:assert/strict';
import { APP_PLAY, PLAY_ADMIN, PLAY_PLAYER_ENTITLEMENTS, gameEntitlement } from '../play/features';
import { cleanUserPermissions } from '../src/lib/userPermissions';

const chosen = cleanUserPermissions({
  [APP_PLAY]: { enabled: true, until: null, mode: 'ALLOW' },
  [gameEntitlement('chess')]: { enabled: true, until: null, mode: 'ALLOW' },
  [gameEntitlement('seabattle')]: { enabled: false, until: null, mode: 'DENY' },
  'play.party.create': { enabled: true, until: '2030-01-01T00:00:00.000Z', mode: 'ALLOW' },
  'project.manage': { enabled: false, until: null },
});

assert.equal(chosen[APP_PLAY].mode, 'ALLOW');
assert.equal(chosen[gameEntitlement('chess')].enabled, true);
assert.deepEqual(chosen[gameEntitlement('seabattle')], { enabled: false, until: null, mode: 'DENY' });
assert.equal(chosen['play.party.create'].until, '2030-01-01T00:00:00.000Z');
assert.equal('project.manage' in chosen, false);
const playable = new Set(PLAY_PLAYER_ENTITLEMENTS.map(e => e.id));
for (const right of [APP_PLAY, gameEntitlement('chess'), 'play.party.create', 'play.session.start']) {
  assert.ok(playable.has(right), `${right} нужен для игры`);
}
assert.equal(playable.has(PLAY_ADMIN), false);
console.log('✓ Карточка сохраняет выдачу игр и личный запрет, рабочие выключенные права очищает');
console.log('✓ Массовая выдача включает вход и запуск матчей без права управления платформой');
