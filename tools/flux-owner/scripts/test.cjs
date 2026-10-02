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
    const nativeRequire = require('node:module').createRequire(path.join(root, 'src/main.cjs'));
    const testModule = { exports: {} };
    const testRequire = name => {
      if (name === 'node:os') return { homedir: () => temp };
      if (name === './signing.cjs') return ownerSigning;
      if (name === 'electron') return { app: { whenReady: () => ({ then() {} }), on() {} }, dialog: { showSaveDialog: async () => ({ filePath: sessionBackup, canceled: false }), showOpenDialog: async () => ({ filePaths: [sessionBackup], canceled: false }) } };
      return nativeRequire(name);
    };
    new Function('require', 'module', '__dirname', `${await fs.readFile(path.join(root, 'src/main.cjs'), 'utf8')}\nmodule.exports = actions;`)(testRequire, testModule, path.join(root, 'src'));
    const ownerActions = testModule.exports;
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
