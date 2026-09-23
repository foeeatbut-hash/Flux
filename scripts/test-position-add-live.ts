/**
 * Своя позиция и привязка тега — вживую, на поднятом сервере.
 *
 * Владелец просил: «сделай возможность самому добавить позицию и привязать
 * тег». Проверяем дорогу целиком: тег проверяется до записи тем же правилом,
 * по которому запишется; похожая кириллическая буква исправляется; позиция
 * встаёт внутрь двигателя, а её тег — под тег владельца; занятый тег получает
 * отказ с именем того, кто его держит; позиция заводится и в моноблок, без
 * владельца. Проект синтетический и удаляется в конце.
 *
 * Запуск (сервер поднят): npx tsx scripts/test-position-add-live.ts
 */
import { VEZA_SAMPLE_XML } from './fixtures/veza';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d).slice(0, 400))));
let token = '';
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) as any };
};

(async () => {
  const login = await call('POST', '/api/login', { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' });
  token = login.data?.token || '';
  if (!token) { console.error('Не удалось войти'); process.exit(2); }

  console.log('1. Проект с установкой');
  const made = await call('POST', '/api/projects', { name: `Проверка своей позиции ${Date.now().toString(36)}`, code: 'PR' });
  const projectId = made.data?.project?.id || made.data?.id;
  const parsed = await call('POST', '/api/equipment/parse-calc', { text: VEZA_SAMPLE_XML, fileName: 'проба.XML', projectId });
  const units = parsed.data?.units || [];
  const plan = await call('POST', '/api/equipment/import-draft-plan', { units, category: 'AHU', projectId });
  const wrote = await call('POST', '/api/equipment/import-draft', { units, category: 'AHU', fileName: 'проба.XML', projectId, tagLinks: plan.data?.plan?.tagLinks });
  ok('установка ввезена', wrote.status === 200, wrote.data);
  const systems = (await call('GET', `/api/projects/${projectId}/systems`)).data?.systems || [];
  const comps = systems.flatMap((s: any) => s.monoblocks.flatMap((m: any) => m.components.map((c: any) => ({ ...c, _mb: m }))));
  const motor = comps.find((c: any) => c.role === 'ДВИГАТЕЛЬ');
  const fan = comps.find((c: any) => c.id === motor?.parentElementId);
  ok('двигатель и его вентилятор найдены', !!motor && !!fan);

  console.log('\n2. Проверка тега до записи');
  // «Т» и «Е» кириллические — опечатка раскладки
  const twin = 'PR-01-ТЕ-001';
  const chk = await call('POST', `/api/projects/${projectId}/tag-check`, { identifier: twin });
  ok('похожие буквы исправлены', chk.data?.ok === true && chk.data?.identifier === 'PR-01-TE-001', chk.data);
  ok('и сказано, что исправлено', !!chk.data?.corrected?.what, chk.data);
  ok('проверка ничего не записала', !(await call('GET', `/api/projects/${projectId}/tags`)).data
    ?.some?.((t: any) => t.identifier === 'PR-01-TE-001'));
  const bad = await call('POST', `/api/projects/${projectId}/tag-check`, { identifier: 'PR 01 TE' });
  ok('тег с пробелом не проходит', bad.data?.ok === false && !!bad.data?.problem, bad.data);

  console.log('\n3. Датчик ПТС внутрь двигателя со своим тегом');
  const pos = await call('POST', `/api/equipment/component/${motor.id}/position`, {
    name: 'Датчик ПТС', role: 'ДАТЧИК', tag: twin, equipClass: 'ДАТЧИК', equipKind: 'ПТС', params: [{ key: 'Тип', value: 'позистор', unit: '' }],
  });
  ok('позиция заведена', pos.status === 200 && pos.data?.ok, pos.data);
  ok('тег записан исправленным', pos.data?.tag?.identifier === 'PR-01-TE-001', pos.data?.tag);
  const fanTag = fan?.tags?.[0]?.identifier || '';
  ok('родитель тега — тег владельца по составу', !!pos.data?.parentTag && pos.data.parentTag !== 'PR-01-TE-001', [pos.data?.parentTag, fanTag]);
  const after = (await call('GET', `/api/projects/${projectId}/systems`)).data?.systems
    .flatMap((s: any) => s.monoblocks.flatMap((m: any) => m.components));
  const ptc = after.find((c: any) => c.id === pos.data?.component?.id);
  ok('стоит внутри двигателя', ptc?.parentElementId === motor.id);
  ok('тип и вид записаны', ptc?.equipClass === 'ДАТЧИК' && ptc?.equipKind === 'ПТС', [ptc?.equipClass, ptc?.equipKind]);
  ok('помечена ручной', ptc?.manual === true);

  console.log('\n4. Один тег — одно изделие');
  const again = await call('POST', `/api/equipment/component/${fan.id}/tag`, { identifier: 'PR-01-TE-001' });
  ok('занятый тег — отказ', again.status === 409, again.status);
  ok('и названо, кто его держит', /Датчик ПТС/.test(again.data?.error || ''), again.data);

  console.log('\n5. «Создать и привязать»');
  const linked = await call('POST', `/api/equipment/component/${motor.id}/tag`, { identifier: 'PR-01-M-001' });
  ok('новый тег заведён и привязан', linked.status === 200 && linked.data?.created === true, linked.data);
  ok('родитель тега двигателя — тег вентилятора', linked.data?.parentTag === fanTag, [linked.data?.parentTag, fanTag]);

  console.log('\n6. Позиция в моноблок, без владельца');
  const top = await call('POST', `/api/equipment/monoblock/${motor._mb.id}/position`, { name: 'Шкаф управления', role: 'ПРОЧЕЕ', tag: 'PR-01-CP-001' });
  ok('заведена', top.status === 200 && top.data?.ok, top.data);
  const cp = (await call('GET', `/api/projects/${projectId}/systems`)).data?.systems
    .flatMap((s: any) => s.monoblocks.flatMap((m: any) => m.components)).find((c: any) => c.id === top.data?.component?.id);
  ok('без владельца', !!cp && !cp.parentElementId, cp?.parentElementId);

  console.log('\n7. Уборка');
  const del = await call('DELETE', `/api/projects/${projectId}`);
  ok('проверочный проект удалён', del.status === 200, del.status);

  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
