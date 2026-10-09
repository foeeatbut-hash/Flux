import { testCredentials } from './testCredentials';
import { VEZA_SAMPLE_XML } from './fixtures/veza';

/**
 * События для тега, созданного из Оборудования, и актуальность ответов API.
 * Проверяет настоящий Socket.IO канал и перечитывает списки теми же API, что
 * используют открытые экраны. Работает только с одноразовым тестовым проектом.
 *
 * Запуск: FLUX_API=http://127.0.0.1:4197 FLUX_USER=… FLUX_PASS=…
 *   node --import tsx/esm scripts/test-equipment-tag-sync-live.ts
 */
const BASE = process.env.FLUX_API || 'http://127.0.0.1:4197';
const LOGIN = testCredentials();
let failed = 0;
const check = (name: string, condition: boolean, detail = '') => {
  if (condition) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

async function api(token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) as any };
}

const waitFor = async (condition: () => boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (!condition() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 40));
  return condition();
};

async function main() {
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`Сервер ${BASE} недоступен`);
  const login = await api('', 'POST', '/api/login', LOGIN);
  const token = String(login.data?.token || '');
  if (!token) throw new Error(`Вход не выполнен (HTTP ${login.status})`);

  const stamp = Date.now().toString(36);
  let projectId = '';
  let socket: import('socket.io-client').Socket | null = null;
  try {
    const project = await api(token, 'POST', '/api/projects', { name: `Проверка синхронизации тегов ${stamp}`, code: 'RT' });
    projectId = String(project.data?.project?.id || '');
    check('одноразовый проект создан', project.status === 200 && !!projectId, `HTTP ${project.status}`);
    if (!projectId) return;

    const { io } = await import('socket.io-client');
    const changes: { kind: string; id: string; ids?: string[] }[] = [];
    socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket.IO не подключился за 5 секунд')), 5000);
      socket!.once('connect', () => { clearTimeout(timer); resolve(); });
      socket!.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
    });
    socket.on('entity:changed', (event: any) => {
      if (typeof event?.kind === 'string' && typeof event?.id === 'string') {
        changes.push({ kind: event.kind, id: event.id, ids: Array.isArray(event.ids) ? event.ids : undefined });
      }
    });
    const hasChange = (kind: string, id: string) => changes.some((event) =>
      event.kind === kind && (event.id === id || (event.ids || []).includes(id)));

    const parsed = await api(token, 'POST', '/api/equipment/parse-calc', {
      text: VEZA_SAMPLE_XML, fileName: 'синтетическая проверка.XML', projectId,
    });
    check('синтетический расчёт разобран', parsed.status === 200 && Array.isArray(parsed.data?.units), `HTTP ${parsed.status}`);
    if (!parsed.data?.units?.length) return;
    const plan = await api(token, 'POST', '/api/equipment/import-draft-plan', {
      units: parsed.data.units, category: 'AHU', projectId, fileName: `Проверка ${stamp}`,
    });
    check('план оборудования построен', plan.status === 200 && !!plan.data?.plan, `HTTP ${plan.status}`);
    if (!plan.data?.plan) return;
    const written = await api(token, 'POST', '/api/equipment/import-draft', {
      units: parsed.data.units, category: 'AHU', projectId, fileName: `Проверка ${stamp}`,
      tagLinks: plan.data.plan.tagLinks,
    });
    check('синтетическое оборудование записано', written.status === 200, `HTTP ${written.status}`);
    if (written.status !== 200) return;

    const systemsBefore = await api(token, 'GET', `/api/projects/${projectId}/systems`);
    const components = (systemsBefore.data?.systems || []).flatMap((system: any) =>
      (system.monoblocks || []).flatMap((mono: any) => mono.components || []));
    const component = components.find((item: any) => !(item.tags || []).length) || components[0];
    check('для проверки найдена позиция оборудования', !!component, `позиций: ${components.length}`);
    if (!component) return;

    const code = `RT-${stamp}-TAG-01`;
    const linked = await api(token, 'POST', `/api/equipment/component/${component.id}/tag`, { identifier: code });
    check('тег создан и привязан из Оборудования', linked.status === 200 && linked.data?.created === true, `HTTP ${linked.status}`);
    if (linked.status !== 200) return;

    const rows = await api(token, 'GET', `/api/projects/${projectId}/tags`);
    const tags = rows.data?.tags || [];
    const tag = tags.find((row: any) => row.identifier === code);
    check('созданный тег виден в свежем ответе Реестра', !!tag, `тегов: ${tags.length}`);
    check('socket сообщает об изменении тега', !!tag && await waitFor(() => hasChange('tag', tag.id)));
    check('socket сообщает об изменении позиции', await waitFor(() => hasChange('element', component.id)));

    const systemsAfter = await api(token, 'GET', `/api/projects/${projectId}/systems`);
    const updatedComponent = (systemsAfter.data?.systems || []).flatMap((system: any) =>
      (system.monoblocks || []).flatMap((mono: any) => mono.components || []))
      .find((item: any) => item.id === component.id);
    check('свежий ответ Оборудования содержит привязанный тег',
      (updatedComponent?.tags || []).some((item: any) => item.id === tag?.id));

    const positionCode = `RT-${stamp}-POS-01`;
    const position = await api(token, 'POST', `/api/equipment/component/${component.id}/position`, {
      name: 'Проверочная позиция', role: 'ДАТЧИК', equipClass: 'ДАТЧИК', tag: positionCode,
    });
    check('позиция с новым тегом создана', position.status === 200 && !!position.data?.component?.id, `HTTP ${position.status}`);
    if (position.data?.component?.id) {
      const positionTag = (await api(token, 'GET', `/api/projects/${projectId}/tags`)).data?.tags
        ?.find((item: any) => item.identifier === positionCode);
      check('новый тег позиции сообщает об изменении', !!positionTag && await waitFor(() => hasChange('tag', positionTag.id)));
      check('новая позиция сообщает об изменении', await waitFor(() =>
        hasChange('element', position.data.component.id)));

      const beforeClass = changes.filter((event) => event.kind === 'element'
        && (event.id === position.data.component.id || (event.ids || []).includes(position.data.component.id))).length;
      const classUpdate = await api(token, 'PUT', `/api/equipment/component/${position.data.component.id}/class`, {
        equipClass: 'ДАТЧИК', equipKind: 'Проверочный вид',
      });
      check('изменение типа и вида принято', classUpdate.status === 200, `HTTP ${classUpdate.status}`);
      check('изменение типа и вида рассылается', await waitFor(() =>
        changes.filter((event) => event.kind === 'element'
          && (event.id === position.data.component.id || (event.ids || []).includes(position.data.component.id))).length > beforeClass));

      const beforeDeleteTag = changes.filter((event) => event.kind === 'tag'
        && (event.id === positionTag?.id || (event.ids || []).includes(positionTag?.id))).length;
      const removed = await api(token, 'DELETE', `/api/equipment/component/${position.data.component.id}`);
      check('проверочная позиция удалена', removed.status === 200, `HTTP ${removed.status}`);
      check('освобождённый тег сообщает об изменении', !!positionTag && await waitFor(() =>
        changes.filter((event) => event.kind === 'tag'
          && (event.id === positionTag.id || (event.ids || []).includes(positionTag.id))).length > beforeDeleteTag));
      const afterDelete = await api(token, 'GET', `/api/projects/${projectId}/tags`);
      check('свежее чтение показывает тег свободным',
        !(afterDelete.data?.tags?.find((item: any) => item.id === positionTag?.id)?.componentElements || []).length);
    }

    const seenBeforeUpdate = changes.filter((event) => event.kind === 'tag'
      && (event.id === tag.id || (event.ids || []).includes(tag.id))).length;
    const changedTag = await api(token, 'PUT', `/api/tags/${tag.id}`, { brand: `Марка ${stamp}` });
    check('правка существующего тега принята', changedTag.status === 200, `HTTP ${changedTag.status}`);
    check('socket сообщает о правке существующего тега', await waitFor(() =>
      changes.filter((event) => event.kind === 'tag'
        && (event.id === tag.id || (event.ids || []).includes(tag.id))).length > seenBeforeUpdate));
    const fresh = await api(token, 'GET', `/api/projects/${projectId}/tags`);
    check('повторное чтение содержит изменённые данные',
      fresh.data?.tags?.find((item: any) => item.id === tag.id)?.brand === `Марка ${stamp}`);

    const bulkCodes = [1, 2, 3].map((number) => `RT-${stamp}-BULK-0${number}`);
    const beforeBulk = changes.filter((event) => event.kind === 'tag').length;
    const bulk = await api(token, 'POST', `/api/projects/${projectId}/tags/bulk-import`, {
      mode: 'add', rows: bulkCodes.map((identifier) => ({ identifier, brand: 'Пакетная проверка' })),
    });
    check('пакетное добавление тегов принято', bulk.status === 200 && bulk.data?.created === bulkCodes.length, `HTTP ${bulk.status}`);
    check('пакетное изменение даёт одно socket-событие со всеми ID', await waitFor(() => {
      const updates = changes.filter((event) => event.kind === 'tag').slice(beforeBulk);
      return updates.length === 1 && Array.isArray(updates[0].ids) && updates[0].ids.length === bulkCodes.length;
    }));
    const afterBulk = await api(token, 'GET', `/api/projects/${projectId}/tags`);
    check('повторное чтение содержит пакетно созданные теги',
      bulkCodes.every((identifier) => afterBulk.data?.tags?.some((item: any) => item.identifier === identifier)));
  } finally {
    socket?.disconnect();
    if (projectId) await api(token, 'DELETE', `/api/projects/${projectId}`).catch(() => undefined);
  }
  console.log(failed ? `\nПровалено проверок: ${failed}` : '\nRealtime API проверка пройдена');
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error?.message || 'Realtime API проверка не выполнена');
  process.exitCode = 2;
});
