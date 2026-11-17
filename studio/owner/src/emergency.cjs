'use strict';
/**
 * Пакет экстренного обновления: подпись и запись одним файлом `.fluxupdate` БЕЗ сервера.
 *
 * Ничего сетевого здесь нет и быть не должно: сценарий, ради которого это сделано, — «вышло неудачное
 * обновление, база с обновлениями не работает, а файл надо передать всем». Подпись ставит ключ обновлений
 * из открытого хранилища владельца (тот же, что подписывает обычные выпуски), запись — потоком, exe целиком
 * в память не читается. Формат и проверка — electron/updatePackage.ts: этот же код читает пакет во Flux.
 */
// Подпись грузится при первом вызове: signing.cjs тянет ядро лицензий в .ts, которое вне сборки читается только через esbuild
const signingApi = () => require('./signing.cjs');
const packageApi = () => require('../../../electron/updatePackage.ts');

/** Имя файла пакета: расширение .fluxupdate обязательно, чтобы Flux и человек узнавали файл */
function packageName(file) {
  return file.toLowerCase().endsWith(`.${packageApi().PACKAGE_EXTENSION}`) ? file : `${file}.${packageApi().PACKAGE_EXTENSION}`;
}

/**
 * Подписать проверенный exe и записать пакет в `outFile`.
 * `exe` — результат signing.inspectExe (путь, размер, SHA-256, которые владелец уже видел на экране).
 * Закрытый ключ остаётся в `vault` и наружу не возвращается; возвращается то, что можно показать и сохранить в реестр.
 */
async function signPackage({ vault, exe, version, outFile, onProgress, signal }) {
  if (!vault || vault.kind !== 'main') throw new Error('Пакет подписывается ключом основного хранилища. Запасной ключ подписи не ставит.');
  const out = packageName(String(outFile || ''));
  // Расширение .fluxupdate добавляется всегда, поэтому пакет не может лечь поверх самого EXE (его имя заканчивается на .exe)
  const signed = signingApi().signUpdate(vault, exe, version);
  const written = await packageApi().writePackage(exe.path, out, { signature: signed.signature, keyHex: vault.keys.update.publicHex, onProgress, signal });
  return { file: out, signature: signed.signature, payload: signed.payload, version: written.version, size: written.size, sha256: written.sha256 };
}

module.exports = { signPackage, packageName };
