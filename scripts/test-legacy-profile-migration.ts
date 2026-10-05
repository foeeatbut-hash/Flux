import assert from 'node:assert/strict';
import { registerUserRoutes } from '../server/routes/users';
import { setPrisma } from '../server/context';
import { isLegacyBootstrapAdmin } from '../server/legacyIdentity';

async function main() {
  const oldLogin = String.fromCharCode(82, 97, 117, 112, 111, 118, 75, 104, 75, 104);
  let person: any = { id: 'original-user-id', symbol: oldLogin, name: 'Инженер', role: 'ADMIN', password: 'old-hash', isActive: true };
  let writes = 0;
  const invalidated: string[] = [];
  setPrisma({ user: {
    findUnique: async ({ where }: any) => where.id === person.id || where.symbol === person.symbol ? { ...person } : null,
    findMany: async () => [{ ...person }, { id: 'another-user', symbol: 'Taken' }],
    update: async ({ where, data }: any) => { assert.equal(where.id, person.id); writes++; person = { ...person, ...data }; return { ...person }; },
  } });
  const routes = new Map<string, Function[]>();
  const app: any = { use() {} };
  for (const method of ['get', 'post', 'put', 'delete']) app[method] = (route: string, ...handlers: Function[]) => routes.set(`${method}:${route}`, handlers);
  registerUserRoutes(app, { hashPassword: plain => `hashed:${plain}`, invalidateRolePerms() {}, invalidateAuthUser: id => invalidated.push(id!) });
  const handler = routes.get('put:/api/users/:id')!.at(-1)!;
  const call = async (role: string, symbol: string, password: string) => {
    const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; return this; } };
    await handler({ params: { id: person.id }, body: { symbol, password }, authUser: { id: 'actor', role } }, res);
    return res;
  };
  assert.equal((await call('ADMIN', 'personal.user', 'fresh-password')).statusCode, 403);
  assert.equal(writes, 0, 'Другой администратор не переносит установочный профиль');
  assert.equal((await call('OWNER', oldLogin, 'fresh-password')).statusCode, 400);
  assert.equal((await call('OWNER', 'personal.user', 'short')).statusCode, 400);
  assert.equal((await call('OWNER', 'taken', 'fresh-password')).statusCode, 400);
  assert.equal(writes, 0, 'Ошибки предпросмотра не меняют профиль');
  const result = await call('OWNER', 'personal.user', 'fresh-password');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.success, true);
  assert.equal(person.id, 'original-user-id');
  assert.equal(person.role, 'ADMIN');
  assert.equal(person.password, 'hashed:fresh-password');
  assert.equal(isLegacyBootstrapAdmin(person), false);
  assert.equal(result.body.user.password, undefined);
  assert.deepEqual(invalidated, ['original-user-id']);
  assert.equal(writes, 1, 'Миграция обновляет исходную запись, не создавая нового автора');
  console.log('✓ Реальный обработчик переноса профиля проверяет владельца, новый логин и пароль, сохраняет ID и отзывает прежние сессии');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
