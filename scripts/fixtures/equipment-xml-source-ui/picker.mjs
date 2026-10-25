/**
 * Проходит окно Проводника Flux в проверках XML-источников: выбор XML-файла (L23/A/L23.xml)
 * или выбор папки по имени. Раньше здесь отвечало системное окно Windows.
 */
export async function pickXmlFile(page) {
  const dialog = page.getByRole('dialog', { name: 'Выбрать файл из Проводника' });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'L23', exact: true }).click();
  await dialog.getByRole('button', { name: 'A', exact: true }).click();
  await dialog.locator('label').filter({ hasText: 'L23.xml' }).locator('input[type=checkbox]').check();
  await dialog.getByRole('button', { name: 'Выбрать файл' }).click();
  await dialog.waitFor({ state: 'detached' });
}

export async function pickFolder(page, folder) {
  const dialog = page.getByRole('dialog', { name: 'Выбрать папку из Проводника' });
  await dialog.waitFor();
  if (folder) await dialog.getByRole('button', { name: folder, exact: true }).click();
  await dialog.getByRole('button', { name: 'Выбрать эту папку' }).click();
  await dialog.waitFor({ state: 'detached' });
}
