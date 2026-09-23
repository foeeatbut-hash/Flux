/**
 * Несколько расчётов одним ввозом — вживую, на поднятом сервере.
 *
 * Владелец: «когда закидываем несколько xml файлов, нужно чтобы можно было
 * выделить нужные или загрузить сразу, а не каждый отдельно». Мастер собирает
 * установки выбранных файлов в один предпросмотр и одну партию. Проверяем
 * дорогу: обе установки встают, у каждой в реестре СВОЙ файл (а не общий
 * «Расчёты: 2 файла»), партия одна — и отменяется одним действием.
 *
 * Запуск (сервер поднят): npx tsx scripts/test-import-many-live.ts
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
  token = (await call('POST', '/api/login', { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' })).data?.token || '';
  if (!token) { console.error('Не удалось войти'); process.exit(2); }
  const made = await call('POST', '/api/projects', { name: `Проверка ввоза пачкой ${Date.now().toString(36)}`, code: 'PR' });
  const projectId = made.data?.project?.id || made.data?.id;

  console.log('1. Два файла — как их разбирает мастер');
  const second = VEZA_SAMPLE_XML.replace(/PR-01-AS-001/g, 'PR-02-AS-001');
  const files = [['первый.XML', VEZA_SAMPLE_XML], ['второй.XML', second]] as const;
  const units: any[] = [];
  for (const [name, text] of files) {
    const p = await call('POST', '/api/equipment/parse-calc', { text, fileName: name, projectId });
    ok(`«${name}» разобран`, p.status === 200 && p.data?.units?.length > 0, p.data);
    // Так мастер склеивает выбранные файлы: у каждой установки её файл
    units.push(...(p.data?.units || []).map((u: any) => ({ ...u, fileName: name })));
  }

  console.log('\n2. Один план и одна запись на оба');
  const plan = await call('POST', '/api/equipment/import-draft-plan', { units, category: 'AHU', projectId });
  ok('план построен', plan.status === 200 && !!plan.data?.plan, plan.data);
  const wrote = await call('POST', '/api/equipment/import-draft', {
    units, category: 'AHU', fileName: 'Расчёты: 2 файлов', projectId, tagLinks: plan.data?.plan?.tagLinks,
  });
  ok('ввоз прошёл', wrote.status === 200 && !!wrote.data?.batchId, wrote.data);
  const systems = (await call('GET', `/api/projects/${projectId}/systems`)).data?.systems || [];
  const byName = (n: string) => systems.find((s: any) => s.name === n);
  ok('обе установки встали', !!byName('PR-01-AS-001') && !!byName('PR-02-AS-001'), systems.map((s: any) => s.name));
  ok('у первой — её файл', byName('PR-01-AS-001')?.fileName === 'первый.XML', byName('PR-01-AS-001')?.fileName);
  ok('у второй — её файл', byName('PR-02-AS-001')?.fileName === 'второй.XML', byName('PR-02-AS-001')?.fileName);

  console.log('\n3. Отмена одной партией');
  const undoPlan = await call('GET', `/api/equipment/import-undo/${encodeURIComponent(wrote.data.batchId)}`);
  ok('план отмены охватывает оба файла', (undoPlan.data?.remove?.length || 0) > 0, undoPlan.data);
  const undo = await call('POST', '/api/equipment/import-undo', { batchId: wrote.data.batchId });
  ok('отменено', undo.status === 200, undo.data);

  await call('DELETE', `/api/projects/${projectId}`);
  console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
  process.exit(f ? 1 : 0);
})();
