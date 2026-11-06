import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Отрицательные проверки панели: каждая правка ломает одно поведение, и
 * набор обязан упасть именно на нём, а не из-за окружения. Без этого новая
 * проверка могла бы быть пустой и всё равно зелёной.
 *
 * `script` — какой набор должен упасть: интерфейсный (по умолчанию, требует
 * пересборки стенда) или узловой без браузера.
 */
interface Mutation { name: string; file: string; from: string; to: string; expect: string; script?: string }
const UI = 'scripts/test-drafts-panel-ui.ts';
const MUTATIONS: Mutation[] = [
  { name: 'button', file: 'src/components/drafts/DraftsButton.tsx', from: 'onClick=', to: 'onDoubleClick=', expect: 'waitFor' },
  { name: 'columns', file: 'src/components/drafts/DraftsCompact.tsx', from: 'repeat(${s.columns}, minmax(0, 1fr))', to: 'repeat(4, minmax(0, 1fr))', expect: 'столбцов плиток' },
  { name: 'state-filter', file: 'src/lib/draftsPanel.ts', from: '(!q.state || draftState(entry, q.openDrafts) === q.state)', to: '(true)', expect: 'фильтр «не в проекте»' },
  { name: 'review', file: 'src/components/drafts/DraftsLayer.tsx', from: '...(reviewing ? { olderThanDays: oldDays } : {}),', to: '', expect: '«Разобрать старые» оставляет только давние' },
  { name: 'pin', file: 'src/components/drafts/draftsOps.ts', from: ': [...pinned, id]', to: ': pinned', expect: 'закреплённый черновик первым' },
  { name: 'hover-delay', file: 'src/components/drafts/DraftDetails.tsx', from: 'HOVER_DELAY = 500', to: 'HOVER_DELAY = 0', expect: 'сведения не раньше 500 мс' },
  { name: 'explorer-drop', file: 'src/components/files/useExplorerOperations.tsx', from: 'if (draftItems) { if (parent) offerDraftDrop(draftItems, parent, event.ctrlKey || event.metaKey); return; }', to: '', expect: 'waitFor' },
  { name: 'drop-setting', file: 'src/store/draftsPublishStore.ts', from: 'if (!useDraftsSettings.getState().dropPublish) {', to: 'if (false) {', expect: 'при выключенной настройке окна публикации нет' },
  { name: 'snooze', file: 'src/components/drafts/DraftsLayer.tsx', from: 'now >= settings.snoozeUntil', to: 'true', expect: '«Позже» скрывает напоминание' },
  { name: 'close-outside', file: 'src/components/drafts/DraftsLayer.tsx', from: '|| !useDraftsSettings.getState().closeOutside', to: '', expect: 'без «закрывать щелчком вне» панель остаётся' },
  { name: 'drop-highlight', file: 'src/components/files/ContentsPane.tsx', from: 'role="row" data-entry-key={entryKey(entry)} data-entry-kind={entry.kind}', to: 'role="row" data-entry-key={entryKey(entry)}', expect: 'подсвечена «опубликовать сюда»' },
  { name: 'name-retry', file: 'src/lib/draftsActions.ts', from: "if (answer.error.code === 'EEXIST') continue;", to: '', script: 'scripts/test-drafts-actions.ts', expect: 'Документ (3).docx' },
  { name: 'keep-copy', file: 'src/lib/draftsActions.ts', from: 'const answer = opts.keepCopy', to: 'const answer = false', script: 'scripts/test-drafts-actions.ts', expect: "'copy'" },
  { name: 'pinned-group', file: 'src/lib/draftsPanel.ts', from: 'if (pinnedItems.length) {', to: 'if (false) {', script: 'scripts/test-drafts-view.ts', expect: 'Закреплённые' },
];

function run(script: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: 240_000 });
}

const only = process.env.ONLY?.split(',');
mkdirSync('.cache/drafts-evidence', { recursive: true });
for (const mutation of MUTATIONS) {
  if (only && !only.includes(mutation.name)) continue;
  const source = readFileSync(mutation.file, 'utf8');
  const changed = source.replace(mutation.from, mutation.to);
  if (changed === source) throw new Error(`Не найдена точка контрольной мутации «${mutation.name}» в ${mutation.file}`);
  try {
    writeFileSync(mutation.file, changed);
    const script = mutation.script ?? UI;
    if (script === UI) {
      const build = run('scripts/build-drafts-fixture.ts');
      if (build.status !== 0) throw new Error(`Контрольная сборка «${mutation.name}» не завершилась: ${build.stderr}`);
    }
    const result = run(script);
    writeFileSync(`.cache/drafts-evidence/${mutation.name}-negative.log`, result.stdout + result.stderr);
    if (result.status !== 1 || !(result.stderr + result.stdout).includes(mutation.expect)) {
      throw new Error(`Мутация «${mutation.name}» должна провалить «${mutation.expect}», а не окружение: exit=${result.status} ${(result.stderr || result.stdout).slice(0, 600)}`);
    }
    console.log(`Отрицательная проверка «${mutation.name}»: набор падает на «${mutation.expect}» (exit 1)`);
  } finally {
    writeFileSync(mutation.file, source);
  }
}
