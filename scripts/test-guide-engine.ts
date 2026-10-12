/** Focused contract tests for the Guide answer engine; no API server required. */
import { answerQuestion } from '../src/guide/engine';

const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fail = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const context = { userId: 'test-user', projectId: 'project-1', projectName: 'Test project' };
let failed = 0;
function check(condition: unknown, message: string) {
  if (condition) console.log(`ok   ${message}`);
  else { failed++; console.error(`FAIL ${message}`); }
}

const originalFetch = globalThis.fetch;
let rangeRequest = '';
let rangeCalls = 0;
async function main() {
try {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/spec?')) {
      rangeCalls++;
      rangeRequest = url;
      const params = new URL(url, 'http://local').searchParams;
      return ok({ total: 1, items: [{ componentId: 'c-range', name: 'Вентилятор В-2', itemCode: 'V-2', equipType: 'ВЕНТИЛЯТОР', system: 'П1', tags: ['FAN-002'], field: 'Расход воздуха', value: '700', unit: 'м³/ч', group: 'Аэродинамика', specsTotal: 1 }], observed: { min: params.get('min'), max: params.get('max') } });
    }
    if (url.includes('/tag/')) return ok({ status: 'no-match', identifier: '3700-B08-DW-002B', tags: [] });
    if (url.includes('/components?')) {
      const params = new URL(url, 'http://local').searchParams;
      if (params.get('limit') === '0') return ok({ total: 3, items: [] });
      return ok({ total: 1, items: [{ id: 'c1', name: 'Вентилятор В-1', itemCode: '', equipType: 'ВЕНТИЛЯТОР', role: '', systemName: 'П1', systemCategory: 'AHU', monoblockName: 'МБ-1', status: '', hasConflict: false, tags: [{ id: 't1', identifier: 'FAN-001' }], specs: [], specsTotal: 0 }] });
    }
    if (url.includes('/tags?')) return ok({ total: 0, items: [] });
    if (url.includes('/files?')) return ok({ total: 1, items: [{ id: 'f1', name: 'fan.pdf', folder: 'РД', size: 1, revision: 'A', statusCode: 'actual', updatedAt: '2026-01-01', mainTags: ['FAN-001'], additionalTags: [] }] });
    if (url.includes('/summary')) return ok({ project: { name: 'Test project', code: 'T1', status: 'active', customer: '' }, counts: { tags: 2, systems: 1, monoblocks: 1, components: 3, componentsNoTag: 1, duplicates: 0, conflicts: 0 }, categories: [], stages: [] });
    return fail(404, { error: 'not found' });
  }) as typeof fetch;

  const missingProject = (await answerQuestion('сколько тегов', { userId: 'test-user', projectId: null }))[0];
  check(missingProject.status === 'need-project', 'project queries require an explicit project');

  const unknown = (await answerQuestion('который час', context))[0];
  check(unknown.status === 'no-match' && /нет точного ответа/.test(unknown.text), 'unknown intent stays a clear no-match');

  const exactMiss = (await answerQuestion('найди тег 3700-B08-DW-002B', context))[0];
  check(exactMiss.status === 'no-match' && !exactMiss.table, 'an exact tag miss does not substitute a similar code');

  const listed = (await answerQuestion('покажи все вентиляторы', context))[0];
  check(listed.table?.rows[0]?.[0] === 'Вентилятор В-1', 'equipment list returns server rows');
  check(listed.source?.label.includes('Оборудование проекта') && listed.context?.projectId === 'project-1', 'data answer carries source and project-bound continuation context');

  const rangeAnswer = (await answerQuestion('покажи расход воздуха от 500 до 1000 м³/ч', context))[0];
  const rangeParams = new URL(rangeRequest, 'http://local').searchParams;
  check(rangeAnswer.table?.total === 1 && rangeParams.get('min') === '500' && rangeParams.get('max') === '1000' && !rangeParams.has('op'), `Guide sends both inclusive range bounds to the server (${rangeRequest})`);
  const rangeCallsBeforeReverse = rangeCalls;
  const reversedRange = (await answerQuestion('покажи расход воздуха от 1000 до 500 м³/ч', context))[0];
  check(/нижняя граница/.test(reversedRange.text) && rangeCalls === rangeCallsBeforeReverse, 'reversed range asks for clarification without querying data');
  const incompatibleUnit = (await answerQuestion('покажи расход воздуха от 1 до 2 кПа', context))[0];
  check(/не подходит к характеристике/.test(incompatibleUnit.text) && rangeCalls === rangeCallsBeforeReverse, 'incompatible range unit asks for clarification without querying data');

  const count = (await answerQuestion('сколько вентиляторов', context))[0];
  check(count.outcome === 'ВЕНТИЛЯТОР: 3' && count.actions?.some((a) => a.route === '/equipment'), 'equipment count has count and valid section action');

  const noTag = (await answerQuestion('покажи оборудование без тега', context))[0];
  check(noTag.table?.title.includes('без тега') && noTag.actions?.some((a) => a.route === '/equipment'), 'untagged list returns rows and a valid equipment action');
  const files = (await answerQuestion('найди документы по вентилятору', context))[0];
  check(files.table?.rows[0]?.[0] === 'fan.pdf' && files.source?.projectId === 'project-1', 'document intent returns project-scoped file rows');
  const summary = (await answerQuestion('покажи сводку проекта', context))[0];
  check(summary.cards?.[0]?.title === 'Test project' && summary.source?.projectId === 'project-1', 'summary intent returns a named project card and source');
  const howto = (await answerQuestion('как загрузить xml оборудования', context))[0];
  check(howto.actions?.some((a) => a.kind === 'tour') && howto.source?.label.includes('Демонстрации'), 'known how-to request offers its checked demonstration');
  const tour = (await answerQuestion('покажи как создать тег', context))[0];
  check(tour.actions?.some((a) => a.kind === 'tour' && !!a.tourId), 'demonstration intent returns a real tour action');

  const firstResult = (await answerQuestion('покажи все вентиляторы', context))[0];
  const followed = (await answerQuestion('покажи их', { ...context, lastResult: firstResult.context }))[0];
  check(followed.table?.rows.length === 1 && followed.context?.projectId === 'project-1', 'follow-up reuses only the last result in the same project');

  globalThis.fetch = (async () => fail(403, { error: 'Forbidden', code: 'FORBIDDEN' })) as typeof fetch;
  const denied = (await answerQuestion('сколько тегов', context))[0];
  check(denied.status === 'permission' && !denied.table, 'permission errors do not leak project rows or counts');
} finally {
  globalThis.fetch = originalFetch;
}

console.log(failed ? `\n${failed} guide engine check(s) failed` : '\nGuide engine checks passed');
process.exitCode = failed ? 1 : 0;
}

void main();
