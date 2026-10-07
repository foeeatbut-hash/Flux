/**
 * Безопасная запись metadata тега: слияние ключей и сверка версии.
 *
 * Дефект («ошибка №1» проекта): PUT /api/tags/:id заменял metadata целиком, а
 * «Закупки» сохраняли по копии тега, прочитанной при открытии экрана. Комментарий,
 * добавленный коллегой в «Тегах», при смене этапа закупки молча стирался.
 *
 * Здесь два «клиента» работают с одним тегом: «Теги» (комментарии) и «Закупки»
 * (этап), причём «Закупки» держат старую копию.
 *
 * Нужен сервер (FLUX_API) и вход (FLUX_USER, FLUX_PASS). Проект — свой,
 * одноразовый, в конце удаляется.
 *
 * Запуск: FLUX_USER=… FLUX_PASS=… npx tsx scripts/test-tag-metadata-merge.ts
 */
import { testCredentials } from './testCredentials';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = testCredentials();

let ok = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { ok++; return; }
  fail++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got).slice(0, 500)}`}`);
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

const stamp = Date.now().toString(36);
const metaOf = (tag: any): any => { try { return JSON.parse(tag?.metadata || '{}'); } catch { return {}; } };
/** Тег так, как его читает любой экран */
const read = async (projectId: string, id: string): Promise<any> =>
  ((await call('GET', `/api/projects/${projectId}/tags`)).json?.tags || []).find((t: any) => t.id === id);

async function main() {
  try { await call('GET', '/api/health'); } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`); process.exit(2);
  }
  const login = await call('POST', '/api/login', LOGIN);
  token = login.json?.token || '';
  if (!token) { console.error('Вход не удался', login.json?.message); process.exit(1); }

  const proj = await call('POST', '/api/projects', { name: `Слияние ${stamp}` });
  const projectId = proj.json?.project?.id;
  if (!projectId) { console.error('Проект не заведён', proj.json); process.exit(1); }
  const mine: string[] = [];

  try {
    const made = (await call('POST', `/api/projects/${projectId}/tags`, {
      identifier: `MRG-${stamp}-A`, brand: 'Старая марка',
      metadata: JSON.stringify({ x: 100, y: 100, mainName: 'Вентилятор', connections: [], descriptions: [], parentId: 'нет-такого' }),
    })).json?.tag;
    mine.push(made?.id);
    check('тег заведён и у него есть версия (updatedAt или ни разу не правился)', !!made?.id);

    // «Закупки» открыли экран здесь: это их копия, она устареет
    const staleCopy = await read(projectId, made.id);
    const staleVersion = staleCopy.updatedAt ?? null;

    console.log('«Теги» добавляют комментарий — по своей актуальной версии');
    const comment = { id: 'c-1', text: 'Проверить мощность', comment: 'уточнить у заказчика', status: 'warning', createdBy: 'Теги', createdAt: new Date().toISOString() };
    const add = await call('PUT', `/api/tags/${made.id}`, { metadata: { descriptions: [comment] }, version: staleVersion });
    check('запись по текущей версии проходит', add.status === 200, add.json);
    check('комментарий записан, соседние ключи не потеряны', JSON.stringify(metaOf(add.json?.tag).descriptions) === JSON.stringify([comment]) && metaOf(add.json?.tag).mainName === 'Вентилятор' && metaOf(add.json?.tag).x === 100, metaOf(add.json?.tag));
    check('версия тега сменилась', add.json?.tag?.updatedAt && add.json.tag.updatedAt !== staleVersion, [add.json?.tag?.updatedAt, staleVersion]);
    const freshVersion = add.json?.tag?.updatedAt;

    console.log('«Закупки» по старой копии меняют этап');
    // Новый клиент «Закупок» шлёт только свой ключ — слияние оставляет чужое
    const stage = await call('PUT', `/api/tags/${made.id}`, { metadata: { procurement: { stage: 'ordered', supplier: 'ООО Поставщик' } } });
    check('запись без версии проходит: старые клиенты работают', stage.status === 200, stage.json);
    let now = metaOf(await read(projectId, made.id));
    check('этап закупки записан', now.procurement?.stage === 'ordered' && now.procurement?.supplier === 'ООО Поставщик', now);
    check('комментарий, добавленный «Тегами», остался', Array.isArray(now.descriptions) && now.descriptions[0]?.id === 'c-1', now.descriptions);
    check('наименование и положение тоже остались', now.mainName === 'Вентилятор' && now.x === 100, now);

    console.log('Запись со старой версией получает конфликт');
    const second = { id: 'c-2', text: 'Второй', comment: 'коллега успел раньше', status: 'info', createdBy: 'Теги', createdAt: new Date().toISOString() };
    const conflict = await call('PUT', `/api/tags/${made.id}`, { metadata: { descriptions: [comment, second] }, version: freshVersion });
    check('«Теги» со старой версией: 409', conflict.status === 409 && conflict.json?.conflict === true, conflict.json);
    check('в ответе — текущий тег с этапом закупки, который «Теги» не видели', metaOf(conflict.json?.tag).procurement?.stage === 'ordered', metaOf(conflict.json?.tag));
    check('конфликтная запись не записана', metaOf(await read(projectId, made.id)).descriptions.length === 1);
    const staleField = await call('PUT', `/api/tags/${made.id}`, { brand: 'Чужая марка', version: freshVersion });
    check('правка поля со старой версией — тоже конфликт', staleField.status === 409 && (await read(projectId, made.id)).brand === 'Старая марка', staleField.status);
    const stalePut = await call('PUT', `/api/tags/${made.id}`, { metadata: { descriptions: [] }, version: staleVersion });
    check('и «Закупки» со своей старой версией не затрут комментарий старой копией', stalePut.status === 409 && metaOf(await read(projectId, made.id)).descriptions.length === 1, stalePut.status);

    console.log('После перечитывания запись проходит');
    const reread = await read(projectId, made.id);
    const retry = await call('PUT', `/api/tags/${made.id}`, { metadata: { descriptions: [comment, second] }, version: reread.updatedAt });
    check('повторная запись по свежей версии проходит', retry.status === 200 && metaOf(retry.json?.tag).descriptions.length === 2, retry.json);
    check('этап закупки при этом не потерян', metaOf(retry.json?.tag).procurement?.stage === 'ordered');

    console.log('«Закупки» новым запросом: PATCH /api/tags/:id/procurement');
    const procCopy = await read(projectId, made.id);          // копия «Закупок», она устареет
    const note = { id: 'c-3', text: 'Третий', comment: 'добавлен после того, как «Закупки» открыли экран', status: 'info', createdBy: 'Теги', createdAt: new Date().toISOString() };
    const addNote = await call('PUT', `/api/tags/${made.id}`, { metadata: { descriptions: [comment, second, note] }, version: procCopy.updatedAt });
    check('«Теги» добавили третий комментарий', addNote.status === 200 && metaOf(addNote.json?.tag).descriptions.length === 3, addNote.json);
    const staleProc = await call('PATCH', `/api/tags/${made.id}/procurement`, { procurement: { stage: 'delivered', supplier: 'ООО Поставщик' }, version: procCopy.updatedAt });
    check('«Закупки» со старой копией: 409 и текущий тег', staleProc.status === 409 && staleProc.json?.conflict === true && metaOf(staleProc.json?.tag).descriptions.length === 3, staleProc.json);
    check('конфликтная закупка не записана', metaOf(await read(projectId, made.id)).procurement?.stage === 'ordered');
    const freshProc = await call('PATCH', `/api/tags/${made.id}/procurement`, { procurement: { stage: 'delivered', supplier: 'ООО Поставщик' }, version: staleProc.json?.tag?.updatedAt });
    now = metaOf(freshProc.json?.tag);
    check('после перечитывания закупка записана', freshProc.status === 200 && now.procurement?.stage === 'delivered', freshProc.json);
    check('все три комментария на месте', now.descriptions?.length === 3 && now.mainName === 'Вентилятор' && now.x === 100, now);
    const stalePatchNoVer = await call('PATCH', `/api/tags/${made.id}/procurement`, { procurement: { stage: 'ordered', supplier: 'Другой' } });
    check('без версии закупка тоже проходит, а чужие ключи целы', stalePatchNoVer.status === 200 && metaOf(stalePatchNoVer.json?.tag).descriptions.length === 3 && metaOf(stalePatchNoVer.json?.tag).procurement?.supplier === 'Другой', stalePatchNoVer.json);
    check('«Теги» со старой версией после правки закупки: 409', (await call('PUT', `/api/tags/${made.id}`, { metadata: { descriptions: [] }, version: freshProc.json?.tag?.updatedAt })).status === 409);
    check('закупка не объектом — 400', (await call('PATCH', `/api/tags/${made.id}/procurement`, { procurement: 'этап' })).status === 400 && (await call('PATCH', `/api/tags/${made.id}/procurement`, {})).status === 400);
    check('несуществующий тег — 404', (await call('PATCH', '/api/tags/нет-такого/procurement', { procurement: { stage: 'x' } })).status === 404);
    const sameProc = (await read(projectId, made.id)).updatedAt;
    await call('PATCH', `/api/tags/${made.id}/procurement`, { procurement: { stage: 'ordered', supplier: 'Другой' } });
    check('та же закупка: версия не сдвигается', (await read(projectId, made.id)).updatedAt === sameProc);
    // Метаданные теперь «ordered», вернём для прежних проверок ниже
    await call('PATCH', `/api/tags/${made.id}/procurement`, { procurement: { stage: 'ordered', supplier: 'ООО Поставщик' } });
    const histProc: any[] = (await call('GET', `/api/tags/${made.id}/history`)).json?.history || [];
    check('история: изменение закупки с источником «Закупки» и «было → стало»', histProc.some((r) => r.source === 'Закупки' && r.field === 'procurement.stage' && r.before === 'ordered' && r.after === 'delivered'), histProc.slice(0, 8));
    check('история: комментарии «Закупки» не пишут', !histProc.some((r) => r.source === 'Закупки' && /комментарий/.test(r.kind)));
    // Затем прежние сценарии идут от «descriptions» из двух
    await call('PUT', `/api/tags/${made.id}`, { metadata: { descriptions: [comment, second] } });

    console.log('Положение карточки версией не сверяется');
    const baseVersion = (await read(projectId, made.id)).updatedAt;
    const layout = await call('PUT', `/api/tags/${made.id}`, { metadata: { x: 640, y: 260 }, version: staleVersion });
    check('перенос по холсту проходит и со старой версией', layout.status === 200 && metaOf(layout.json?.tag).x === 640, layout.json);
    check('и ничего другого не трогает', metaOf(layout.json?.tag).descriptions.length === 2 && metaOf(layout.json?.tag).procurement?.stage === 'ordered');
    check('перенос карточки версию тега не меняет', layout.json?.tag?.updatedAt === baseVersion, [layout.json?.tag?.updatedAt, baseVersion]);
    const bulkLayout = await call('PUT', '/api/tags/bulk-metadata', { updates: [{ id: made.id, metadata: { x: 10, y: 20 } }] });
    check('и раскладка массовым запросом — тоже', bulkLayout.json?.versions?.[0]?.updatedAt === baseVersion, bulkLayout.json);

    console.log('Удаление ключа — только явным null');
    const noParent = await call('PUT', `/api/tags/${made.id}`, { metadata: { parentId: null } });
    check('null снимает ключ', noParent.status === 200 && !('parentId' in metaOf(noParent.json?.tag)), metaOf(noParent.json?.tag));
    check('пропущенный ключ — «не трогать»', metaOf(noParent.json?.tag).mainName === 'Вентилятор');

    console.log('Пустая запись не меняет версию');
    const before = (await read(projectId, made.id)).updatedAt;
    const same = await call('PUT', `/api/tags/${made.id}`, { metadata: { mainName: 'Вентилятор' }, brand: 'Старая марка' });
    check('то же значение: запрос проходит', same.status === 200);
    check('и версия не сдвигается', (await read(projectId, made.id)).updatedAt === before);

    console.log('Плохой вход');
    check('metadata не JSON — 400', (await call('PUT', `/api/tags/${made.id}`, { metadata: '{не json' })).status === 400);
    check('metadata массивом — 400', (await call('PUT', `/api/tags/${made.id}`, { metadata: [1] })).status === 400);
    check('служебное parsedMetadata в базу не попадает', !('parsedMetadata' in metaOf((await call('PUT', `/api/tags/${made.id}`, { metadata: { parsedMetadata: { a: 1 }, note: 'x' } })).json?.tag)));

    console.log('Одновременные записи не затирают друг друга');
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      call('PUT', `/api/tags/${made.id}`, { metadata: { [`k${i}`]: i } })));
    check('все двенадцать записей приняты', burst.every((r) => r.status === 200), burst.map((r) => r.status));
    now = metaOf(await read(projectId, made.id));
    check('все двенадцать ключей на месте', Array.from({ length: 12 }, (_, i) => now[`k${i}`] === i).every(Boolean), Object.keys(now));

    console.log('Массовая запись');
    const second2 = (await call('POST', `/api/projects/${projectId}/tags`, { identifier: `MRG-${stamp}-B`, metadata: JSON.stringify({ descriptions: [comment], mainName: 'Второй' }) })).json?.tag;
    mine.push(second2?.id);
    const bulk = await call('PUT', '/api/tags/bulk-metadata', { updates: [
      { id: made.id, metadata: { procurement: { stage: 'approved' } } },
      { id: second2.id, metadata: JSON.stringify({ procurement: { stage: 'approved' } }) },
      { id: 'нет-такого-тега', metadata: { a: 1 } },
    ] });
    check('массовая запись прошла, несуществующий тег назван', bulk.status === 200 && bulk.json?.missing?.[0] === 'нет-такого-тега', bulk.json);
    const m1 = metaOf(await read(projectId, made.id));
    const m2 = metaOf(await read(projectId, second2.id));
    check('этап поменялся у обоих', m1.procurement?.stage === 'approved' && m2.procurement?.stage === 'approved');
    check('комментарии и наименования у обоих остались', m1.descriptions.length === 2 && m2.descriptions.length === 1 && m2.mainName === 'Второй', [m1.descriptions, m2]);
    const onlyProc = await call('PUT', '/api/tags/bulk-metadata', { source: 'Закупки', updates: [
      { id: second2.id, metadata: { procurement: { stage: 'purchased' }, descriptions: [], mainName: 'Стёрто' } },
    ] });
    const m3 = metaOf(await read(projectId, second2.id));
    check('«Закупки» массово меняют только procurement', onlyProc.status === 200 && m3.procurement?.stage === 'purchased' && m3.descriptions.length === 1 && m3.mainName === 'Второй', m3);

    console.log('История записала слияния');
    const hist: any[] = (await call('GET', `/api/tags/${made.id}/history`)).json?.history || [];
    check('комментарий добавлен «Тегами» — запись есть', hist.some((r) => r.kind === 'комментарий добавлен' && r.source === 'Теги' && /уточнить у заказчика/.test(r.after || '')), hist.slice(0, 6));
    check('этап закупки записан отдельной строкой «было → стало»', hist.some((r) => r.field === 'procurement.stage' && r.before === 'ordered' && r.after === 'approved'), hist.slice(0, 8));
    check('конфликтные записи в историю не попали', !hist.some((r) => r.after === 'Чужая марка'));
  } finally {
    for (const id of mine) if (id) await call('DELETE', `/api/tags/${id}`);
    await call('DELETE', `/api/projects/${projectId}`);
  }

  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
