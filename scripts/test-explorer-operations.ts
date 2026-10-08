import { clipboardAction, choicesForPlan, planSummary, publishRequestFor } from '../src/components/files/explorerOperationLogic';
import type { WindowsPublishPlan } from '../filesystem/contracts';

let passed = 0; let failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log('✓', name); }
  else { failed++; console.error('✗', name, '\n   получено:', JSON.stringify(actual), '\n   ожидалось:', JSON.stringify(expected)); }
}

const plan: WindowsPublishPlan = {
  ref: { rootId: 'root', relativePath: 'Черновик', draftId: 'root-draft' },
  items: [
    { draftId: 'free', name: 'новый.txt', kind: 'file', targetPath: 'новый.txt', status: 'free' },
    { draftId: 'conflict', name: 'занят.txt', kind: 'file', targetPath: 'занят.txt', status: 'collision' },
    { draftId: 'blocked', name: 'bad:name', kind: 'file', targetPath: 'bad:name', status: 'blocked', reason: 'Недопустимое имя.' },
  ], collisions: 1, blocked: 1, truncated: false,
};

eq('выбор публикации формируется только для совпадений', choicesForPlan(plan, 'replace'), { conflict: 'replace' });
eq('заблокированный объект не получает молчаливое решение', choicesForPlan(plan, 'keepBoth'), { conflict: 'keepBoth' });
eq('отдельные решения сохраняются, а replaceable=false запрещает замену', choicesForPlan({ ...plan, items: [...plan.items, { draftId: 'locked-conflict', name: 'папка', kind: 'directory', targetPath: 'папка', status: 'collision', replaceable: false }] }, { conflict: 'replace', 'locked-conflict': 'replace' }), { conflict: 'replace' });
eq('сводка публикации различает свободные, занятые и заблокированные', planSummary(plan.items), { collisions: 1, blocked: 1, free: 1 });
eq('план с папкой публикуется одной древовидной операцией', publishRequestFor(plan), 'publishDraft');
eq('план папки выбирает публикацию дерева', publishRequestFor({ ...plan, items: [...plan.items, { draftId: 'dir', name: 'папка', kind: 'directory', targetPath: 'папка', status: 'free' }] }), 'publishDraftTree');
eq('перемещение остаётся внутри корня, если не зажата копия', clipboardAction({ rootId: 'a', relativePath: 'x' }, { rootId: 'a', relativePath: 'dest' }, false), 'move');
eq('Ctrl/Meta выбирает копирование внутри корня', clipboardAction({ rootId: 'a', relativePath: 'x' }, { rootId: 'a', relativePath: 'dest' }, true), 'copy');
eq('между корнями вставка всегда копирует', clipboardAction({ rootId: 'a', relativePath: 'x' }, { rootId: 'b', relativePath: 'dest' }, false), 'copy');

console.log(`\nИтог: ${passed} успешно, ${failed} ошибок`);
if (failed) process.exitCode = 1;
