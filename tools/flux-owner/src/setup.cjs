'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vaultApi = require('./vault.cjs');

const names = {
  full: 'Flux-Owner-Полная-копия.flux-owner',
  emergency: 'Flux-Owner-Аварийный-вход.flux-owner',
  public: 'flux-public-keys.json',
};
function publicConfig(vault) {
  if (vault.kind !== 'main') throw new Error('Для настройки нужны полные ключи владельца.');
  return { format: 'FLUXPUBLIC1', license: vault.keys.license.publicHex, update: vault.keys.update.publicHex,
    owner: vault.keys.owner.publicHex, ownerBackup: vault.backupOwnerPublic };
}
function sameKeys(a, b) { return JSON.stringify(publicConfig(a)) === JSON.stringify(publicConfig(b)); }
async function archiveExisting(file) {
  let previous;
  try { previous = await fs.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  const archive = path.join(path.dirname(file), 'previous', `vault-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.flux-owner`);
  await vaultApi.atomicWrite(archive, previous);
  if (!(await fs.readFile(archive)).equals(previous)) throw new Error('Не удалось проверить сохранность прежнего хранилища. Замена отменена.');
  return archive;
}
async function createSetup({ folder, localFile, password, signal }) {
  vaultApi.passwordCheck(password);
  const stat = await fs.stat(folder);
  if (!stat.isDirectory()) throw new Error('Выберите папку для резервных копий.');
  const generated = vaultApi.generateVaults();
  const kitPath = path.join(folder, `Flux-Owner-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
  await fs.mkdir(kitPath, { mode: 0o700 });
  let complete = false;
  try {
    const [full, emergency] = await Promise.all([
      vaultApi.encrypt(generated.main, password), vaultApi.encrypt(generated.backup, password),
    ]);
    await vaultApi.atomicWrite(path.join(kitPath, names.full), full);
    await vaultApi.atomicWrite(path.join(kitPath, names.emergency), emergency);
    await vaultApi.atomicWrite(path.join(kitPath, names.public), JSON.stringify(publicConfig(generated.main), null, 2));
    await vaultApi.atomicWrite(path.join(kitPath, 'Как-пользоваться.txt'), [
      'Flux-Owner: комплект восстановления', '',
      'Оба файла .flux-owner защищены одним паролем, заданным при создании этого комплекта.',
      'Полная копия: все ключи лицензий, обновлений и входа. Восстановите её через «Восстановить полную копию».',
      'Аварийный вход: только запасной вход владельца, без выдачи лицензий и подписи обновлений.',
      'flux-public-keys.json: только публичные ключи. Передайте сборщику Flux только этот JSON.',
      'Пароль и файлы .flux-owner не передавайте. Сохраните комплект на отдельном носителе.',
      'Копия содержит реестр на момент создания. После выдачи лицензий сохраняйте свежую полную копию.',
      'Новые ключи требуют новой сборки Flux и перевыпуска прежних лицензий.',
    ].join('\r\n'));
    await verifyKit(kitPath, password, generated.main);
    complete = true;
    signal?.throwIfAborted();
    const previousVaultPath = await archiveExisting(localFile);
    signal?.throwIfAborted();
    await vaultApi.atomicWrite(localFile, full);
    return { main: generated.main, kitPath, publicFilePath: path.join(kitPath, names.public), previousVaultPath };
  } catch (error) {
    // Готовый комплект сохраняем даже при ошибке установки: его можно импортировать.
    if (!complete) await fs.rm(kitPath, { recursive: true, force: true }).catch(() => {});
    if (complete) error.message += `\nПолная резервная копия сохранена: ${kitPath}`;
    throw error;
  }
}
async function verifyKit(kitPath, password, expected) {
  const full = await vaultApi.readVault(path.join(kitPath, names.full), password);
  const emergency = await vaultApi.readVault(path.join(kitPath, names.emergency), password);
  if (!sameKeys(full, expected) || emergency.kind !== 'backup' || emergency.keys.owner.publicHex !== expected.backupOwnerPublic)
    throw new Error('Ключи резервной копии не совпадают с локальным хранилищем.');
  const config = JSON.parse(await fs.readFile(path.join(kitPath, names.public), 'utf8'));
  if (JSON.stringify(config) !== JSON.stringify(publicConfig(expected))) throw new Error('Публичный файл не совпадает с ключами хранилища.');
  return true;
}
module.exports = { createSetup, verifyKit, archiveExisting, sameKeys, names };
