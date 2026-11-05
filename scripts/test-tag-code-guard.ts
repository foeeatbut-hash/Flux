/**
 * Код тега: пустой и занятый не записываются.
 *
 * Дефект. `POST /api/projects/:id/tags` и `PUT /api/tags/:id` принимали пустой
 * код и код, уже стоящий у другого тега проекта. Двойное нажатие «Создать» (или
 * двойной Enter) отправляло тот же тег дважды и заводило два тега с одним кодом;
 * переименование в код соседа тоже проходило молча. В спецификацию и в документ
 * такие два тега попадают как «либо не та позиция, либо обе».
 *
 * Нужен сервер (FLUX_API) и вход (FLUX_USER, FLUX_PASS). Проект — свой,
 * одноразовый, в конце удаляется.
 *
 * Запуск: FLUX_USER=… FLUX_PASS=… npx tsx scripts/test-tag-code-guard.ts
 */
import { testCredentials } from './testCredentials';
import { tagCodeKey } from '../server/tagWrite';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();

let ok = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { ok++; return; }
  fail++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got).slice(0, 400)}`}`);
};

let token = '';
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: res.status, json };
};

const stamp = Date.now().toString(36).toUpperCase();
const codes = async (projectId: string): Promise<string[]> =>
  ((await call('GET', `/api/projects/${projectId}/tags`)).json?.tags || []).map((t: any) => t.identifier);

async function main() {
  check('ключ кода: пробелы по краям и регистр не различают коды', tagCodeKey('  Ahu-1 ') === tagCodeKey('AHU-1'));
  check('ключ кода: разные коды разные', tagCodeKey('AHU-1') !== tagCodeKey('AHU-11'));

  try { await call('GET', '/api/health'); } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`); process.exit(2);
  }
  const login = await call('POST', '/api/login', LOGIN);
  token = login.json?.token || '';
  if (!token) { console.error('Вход не удался', login.json?.message); process.exit(1); }

  const mk = async (name: string) => (await call('POST', '/api/projects', { name })).json?.project?.id as string;
  const projectId = await mk(`Код тега ${stamp}`);
  const otherId = await mk(`Код тега, другой ${stamp}`);
  if (!projectId || !otherId) { console.error('Проект не заведён'); process.exit(1); }

  try {
    console.log('Создание');
    const first = await call('POST', `/api/projects/${projectId}/tags`, { identifier: `AHU-${stamp}`, brand: 'М1' });
    check('первый тег создан', first.status === 200 && first.json?.tag?.identifier === `AHU-${stamp}`, first);
    const again = await call('POST', `/api/projects/${projectId}/tags`, { identifier: `AHU-${stamp}`, brand: 'М2' });
    check('тот же код второй раз — 409 с пометкой «занят»', again.status === 409 && again.json?.duplicate === true, again);
    check('сообщение называет код', String(again.json?.error || '').includes(`AHU-${stamp}`), again.json);
    const loose = await call('POST', `/api/projects/${projectId}/tags`, { identifier: `  ahu-${stamp.toLowerCase()}  ` });
    check('тот же код с другим регистром и пробелами — тоже занят', loose.status === 409, loose);
    check('в проекте один такой тег', (await codes(projectId)).filter((c) => tagCodeKey(c) === tagCodeKey(`AHU-${stamp}`)).length === 1);
    const empty = await call('POST', `/api/projects/${projectId}/tags`, { identifier: '   ', brand: 'М3' });
    check('пустой код — 400', empty.status === 400, empty);
    const missing = await call('POST', `/api/projects/${projectId}/tags`, { brand: 'М3' });
    check('код не передан — 400, а не 500 из базы', missing.status === 400, missing);
    const trimmed = await call('POST', `/api/projects/${projectId}/tags`, { identifier: `  BL-${stamp}  ` });
    check('код записывается без пробелов по краям', trimmed.status === 200 && trimmed.json?.tag?.identifier === `BL-${stamp}`, trimmed.json?.tag);
    const elsewhere = await call('POST', `/api/projects/${otherId}/tags`, { identifier: `AHU-${stamp}` });
    check('тот же код в другом проекте — можно', elsewhere.status === 200, elsewhere);

    console.log('Переименование');
    const second = trimmed.json?.tag;
    const clash = await call('PUT', `/api/tags/${second.id}`, { identifier: `ahu-${stamp.toLowerCase()}` });
    check('переименовать в код соседа — 409 «занят»', clash.status === 409 && clash.json?.duplicate === true, clash);
    check('код после отказа прежний', (await codes(projectId)).includes(`BL-${stamp}`) && !(await codes(projectId)).includes(`ahu-${stamp.toLowerCase()}`));
    const blank = await call('PUT', `/api/tags/${second.id}`, { identifier: '' });
    check('переименовать в пустой код — 400', blank.status === 400, blank);
    const same = await call('PUT', `/api/tags/${second.id}`, { identifier: ` BL-${stamp} `, brand: 'Новая' });
    check('тот же код (с пробелами) и другая марка — принимается', same.status === 200 && same.json?.tag?.brand === 'Новая' && same.json?.tag?.identifier === `BL-${stamp}`, same);
    const fresh = await call('PUT', `/api/tags/${second.id}`, { identifier: `BL-${stamp}-2` });
    check('переименовать в свободный код — можно', fresh.status === 200 && fresh.json?.tag?.identifier === `BL-${stamp}-2`, fresh);
    const onlyMeta = await call('PUT', `/api/tags/${second.id}`, { metadata: { mainName: 'Имя' } });
    check('правка без кода не трогает проверку кода', onlyMeta.status === 200, onlyMeta);
  } finally {
    for (const id of [projectId, otherId]) await call('DELETE', `/api/projects/${id}`);
  }

  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
