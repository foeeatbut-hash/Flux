import { checks, launch, openStand } from './fixtures/explorer-shell/harness';

const { ok, done } = checks();
const focusedScenario = Number(process.env.EXPLORER_UI_SCENARIO || 0);
const selectedScenarios = (process.env.EXPLORER_UI_SCENARIOS || '').split(',').map(Number).filter(Number.isInteger);
const shouldRun = (scenario: number) => selectedScenarios.length ? selectedScenarios.includes(scenario) : !focusedScenario || scenario >= focusedScenario;
(async () => {
  const browser = await launch();
  const errorLists: string[][] = [];
  const open = async (query = '') => {
    const stand = await openStand(browser, 'operations.html', query, { width: 1050, height: 850 });
    await stand.page.waitForFunction(() => !!(window as any).__ops && !!(window as any).__fixture);
    await stand.page.getByRole('heading', { name: 'Корзина Windows' }).waitFor();
    errorLists.push(stand.errors);
    return stand.page;
  };
  try {
    // 1. Three collisions take independent choices; write calls share one undo group.
    if (shouldRun(1)) {
      const page = await open();
      await page.evaluate(() => (window as any).__fixture.prepare(['collision-replace.txt', 'collision-keep.txt', 'collision-skip.txt']));
      await page.getByRole('status').filter({ hasText: /копирование collision-replace/u }).waitFor();
      await page.getByRole('button', { name: 'Вставить буфер' }).click();
      const dialog = page.getByRole('dialog', { name: 'Совпадающие имена' }); await dialog.waitFor();
      await dialog.getByRole('checkbox', { name: /Перенести теги, проекты/ }).check();
      await dialog.getByRole('combobox', { name: 'Решение для collision-replace.txt' }).selectOption('replace');
      await dialog.getByRole('combobox', { name: 'Решение для collision-keep.txt' }).selectOption('keepBoth');
      await dialog.getByRole('combobox', { name: 'Решение для collision-skip.txt' }).selectOption('skip');
      await dialog.getByRole('button', { name: 'Продолжить' }).click();
      await page.waitForFunction(() => (window as any).__fixture.state.files.get('root/collision-replace.txt')?.text === 'bytes:collision-replace.txt' && (window as any).__fixture.state.files.has('root/collision-keep - копия.txt'));
      const results = await page.evaluate(() => {
        const s = (window as any).__fixture.state;
        return { replace: s.files.get('root/collision-replace.txt')?.text, replaceMeta: s.files.get('root/collision-replace.txt')?.meta, keepBoth: s.files.get('root/collision-keep - копия.txt')?.text, keepMeta: s.files.get('root/collision-keep - копия.txt')?.meta, skip: s.files.get('root/collision-skip.txt')?.text, writes: s.calls.filter((c: any) => ['replaceCopy', 'copy'].includes(c.action)), groups: [...new Set(s.groups)] };
      });
      ok('Публикация буфера применяет replace / keepBoth / skip поштучно и переносит метаданные по флажку', results.replace === 'bytes:collision-replace.txt' && results.replaceMeta === true && results.keepBoth === 'bytes:collision-keep.txt' && results.keepMeta === true && results.skip === 'target:collision-skip.txt', results);
      ok('Одна вставка группирует все записи одним group id', results.writes.length === 2 && results.writes.every((item: any) => item.group) && results.groups.length === 1, results);
      await page.evaluate(() => (window as any).__ops.undoLast());
      await page.waitForFunction(() => (window as any).__fixture.state.calls.some((call: any) => call.action === 'undo'));
      ok('Undo после пакета вызывает команду undo моста', await page.evaluate(() => (window as any).__fixture.state.calls.some((call: any) => call.action === 'undo')));
      await page.close();
    }

    // 2. Copying a clip back into its source folder creates a free copy without prompting.
    if (shouldRun(2)) {
      const page = await open();
      await page.evaluate(() => (window as any).__fixture.prepare(['same.txt']));
      await page.getByRole('status').filter({ hasText: /копирование same/u }).waitFor();
      await page.getByRole('button', { name: 'Вставить буфер' }).click();
      await page.waitForFunction(() => (window as any).__fixture.state.files.has('root/same - копия.txt'));
      ok('Копия в той же папке получает свободное имя без диалога', await page.getByRole('dialog').count() === 0 && await page.evaluate(() => (window as any).__fixture.state.files.has('root/same - копия.txt')));
      await page.close();
    }

    // 3. Cancellation waits for the in-flight file, then prevents later files from starting.
    if (shouldRun(3)) {
      const page = await open();
      await page.evaluate(() => { const f = (window as any).__fixture; f.prepare(['source-a.txt', 'source-b.txt', 'source-c.txt']); f.delay('source-b.txt', 600); });
      await page.getByRole('status').filter({ hasText: /копирование source-a/u }).waitFor();
      await page.getByRole('button', { name: 'Вставить буфер' }).click();
      await page.waitForFunction(() => (window as any).__fixture.state.calls.some((call: any) => call.action === 'copy' && call.name === 'source-b.txt'));
      await page.getByRole('button', { name: 'Остановить после текущего файла' }).click();
      await page.waitForFunction(() => !(window as any).__ops.busy);
      const result = await page.evaluate(() => { const s = (window as any).__fixture.state; return { a: s.files.has('root/source-a.txt'), b: s.files.has('root/source-b.txt'), c: s.files.has('root/source-c.txt'), cCalls: s.calls.filter((call: any) => call.action === 'copy' && call.name === 'source-c.txt').length }; });
      ok('Отмена останавливает пакет между файлами, не прерывая текущую запись', result.a && result.b && !result.c && result.cCalls === 0, result);
      await page.close();
    }

    // 4. Failed cut entries remain in the shared clipboard; successful ones leave it.
    if (shouldRun(4)) {
      const page = await open();
      await page.evaluate(() => { const f = (window as any).__fixture; f.prepare(['bad-move.txt', 'source-c.txt'], true); f.fail(['bad-move.txt']); });
      await page.getByRole('status').filter({ hasText: /вырезание bad-move/u }).waitFor({ timeout: 8000 }).catch(async (cause) => {
        const state = await page.evaluate(() => ({ status: document.querySelector('[role="status"]')?.textContent, alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent), calls: (window as any).__fixture.state.calls.slice(-8), clip: (window as any).__fixture.getClip() }));
        throw new Error(`Scenario 4 clip preparation timed out: ${JSON.stringify(state)}; ${String(cause)}`);
      });
      await page.getByRole('button', { name: 'Вставить буфер' }).click();
      await page.waitForFunction(() => !(window as any).__ops.busy && (window as any).__fixture.state.files.has('root/source-c.txt'));
      const clip = await page.evaluate(() => (window as any).__fixture.getClip()?.items.map((item: any) => item.name));
      ok('После частичного переноса в буфере остаётся только неудавшийся объект', JSON.stringify(clip) === JSON.stringify(['bad-move.txt']), clip);
      await page.close();
    }

    // 5. External drop keeps one operation group across unresolved name collisions.
    if (shouldRun(5)) {
      const page = await open();
      await page.getByRole('button', { name: 'Импорт drop' }).click();
      const dialog = page.getByRole('dialog', { name: 'Совпадающие имена' }); await dialog.waitFor();
      ok('Импорт до решения скопировал свободный файл, конфликт ждёт выбора', await page.evaluate(() => (window as any).__fixture.state.files.has('root/windows-new.txt')));
      await dialog.getByRole('combobox', { name: 'Решение для occupied.txt' }).selectOption('skip');
      await dialog.getByRole('button', { name: 'Продолжить импорт' }).click();
      await page.waitForFunction(() => !(window as any).__ops.busy);
      const data = await page.evaluate(() => (window as any).__fixture.state.calls.filter((call: any) => call.action === 'importPaths').map((call: any) => call.group));
      ok('Первичная обработка drop и решение конфликта используют один group id', data.length === 2 && !!data[0] && data[0] === data[1], data);
      await page.close();
    }

    // 6. Blocked publication is explained; replace is absent when replacement is unsafe.
    if (shouldRun(6)) {
      const page = await open();
      await page.getByRole('combobox', { name: 'Источник' }).selectOption('draft.txt');
      await page.evaluate(() => { const f = (window as any).__fixture; f.setPlan({ ref: { rootId: 'root', relativePath: 'publish-root', draftId: 'publish-root' }, items: [
        { draftId: 'free', name: 'free.txt', kind: 'file', targetPath: 'free.txt', status: 'free' },
        { draftId: 'same-kind', name: 'folder', kind: 'directory', targetPath: 'folder', status: 'collision', replaceable: false },
        { draftId: 'blocked', name: 'bad', kind: 'file', targetPath: 'bad', status: 'blocked', reason: 'Исходная папка закрыта.' },
      ], collisions: 1, blocked: 1, truncated: false }); f.touch(); });
      await page.getByRole('button', { name: 'Публиковать черновик' }).click();
      const dialog = page.getByRole('dialog', { name: 'Публикация черновика' }); await dialog.waitFor();
      const replaceOption = await dialog.getByRole('combobox', { name: 'Решение для folder' }).locator('option').allTextContents();
      ok('Заблокированный путь виден, replace недоступен для небезопасного совпадения', await dialog.getByText('Исходная папка закрыта.').isVisible() && replaceOption.every((text) => text !== 'Заменить'), replaceOption);
      await dialog.getByRole('button', { name: 'Опубликовать доступные' }).click();
      await page.getByRole('alert').filter({ hasText: 'Остальные черновики сохранены в Flux' }).waitFor();
      ok('Частичная публикация оставляет заблокированный черновик в Flux', await page.getByRole('alert').filter({ hasText: 'Остальные черновики сохранены в Flux' }).count() === 1);
      await page.close();
    }

    // 7. A truncated plan cannot be accepted.
    if (shouldRun(7)) {
      const page = await open();
      await page.getByRole('combobox', { name: 'Источник' }).selectOption('draft.txt');
      await page.evaluate(() => { const f = (window as any).__fixture; f.setPlan({ ref: { rootId: 'root', relativePath: 'publish-root', draftId: 'publish-root' }, items: [{ draftId: 'free', name: 'free.txt', kind: 'file', targetPath: 'free.txt', status: 'free' }], collisions: 0, blocked: 0, truncated: true }); f.touch(); });
      await page.getByRole('button', { name: 'Публиковать черновик' }).click();
      const dialog = page.getByRole('dialog', { name: 'Публикация черновика' }); await dialog.waitFor();
      ok('Неполный план честно показан и его нельзя применить', await dialog.getByText(/План ограничен по числу объектов/u).isVisible() && await dialog.getByRole('button', { name: 'Опубликовать доступные' }).isDisabled());
      ok('Неполный план не вызвал публикацию', await page.evaluate(() => !(window as any).__fixture.state.calls.some((call: any) => call.action === 'publishDraft' || call.action === 'publishDraftTree')));
      await page.close();
    }

    // 8. Both recycle bins restore through their own bridge actions.
    if (shouldRun(8)) {
      const page = await open();
      await page.locator('section[aria-labelledby="windows-recycle-title"] ul button').first().click();
      await page.waitForFunction(() => (window as any).__fixture.state.files.has('root/restored.txt'));
      await page.getByRole('button', { name: 'Восстановить в Flux' }).click();
      await page.waitForFunction(() => (window as any).__fixture.state.drafts.has('gone-1'));
      const actions = await page.evaluate(() => (window as any).__fixture.state.calls.map((call: any) => call.action));
      ok('Корзина Windows и черновики Flux восстанавливаются отдельными командами', actions.includes('recycleBinRestore') && actions.includes('restoreDraft'), actions);
      ok('После возврата обеих корзин вызывается onChanged', await page.evaluate(() => (window as any).__fixture.changed()) === 2);
      await page.close();
    }

    // 9. Dismissing the empty-bin confirmation leaves Windows recycle contents intact.
    if (shouldRun(9)) {
      const page = await open();
      page.once('dialog', (dialog) => void dialog.dismiss());
      await page.getByRole('button', { name: 'Очистить корзину Windows' }).click();
      await page.waitForTimeout(100);
      const result = await page.evaluate(() => ({ count: (window as any).__fixture.state.windowsTrash.length, calls: (window as any).__fixture.state.calls.filter((call: any) => call.action === 'recycleBinEmpty').length }));
      ok('Отмена подтверждения очистки не меняет корзину и не вызывает очистку', result.count === 2 && result.calls === 0, result);
      await page.close();
    }

    // 10. Trash confirmation cancellation performs no deletion.
    if (shouldRun(10)) {
      const page = await open();
      page.once('dialog', (dialog) => void dialog.dismiss());
      await page.getByRole('button', { name: 'Переместить в корзину' }).click();
      await page.waitForTimeout(100);
      ok('Отмена подтверждения удаления не отправляет команду trash', await page.evaluate(() => !(window as any).__fixture.state.calls.some((call: any) => call.action === 'trash')));
      await page.close();
    }

    // 11. Dismissing Flux purge confirmation leaves drafts untouched.
    if (shouldRun(11)) {
      const page = await open();
      page.once('dialog', (dialog) => void dialog.dismiss());
      await page.getByRole('button', { name: 'Удалить из Flux' }).click();
      await page.waitForTimeout(100);
      const result = await page.evaluate(() => ({ count: (window as any).__fixture.state.fluxTrash.length, calls: (window as any).__fixture.state.calls.filter((call: any) => call.action === 'purgeDraft').length }));
      ok('Отмена безвозвратного удаления Flux не меняет черновики', result.count === 1 && result.calls === 0, result);
      await page.close();
    }

    // 12. Confirmed Flux purge removes the draft through its dedicated bridge action.
    if (shouldRun(12)) {
      const page = await open();
      page.once('dialog', (dialog) => void dialog.accept());
      await page.getByRole('button', { name: 'Удалить из Flux' }).click();
      await page.waitForFunction(() => (window as any).__fixture.state.fluxTrash.length === 0);
      const result = await page.evaluate(() => ({ calls: (window as any).__fixture.state.calls.filter((call: any) => call.action === 'purgeDraft'), changed: (window as any).__fixture.changed() }));
      ok('Подтверждённое удаление Flux очищает черновик через purgeDraft', result.calls.length === 1 && result.calls[0].ref.draftId === 'gone-1' && result.changed === 1, result);
      await page.close();
    }

    // 13. Cut may replace an existing file; replacement consumes the source only on success.
    if (shouldRun(13)) {
      const page = await open();
      await page.evaluate(() => (window as any).__fixture.prepare(['collision-replace.txt'], true));
      await page.getByRole('status').filter({ hasText: /вырезание collision-replace/u }).waitFor();
      await page.getByRole('button', { name: 'Вставить буфер' }).click();
      const dialog = page.getByRole('dialog', { name: 'Совпадающие имена' }); await dialog.waitFor();
      await dialog.getByRole('combobox', { name: 'Решение для collision-replace.txt' }).selectOption('replace');
      await dialog.getByRole('button', { name: 'Продолжить' }).click();
      await page.waitForFunction(() => (window as any).__fixture.state.files.get('root/collision-replace.txt')?.text === 'bytes:collision-replace.txt' && !(window as any).__fixture.state.files.has('root/src/collision-replace.txt'));
      const result = await page.evaluate(() => (window as any).__fixture.state.calls.find((call: any) => call.action === 'replaceCopy'));
      ok('Перенос файла может заменить одноимённый файл и помечается move', result?.move === true, result);
      await page.close();
    }

    // 14. A failed hash preflight must preserve the current clipboard.
    if (shouldRun(14)) {
      const page = await open();
      await page.evaluate(() => (window as any).__fixture.prepare(['source-a.txt']));
      await page.getByRole('status').filter({ hasText: /копирование source-a/u }).waitFor();
      await page.evaluate(() => { const f = (window as any).__fixture; f.failHash(['bad-move.txt']); f.prepare(['bad-move.txt'], true); });
      await page.getByRole('alert').filter({ hasText: 'Фикстура отказала в вычислении хеша' }).waitFor();
      const result = await page.evaluate(() => ({ clip: (window as any).__fixture.getClip(), hashCalls: (window as any).__fixture.state.calls.filter((call: any) => call.action === 'fileHash') }));
      ok('Ошибка fileHash при вырезании сохраняет прежний буфер копирования', !result.clip?.cut && result.clip?.items.length === 1 && result.clip.items[0].name === 'source-a.txt' && result.hashCalls.at(-1)?.ref.relativePath === 'src/bad-move.txt', result);
      await page.close();
    }

    // 15. Partial Flux purge refreshes both panes and notifies the owner on response errors and thrown errors.
    if (shouldRun(15)) {
      for (const mode of ['error', 'throw'] as const) {
        const page = await open('?extraDraft=1');
        await page.evaluate((failureMode) => (window as any).__fixture.purgeFailure('gone-2', failureMode), mode);
        page.once('dialog', (dialog) => void dialog.accept());
        await page.getByRole('button', { name: 'Очистить черновики Flux' }).click();
        await page.waitForFunction(() => (window as any).__fixture.state.changed === 1 && (window as any).__fixture.state.fluxTrash.length === 1);
        await page.getByRole('alert').filter({ hasText: /Не удалось удалить некоторые черновики/u }).waitFor();
        const result = await page.evaluate(() => ({ remaining: (window as any).__fixture.state.fluxTrash.map((item: any) => item.ref.draftId), purgeCalls: (window as any).__fixture.state.calls.filter((call: any) => call.action === 'purgeDraft').map((call: any) => call.ref.draftId), changed: (window as any).__fixture.changed() }));
        const remaining = page.locator('section[aria-labelledby="flux-trash-title"] li');
        ok(`Частичная очистка Flux после ${mode === 'throw' ? 'исключения' : 'error response'} обновляет список и вызывает onChanged`, JSON.stringify(result.remaining) === JSON.stringify(['gone-2']) && JSON.stringify(result.purgeCalls) === JSON.stringify(['gone-1', 'gone-2']) && result.changed === 1 && await remaining.count() === 1 && await remaining.first().getByText('gone-2.txt').isVisible(), result);
        await page.close();
      }
    }

    const errors = errorLists.flat();
    ok('Операционные диалоги не создают ошибок страницы', errors.length === 0, errors);
  } finally { await browser.close(); }
  process.exitCode = done();
})();
