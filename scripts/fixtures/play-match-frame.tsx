import React from 'react';
import { createRoot } from 'react-dom/client';
import MatchFrame from '../../src/play/runtime/MatchFrame';

type Match = { sessionId: string; gameId: string; revision: number; turnUserId: string; yourTurn: boolean; view: unknown; done: boolean; winnerTeam: number; why: string; seats: string[] };
const state = (sessionId: string, done = false): Match => ({
  sessionId, gameId: 'unknown-test-game', revision: done ? 2 : 1, turnUserId: 'me', yourTurn: true,
  view: {}, done, winnerTeam: 0, why: done ? 'Завершена' : '', seats: ['me', 'other'],
});
const matches = new Map([['A', state('A')], ['B', state('B', true)]]);
let deferNext = false;
let failNext = false;
const held: Array<{ sessionId: string; release: () => void }> = [];
const calls: Array<{ method: string; sessionId: string }> = [];
const originalFetch = window.fetch.bind(window);
const nativeSetInterval = window.setInterval.bind(window);
const pollDelay = Number(new URLSearchParams(location.search).get('poll')) || 700;
window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) =>
  nativeSetInterval(handler, timeout === 700 ? pollDelay : timeout, ...args)) as typeof window.setInterval;
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const matchPath = url.pathname.match(/\/api\/play\/match\/([^/]+)(?:\/(move|resign))?$/);
  if (!matchPath) return originalFetch(input, init);
  const sessionId = decodeURIComponent(matchPath[1]);
  const method = init?.method || 'GET';
  calls.push({ method, sessionId });
  if (method !== 'GET') {
    matches.set(sessionId, state(sessionId, true));
    return Response.json({ ok: true, repeated: false, result: {} });
  }
  if (failNext) {
    failNext = false;
    return Response.json({ ok: false, message: 'Связь прервана' }, { status: 503 });
  }
  if (deferNext) {
    deferNext = false;
    return new Promise<Response>(resolve => held.push({ sessionId, release: () => resolve(Response.json({ ok: true, result: matches.get(sessionId) })) }));
  }
  return Response.json({ ok: true, result: matches.get(sessionId) });
};
(window as any).__playMatchTest = {
  calls,
  deferNextGet: () => { deferNext = true; },
  releaseGet: (sessionId: string) => {
    const index = held.findIndex(request => request.sessionId === sessionId);
    if (index >= 0) held.splice(index, 1)[0].release();
  },
  failNextGet: () => { failNext = true; },
};

function Fixture() {
  const [sessionId, setSessionId] = React.useState('A');
  return <>
    <button onClick={() => setSessionId('B')}>Переключить матч</button>
    <MatchFrame key={sessionId} sessionId={sessionId} meId="me" names={{ me: 'Я' }} onLeave={() => {}} />
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
