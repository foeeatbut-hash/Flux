/**
 * Стенд для наборов windows-file-*: новая панель Flux Office над файлом
 * Проводника при заглушках редактора. Маршруты возвращают те же формы, что и
 * сервер (каталог, выборка, состояние по содержимому), а шаги сценария —
 * то, что делает сотрудник: команда ленты «Теги», «Обновить выборку», «Вставить все».
 */
import type { Page, Frame } from 'playwright-core';

export interface MockTag { id: string; identifier: string; name?: string }

/** Каталог, шаблоны, выборка тегов и состояние файла по содержимому. */
export async function mockFluxPanelApi(page: Page, tags: MockTag[]): Promise<void> {
  await page.route('**/api/project-data/catalog*', (route) => route.fulfill({ json: { tagFields: [{ path: 'identifier', title: 'Тег' }, { path: 'name', title: 'Наименование' }], elementFields: [], params: [], aliases: [], metaKeys: [] } }));
  await page.route('**/api/project-data/office/templates', (route) => route.fulfill({ json: { templates: [], pinned: [] } }));
  await page.route('**/api/project-data/office/query', (route) => route.fulfill({ json: {
    revision: 'mock-rev', total: tags.length,
    rows: tags.map((tag) => ({ entityId: `tags:tag:${tag.id}`, entityType: 'tag', sourceId: 'tags', tag: tag.identifier, values: { identifier: { value: tag.identifier }, name: { value: tag.name ?? null } } })),
  } }));
  await page.route('**/api/project-data/office-local/state', (route) => route.fulfill({ json: { baseHash: 'mock-hash', sourceRevision: 'mock-rev', schema: { version: 1, anchors: [] }, rows: [] } }));
}

/** Лента «Flux» редактора нажимает кнопку: одно сообщение flux:open-panel с полем command. */
export const ribbonCommand = (frame: Frame, command: string): Promise<void> =>
  frame.evaluate((name) => window.parent.postMessage({ flux: 'office', op: 'flux:open-panel', command: name }, location.origin), command);

/** Панель с источником «Теги» и загруженной выборкой — после этого доступна «Вставить все». */
export async function openTagsSelection(page: Page, frame: Frame, firstTag: string, timeout = 15000): Promise<void> {
  await ribbonCommand(frame, 'source-tags');
  await page.getByRole('complementary', { name: 'Flux Office' }).waitFor({ timeout });
  await page.getByRole('button', { name: 'Обновить выборку' }).click();
  await page.getByRole('checkbox', { name: `Выбрать строку ${firstTag}` }).waitFor({ timeout });
}
