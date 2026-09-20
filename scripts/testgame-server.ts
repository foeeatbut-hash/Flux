/**
 * Проверочная игра — отдельный процесс, с которым платформа говорит по сети.
 *
 * Зачем он нужен именно процессом. ТЗ прямо запрещает считать сделанным то,
 * что проверено на моках, и это не придирка: заглушка внутри сервера отвечает
 * мгновенно и всегда «да». На ней «работает» всё, что на живом процессе не
 * работает никогда — тайм-аут выделения, повторная доставка результата,
 * подпись, которую никто не считал, порядок «сначала билет, потом игра».
 *
 * Что он умеет, и это весь его смысл:
 *
 *   POST /allocate  — платформа просит место под матч; отвечаем адресом;
 *   POST /join      — игровой клиент предъявляет билет; мы спрашиваем
 *                     платформу, кто это, и пускаем;
 *   POST /finish    — матч закончен: считаем результат и отправляем его
 *                     платформе ПОДПИСАННЫМ;
 *   POST /release   — платформа отпускает место.
 *
 * Игра сама не решает, кого пускать: она пересказывает билет платформе и
 * верит её ответу. Так игровому серверу не нужен список игроков, а платформе
 * не нужно доверять игроку.
 *
 * Секрет подписи и адрес платформы берутся из окружения. В коде их нет:
 * секрет в репозитории — это секрет у всех.
 *
 *   FLUX_TESTGAME_SECRET=… FLUX_TESTGAME_PORT=3210 \
 *   FLUX_PLATFORM_URL=http://localhost:3000 FLUX_PLATFORM_TOKEN=… \
 *   npx tsx scripts/testgame-server.ts
 */

import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.FLUX_TESTGAME_PORT || 3210);
const SECRET = String(process.env.FLUX_TESTGAME_SECRET || '');
const PLATFORM = String(process.env.FLUX_PLATFORM_URL || 'http://localhost:3000').replace(/\/+$/, '');
/** Токен сессии игрового сервера: он обращается к платформе как служба */
const TOKEN = String(process.env.FLUX_PLATFORM_TOKEN || '');

if (!SECRET) {
  console.error('Нет FLUX_TESTGAME_SECRET: без общего секрета результат нечем подписать.');
  process.exit(2);
}

/** Тот же порядок полей, что у платформы: подпись не должна зависеть от него. */
function stableJson(value: unknown): string {
  const walk = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  try { return JSON.stringify(walk(value) ?? null); } catch (_) { return '""'; }
}

const sign = (sessionId: string, payload: unknown): string =>
  createHmac('sha256', SECRET).update(`${sessionId}.${stableJson(payload)}`).digest('hex');

interface Match {
  sessionId: string;
  seats: Array<{ userId: string; team: number }>;
  joined: Set<string>;
  finished: boolean;
}

const matches = new Map<string, Match>();

const readBody = (req: any): Promise<any> => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c: any) => { raw += c; });
  req.on('end', () => {
    try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); }
  });
});

const send = (res: any, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
};

/** Спросить платформу, кто предъявил билет. Игра сама этого не знает. */
async function redeem(token: string): Promise<{ sessionId: string; userId: string; team: number } | null> {
  const res = await fetch(`${PLATFORM}/api/play/tickets/redeem`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  // Платформа отвечает единым конвертом `{ ok, result }` — он общий у всех её
  // маршрутов, и разбирать его надо так же, как это делает окно
  return data?.result?.seat || null;
}

/** Отправить платформе подписанный результат. Повтор — не беда: она стерпит. */
async function report(sessionId: string, payload: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${PLATFORM}/api/play/results`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ sessionId, payload, signature: sign(sessionId, payload) }),
  });
  return res.ok;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'только POST' });
  const path = String(req.url || '').split('?')[0];
  const body = await readBody(req);

  if (path === '/allocate') {
    const sessionId = String(body?.sessionId || '');
    if (!sessionId) return send(res, 400, { error: 'нет матча' });
    matches.set(sessionId, {
      sessionId,
      seats: Array.isArray(body?.seats) ? body.seats : [],
      joined: new Set(),
      finished: false,
    });
    return send(res, 200, { address: `127.0.0.1:${PORT}`, externalId: sessionId });
  }

  if (path === '/join') {
    const seat = await redeem(String(body?.token || ''));
    if (!seat) return send(res, 403, { error: 'билет недействителен' });
    const match = matches.get(seat.sessionId);
    if (!match) return send(res, 404, { error: 'матч не выделен' });
    match.joined.add(seat.userId);
    return send(res, 200, {
      ok: true,
      userId: seat.userId,
      team: seat.team,
      joined: match.joined.size,
      seats: match.seats.length,
      /** Все на месте — матч можно заканчивать; так это и делает проверка */
      full: match.joined.size >= match.seats.length,
    });
  }

  if (path === '/finish') {
    const sessionId = String(body?.sessionId || '');
    const match = matches.get(sessionId);
    if (!match) return send(res, 404, { error: 'матч не выделен' });
    if (match.finished) return send(res, 200, { ok: true, repeated: true });

    // Считать тут нечего — важно, что результат исходит от ИГРЫ и подписан
    const winnerTeam = Number(body?.winnerTeam) || (match.seats[0]?.team ?? 1);
    const payload = {
      winnerTeam,
      players: match.seats.map((s) => ({ userId: s.userId, team: s.team, joined: match.joined.has(s.userId) })),
      durationSec: Number(body?.durationSec) || 1,
    };
    const ok = await report(sessionId, payload);
    match.finished = ok;
    return send(res, ok ? 200 : 502, { ok, payload });
  }

  if (path === '/release') {
    matches.delete(String(body?.sessionId || ''));
    return send(res, 200, { ok: true });
  }

  if (path === '/health') return send(res, 200, { ok: true, matches: matches.size });

  return send(res, 404, { error: 'нет такого' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[TestGame] слушает 127.0.0.1:${PORT}, платформа ${PLATFORM}`);
});
