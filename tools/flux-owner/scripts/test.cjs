'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const serviceRoot = path.resolve(root, '../..');

function compile(entryPoint, outfile, options = {}) {
  esbuild.buildSync({ entryPoints: [entryPoint], outfile, bundle: true, platform: 'node', format: 'cjs', legalComments: 'none', ...options });
  return require(outfile);
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-owner-tests-'));
  try {
    const ownerCore = compile(path.join(root, 'src/vendor/license-core.ts'), path.join(temp, 'owner-license-core.cjs'));
    const ownerUpdate = compile(path.join(root, 'src/vendor/updateSignature.ts'), path.join(temp, 'owner-update-signature.cjs'));
    const ownerSigning = compile(path.join(root, 'src/signing.cjs'), path.join(temp, 'owner-signing.cjs'));
    const serviceCore = compile(path.join(serviceRoot, 'license/node/core.ts'), path.join(temp, 'service-license-core.cjs'));
    const serviceRevocation = compile(path.join(serviceRoot, 'license/node/revocation.ts'), path.join(temp, 'service-revocation.cjs'));
    const serviceUpdate = compile(path.join(serviceRoot, 'electron/updateSignature.ts'), path.join(temp, 'service-update-signature.cjs'));
    const vaultApi = require(path.join(root, 'src/vault.cjs'));
    const { applyPublicConfig } = require(path.join(root, 'src/public-config.cjs'));

    const generated = vaultApi.generateVaults();
    const mainVault = generated.main;
    const backupVault = generated.backup;
    const config = ownerSigning.publicConfig(mainVault);

    const encrypted = await vaultApi.encrypt(mainVault, 'temporary-test-passphrase');
    assert.equal((await vaultApi.decrypt(encrypted, 'temporary-test-passphrase')).kind, 'main');
    await assert.rejects(vaultApi.decrypt(encrypted, 'wrong-test-passphrase'));
    const encryptedFile = path.join(temp, 'vault.flux-owner');
    await vaultApi.atomicWrite(encryptedFile, encrypted);
    assert.equal((await vaultApi.readVault(encryptedFile, 'temporary-test-passphrase')).kind, 'main');
    assert.equal(config.ownerBackup, backupVault.keys.owner.publicHex);
    assert.throws(() => ownerSigning.publicConfig(backupVault), /только для входа владельца/);

    const backupPassword = 'отдельный пароль запасного ключа';
    const encryptedBackup = await vaultApi.encrypt(backupVault, backupPassword);
    assert.equal((await vaultApi.decrypt(encryptedBackup, backupPassword)).kind, 'backup');
    await assert.rejects(vaultApi.decrypt(encryptedBackup, 'temporary-test-passphrase'), /пароль запасного ключа/);
    await assert.rejects(vaultApi.decrypt(encrypted, backupPassword), /Проверьте пароль именно этого файла/);
    await assert.rejects(vaultApi.decrypt(encryptedBackup, `${backupPassword} `), /расшифровать/);
    assert.equal((await vaultApi.decrypt(`\uFEFF${encryptedBackup}`, backupPassword)).keys.owner.publicHex, config.ownerBackup);
    const backupFile = path.join(temp, 'backup.flux-owner');
    await vaultApi.atomicWrite(backupFile, `\uFEFF${encryptedBackup}`);
    assert.equal((await vaultApi.readVault(backupFile, backupPassword)).kind, 'backup');
    await assert.rejects(vaultApi.decrypt(JSON.stringify(config), backupPassword), /открытых ключей для сборки/);
    await assert.rejects(vaultApi.decrypt('{', backupPassword), /прочитать JSON/);
    const damaged = JSON.parse(encryptedBackup);
    damaged.iv = 'broken';
    await assert.rejects(vaultApi.decrypt(JSON.stringify(damaged), backupPassword), /Повреждённый файл/);

    // Проверяем подпись из настоящего Electron-обработчика, заменяя только оболочку.
    const electronStub = path.join(temp, 'electron-stub.cjs');
    await fs.writeFile(electronStub, 'module.exports = {};');
    const fluxLogin = compile(path.join(serviceRoot, 'electron/ownerLogin.ts'), path.join(temp, 'flux-login.cjs'), { alias: { electron: electronStub } });
    const origin = 'https://flux.company.test';
    const expiresAt = Date.now() + 60000;
    const nonce = crypto.randomBytes(24).toString('base64url');
    const packet = { nonce, expiresAt, message: JSON.stringify({ purpose: 'flux-owner-login', version: 1, nonce, origin, expiresAt, installationId: 'vault-login-test' }) };
    for (const [file, phrase, hex] of [[encrypted, 'temporary-test-passphrase', config.owner], [`\uFEFF${encryptedBackup}`, backupPassword, config.ownerBackup]]) {
      const signature = await fluxLogin.signOwnerChallenge(file, phrase, packet, origin);
      const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), type: 'spki', format: 'der' });
      assert.ok(crypto.verify(null, Buffer.from(packet.message), publicKey, Buffer.from(signature, 'base64')));
    }
    await assert.rejects(fluxLogin.signOwnerChallenge(encryptedBackup, 'temporary-test-passphrase', packet, origin), /пароль запасного ключа/);
    await assert.rejects(fluxLogin.signOwnerChallenge(JSON.stringify(config), backupPassword, packet, origin), /открытых ключей для сборки/);
    await assert.rejects(fluxLogin.signOwnerChallenge(encryptedBackup, backupPassword, packet, 'https://other.test'), /другому серверу/);

    const sessionBackup = path.join(temp, 'first-run-backup.flux-owner');
    let selectedDirectory = path.join(temp, 'setup-backups');
    let selectedOpenFile = sessionBackup;
    let selectedSaveFile = sessionBackup;
    let confirmationResponse = 1;
    let cancelDirectoryDialog = false;
    const realNetwork = require(path.join(root, 'src/network.cjs'));
    const runtimeRecords = [];
    let expectedConnectOwnerHex = '';
    let nextChallengeError = '';
    let challengeByOrigin = new Map();
    let runtimeStartWaiter = null;
    let deferredDatabaseStartup = null;
    const fakeNetwork = {
      ...realNetwork,
      request: async (origin, route, options = {}) => {
        if (route === '/api/owner/challenge') {
          if (nextChallengeError) { const error = nextChallengeError; nextChallengeError = ''; throw new Error(error); }
          const nonce = crypto.randomBytes(24).toString('base64url');
          const expiresAt = Date.now() + 60000;
          const message = JSON.stringify({ purpose: 'flux-owner-login', version: 1, nonce, origin, expiresAt, installationId: 'database-runtime-test' });
          challengeByOrigin.set(origin, message);
          return { nonce, expiresAt, message };
        }
        if (route === '/api/owner/login') {
          const message = challengeByOrigin.get(origin);
          assert.ok(message, 'login must follow an issued challenge');
          const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(expectedConnectOwnerHex, 'hex')]), type: 'spki', format: 'der' });
          assert.ok(crypto.verify(null, Buffer.from(message), publicKey, Buffer.from(options.body.sig, 'base64')), 'owner challenge signature must verify');
          assert.equal(options.body.nonce, JSON.parse(message).nonce);
          return { token: 'temporary-controller-token-123', user: { name: 'Test Owner', role: 'OWNER' } };
        }
        throw new Error(`Unexpected mocked request ${route}`);
      },
    };
    const fakeStartDatabaseRuntime = async ({ uri, signal, onUnexpectedExit }) => {
      const record = { uri, signal, onUnexpectedExit, stops: 0 };
      runtimeRecords.push(record);
      runtimeStartWaiter?.();
      runtimeStartWaiter = null;
      const startup = deferredDatabaseStartup;
      deferredDatabaseStartup = null;
      if (startup) await startup;
      const index = runtimeRecords.length;
      return {
        origin: `http://127.0.0.1:${35000 + index}`,
        display: `PostgreSQL · flux_test · localhost`,
        stop: async () => { record.stops += 1; },
      };
    };
    const nativeRequire = require('node:module').createRequire(path.join(root, 'src/main.cjs'));
    const testModule = { exports: {} };
    const testRequire = name => {
      if (name === 'node:os') return { homedir: () => temp };
      if (name === './signing.cjs') return ownerSigning;
      if (name === './network.cjs') return fakeNetwork;
      if (name === './database-runtime.cjs') return { startDatabaseRuntime: fakeStartDatabaseRuntime };
      if (name === 'electron') return {
        app: { whenReady: () => ({ then() {} }), on() {} },
        BrowserWindow: class {}, ipcMain: { handle() {} }, clipboard: { writeText() {} },
        shell: { openPath: async () => '' },
        dialog: {
          showSaveDialog: async () => ({ filePath: selectedSaveFile, canceled: false }),
          showOpenDialog: async (_win, options = {}) => ({
            filePaths: [options.properties?.includes('openDirectory') ? selectedDirectory : selectedOpenFile], canceled: options.properties?.includes('openDirectory') && cancelDirectoryDialog,
          }),
          showMessageBox: async () => ({ response: confirmationResponse }),
        },
      };
      return nativeRequire(name);
    };
    new Function('require', 'module', '__dirname', `${await fs.readFile(path.join(root, 'src/main.cjs'), 'utf8')}\nmodule.exports = actions;`)(testRequire, testModule, path.join(root, 'src'));
    const ownerActions = testModule.exports;
    // Реальный preload оставляет в мосту только allowlist и передаёт разрешённые действия в IPC.
    let exposedOwnerApi;
    const invokedActions = [];
    const preloadElectron = {
      contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'owner'); exposedOwnerApi = api; } },
      ipcRenderer: {
        invoke: async (_channel, action, args) => { invokedActions.push({ action, args }); return { ok: true, value: action }; },
        on() {}, removeListener() {},
      },
    };
    new Function('require', await fs.readFile(path.join(root, 'src/preload.cjs'), 'utf8'))(name => {
      if (name === 'electron') return preloadElectron;
      return nativeRequire(name);
    });
    for (const action of ['openBackup', 'chooseSetupFolder', 'setup', 'verifySetup', 'showSetupFolder']) {
      assert.deepEqual(await exposedOwnerApi.call(action, { test: true }), { ok: true, value: action });
    }
    assert.deepEqual(invokedActions.map(entry => entry.action), ['openBackup', 'chooseSetupFolder', 'setup', 'verifySetup', 'showSetupFolder']);
    assert.deepEqual(invokedActions[0].args, { test: true });
    assert.deepEqual(await exposedOwnerApi.call('unlistedAction'), { ok: false, error: 'Недоступное действие.' });
    assert.equal(invokedActions.length, 5);

    // Создание, блокировка и запасной вход проходят через реальные действия программы.
    const nativeBackup = path.join(temp, '.flux-owner', 'vault.flux-owner');
    await ownerActions.create({ password: 'temporary-main-password', backupPassword });
    const mainBytes = await fs.readFile(nativeBackup, 'utf8');
    const createdBackup = await vaultApi.readVault(sessionBackup, backupPassword);
    assert.equal(createdBackup.kind, 'backup');
    await ownerActions.lock();
    await assert.rejects(ownerActions.openBackup({ password: 'temporary-main-password' }), /пароль запасного ключа/);
    const opened = await ownerActions.openBackup({ password: backupPassword });
    assert.equal(opened.backupSession, true);
    assert.equal(opened.kind, 'backup');
    assert.equal(opened.publicKeys.owner, createdBackup.keys.owner.publicHex);
    assert.equal(await fs.readFile(nativeBackup, 'utf8'), mainBytes);
    await assert.rejects(ownerActions.changePassword({ password: 'replacement-main-password' }), /Основное хранилище не изменяется/);
    await assert.rejects(ownerActions.import({ importPassword: backupPassword, password: 'replacement-main-password' }), /Запасной ключ не заменяет/);
    assert.equal(await fs.readFile(nativeBackup, 'utf8'), mainBytes);
    await ownerActions.lock();
    const reopened = await ownerActions.unlock({ password: 'temporary-main-password' });
    assert.equal(reopened.kind, 'main');
    assert.equal(reopened.backupSession, false);

    // Настройка полного комплекта: отмена выбора/подтверждения не меняет рабочий файл.
    const localVaultPath = path.join(temp, '.flux-owner', 'vault.flux-owner');
    const beforeSetup = await fs.readFile(localVaultPath);
    const beforeState = await ownerActions.state();
    selectedDirectory = path.join(temp, 'setup-backups');
    await fs.mkdir(selectedDirectory, { recursive: true });
    cancelDirectoryDialog = true;
    const canceledFolder = await ownerActions.chooseSetupFolder();
    assert.equal(canceledFolder.canceled, true);
    await assert.rejects(ownerActions.setup({ password: 'temporary-setup-password', confirmPassword: 'temporary-setup-password', replaceExisting: true }), /Сначала выберите папку/);
    assert.deepEqual(await fs.readFile(localVaultPath), beforeSetup);
    cancelDirectoryDialog = false;
    // Первая попытка не подтверждает замену существующих ключей.
    confirmationResponse = 0;
    await ownerActions.chooseSetupFolder();
    const canceledSetup = await ownerActions.setup({ password: 'temporary-setup-password', confirmPassword: 'temporary-setup-password', replaceExisting: true });
    assert.equal(canceledSetup.canceled, true);
    assert.deepEqual(await fs.readFile(localVaultPath), beforeSetup);
    assert.equal((await ownerActions.state()).setupKitPath, '');
    assert.deepEqual((await fs.readdir(selectedDirectory)), []);
    assert.deepEqual((await ownerActions.state()).publicKeys, beforeState.publicKeys);

    // Несовпадающее подтверждение пароля завершается до любых записей.
    confirmationResponse = 1;
    await assert.rejects(ownerActions.setup({ password: 'temporary-setup-password', confirmPassword: 'different-setup-password', replaceExisting: true }), /Пароли не совпадают/);
    assert.deepEqual(await fs.readFile(localVaultPath), beforeSetup);
    assert.deepEqual(await fs.readdir(selectedDirectory), []);

    selectedDirectory = path.join(temp, 'setup-backups');
    await ownerActions.chooseSetupFolder();
    const setupState = await ownerActions.setup({ password: 'temporary-setup-password', confirmPassword: 'temporary-setup-password', replaceExisting: true });
    assert.equal(setupState.kind, 'main');
    assert.equal(setupState.setupVerified, false);
    assert.ok(setupState.setupKitPath);
    const fullKitFile = path.join(setupState.setupKitPath, 'Flux-Owner-Полная-копия.flux-owner');
    const emergencyKitFile = path.join(setupState.setupKitPath, 'Flux-Owner-Аварийный-вход.flux-owner');
    const fullKit = await vaultApi.readVault(fullKitFile, 'temporary-setup-password');
    const emergencyKit = await vaultApi.readVault(emergencyKitFile, 'temporary-setup-password');
    assert.equal(fullKit.kind, 'main');
    assert.equal(emergencyKit.kind, 'backup');
    const originalFullKitBytes = await fs.readFile(fullKitFile);
    await assert.rejects(vaultApi.readVault(fullKitFile, 'wrong-temporary-setup-password'));
    await assert.rejects(vaultApi.readVault(emergencyKitFile, 'wrong-temporary-setup-password'));
    const archivedSetupVault = await fs.readFile(setupState.previousVaultPath);
    assert.deepEqual(archivedSetupVault, beforeSetup);
    await assert.rejects(ownerActions.verifySetup({ password: 'wrong-temporary-setup-password' }));
    assert.equal((await ownerActions.state()).setupVerified, false);
    assert.equal((await ownerActions.verifySetup({ password: 'temporary-setup-password' })).setupVerified, true);
    await fs.writeFile(fullKitFile, 'damaged setup copy');
    await assert.rejects(ownerActions.verifySetup({ password: 'temporary-setup-password' }));
    assert.equal((await ownerActions.state()).setupVerified, false);
    await fs.writeFile(fullKitFile, originalFullKitBytes);
    assert.equal((await ownerActions.verifySetup({ password: 'temporary-setup-password' })).setupVerified, true);

    // State exposed to the UI contains public material and status only.
    const stateJson = JSON.stringify(await ownerActions.state());
    assert.doesNotMatch(stateJson, /privatePem|privateKey|password|secret/i);
    assert.doesNotMatch(stateJson, /BEGIN (?:ENCRYPTED )?PRIVATE KEY/);
    assert.equal(Object.hasOwn(await ownerActions.state(), 'password'), false);

    // Аварийный ключ остаётся read-only, даже когда открыт как временная сессия.
    selectedOpenFile = emergencyKitFile;
    const setupLocalBytes = await fs.readFile(localVaultPath);
    await ownerActions.lock();
    const backupOnly = await ownerActions.openBackup({ password: 'temporary-setup-password' });
    assert.equal(backupOnly.kind, 'backup');
    assert.equal(backupOnly.backupSession, true);
    await assert.rejects(ownerActions.changePassword({ password: 'temporary-backup-replacement' }), /Основное хранилище не изменяется/);
    assert.deepEqual(await fs.readFile(localVaultPath), setupLocalBytes);

    // Восстановление полной копии сохраняет полный набор ключей и архивирует прежний файл побайтно.
    selectedOpenFile = fullKitFile;
    confirmationResponse = 1;
    const archiveDir = path.join(temp, '.flux-owner', 'previous');
    const archivesBeforeRestore = await fs.readdir(archiveDir);
    const restored = await ownerActions.import({ importPassword: 'temporary-setup-password', password: 'temporary-restored-password' });
    assert.equal(restored.kind, 'main');
    assert.equal(restored.backupSession, false);
    assert.deepEqual(restored.publicKeys, Object.fromEntries(Object.entries(fullKit.keys).map(([name, key]) => [name, key.publicHex])));
    const archivesAfterRestore = await fs.readdir(archiveDir);
    const newlyArchived = archivesAfterRestore.filter(name => !archivesBeforeRestore.includes(name));
    assert.equal(newlyArchived.length, 1);
    assert.deepEqual(await fs.readFile(path.join(archiveDir, newlyArchived[0])), setupLocalBytes);
    assert.deepEqual((await vaultApi.readVault(localVaultPath, 'temporary-restored-password')).keys, fullKit.keys);

    // Controller lifecycle uses only a fake database runtime and mocked HTTP requests.
    expectedConnectOwnerHex = fullKit.keys.owner.publicHex;
    const databaseUri = 'mysql://test_owner:temporary-db-secret@db.invalid:3306/flux_test';
    const databaseConnected = await ownerActions.connect({ server: databaseUri });
    assert.equal(databaseConnected.connected, true);
    assert.equal(databaseConnected.connectionKind, 'database');
    assert.equal(databaseConnected.server, 'PostgreSQL · flux_test · localhost');
    assert.doesNotMatch(JSON.stringify(databaseConnected), /temporary-db-secret|mysql:\/\//i);
    assert.equal(runtimeRecords.length, 1);
    assert.equal(runtimeRecords[0].uri, databaseUri);
    assert.equal(runtimeRecords[0].stops, 0);
    const disconnectedDatabase = await ownerActions.disconnect();
    assert.equal(disconnectedDatabase.connected, false);
    assert.equal(disconnectedDatabase.server, '');
    assert.equal(disconnectedDatabase.connectionKind, 'server');
    assert.equal(runtimeRecords[0].stops, 1);

    const lockedDatabase = await ownerActions.connect({ server: databaseUri });
    assert.equal(lockedDatabase.connected, true);
    await ownerActions.lock();
    assert.equal(runtimeRecords[1].stops, 1);
    const lockedState = await ownerActions.state();
    assert.equal(lockedState.connected, false);
    assert.equal(lockedState.server, '');
    assert.equal(lockedState.unlocked, false);
    await ownerActions.unlock({ password: 'temporary-restored-password' });

    nextChallengeError = 'temporary challenge failure';
    await assert.rejects(ownerActions.connect({ server: databaseUri }), /temporary challenge failure/);
    assert.equal(runtimeRecords[2].stops, 1);
    const failedChallengeState = await ownerActions.state();
    assert.equal(failedChallengeState.connected, false);
    assert.equal(failedChallengeState.server, '');
    assert.equal(failedChallengeState.connectionKind, 'server');

    let finishDatabaseStartup;
    const startupObserved = new Promise(resolve => { runtimeStartWaiter = resolve; });
    deferredDatabaseStartup = new Promise(resolve => { finishDatabaseStartup = resolve; });
    const canceledConnection = ownerActions.connect({ server: databaseUri });
    await startupObserved;
    assert.deepEqual(await ownerActions.cancel(), { canceled: true });
    finishDatabaseStartup();
    await assert.rejects(canceledConnection, /abort|cancel/i);
    assert.equal(runtimeRecords[3].stops, 1);
    const canceledConnectionState = await ownerActions.state();
    assert.equal(canceledConnectionState.connected, false);
    assert.equal(canceledConnectionState.server, '');
    assert.equal(canceledConnectionState.connectionKind, 'server');

    const beforeUnexpectedExit = await ownerActions.connect({ server: databaseUri });
    assert.equal(beforeUnexpectedExit.connected, true);
    assert.equal(runtimeRecords[4].stops, 0);
    assert.equal(typeof runtimeRecords[4].onUnexpectedExit, 'function');
    runtimeRecords[4].onUnexpectedExit();
    const unexpectedExitState = await ownerActions.state();
    assert.equal(unexpectedExitState.connected, false);
    assert.equal(unexpectedExitState.server, '');
    assert.equal(unexpectedExitState.connectionKind, 'server');
    assert.equal(unexpectedExitState.unlocked, true);
    assert.equal(runtimeRecords[4].stops, 1);
    assert.doesNotMatch(JSON.stringify(unexpectedExitState), /temporary-db-secret|mysql:\/\//i);

    const recoveredDatabase = await ownerActions.connect({ server: databaseUri });
    assert.equal(recoveredDatabase.connected, true);
    assert.equal(recoveredDatabase.connectionKind, 'database');
    assert.equal(recoveredDatabase.unlocked, true);
    assert.doesNotMatch(JSON.stringify(recoveredDatabase), /temporary-db-secret|mysql:\/\//i);
    assert.equal(runtimeRecords.length, 6);
    await ownerActions.disconnect();
    assert.equal(runtimeRecords[5].stops, 1);

    const startsBeforeLegacy = runtimeRecords.length;
    const legacyConnection = await ownerActions.connect({ server: 'https://legacy.company.test' });
    assert.equal(legacyConnection.connected, true);
    assert.equal(legacyConnection.connectionKind, 'server');
    assert.equal(legacyConnection.server, 'https://legacy.company.test');
    assert.equal(runtimeRecords.length, startsBeforeLegacy);
    assert.equal((await ownerActions.disconnect()).connected, false);

    // Ни зашифрованный, ни публичный экспорт не могут перезаписать активное хранилище.
    const restoredBytes = await fs.readFile(localVaultPath);
    selectedSaveFile = localVaultPath;
    await assert.rejects(ownerActions.export({ password: 'temporary-export-password' }), /Нельзя перезаписать рабочее хранилище экспортом/);
    await assert.rejects(ownerActions.publicExport(), /Нельзя перезаписать рабочее хранилище экспортом/);
    assert.deepEqual(await fs.readFile(localVaultPath), restoredBytes);

    // Ошибка установки локальной копии не повреждает parent-файл и сохраняет уже готовый комплект.
    const setupApi = require(path.join(root, 'src/setup.cjs'));
    const failedParent = path.join(temp, 'not-a-directory');
    const preservedParentBytes = crypto.randomBytes(73);
    await fs.writeFile(failedParent, preservedParentBytes);
    const failedSetupFolder = path.join(temp, 'failed-local-install-backups');
    await fs.mkdir(failedSetupFolder);
    let localInstallError;
    try {
      await setupApi.createSetup({
        folder: failedSetupFolder,
        localFile: path.join(failedParent, 'vault.flux-owner'),
        password: 'temporary-failed-install-password',
      });
    } catch (error) { localInstallError = error; }
    // mkdir под обычным файлом: Windows возвращает EEXIST, Linux — ENOTDIR.
    assert.ok(['ENOTDIR', 'EEXIST'].includes(localInstallError?.code));
    assert.deepEqual(await fs.readFile(failedParent), preservedParentBytes);
    const retainedKits = await fs.readdir(failedSetupFolder);
    assert.equal(retainedKits.length, 1);
    const retainedKitPath = path.join(failedSetupFolder, retainedKits[0]);
    assert.equal((await vaultApi.readVault(path.join(retainedKitPath, 'Flux-Owner-Полная-копия.flux-owner'), 'temporary-failed-install-password')).kind, 'main');
    assert.equal((await vaultApi.readVault(path.join(retainedKitPath, 'Flux-Owner-Аварийный-вход.flux-owner'), 'temporary-failed-install-password')).kind, 'backup');

    const fluxSources = path.join(temp, 'flux-source-fixture');
    await fs.mkdir(path.join(fluxSources, 'license'), { recursive: true });
    await fs.mkdir(path.join(fluxSources, 'electron'), { recursive: true });
    await fs.writeFile(path.join(fluxSources, 'license/ownerKey.ts'), [
      "export const OWNER_PUBLIC_KEY_HEX = '';",
      "export const OWNER_BACKUP_PUBLIC_KEY_HEX = '';",
      "export const LICENSE_SIGNING_PUBLIC_KEY_HEX = '';",
    ].join('\n'));
    await fs.writeFile(path.join(fluxSources, 'electron/updateKey.ts'), "export const UPDATE_PUBLIC_KEY_HEX = '';\n");
    const applied = await applyPublicConfig(fluxSources, config);
    assert.equal(applied.files.length, 2);
    const ownerKeys = await fs.readFile(path.join(fluxSources, 'license/ownerKey.ts'), 'utf8');
    const updateKey = await fs.readFile(path.join(fluxSources, 'electron/updateKey.ts'), 'utf8');
    for (const key of [config.owner, config.ownerBackup, config.license]) assert.ok(ownerKeys.includes(key));
    assert.ok(updateKey.includes(config.update));
    assert.ok(!ownerKeys.includes('PRIVATE KEY'));
    assert.ok(!updateKey.includes('PRIVATE KEY'));
    await assert.rejects(applyPublicConfig(fluxSources, { ...config, owner: '0'.repeat(64) }), /другой OWNER_PUBLIC_KEY_HEX/);

    const request = ownerCore.makeRequest({
      inst: 'owner-test-installation', org: 'Test company', at: Date.now(),
      people: [{ login: 'OwnerTestUser', name: 'Test User' }],
    });
    assert.equal(ownerSigning.safeRequest(request).people[0].login, 'OwnerTestUser');
    const issued = ownerSigning.issueLicense(mainVault, {
      code: request, logins: ['ownertestuser'], org: 'Test company', expiresAt: Date.now() + 86400000,
    });
    assert.ok(issued.code.startsWith('FLUX2.'));
    assert.equal(serviceCore.readLicense(issued.code, config.license).logins[0], 'ownertestuser');
    assert.throws(() => ownerSigning.issueLicense(mainVault, {
      code: request, logins: ['unknown-user'], org: '', expiresAt: Date.now() + 86400000,
    }), /отсутствующий в запросе/);

    const revoked = ownerSigning.revokeLicenses(mainVault, { inst: issued.payload.inst, ids: [issued.payload.id] });
    const serviceRevoked = serviceRevocation.readRevocations(revoked.code, config.license);
    assert.deepEqual(serviceRevoked.ids, [issued.payload.id]);
    const revokedAgain = ownerSigning.revokeLicenses(mainVault, { inst: issued.payload.inst, ids: [issued.payload.id] });
    const serviceRevokedAgain = serviceRevocation.readRevocations(revokedAgain.code, config.license);
    assert.ok(serviceRevocation.acceptsRevocations(serviceRevokedAgain, serviceRevoked, issued.payload.inst));
    assert.equal(serviceRevocation.readRevocations(`${revoked.code}x`, config.license), null);

    const release = { size: 123456, sha256: crypto.createHash('sha256').update('test executable bytes').digest('hex') };
    const signedRelease = ownerSigning.signUpdate(mainVault, release, '1.2.3');
    assert.deepEqual(ownerUpdate.readUpdateSignature(signedRelease.signature, config.update), signedRelease.payload);
    assert.deepEqual(serviceUpdate.readUpdateSignature(signedRelease.signature, config.update), signedRelease.payload);
    assert.equal(serviceUpdate.readUpdateSignature(signedRelease.signature, config.license), null);

    console.log('Flux-Owner: vault, public config, FLUX2 license, FLUXREV1 revocation, and update-signature checks passed.');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
