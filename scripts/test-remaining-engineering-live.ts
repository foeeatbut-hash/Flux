import { testCredentials } from './testCredentials';

/**
 * API/DB smoke coverage for critical engineering mutations that had only
 * unit/helper claims. Uses a disposable project and removes that whole project
 * even when an assertion fails. Never targets the shared/company database.
 *
 * Run against the isolated MariaDB fixture with FLUX_API/FLUX_USER/FLUX_PASS.
 */
const BASE = process.env.FLUX_API || 'http://127.0.0.1:4300';
const LOGIN = testCredentials();
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let token = '';
let projectId = '';
let passed = 0;
let failures = 0;

const ok = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) { passed++; console.log('  ✓', name); }
  else {
    failures++;
    console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400));
  }
};

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* report status/body when relevant */ }
  return { status: response.status, json, text };
}

const parseMeta = (value: unknown) => {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value as any : {};
  try { return JSON.parse(value); } catch { return {}; }
};

(async () => {
  try {
    token = (await call('POST', '/api/login', LOGIN)).json?.token || '';
    ok('вход в выделенную фикстуру', token.length > 20);
    if (!token) throw new Error('Вход не удался; дальнейшие изменения не выполнялись.');

    const createdProject = await call('POST', '/api/projects', { name: `Проверка инженерии ${suffix}` });
    projectId = createdProject.json?.project?.id || '';
    ok('создан отдельный проект для сценария', createdProject.status === 200 && !!projectId, createdProject.json);
    if (!projectId) throw new Error('Не удалось создать проект для изолированного сценария.');

    console.log('1. Теги и удаление из проекта');
    const tagIds: string[] = [];
    for (const identifier of [`QA-${suffix}-A`, `QA-${suffix}-B`, `QA-${suffix}-C`]) {
      const made = await call('POST', `/api/projects/${projectId}/tags`, {
        identifier,
        department: 'Проверка инженерии',
        metadata: { verificationRun: suffix },
      });
      tagIds.push(made.json?.tag?.id || '');
      ok(`тег ${identifier} создан`, made.status === 200 && !!made.json?.tag?.id, made.json);
    }
    const tagId = tagIds[0];
    const updateTag = await call('PUT', `/api/tags/${tagId}`, {
      brand: 'Пробная марка', fluid: 'Вода', wbs: 'QA/01',
      metadata: { verificationRun: suffix, value: 'edited' },
    });
    ok('карточка тега сохраняет поля и спецификацию', updateTag.status === 200 && updateTag.json?.tag?.brand === 'Пробная марка' && parseMeta(updateTag.json?.tag?.metadata)?.value === 'edited', updateTag.json);
    const listedTags = (await call('GET', `/api/projects/${projectId}/tags`)).json?.tags || [];
    ok('сохранённый тег перечитывается из того же проекта', listedTags.some((t: any) => t.id === tagId && t.fluid === 'Вода'));
    const removedTag = await call('DELETE', `/api/tags/${tagIds[2]}`);
    const afterDelete = (await call('GET', `/api/projects/${projectId}/tags`)).json?.tags || [];
    ok('удаление тега убирает только выбранную запись', removedTag.status === 200 && !afterDelete.some((t: any) => t.id === tagIds[2]) && afterDelete.some((t: any) => t.id === tagIds[0]), afterDelete.map((t: any) => t.identifier));

    console.log('2. Этап закупки и массовая запись');
    const procOne = { procurement: { stage: 'ordered', stageLog: { ordered: { at: '2026-10-04T10:00:00.000Z', by: 'Проверка' } } }, verificationRun: suffix };
    const stageOne = await call('PUT', `/api/tags/${tagIds[0]}`, { metadata: procOne });
    const bulk = await call('PUT', '/api/tags/bulk-metadata', {
      updates: [
        { id: tagIds[1], metadata: { procurement: { stage: 'approved', stageLog: { approved: { at: '2026-10-04T10:01:00.000Z', by: 'Проверка' } } }, verificationRun: suffix } },
        { id: tagIds[0], metadata: { ...procOne, note: 'bulk-preserved' } },
      ],
    });
    const procurementRead = (await call('GET', `/api/projects/${projectId}/tags`)).json?.tags || [];
    const readOne = parseMeta(procurementRead.find((t: any) => t.id === tagIds[0])?.metadata);
    const readTwo = parseMeta(procurementRead.find((t: any) => t.id === tagIds[1])?.metadata);
    ok('одиночный этап закупки сохраняется', stageOne.status === 200 && readOne.procurement?.stage === 'ordered');
    ok('массовая запись сохраняет этапы обеих выбранных строк', bulk.status === 200 && bulk.json?.updated === 2 && readOne.note === 'bulk-preserved' && readTwo.procurement?.stage === 'approved', bulk.json);

    console.log('3. Список Конструктора, позиции, отмена и выпуск');
    const createdList = await call('POST', '/api/builder/lists', {
      projectId, classId: 'cls-valve', name: `Проверка ${suffix}`,
    });
    const listId = createdList.json?.list?.id || '';
    ok('список создан в текущем тестовом проекте', createdList.status === 200 && !!listId && createdList.json?.list?.header?.object === `Проверка инженерии ${suffix}`, createdList.json);
    if (listId) {
      const renamed = await call('PUT', `/api/builder/lists/${listId}`, { name: `Переименовано ${suffix}` });
      const itemA = { id: `item-${suffix}-1`, classId: 'cls-valve', tags: [`QA-${suffix}-A`], qty: 2, familyId: 'veza-kpu-1n', values: { W: 400 }, status: 'matched', sort: 1 };
      const itemB = { id: `item-${suffix}-2`, classId: 'cls-valve', tags: [`QA-${suffix}-B`], qty: 1, familyId: 'veza-kpu-1n', values: { W: 500 }, status: 'matched', sort: 2 };
      const firstWrite = await call('POST', `/api/builder/lists/${listId}/apply`, { title: 'Синтетические позиции', upserts: [itemA, itemB] });
      const loaded = await call('GET', `/api/builder/lists/${listId}`);
      ok('список переименовывается и позиции с количеством читаются обратно', renamed.status === 200 && renamed.json?.list?.name === `Переименовано ${suffix}` && firstWrite.status === 200 && loaded.json?.items?.length === 2 && loaded.json.items[0].qty === 2, loaded.json?.items);
      const changed = await call('POST', `/api/builder/lists/${listId}/apply`, { title: 'Массовая правка количества', upserts: [{ ...loaded.json.items[0], qty: 7 }] });
      const changedRows = (await call('GET', `/api/builder/lists/${listId}`)).json?.items || [];
      ok('пакетная правка позиции сохраняет новое количество', changed.status === 200 && changedRows.find((i: any) => i.id === itemA.id)?.qty === 7);
      const undo = await call('POST', `/api/builder/batches/${changed.json?.batchId}/undo`);
      const afterUndo = (await call('GET', `/api/builder/lists/${listId}`)).json?.items || [];
      ok('отмена возвращает предыдущее количество', undo.status === 200 && afterUndo.find((i: any) => i.id === itemA.id)?.qty === 2);
      const duplicateUndo = await call('POST', `/api/builder/batches/${changed.json?.batchId}/undo`);
      ok('повторная отмена отклоняется без второй записи', duplicateUndo.status === 409);
      const issue = await call('POST', `/api/builder/lists/${listId}/issues`, { rev: `QA-${suffix}`, date: '2026-10-04', reason: 'Сквозная проверка' });
      const issues = (await call('GET', `/api/builder/lists/${listId}/issues?snapshots=1`)).json?.issues || [];
      ok('выпуск фиксирует ревизию и снимок текущих позиций', issue.status === 200 && issues.some((x: any) => x.rev === `QA-${suffix}` && x.snapshot?.items?.length === 2), issues);
      const duplicateIssue = await call('POST', `/api/builder/lists/${listId}/issues`, { rev: `QA-${suffix}`, date: '2026-10-04', reason: 'Повтор' });
      ok('одна ревизия не выпускается дважды', duplicateIssue.status === 409, duplicateIssue.status);
      const deletedList = await call('DELETE', `/api/builder/lists/${listId}`);
      const remainingLists = (await call('GET', `/api/builder/lists?projectId=${projectId}`)).json?.lists || [];
      ok('список удаляется из списка проекта', deletedList.status === 200 && !remainingLists.some((x: any) => x.id === listId));
    }

    console.log('4. Справочник: запись, дочернее значение и удаление');
    const dictionary = await call('POST', `/api/projects/${projectId}/dictionaries`, {
      name: `Справочник проверки ${suffix}`,
      items: [{ code: `ROOT-${suffix}`, nameRu: `Корень ${suffix}` }],
    });
    const dictionaryId = dictionary.json?.dictionary?.id || '';
    const rootItemId = dictionary.json?.dictionary?.items?.[0]?.id || '';
    const child = dictionaryId ? await call('POST', `/api/projects/${projectId}/dictionaries/${dictionaryId}/items`, {
      code: `CHILD-${suffix}`, nameRu: `Дочернее ${suffix}`, parentId: rootItemId,
    }) : { status: 0, json: null };
    const childId = child.json?.item?.id || '';
    const editChild = childId ? await call('PUT', `/api/dictionaries/items/${childId}`, { code: `CHILD-EDITED-${suffix}`, nameRu: `Правка ${suffix}`, parentId: rootItemId }) : { status: 0, json: null };
    const dictionaryRead = (await call('GET', `/api/projects/${projectId}/dictionaries`)).json?.dictionaries || [];
    const readDictionary = dictionaryRead.find((d: any) => d.id === dictionaryId);
    ok('справочник и дочернее значение сохраняются и редактируются', dictionary.status === 200 && child.status === 200 && editChild.status === 200 && readDictionary?.items?.some((i: any) => i.id === childId && i.parentId === rootItemId && i.code === `CHILD-EDITED-${suffix}`), readDictionary);
    const deleteChild = childId ? await call('DELETE', `/api/dictionaries/items/${childId}`) : { status: 0 };
    const afterChildDelete = (await call('GET', `/api/projects/${projectId}/dictionaries`)).json?.dictionaries || [];
    ok('дочерняя запись удаляется отдельно от корневой', deleteChild.status === 200 && afterChildDelete.find((d: any) => d.id === dictionaryId)?.items?.length === 1);
  } catch (error: any) {
    failures++;
    console.error('  ✗ сценарий прерван:', error?.message || error);
  } finally {
    if (projectId && token) {
      const cleanup = await call('DELETE', `/api/projects/${projectId}`);
      ok('временный проект и его данные удалены после сценария', cleanup.status === 200, cleanup.json || cleanup.text);
    }
  }

  console.log(`\n${passed} проверок пройдено, ${failures} провалено`);
  if (failures) process.exit(1);
})();
