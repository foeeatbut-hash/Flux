import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { docflowRedirect } from '../src/lib/docflowNavigation';
import { resolveSectionHref } from '../src/lib/sectionAliases';

assert.equal(docflowRedirect(new URLSearchParams()), null);
assert.equal(docflowRedirect(new URLSearchParams('tab=procurement&other=1')), null);
assert.equal(docflowRedirect(new URLSearchParams('tab=vdr')), '/docflow?tab=registry');
assert.equal(docflowRedirect(new URLSearchParams('tab=docflow')), '/docflow?tab=settings');
const result = docflowRedirect(new URLSearchParams('vdr=%D0%B0%2Fb%26c&item=x%3Dy%2Bz&other=one%20two'));
assert.ok(result);
const url = new URL(result, 'https://example.test');
assert.equal(url.pathname, '/docflow');
assert.equal(url.searchParams.get('tab'), 'registry');
assert.equal(url.searchParams.get('vdr'), 'а/b&c');
assert.equal(url.searchParams.get('item'), 'x=y+z');
assert.equal(url.searchParams.get('other'), 'one two');
assert.equal(docflowRedirect(new URLSearchParams('tab=docflow&vdr=1')), '/docflow?tab=settings&vdr=1');
// Окно открывается уже по новому адресу: иначе «Менеджмент» оставался бы
// пустым окном, которое при каждом выходе вперёд снова уводит в ДО
assert.equal(resolveSectionHref('/management?vdr=r1&item=i1'), '/docflow?vdr=r1&item=i1&tab=registry');
assert.equal(resolveSectionHref('/management?tab=docflow'), '/docflow?tab=settings');
assert.equal(resolveSectionHref('/management'), '/management');
assert.equal(resolveSectionHref('/management?tab=procurement'), '/management?tab=procurement');

// Новые ссылки на строку ВДР ведут прямо в ДО, а не через перенаправление
for (const file of ['server/routes/vdr.ts', 'server/insight.ts', 'server/insightRules.ts', 'src/components/registry/TagVdrDocs.tsx', 'src/lib/notifCenter.ts', 'server/actionWords.ts', 'src/screens/Dashboard.tsx']) {
  const text = readFileSync(file, 'utf8');
  assert.ok(!/['`"]\/management\?vdr=/.test(text), `${file}: ссылка на строку ВДР через Менеджмент`);
  assert.ok(!/vdr: \{[^}]*'\/management'/.test(text) && !/ДОКУМЕНТЫ'\) return '\/management'/.test(text) && !/Открыть ВДР', go: \(\) => open\('\/management'\)/.test(text), `${file}: ВДР открывается через Менеджмент`);
}
console.log('Переходы в документооборот: все проверки прошли');
