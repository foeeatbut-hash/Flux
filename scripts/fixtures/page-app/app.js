// Страница-проверка: каждая попытка выйти за границы кадра записывается в отчёт, а отчёт читает окно-хост через flux.state.
const report = {};
const attempt = async (name, run) => {
  try { report[name] = { ok: true, value: await run() }; }
  catch (e) { report[name] = { ok: false, error: String((e && (e.code || e.name)) || e) }; }
};
flux.ready.then(async () => {
  const target = new URLSearchParams(location.search).get('leak');
  report.theme = flux.theme.mode;
  await attempt('fetch', () => fetch(target + '/fetch').then(r => r.status));
  await attempt('xhr', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', target + '/xhr'); x.onload = () => res(x.status); x.onerror = () => rej(new Error('blocked')); x.send(); }));
  await attempt('websocket', () => new Promise((res, rej) => { const w = new WebSocket(target.replace('http', 'ws') + '/ws'); w.onopen = () => res('open'); w.onerror = () => rej(new Error('blocked')); }));
  await attempt('image', () => new Promise((res, rej) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => rej(new Error('blocked')); i.src = target + '/img.png'; }));
  await attempt('script', () => new Promise((res, rej) => { const s = document.createElement('script'); s.src = target + '/s.js'; s.onload = () => res('loaded'); s.onerror = () => rej(new Error('blocked')); document.head.append(s); }));
  await attempt('parentDocument', () => parent.document.title);
  await attempt('topLocation', () => { top.location.href = target + '/nav'; return 'navigated'; });
  await attempt('localStorage', () => localStorage.getItem('x'));
  await attempt('indexedDB', () => new Promise((res, rej) => { const r = indexedDB.open('x'); r.onsuccess = () => res('opened'); r.onerror = () => rej(new Error('blocked')); }));
  await attempt('cookie', () => document.cookie);
  await attempt('eval', () => eval('1+1'));
  await attempt('newFunction', () => new Function('return 1')());
  await attempt('windowOpen', () => { const w = window.open(target + '/popup'); if (!w) throw new Error('blocked'); return 'opened'; });
  await attempt('styleAttribute', () => { const d = document.createElement('div'); d.setAttribute('style', 'width:77px'); document.body.append(d); return getComputedStyle(d).width; });
  await attempt('inlineScriptRan', () => { const t = document.getElementById('inline-mark').textContent; if (t !== 'до') throw new Error('ran'); return t; });
  await attempt('canvas', () => { const c = document.getElementById('c'); const g = c.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 10, 10); return c.toDataURL().slice(0, 22); });
  await attempt('dataImage', () => new Promise((res, rej) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => rej(new Error('blocked')); i.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'); }));
  await attempt('blobImage', () => new Promise((res, rej) => { const u = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'], { type: 'image/svg+xml' })); const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => rej(new Error('blocked')); i.src = u; }));
  // Мост: разрешённое
  await attempt('readProject', () => flux.read('project').then(p => p && p.name));
  await attempt('stateRoundtrip', async () => { await flux.state.set({ n: 1 }); return (await flux.state.get()).n; });
  // Мост: запрещённое — каждый вид со своим понятным кодом
  await attempt('readUndeclared', () => flux.read('catalog'));
  await attempt('computeTs', () => flux.compute({}));
  await attempt('connectUndeclared', () => flux.connect.call('nope', { op: 'com-open' }));
  await attempt('netUndeclared', () => flux.net.fetch('nope', '/x'));
  await attempt('windowUndeclaredPage', () => flux.windows.open('secret.html'));
  await attempt('windowDeclaredPage', () => flux.windows.open('second.html', { a: 1 }));
  await attempt('badFileName', () => flux.saveFile('../x.txt', 'a'));
  await attempt('saveFile', () => flux.saveFile('result.csv', 'a;b\n1;2', 'text/csv'));
  await attempt('bigState', () => flux.state.set({ big: 'x'.repeat(300 * 1024) }));
  // Запись в данные Flux: сообщение в обход клиента
  await attempt('rawWrite', () => new Promise((res, rej) => {
    const id = 'w-1', session = location.hash.slice(1);
    addEventListener('message', e => { if (e.data && e.data.id === id) (e.data.type === 'error' ? rej(Object.assign(new Error(e.data.code), { code: e.data.code })) : res(e.data.type)); });
    parent.postMessage({ flux: 'module', v: 1, session, id, type: 'write', resource: 'project', data: {} }, '*');
  }));
  document.getElementById('go').addEventListener('click', async () => {
    const out = await flux.state.get();
    await flux.state.set({ ...out, clicked: (out.clicked || 0) + 1 });
  });
  await flux.state.set({ report });
});
