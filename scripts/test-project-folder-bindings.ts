/**
 * Общие привязки папок к проекту: наследование по цепочке ключей, нормализация сетевого пути,
 * разбор вывода Windows (перевод буквы диска в UNC) и ключи мест на двух «компьютерах».
 *
 * Только Windows и проверить нельзя: сам вызов PowerShell/`net use` (electron/filesystem/network.ts).
 * Здесь он заменён образцами вывода, а остальная логика (разбор, нормализация, цепочки, хеши) — настоящая.
 */
import assert from 'node:assert/strict';
import { effectiveProjectIds, isLocationKey, nearestBinding, resolveBoundProject, validateBinding, type ProjectFolderBinding } from '../src/lib/projectFolderBindings.js';
import { LocationKeys, hashLocation, normalizeLocationPath, parseNetUse, parseProviderName, resolvePortableFolder, uncChain, type LocationKeyDeps } from '../electron/filesystem/locationKeys.js';

const key = (path: string) => hashLocation(normalizeLocationPath(path)!);
const base: ProjectFolderBinding = { id: 'b1', locationKey: key('\\\\srv\\share\\Engineering'), projectId: 'p1', label: 'Engineering', actorId: 'u1', at: '2026-10-14T10:00:00.000Z' };
const chainOf = (path: string) => uncChain(normalizeLocationPath(path)!).map(hashLocation);

/** Два компьютера: на одном ресурс подключён как Z:, на другом как P:, на третьем открыт по UNC; C: — локальный диск. */
function computer(roots: Record<string, string>, mapped: Record<string, string>): LocationKeys {
  const deps: LocationKeyDeps = { rootPath: id => { if (!roots[id]) throw new Error('нет корня'); return roots[id]; }, uncOfDrive: async drive => mapped[drive.toUpperCase()] || null };
  return new LocationKeys(deps);
}
async function chains(l: LocationKeys, rootId: string, ...paths: string[]) {
  const result = await l.resolve(paths.map(relativePath => ({ rootId, relativePath })));
  return result.chains.map(chain => chain && chain.map(index => result.keys[index]));
}

const checks: Array<[string, () => void | Promise<void>]> = [
  ['validates a shared binding record', () => validateBinding(base)],
  ['rejects malformed location keys and labels', () => {
    assert.throws(() => validateBinding({ ...base, locationKey: 'Z:\\Projects' }));
    assert.throws(() => validateBinding({ ...base, locationKey: base.locationKey.toUpperCase() }));
    assert.throws(() => validateBinding({ ...base, label: '' }));
    assert.throws(() => validateBinding({ ...base, label: 'a\nb' }));
    assert.throws(() => validateBinding({ ...base, at: 'вчера' }));
    assert.equal(isLocationKey(base.locationKey), true);
  }],
  ['resolves the closest bound folder in the chain', () => {
    const inner: ProjectFolderBinding = { ...base, id: 'b2', locationKey: key('\\\\srv\\share\\Engineering\\Unit 1'), projectId: 'p2', label: 'Unit 1' };
    const chain = chainOf('\\\\srv\\share\\Engineering\\Unit 1\\plan\\a.xlsx');
    assert.equal(resolveBoundProject([base, inner], chain), 'p2');
    assert.equal(nearestBinding([base, inner], chain)?.depth, 2);
    assert.equal(resolveBoundProject([base], chain), 'p1');
  }],
  ['matches whole path components, not string prefixes', () => assert.equal(resolveBoundProject([base], chainOf('\\\\srv\\share\\Engineering-old\\a.xlsx')), null)],
  ['does not cross shares or servers', () => {
    assert.equal(resolveBoundProject([base], chainOf('\\\\srv\\other\\Engineering\\a.xlsx')), null);
    assert.equal(resolveBoundProject([base], chainOf('\\\\srv2\\share\\Engineering\\a.xlsx')), null);
  }],
  ['binding the share root covers the whole share', () => assert.equal(resolveBoundProject([{ ...base, locationKey: key('\\\\srv\\share') }], chainOf('\\\\srv\\share\\x\\y')), 'p1')],
  ['no chain means no inheritance', () => { assert.equal(resolveBoundProject([base], null), null); assert.equal(resolveBoundProject([], chainOf('\\\\srv\\share\\a')), null); }],
  ['preserves manual project metadata', () => assert.deepEqual(effectiveProjectIds(['manual', 'manual'], 'inherited'), ['manual'])],
  ['inherits only when manual metadata is absent', () => assert.deepEqual(effectiveProjectIds([], 'inherited'), ['inherited'])],

  // ---- нормализация пути
  ['normalizes UNC paths: case, separators, trailing slashes, dots', () => {
    assert.equal(normalizeLocationPath('\\\\SRV\\Share\\Проекты\\А\\'), '//srv/share/проекты/а');
    assert.equal(normalizeLocationPath('//srv/share//a/./b///'), '//srv/share/a/b');
    assert.equal(normalizeLocationPath('\\\\srv\\share'), '//srv/share');
  }],
  ['strips Win32 namespace prefixes', () => {
    assert.equal(normalizeLocationPath('\\\\?\\UNC\\srv\\share\\a'), '//srv/share/a');
    assert.equal(normalizeLocationPath('\\\\?\\C:\\X'), 'c:/x');
  }],
  ['normalizes drive paths and composed Unicode', () => {
    assert.equal(normalizeLocationPath('Z:\\'), 'z:');
    assert.equal(normalizeLocationPath('Z:\\Projects\\'), 'z:/projects');
    assert.equal(normalizeLocationPath('\\\\srv\\share\\Cafe\u0301'), normalizeLocationPath('\\\\srv\\share\\Caf\u00e9'));
  }],
  ['rejects unusable input', () => {
    for (const bad of ['', 'relative\\path', '\\\\srv', 'C:\\A\\..\\B', '\\\\srv\\share\\..\\x', 'C:\\a\0b']) assert.equal(normalizeLocationPath(bad), null, JSON.stringify(bad));
  }],
  ['builds the chain from the folder up to the share root', () => {
    assert.deepEqual(uncChain('//srv/share/a/b'), ['//srv/share/a/b', '//srv/share/a', '//srv/share']);
    assert.deepEqual(uncChain('//srv/share'), ['//srv/share']);
    assert.deepEqual(uncChain('c:/a'), []);
  }],
  ['hash is a stable 64-hex key independent of spelling', () => {
    assert.ok(isLocationKey(key('\\\\SRV\\Share\\A')));
    assert.equal(key('\\\\SRV\\Share\\A\\'), key('//srv/share/a'));
    assert.notEqual(key('\\\\srv\\share\\a'), key('\\\\srv\\share\\b'));
  }],

  // ---- разбор вывода Windows (образцы)
  ['parses the WMI ProviderName line', () => {
    assert.equal(parseProviderName('\\\\srv\\share\r\n'), '\\\\srv\\share');
    assert.equal(parseProviderName('\r\n\\\\fs01\\Мой ресурс\r\n'), '\\\\fs01\\Мой ресурс');
    assert.equal(parseProviderName(''), null);
    assert.equal(parseProviderName('Z:\\'), null);
  }],
  ['parses `net use Z:` in English and Russian Windows', () => {
    const en = 'Local name        Z:\r\nRemote name       \\\\srv\\Project Files\r\nResource type     Disk\r\nStatus            OK\r\n';
    const ru = 'Локальное имя     Z:\r\nИмя удаленного ресурса \\\\srv\\Проекты\r\nТип ресурса      Диск\r\nСостояние        ОК\r\n';
    assert.equal(parseNetUse(en), '\\\\srv\\Project Files');
    assert.equal(parseNetUse(ru), '\\\\srv\\Проекты');
    assert.equal(parseNetUse('System error 2250 has occurred.\r\nThe network connection could not be found.'), null);
  }],

  // ---- ключи мест на разных компьютерах
  ['two computers with different drive letters get the same keys for the same network folder', async () => {
    const a = computer({ rA: 'Z:\\Projects' }, { 'Z:\\': '\\\\SRV\\Share' });
    const b = computer({ rB: 'P:\\Projects' }, { 'P:\\': '\\\\srv\\share' });
    const c = computer({ rC: '\\\\srv\\share\\projects\\' }, {});
    const [ca] = await chains(a, 'rA', 'Unit 1/plan.xlsx'); const [cb] = await chains(b, 'rB', 'unit 1/plan.xlsx'); const [cc] = await chains(c, 'rC', 'Unit 1/plan.xlsx');
    assert.ok(ca && ca.length === 4, JSON.stringify(ca));
    assert.deepEqual(ca, cb); assert.deepEqual(ca, cc);
    assert.deepEqual(ca, chainOf('\\\\srv\\share\\projects\\unit 1\\plan.xlsx'));
    assert.equal(resolveBoundProject([{ ...base, locationKey: key('\\\\srv\\share\\Projects\\Unit 1') }], cb), 'p1');
  }],
  ['portable folder locator resolves Z and P mappings at different root depths without scanning', async () => {
    const z = computer({ rZ: 'Z:\\Projects' }, { 'Z:\\': '\\\\srv\\share' });
    const p = computer({ rP: 'P:\\' }, { 'P:\\': '\\\\srv\\share' });
    const locator = await z.portable({ rootId: 'rZ', relativePath: 'Unit' });
    assert.ok(locator);
    assert.ok(!JSON.stringify(locator).includes('srv'));
    const tried: string[] = [];
    const resolved = await resolvePortableFolder(locator, [{ id: 'rP', available: true }], p, async ref => {
      tried.push(ref.relativePath);
      return { kind: 'directory' };
    });
    assert.deepEqual(tried, ['projects/unit']);
    assert.deepEqual(resolved, { rootId: 'rP', relativePath: 'projects/unit' });
  }],
  ['a drive mapped to a subfolder of a share keeps the share root at the end of the chain', async () => {
    const l = computer({ r: 'Q:\\' }, { 'Q:\\': '\\\\srv\\share\\Projects' });
    const [chain] = await chains(l, 'r', 'A');
    assert.deepEqual(chain, chainOf('\\\\srv\\share\\projects\\a'));
    assert.equal(chain![chain!.length - 1], key('\\\\srv\\share'));
  }],
  ['local folders, drafts and unknown roots have no shared key', async () => {
    const l = computer({ local: 'C:\\Work' }, {});
    const result = await l.resolve([{ rootId: 'local', relativePath: 'A' }, { rootId: 'local', relativePath: 'A', draftId: 'd1' }, { rootId: 'ghost', relativePath: 'A' }, { rootId: 'local', relativePath: '../escape' }]);
    assert.deepEqual(result.chains, [null, null, null, null]);
  }],
  ['the drive-to-UNC lookup runs once per root while cached', async () => {
    let calls = 0;
    const l = new LocationKeys({ rootPath: () => 'Z:\\Projects', uncOfDrive: async () => { calls++; return '\\\\srv\\share'; } });
    await l.resolve(Array.from({ length: 300 }, (_, i) => ({ rootId: 'r', relativePath: `Folder ${i}` })));
    await l.resolve([{ rootId: 'r', relativePath: 'More' }]);
    assert.equal(calls, 1);
  }],
  ['a failed drive lookup yields null instead of an error', async () => {
    const l = new LocationKeys({ rootPath: () => 'Z:\\Projects', uncOfDrive: async () => { throw new Error('powershell'); } });
    assert.deepEqual((await l.resolve([{ rootId: 'r', relativePath: 'A' }])).chains, [null]);
  }],
  ['shares parent keys between chains in the response table', async () => {
    const l = computer({ r: '\\\\srv\\share\\p' }, {});
    const result = await l.resolve([{ rootId: 'r', relativePath: 'a' }, { rootId: 'r', relativePath: 'b' }]);
    assert.equal(result.keys.length, 4); // //srv/share, //srv/share/p, …/a, …/b
    assert.ok(!JSON.stringify(result).includes('srv'), 'в ответе нет пути');
  }],
  ['rejects an empty or oversized request', async () => {
    const l = computer({}, {});
    await assert.rejects(() => l.resolve([]));
    await assert.rejects(() => l.resolve(Array.from({ length: 501 }, () => ({ rootId: 'r', relativePath: '' }))));
  }],
];

let failed = 0;
async function main() {
  for (const [name, check] of checks) {
    try { await check(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}`, error); }
  }
  console.log(`${checks.length - failed}/${checks.length} project folder binding checks passed`);
  if (failed) process.exitCode = 1;
}
void main();
