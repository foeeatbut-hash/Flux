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
// Имитируем узлы, которыми владеет React: удаление узла должно сразу ронять тест.
const aiButton = {
  nodeType: 1,
  className: 'ai-entry',
  attributes: { 'aria-label': 'Ask AI' },
  style: { values: new Map(), setProperty(name, value, priority) { this.values.set(name, { value, priority }) } },
  hidden: false,
  inert: false,
  disabled: false,
  parentNode: { name: 'react-owned-menu' },
  getAttribute(name) { return this.attributes[name] ?? null },
  setAttribute(name, value) { this.attributes[name] = value },
  closest(selector) { return this.matches(selector) ? this : null },
  matches(selector) { return selector.includes('.ai-entry') || selector === 'button,[role="menuitem"],input,textarea' },
  remove() { throw new Error('AI control must not be structurally removed from React-owned DOM') },
}
const normalButton = {
  nodeType: 1,
  className: 'save-entry',
  attributes: { 'aria-label': 'Save' },
  style: { values: new Map(), setProperty(name, value, priority) { this.values.set(name, { value, priority }) } },
  hidden: false,
  inert: false,
  disabled: false,
  parentNode: { name: 'react-owned-menu' },
  getAttribute(name) { return this.attributes[name] ?? null },
  setAttribute(name, value) { this.attributes[name] = value },
  closest(selector) { return this.matches(selector) ? this : null },
  matches(selector) { return selector === 'button,[role="menuitem"],input,textarea' },
  remove() { throw new Error('Normal control must remain in React-owned DOM') },
}
const controls = [aiButton, normalButton]
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
  addEventListener: (name, fn) => documentEvents.set(name, [...(documentEvents.get(name) || []), fn]),
  querySelectorAll: (selector) => selector === 'button,[role="menuitem"],input,textarea' ? controls : controls.filter((node) => node.matches(selector)),
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
assert.equal(aiButton.parentNode.name, 'react-owned-menu', 'AI control lost its React-owned parent');
assert.equal(aiButton.hidden, true, 'AI control remained visible');
assert.equal(aiButton.inert, true, 'AI control remained interactive');
assert.equal(aiButton.attributes['aria-hidden'], 'true', 'AI control remained in the accessibility tree');
assert.equal(aiButton.attributes.tabindex, '-1', 'AI control remained keyboard-focusable');
assert.equal(aiButton.disabled, true, 'AI button remained enabled');
assert.deepEqual(aiButton.style.values.get('display'), { value: 'none', priority: 'important' });
assert.equal(normalButton.hidden, false, 'normal control was hidden');
assert.equal(normalButton.inert, false, 'normal control was made inert');
assert.equal(normalButton.disabled, false, 'normal control was disabled');
assert.equal(normalButton.attributes.tabindex, undefined, 'normal control lost its tab order');
let aiClicks = 0;
let normalClicks = 0;
assert.equal(aiButton.closest('.ai-entry,.ai-dock,.copilot'), aiButton, 'fake AI button does not match the AI selector');
assert.ok(documentEvents.get('click')?.length, 'renderer click guard was not installed');
const dispatchClick = (target, onClick) => {
  let prevented = false;
  let stopped = false;
  const event = { target, preventDefault() { prevented = true }, stopImmediatePropagation() { stopped = true } };
  for (const listener of documentEvents.get('click')) listener(event);
  if (!stopped) onClick();
  return { prevented, stopped };
};
const blockedAiClick = dispatchClick(aiButton, () => { aiClicks += 1 });
assert.equal(blockedAiClick.prevented, true, 'AI click was not cancelled');
assert.equal(blockedAiClick.stopped, true, 'AI click reached application handlers');
assert.equal(aiClicks, 0, 'AI click action ran');
const allowedNormalClick = dispatchClick(normalButton, () => { normalClicks += 1 });
assert.equal(allowedNormalClick.prevented, false, 'normal click was cancelled');
assert.equal(allowedNormalClick.stopped, false, 'normal click propagation was stopped');
assert.equal(normalClicks, 1, 'normal control click did not reach its handler');
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
for (const listener of documentEvents.get('keydown')) listener(f7);
assert.equal(f7.prevented, true, 'F7 reached the GenOffice proofreader');
assert.equal(f7.stopped, true);
let menuAction = null;
api.on('menu:action', (_event, action) => { menuAction = action; });
const ctrlS = { key: 's', ctrlKey: true, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
windowEvents.get('keydown')(ctrlS);
assert.equal(menuAction, 'save', 'normal Ctrl+S was intercepted as an AI action');
assert.equal(ctrlS.prevented, true);
assert.equal(ctrlS.stopped, true);

console.log('GenOffice AI controls and IPC are blocked; React-owned DOM and normal controls remain intact.')
