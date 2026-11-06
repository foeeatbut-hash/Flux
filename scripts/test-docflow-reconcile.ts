/**
 * «Сверка с папкой» (docs/docflow-program.md, 4.3): четыре группы расхождений
 * и то, что в них не попадает. Чистая функция — без сервера и Проводника.
 */
import assert from 'node:assert/strict';
import { normalizeDocflowConfig } from '../shared/docflow/config';
import { reconcile, reconSummary, type ReconFile, type ReconRow } from '../shared/docflow/reconcile';
import type { DocLinkDto } from '../shared/docflow/links';

let passed = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  passed++;
};

const config = normalizeDocflowConfig({ vdrTypes: [{ code: 'E02', titleRu: 'Общий вид' }, { code: 'C32', titleRu: 'Опросный лист' }] });
const K = 'a'.repeat(64);
const row = (id: string, no: string, code: string, revision: string, status = 'DRAFT'): ReconRow => ({ id, registerId: 'r', title: id, status, row: { contractorNo: no, vdrCode: code, revision } });
const file = (relativePath: string): ReconFile => ({ folderKey: K, relativePath, name: relativePath.split('/').pop()! });
const link = (itemId: string, relativePath: string, revision: string, over: Partial<DocLinkDto> = {}): DocLinkDto => ({
  id: `l-${itemId}-${revision}`, itemId, projectId: 'p', revision, role: 'file', toLinkId: null, folderKey: K, relativePath, fileName: relativePath.split('/').pop()!,
  sha256: '', size: 1, reviewCode: '', receivedAt: null, lostAt: null, linkedById: null, createdAt: '', unlinkedAt: null, unlinkReason: '', ...over,
});

const rows = [
  row('ok', '3700-B01-E02-001', 'E02', 'B'),
  row('nofile', '3700-B01-E02-002', 'E02', 'A'),
  row('hasOther', '3700-B01-E02-003', 'E02', 'B'),
  row('renamed', '3700-B01-C32-001', 'C32', 'A'),
  row('gone', '3700-B01-C32-002', 'C32', 'A'),
  row('void', '3700-B01-E02-009', 'E02', 'A', 'VOID'),
];
const files = [
  file('E02/3700-B01-E02-001_B.pdf'),          // привязан, всё хорошо
  file('E02/3700-B01-E02-002_A.pdf'),          // имя подходит строке nofile, но не привязан
  file('E02/3700-B01-E02-004_A.pdf'),          // читается, строки нет
  file('E02/черновик.docx'),                   // не по маске
  file('E02/3700-B01-E02-005_%.pdf'),          // ревизия не по схеме
  file('E02/~$3700-B01-E02-001_B.pdf'),        // служебный
  file('E02/notes.bak'),                       // служебный
  file('C32/Опросный.pdf'),                    // привязан, но имя разошлось со строкой
];
const links = [
  link('ok', 'E02/3700-B01-E02-001_B.pdf', 'B'),
  link('renamed', 'C32/Опросный.pdf', 'A'),
  link('gone', 'C32/3700-B01-C32-002_A.pdf', 'A'),                 // файла в папке нет
  link('hasOther', 'E02/3700-B01-E02-003_A.pdf', 'A', { }),         // файл прошлой ревизии: для текущей B файла нет
];
files.push(file('E02/3700-B01-E02-003_A.pdf'));

const r = reconcile(config, rows, files, links);

check('есть в реестре, файла нет: строка без файла текущей ревизии', r.noFile.some((x) => x.rowId === 'nofile') && r.noFile.some((x) => x.rowId === 'hasOther'), r.noFile);
check('привязанная строка и аннулированная в «нет файла» не попадают', !r.noFile.some((x) => x.rowId === 'ok' || x.rowId === 'void'));
check('для строки без файла предложен подходящий по имени файл', r.noFile.find((x) => x.rowId === 'nofile')!.candidates.map((c) => c.name).join() === '3700-B01-E02-002_A.pdf');
check('файл прошлой ревизии не закрывает текущую', r.noFile.find((x) => x.rowId === 'hasOther')!.revision === 'B');

check('файл есть, в реестре нет: читается по маске, строки нет', r.noRow.some((x) => x.file.name === '3700-B01-E02-004_A.pdf' && x.matches.length === 0));
check('файл с совпавшим шифром предлагает «Связать с …»', r.noRow.find((x) => x.file.name === '3700-B01-E02-002_A.pdf')!.matches.join() === 'nofile');
check('привязанные файлы в этой группе не повторяются', !r.noRow.some((x) => x.file.name === '3700-B01-E02-001_B.pdf'));

check('имя не по маске: нечитаемое и с ревизией не по схеме', r.offMask.map((x) => x.file.name).sort().join('|') === '3700-B01-E02-005_%.pdf|черновик.docx', r.offMask);
check('для нечитаемого имени сказано, чего не хватает', r.offMask.every((x) => x.problems.length > 0));
check('служебные файлы не считаются документами', !r.offMask.some((x) => /\$|\.bak/.test(x.file.name)) && r.ignored === 2, r);

check('расходится: привязанный файл с несходящимся именем', r.diverged.some((x) => x.rowId === 'renamed' && x.reason === 'name' && x.expectedName === '3700-B01-C32-001_A.pdf'), r.diverged);
check('расходится: привязанного файла в папке нет', r.diverged.some((x) => x.rowId === 'gone' && x.reason === 'missing'));
check('исправный привязанный файл нигде не числится', !r.diverged.some((x) => x.rowId === 'ok') && !r.noFile.some((x) => x.rowId === 'ok'));
check('сводка считает группы', JSON.stringify(reconSummary(r)) === JSON.stringify({ noFile: 2, noRow: 2, offMask: 2, diverged: 2 }), reconSummary(r));

const lost = reconcile(config, rows, files, [...links, link('nofile', 'E02/3700-B01-E02-002_A.pdf', 'A', { lostAt: '2026-11-05T00:00:00Z' })]);
check('помеченный пропавшим файл — расхождение, даже если путь занят', lost.diverged.some((x) => x.rowId === 'nofile' && x.reason === 'missing'));
const empty = reconcile(config, [], [], []);
check('пустая папка и пустой реестр — пустая сверка', reconSummary(empty).noFile + reconSummary(empty).noRow + reconSummary(empty).offMask + reconSummary(empty).diverged === 0);
const history = reconcile(config, rows, files, [...links, link('nofile', 'E02/3700-B01-E02-002_A.pdf', 'A', { unlinkedAt: '2026-11-04T00:00:00Z' })]);
check('отвязанная связь сверку не затрагивает', history.noFile.some((x) => x.rowId === 'nofile') && !history.diverged.some((x) => x.rowId === 'nofile'));

console.log(`docflow-reconcile: ${passed} проверок прошли`);
