'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const serviceRoot = path.resolve(root, '../..');

function compile(entryPoint, outfile) {
  esbuild.buildSync({ entryPoints: [entryPoint], outfile, bundle: true, platform: 'node', format: 'cjs', legalComments: 'none' });
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
