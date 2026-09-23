/**
 * Состав оборудования доезжает до базы — вживую, на поднятом сервере.
 *
 * Офлайновые проверки стерегут разбор и правила. Здесь проверяется ДОРОГА: то,
 * что подпозиции, теги из примечания и родство тегов доходят от файла до
 * реестра через настоящие маршруты, а не только внутри одного модуля.
 *
 * Дорога выбрана та самая, по которой человек приносит расчёт в обращении
 * ОБР-000006: мастер (`parse-calc` → `import-draft-plan` → `import-draft`).
 * Именно её санитайзер однажды и обрезал молча.
 *
 * Файл синтетический (scripts/fixtures/veza.ts): настоящие выгрузки заказчика
 * в репозиторий не попадают.
 *
 * Запуск (сервер поднят): npx tsx scripts/test-equip-composition-live.ts
 */

import { VEZA_SAMPLE_XML } from './fixtures/veza';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const LOGIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 400))));

let token = '';
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) as any };
};
const post = (path: string, body: unknown) => call('POST', path, body);
const get = (path: string) => call('GET', path);

(async () => {
  try {
    const h = await get('/api/health');
    if (h.status !== 200) throw new Error('health вернул ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}). Поднимите: npx tsx server.ts`);
    process.exit(2);
  }

  console.log('0. Вход');
  const logged = await post('/api/login', LOGIN);
  token = logged.data?.token || '';
  ok('вход выполнен', !!token, logged.data);
  if (!token) { console.log('\nПРОВАЛОВ: ' + f); process.exit(1); }

  console.log('\n1. Проект для проверки');
  const stamp = Date.now().toString(36);
  const made = await post('/api/projects', { name: `Проверка состава ${stamp}` });
  const projectId = made.data?.project?.id || made.data?.id;
  ok('проект заведён', !!projectId, made.data);
  if (!projectId) { console.log('\nПРОВАЛОВ: ' + (f + 1)); process.exit(1); }

  console.log('\n2. Разбор расчёта по дороге мастера');
  const parsed = await post('/api/equipment/parse-calc', { text: VEZA_SAMPLE_XML, fileName: 'проба.XML' });
  ok('файл разобран', parsed.status === 200 && Array.isArray(parsed.data?.units), parsed.data);
  const units = parsed.data?.units || [];
  const blocks = units.flatMap((u: any) => (u.monoblocks || []).flatMap((m: any) => m.blocks || []));
  ok('подпозиции доехали от разбора', blocks.some((b: any) => b.role === 'ДВИГАТЕЛЬ'), blocks.map((b: any) => b.name));
  ok('теги примечания доехали',
    blocks.some((b: any) => (b.tags || []).includes('PR-01-BL-001A')), blocks.filter((b: any) => b.tags).map((b: any) => [b.name, b.tags]));

  console.log('\n3. План импорта: состав и свидетельства');
  const planned = await post('/api/equipment/import-draft-plan', { units, category: 'AHU', projectId });
  ok('план построен', planned.status === 200 && !!planned.data?.plan, planned.data);
  const plan = planned.data?.plan;
  const pb = (plan?.blocks || []) as any[];
  ok('подпозиция пережила санитайзер мастера',
    pb.some((b) => b.role === 'ДВИГАТЕЛЬ'), pb.map((b) => [b.itemCode, b.role]));
  ok('владелец подпозиции назван',
    pb.some((b) => b.role === 'ДВИГАТЕЛЬ' && !!b.parentKey), pb.filter((b) => b.role === 'ДВИГАТЕЛЬ'));
  ok('номер экземпляра дошёл',
    pb.some((b) => b.role === 'ВЕНТИЛЯТОР' && b.instanceNo === 2), pb.filter((b) => b.role === 'ВЕНТИЛЯТОР'));
  // Три тега привода при двух приводах в расчёте: третий привод стоит на
  // объекте, а в расчёт не попал. Владелец распорядился: «если позиции нет —
  // всё создаётся автоматически», поэтому тег заводит свою позицию, помеченную
  // «по примечанию», — и фраза, из которой он взят, остаётся свидетельством
  const born = pb.filter((b) => b.sourceKind === 'note');
  ok('лишний тег привода завёл позицию по примечанию', born.length === 1 && born[0].role === 'ПРИВОД', pb.map((b) => [b.itemCode, b.role, b.sourceKind]));
  const why = born.flatMap((b) => b.tagNotes || []).find((e: any) => e.verdict === 'created');
  ok('и названа фраза, из которой он взят', /Таг-номер привода/.test(why?.phrase || ''), why);
  ok('расхождением он больше не висит', !pb.some((b) => (b.tagNotes || []).some((e: any) => e.verdict === 'no-slot')));

  const tagLinks = (plan?.tagLinks || []).map((l: any) => ({ ...l }));
  ok('теги бланка попали в план', tagLinks.length >= 5, tagLinks.map((l: any) => [l.identifier, l.action]));

  console.log('\n4. Запись в базу');
  const wrote = await post('/api/equipment/import-draft', {
    units, category: 'AHU', fileName: 'проба.XML', projectId, tagLinks,
  });
  ok('импорт прошёл', wrote.status === 200, wrote.data);
  ok('родство тегов построено', (wrote.data?.tagParents || 0) >= 3,
    { tagParents: wrote.data?.tagParents, tagsLinked: wrote.data?.tagsLinked, tagsCreated: wrote.data?.tagsCreated });

  console.log('\n5. Реестр: позиции стоят внутри своих владельцев');
  const got = await get(`/api/projects/${projectId}/systems`);
  const comps = (got.data?.systems || []).flatMap((s: any) =>
    (s.monoblocks || []).flatMap((m: any) => m.components || []));
  const byCode = (code: string) => comps.find((c: any) => c.itemCode === code);

  ok('вентиляторов два', comps.filter((c: any) => c.role === 'ВЕНТИЛЯТОР' && c.parentElementId).length === 2,
    comps.filter((c: any) => c.role === 'ВЕНТИЛЯТОР').map((c: any) => c.itemCode));
  ok('двигателей два, а не четыре', comps.filter((c: any) => c.role === 'ДВИГАТЕЛЬ').length === 2,
    comps.filter((c: any) => c.role === 'ДВИГАТЕЛЬ').map((c: any) => c.itemCode));
  const motor = byCode('1.3/вентилятор1/двигатель1');
  const fan1 = byCode('1.3/вентилятор1');
  ok('двигатель лежит внутри своего вентилятора',
    !!motor && !!fan1 && motor.parentElementId === fan1.id, [motor?.itemCode, motor?.parentElementId, fan1?.id]);
  ok('тег вентилятора привязан',
    (fan1?.tags || []).some((t: any) => t.identifier === 'PR-01-BL-001A'), fan1?.tags);
  ok('двигатель получил свои параметры',
    /Номинальная мощность/.test(String(motor?.specs || '')), String(motor?.specs || '').slice(0, 200));

  console.log('\n6. Родство тегов: вентилятор под установкой, установка — корень');
  const tags = await get(`/api/projects/${projectId}/tags`);
  const raw = tags.data;
  const list = (Array.isArray(raw) ? raw : (raw?.tags || raw?.items || [])) as any[];
  ok('список тегов проекта получен', Array.isArray(list) && list.length > 0, typeof raw);
  const byName = (id: string) => list.find((t: any) => t.identifier === id);
  const meta = (t: any) => { try { return t?.metadata ? JSON.parse(t.metadata) : {}; } catch (_) { return {}; } };
  const unit = byName('PR-01-AS-001');
  const fanTag = byName('PR-01-BL-001A');
  ok('тег установки есть в проекте', !!unit, list.map((t: any) => t.identifier));
  ok('родитель вентилятора — тег установки', meta(fanTag).parentId === unit?.id, [meta(fanTag), unit?.id]);
  ok('связь помечена как построенная импортом', meta(fanTag).parentBy === 'import', meta(fanTag));
  ok('установка числит вентилятор своим ребёнком',
    (meta(unit).connections || []).includes(fanTag?.id), meta(unit));

  console.log('\n7. Повторный импорт того же файла ничего не ломает');
  const again = await post('/api/equipment/import-draft', {
    units, category: 'AHU', fileName: 'проба.XML', projectId, tagLinks,
  });
  ok('повтор прошёл', again.status === 200, again.data);
  const got2 = await get(`/api/projects/${projectId}/systems`);
  const comps2 = (got2.data?.systems || []).flatMap((s: any) =>
    (s.monoblocks || []).flatMap((m: any) => m.components || []));
  ok('позиций не удвоилось', comps2.length === comps.length, [comps.length, comps2.length]);

  console.log('\n8. Ручная позиция внутри двигателя');
  const added = await post(`/api/equipment/component/${motor?.id}/position`, {
    name: 'Датчик ПТС ВЕДО-201', role: 'ДАТЧИК', tag: `PR-01-TE-001${stamp.slice(-1).toUpperCase()}`,
    params: [{ key: 'Диапазон', value: '0…150', unit: '°C' }],
  });
  ok('позиция заведена', added.status === 200, added.data);
  ok('родителем тега стал тег двигателя или установки', !!added.data?.parentTag, added.data);

  const got3 = await get(`/api/projects/${projectId}/systems`);
  const comps3 = (got3.data?.systems || []).flatMap((s: any) =>
    (s.monoblocks || []).flatMap((m: any) => m.components || []));
  const sensor = comps3.find((c: any) => c.role === 'ДАТЧИК' && c.manual);
  ok('ручная позиция помечена рукой', !!sensor, comps3.filter((c: any) => c.role === 'ДАТЧИК'));
  ok('и стоит внутри двигателя', sensor?.parentElementId === motor?.id, [sensor?.parentElementId, motor?.id]);

  console.log('\n9. Повторный импорт ручную позицию не трогает');
  await post('/api/equipment/import-draft', { units, category: 'AHU', fileName: 'проба.XML', projectId, tagLinks });
  const got4 = await get(`/api/projects/${projectId}/systems`);
  const comps4 = (got4.data?.systems || []).flatMap((s: any) =>
    (s.monoblocks || []).flatMap((m: any) => m.components || []));
  ok('ручная позиция на месте', comps4.some((c: any) => c.id === sensor?.id), comps4.length);

  console.log('\n10. Шаблон вида и срез по роли в таблице');
  const view = await post('/api/equipment/view-templates', {
    name: `Автоматика ${stamp}`, role: 'ДВИГАТЕЛЬ',
    fields: [{ group: 'Электродвигатель', key: 'Номинальная мощность', unit: 'кВт' }],
  });
  ok('шаблон вида сохранён', view.status === 200, view.data);
  const views = await get('/api/equipment/view-templates');
  ok('шаблон виден в списке', (views.data?.views || []).some((v: any) => v.id === view.data?.view?.id), views.data);

  const query = await post('/api/constructor/query', {
    projectId, entity: 'element',
    columns: ['tag', 'role', 'parentTag', 'unitTag', 'param:Электродвигатель|Номинальная мощность'],
    filters: [{ field: 'role', op: 'eq', value: 'ДВИГАТЕЛЬ' }],
  });
  ok('срез по роли собрался', query.status === 200, query.data?.error);
  const rows = (query.data?.rows || []) as any[];
  ok('в срезе только двигатели', rows.length === 2, rows.map((r) => r.cells));
  ok('тег родителя стоит в строке',
    rows.every((r) => /^PR-01-BL-00[12]A$/.test(String(r.cells?.[2] || ''))), rows.map((r) => r.cells));
  ok('тег установки стоит в строке',
    rows.every((r) => String(r.cells?.[3] || '') === 'PR-01-AS-001'), rows.map((r) => r.cells));
  ok('характеристика двигателя собралась',
    rows.every((r) => String(r.cells?.[4] || '') === '15'), rows.map((r) => r.cells));

  console.log('\n11. Фоновый ввоз: очередь переживает закрытое окно');
  {
    /**
     * Папка расчётов — тот самый случай, ради которого очередь и заведена:
     * двадцать три выгрузки, окно закрыли на седьмой. Здесь их две, но путь
     * тот же самый: файл в хранилище → задание → разбор и запись на сервере.
     */
    const b64 = Buffer.from(VEZA_SAMPLE_XML, 'utf-8').toString('base64');
    const made: string[] = [];
    for (const name of ['партия-1.XML', 'партия-2.XML']) {
      const f = await post('/api/files', { name, content: b64, type: 'FILE', size: b64.length });
      const id = f.data?.file?.id || '';
      if (id) made.push(id);
    }
    ok('файлы положены в хранилище', made.length === 2, made);

    const idemKey = `проверка-${stamp}`;
    const queued = await post('/api/import-jobs', {
      projectId, category: 'AHU', title: 'Партия проверки', idemKey,
      files: made.map((id) => ({ fileId: id })),
    });
    ok('партия поставлена в очередь', queued.status === 200 && queued.data?.queued === 2, queued.data);

    // Повтор той же постановки не заводит второй ввоз — это держит база
    const twice = await post('/api/import-jobs', {
      projectId, category: 'AHU', title: 'Партия проверки', idemKey,
      files: made.map((id) => ({ fileId: id })),
    });
    ok('повтор постановки не завёл второй ввоз', twice.data?.queued === 0 && twice.data?.already === 2, twice.data);

    // Ждём проход очереди: она сама читает файлы, строит план и пишет
    let batch: any = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const list = await get(`/api/import-jobs?projectId=${projectId}`);
      batch = (list.data?.batches || []).find((x: any) => x.id === queued.data?.batchId);
      if (batch && batch.state !== 'RUNNING') break;
    }
    ok('партия дошла до конца', batch?.state === 'DONE', batch);
    ok('оба задания записаны', batch?.done === 2 && batch?.failed === 0, batch);
    ok('в задании виден итог', !!batch?.jobs?.[0]?.summary, batch?.jobs?.[0]);

    // Повторный ввоз того же файла позиций не удваивает — это уже проверено
    // выше, здесь важно, что фоновый путь ведёт себя так же
    const after = await get(`/api/projects/${projectId}/systems`);
    const count = (after.data?.systems || []).flatMap((s: any) =>
      (s.monoblocks || []).flatMap((m: any) => m.components || [])).length;
    ok('позиций не удвоилось после фонового ввоза', count === comps4.length, [comps4.length, count]);
  }

  console.log('\n12. Уборка');
  const gone = await call('DELETE', `/api/projects/${projectId}`);
  ok('проверочный проект удалён', gone.ok, gone.status);

  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
