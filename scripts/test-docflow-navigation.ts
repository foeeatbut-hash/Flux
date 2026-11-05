import assert from 'node:assert/strict';
import { docflowRedirect } from '../src/lib/docflowNavigation';

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
console.log('Переходы в документооборот: все проверки прошли');
