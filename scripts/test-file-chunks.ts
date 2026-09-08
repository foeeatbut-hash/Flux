/**
 * Файл любого размера доезжает до базы и возвращается байт в байт.
 *
 * Разбором кода этого не поймать. Содержимое едет кусками, и ошибка на границе
 * куска даёт файл, который «загрузился»: значок есть, размер похож, а книга не
 * открывается. Заметит это не программа, а человек — через неделю, когда
 * полезет за сметой.
 *
 * Проверяется именно то, что ломается: порядок кусков, границы, повторная
 * отправка после обрыва, файлы прежних версий (у них содержимое лежит строкой)
 * и подсчёт размера сервером, а не окном.
 *
 * Запуск (нужен поднятый сервер):
 *   npx tsx server.ts > /tmp/srv.log 2>&1 &
 *   npx tsx scripts/test-file-chunks.ts
 */
import { createHash } from 'crypto';

const BASE = process.env.FLUX_API || 'http://localhost:3000';
const ADMIN = { symbol: process.env.FLUX_USER || 'RaupovKhKh', password: process.env.FLUX_PASS || '1122' };

let failed = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { console.log('  ✓', name); return; }
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got).slice(0, 200)}`}`);
};

let token = '';
const api = async (method: string, url: string, body?: any) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null as any, text }; }
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Байты с разбросом, а не нули: нулями любая склейка выглядит правильной */
function noise(size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = 123456789;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

(async () => {
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error('health ' + h.status);
  } catch (e: any) {
    console.error(`Сервер на ${BASE} не отвечает (${e?.message || e}).`);
    process.exit(2);
  }

  const login = await api('POST', '/api/login', ADMIN);
  token = login.json?.token || '';
  if (!token) { console.error('Не удалось войти администратором.'); process.exit(2); }

  const stamp = Date.now().toString(36).slice(-6);
  const project = await api('POST', '/api/projects', { name: `Куски ${stamp}` });
  const projectId = project.json?.project?.id || project.json?.id;
  const folder = await api('POST', '/api/folders', { name: `Папка ${stamp}`, projectId });
  const folderId = folder.json?.folder?.id;
  ok('папка для пробы заведена', !!folderId, folder.json);

  console.log('1. Размер куска приходит от сервера');
  const limits = await api('GET', '/api/limits');
  const piece = Number(limits.json?.chunkBytes || 0);
  ok('кусок назван числом', piece > 0, limits.json);
  // Предела на файл больше нет — есть порог, с которого спрашивают
  ok('предела на файл нет, есть порог вопроса', Number(limits.json?.warnBytes) > 0, limits.json);

  const send = async (name: string, bytes: Buffer) => {
    const made = await api('POST', '/api/files', {
      name, folderId, type: 'BIN', size: bytes.length,
    });
    const id = made.json?.file?.id;
    if (!id) return { id: '', why: JSON.stringify(made.json) };
    let idx = 0;
    for (let at = 0; at < bytes.length; at += piece) {
      const part = bytes.subarray(at, Math.min(bytes.length, at + piece));
      const r = await api('POST', `/api/files/${id}/chunk`, { idx, data: part.toString('base64') });
      if (r.status !== 200) return { id, why: `кусок ${idx}: ${JSON.stringify(r.json)}` };
      idx++;
    }
    const done = await api('POST', `/api/files/${id}/done`, {});
    return { id, why: done.status === 200 ? '' : JSON.stringify(done.json), done: done.json };
  };

  const readBack = async (id: string): Promise<Buffer> => {
    const res = await fetch(`${BASE}/api/files/${id}/raw`, { headers: { Authorization: `Bearer ${token}` } });
    return Buffer.from(await res.arrayBuffer());
  };

  console.log('2. Файл заметно больше куска возвращается байт в байт');
  {
    // Не кратный куску — самая частая ошибка на границе: последний кусок
    // короче остальных, и «забыли остаток» видно только на нём
    const bytes = noise(piece * 3 + 12345);
    const out = await send(`Большой ${stamp}.bin`, bytes);
    ok('отправлен без отказов', !out.why, out.why);
    ok('сервер посчитал размер сам', out.done?.size === bytes.length, [out.done?.size, bytes.length]);
    ok('и кусков ровно столько, сколько нужно',
      out.done?.chunks === Math.ceil(bytes.length / piece), [out.done?.chunks, Math.ceil(bytes.length / piece)]);

    const back = await readBack(out.id);
    ok('длина совпала', back.length === bytes.length, [back.length, bytes.length]);
    ok('и содержимое совпало до байта', sha(back) === sha(bytes), [sha(back).slice(0, 12), sha(bytes).slice(0, 12)]);

    const meta = await api('GET', `/api/files/${out.id}?meta=1`);
    ok('в записи стоит настоящий размер', meta.json?.file?.size === bytes.length, meta.json?.file?.size);
    // Строку содержимого после дописывания оставлять нельзя: файл лежал бы в
    // базе дважды, и вторая копия молча устаревала бы при каждой правке
    ok('старой строки содержимого не осталось', !meta.json?.file?.content, typeof meta.json?.file?.content);
  }

  console.log('3. Повторная отправка куска не удлиняет файл');
  {
    const bytes = noise(piece + 777);
    const made = await api('POST', '/api/files', { name: `Повтор ${stamp}.bin`, folderId, type: 'BIN' });
    const id = made.json?.file?.id;
    const first = bytes.subarray(0, piece);
    const second = bytes.subarray(piece);
    await api('POST', `/api/files/${id}/chunk`, { idx: 0, data: first.toString('base64') });
    // Обрыв связи и повтор того же куска: если он ляжет вторым, файл окажется
    // длиннее себя, и заметит это человек, открыв испорченную книгу
    await api('POST', `/api/files/${id}/chunk`, { idx: 0, data: first.toString('base64') });
    await api('POST', `/api/files/${id}/chunk`, { idx: 1, data: second.toString('base64') });
    const done = await api('POST', `/api/files/${id}/done`, {});
    ok('размер тот же, что у исходника', done.json?.size === bytes.length, [done.json?.size, bytes.length]);
    const back = await readBack(id);
    ok('и байты те же', sha(back) === sha(bytes));
  }

  console.log('4. Файл прежних версий продолжает открываться');
  {
    // Содержимое строкой — так клали файлы до этой версии. Переписывать их
    // ничем нельзя: они просто обязаны читаться тем же маршрутом
    const bytes = Buffer.from('Старый файл: содержимое строкой', 'utf-8');
    const made = await api('POST', '/api/files', {
      name: `Старый ${stamp}.txt`, folderId, type: 'TXT',
      content: `data:text/plain;base64,${bytes.toString('base64')}`,
    });
    const back = await readBack(made.json?.file?.id);
    ok('старый файл читается тем же путём', sha(back) === sha(bytes), back.toString('utf-8').slice(0, 40));
  }

  console.log('5. Пустой файл не притворяется целым');
  {
    const made = await api('POST', '/api/files', { name: `Пустой ${stamp}.bin`, folderId, type: 'BIN' });
    const back = await readBack(made.json?.file?.id);
    ok('содержимого нет — и байтов нет', back.length === 0, back.length);
  }

  await api('DELETE', `/api/projects/${projectId}`);
  console.log(failed === 0 ? '\nВсе проверки кусков пройдены' : `\nПровалено: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
