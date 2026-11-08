/**
 * Что Проводник знает о файле как о документе (docs/docflow-program.md, 3.2):
 * значок «не по маске», связь со строкой, файл замечаний, фильтры.
 */
import assert from 'node:assert/strict';
import { normalizeDocflowConfig } from '../shared/docflow/config';
import { linkLookupKey, type DocLinkDto, type LinkedItemBrief } from '../shared/docflow/links';
import { docInfoOf, matchesDocFilter, type DocContext } from '../src/components/files/docEntryInfo';

let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  passed++;
};
const K = 'a'.repeat(64); const R = 'b'.repeat(64);
const config = normalizeDocflowConfig({ vdrTypes: [{ code: 'E02', titleRu: 'Общий вид' }] });
const link = (id: string, relativePath: string, over: Partial<DocLinkDto> = {}): DocLinkDto => ({
  id, itemId: 'i1', projectId: 'p', revision: 'B', role: 'file', toLinkId: null, folderKey: K, relativePath, fileName: relativePath.split('/').pop()!,
  sha256: '', size: 1, reviewCode: '', receivedAt: null, lostAt: null, linkedById: null, createdAt: '', unlinkedAt: null, unlinkReason: '', locked: false, lockedAt: null, lockedByName: '', unlockedAt: null, unlockedByName: '', lockViolation: '', ...over,
});
const brief: LinkedItemBrief = { id: 'i1', cipher: '3700-B01-E02-001', title: 'Общий вид', vdrCode: 'E02', revision: 'C', status: 'DRAFT', registerId: 'r', dueDate: null, assignee: '', tags: [] };
const f = link('l1', 'E02/3700-B01-E02-001_B.pdf');
const remarks = link('l2', 'E02/Замечания.pdf', { folderKey: R, role: 'remarks', toLinkId: 'l1' });
const links = [f, remarks];
const ctx: DocContext = { config, links, items: { i1: brief }, byPath: new Map(links.map((l) => [linkLookupKey(l.folderKey, l.relativePath), l])) };
const work = { projectId: 'p', folderKey: K, purpose: 'work' as const };

const ok = docInfoOf({ name: '3700-B01-E02-001_B.pdf', kind: 'file' }, { ...work, relativePath: 'E02/3700-B01-E02-001_B.pdf' }, ctx)!;
check('файл по маске со связью: шифр, тип, ревизия и строка', ok.offMask.length === 0 && ok.parsed?.fields['тип'] === 'E02' && ok.parsed?.fields['ред'] === 'B' && ok.item?.cipher === '3700-B01-E02-001', ok);
check('последняя ревизия документа видна отдельно от ревизии файла', ok.item?.revision === 'C' && ok.link?.revision === 'B');
const bad = docInfoOf({ name: 'черновик.docx', kind: 'file' }, { ...work, relativePath: 'E02/черновик.docx' }, ctx)!;
check('имя не по маске: причина для подсказки', bad.offMask.length > 0 && !bad.link, bad.offMask);
const noRev = docInfoOf({ name: '3700-B01-E02-001.pdf', kind: 'file' }, { ...work, relativePath: 'E02/3700-B01-E02-001.pdf' }, ctx)!;
check('нет ревизии — подсказка называет поле', noRev.offMask.some((p) => /ревиз/i.test(p)), noRev.offMask);
const badType = docInfoOf({ name: '3700-B01-E2-001_B.pdf', kind: 'file' }, { ...work, relativePath: 'E2/3700-B01-E2-001_B.pdf' }, ctx)!;
check('неизвестный тип — в подсказке', badType.offMask.some((p) => /неизвестный тип «E2»/.test(p)), badType.offMask);
const badRev = docInfoOf({ name: '3700-B01-E02-001_%.pdf', kind: 'file' }, { ...work, relativePath: 'x/3700-B01-E02-001_%.pdf' }, ctx)!;
check('ревизия не по схеме — в подсказке', badRev.offMask.some((p) => /не по схеме/.test(p)), badRev.offMask);
const junk = docInfoOf({ name: '~$3700.docx', kind: 'file' }, { ...work, relativePath: '~$3700.docx' }, ctx)!;
check('служебный файл не ошибка и не документ', junk.ignored && junk.offMask.length === 0 && !matchesDocFilter(junk, 'unlinked') && !matchesDocFilter(junk, 'offMask'));
check('папка и файл вне проекта — нет сведений', docInfoOf({ name: 'E02', kind: 'directory' }, { ...work, relativePath: 'E02' }, ctx) === null && docInfoOf({ name: 'x.pdf', kind: 'file' }, { ...work, relativePath: '' }, ctx) === null);
const ret = docInfoOf({ name: 'Замечания.pdf', kind: 'file' }, { projectId: 'p', folderKey: R, purpose: 'returns', relativePath: 'E02/Замечания.pdf' }, ctx)!;
check('файл в папке возвратов — замечания к файлу ревизии, маска не проверяется', ret.role === 'remarks' && ret.remarksTo?.id === 'l1' && ret.offMask.length === 0 && ret.parsed === null, ret);
check('во входящих и выпуске: входящие не документы, выпуск — документы', docInfoOf({ name: 'a.pdf', kind: 'file' }, { projectId: 'p', folderKey: K, purpose: 'incoming', relativePath: 'a.pdf' }, ctx) === null
  && docInfoOf({ name: 'a.pdf', kind: 'file' }, { projectId: 'p', folderKey: K, purpose: 'issue', relativePath: 'a.pdf' }, ctx) !== null);
check('настройки ещё не пришли — сведения без разбора', docInfoOf({ name: 'a.pdf', kind: 'file' }, { ...work, relativePath: 'a.pdf' }, undefined)?.parsed === null);
check('фильтры: в реестре, нет в реестре, не по маске', matchesDocFilter(ok, 'linked') && !matchesDocFilter(ok, 'unlinked') && matchesDocFilter(bad, 'unlinked') && matchesDocFilter(bad, 'offMask') && !matchesDocFilter(ok, 'offMask'));
check('файл вне проекта проходит только «все»', matchesDocFilter(null, 'all') && !matchesDocFilter(null, 'linked'));
console.log(`docflow-entry-info: ${passed} проверок прошли`);
