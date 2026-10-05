import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import vm from 'node:vm'

const read = (path) => readFileSync(path, 'utf8')
const electronRenderer = read('tools/genoffice/shims/electron-renderer.js')
const docsBridge = read('tools/genoffice/flux-bridge.js')
const markdownBridge = read('tools/genoffice/md-bridge.js')
const patches = read('tools/genoffice/patches.mjs')

const aiLabel = /\b(?:ai|gsk|genspark|copilot|ask\s*ai)\b|(?:^|[^\p{L}\p{N}_])ИИ(?:$|[^\p{L}\p{N}_])|искусственн[\p{L}\p{N}_]*\s+интеллект/iu
for (const ordinaryRussianLabel of ['Функции', 'копии', 'орфографии']) {
  assert.equal(aiLabel.test(ordinaryRussianLabel), false, `${ordinaryRussianLabel} was mistaken for an AI control`)
}
assert.equal(aiLabel.test('Спросить ИИ'), true, 'standalone ИИ label was not recognized')

assert.match(electronRenderer, /const isAiChannel =/)
assert.match(electronRenderer, /if \(isAiChannel\(channel\)\) return Promise\.resolve\(aiDisabled\(\)\)/)
assert.match(electronRenderer, /if \(!isAiChannel\(channel\)\) post\(/)
assert.match(electronRenderer, /if \(isAiChannel\(channel\)\) return ipcRenderer/)
assert.match(electronRenderer, /window\.__fluxNoGenOfficeAI = true/)
assert.match(electronRenderer, /removeAiControls\(document\)/)
assert.match(electronRenderer, /if \(event\.key === 'F7'\) \{\s*event\.preventDefault\(\)/)

for (const bridge of [docsBridge, markdownBridge]) {
  assert.match(bridge, /window\.__fluxNoGenOfficeAI = true/)
  assert.match(bridge, /removeAiControls\(document\)/)
  assert.match(bridge, /if \(event\.key === 'F7'\) \{ event\.preventDefault\(\)/)
}

assert.match(patches, /id: 'flux-disable-docs-mcp-ai-bridge'/)
assert.match(patches, /id: 'flux-disable-sheets-mcp-ai-bridge'/)
assert.match(patches, /id: 'flux-disable-docs-ai-settings-read'/)
assert.match(patches, /id: 'flux-sheets-disabled-settings'/)
assert.match(patches, /__fluxNoGenOfficeAI\) void window\.desktopApi\.getAiSettings/)

// Generated assets are ignored build output. When present, verify the bundled
// shims and Docs feature guards match the source-level policy test.
const compiled = [
  'public/genoffice/sheets/flux-preload.js',
  'public/genoffice/pdf/flux-preload.js',
  'public/genoffice/flux-bridge.js',
  'public/genoffice/md-bridge.js',
].filter(existsSync);
const docsAssetDir = 'public/genoffice/docs/assets';
if (existsSync(docsAssetDir)) {
  compiled.push(...readdirSync(docsAssetDir).filter((name) => /^index-.*\.js$/.test(name)).map((name) => `${docsAssetDir}/${name}`));
}
if (compiled.length) {
  assert.equal(compiled.length, 5, 'GenOffice assets are only partially rebuilt');
  for (const path of compiled) {
    const output = read(path);
    assert.match(output, /__fluxNoGenOfficeAI|isAiChannel|AI IPC/, `AI gate missing from ${path}`);
  }
}

// Run the actual Electron renderer shim against a small isolated browser
// surface: AI provider IPC must never post, while save IPC and F7 behave as
// expected. The fake parent records messages but has no network capabilities.
const sent = []
const documentEvents = new Map()
const windowEvents = new Map()
const parent = { postMessage: (message) => sent.push(message) }
const window = {
  parent,
  location: { origin: 'null' },
  addEventListener: (name, fn) => windowEvents.set(name, fn),
  dispatchEvent() {},
};
const document = {
  documentElement: { appendChild() {} },
  head: null,
  createElement: () => ({ textContent: '' }),
  addEventListener: (name, fn) => documentEvents.set(name, fn),
  querySelectorAll: () => [],
};
const context = {
  window,
  document,
  localStorage: { setItem() {} },
  Node: { ELEMENT_NODE: 1 },
  MutationObserver: class { observe() {} },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
};
vm.runInNewContext(
  electronRenderer
    .replace(/^export const /gm, 'const ')
    .replace(/^export default .*;\s*$/gm, '') + '\n;globalThis.__api = ipcRenderer;',
  context,
  { filename: 'electron-renderer.js' },
);
const api = context.__api;
for (const channel of ['ai:chat', 'sheets:ai-generate-image', 'pdf:generate-image', 'ai:stream-chunk']) {
  const before = sent.length;
  let received = false;
  await api.invoke(channel, { prompt: 'ignored' });
  api.send(channel, { prompt: 'ignored' });
  api.on(channel, () => { received = true; });
  assert.equal(sent.length, before, `AI IPC escaped through ${channel}`);
  windowEvents.get('message')({
    source: parent,
    origin: 'null',
    data: { flux: 'office', event: 'ipc', payload: { channel, args: [] } },
  });
  assert.equal(received, false, `AI event reached renderer through ${channel}`);
}
const beforeSave = sent.length;
const save = api.invoke('workbook:save', { bytes: new ArrayBuffer(0) });
assert.equal(sent.length, beforeSave + 1, 'normal workbook save was blocked');
assert.equal(sent[beforeSave].op, 'ipc');
assert.equal(sent[beforeSave].payload.channel, 'workbook:save');
windowEvents.get('message')({
  source: parent,
  origin: 'null',
  data: { flux: 'office', reply: sent[beforeSave].id, result: { ok: true } },
});
assert.deepEqual(await save, { ok: true });
const f7 = { key: 'F7', preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
documentEvents.get('keydown')(f7);
assert.equal(f7.prevented, true, 'F7 reached the GenOffice proofreader');
assert.equal(f7.stopped, true);
let menuAction = null;
api.on('menu:action', (_event, action) => { menuAction = action; });
const ctrlS = { key: 's', ctrlKey: true, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
windowEvents.get('keydown')(ctrlS);
assert.equal(menuAction, 'save', 'normal Ctrl+S was intercepted as an AI action');
assert.equal(ctrlS.prevented, true);
assert.equal(ctrlS.stopped, true);

console.log('GenOffice AI IPC and shortcuts are blocked; normal workbook save remains available.')
