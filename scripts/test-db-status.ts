/**
 * Индикатор связи с базой: пороги и переходы.
 *
 * Ошибка здесь стоит дорого в обе стороны: ложное «нет связи» приучает не
 * верить индикатору, пропущенный обрыв — терять правки. Поэтому решение по
 * замерам — чистый модуль, и каждое правило проверяется здесь.
 */
import { stateOf, pollDelay, pushSample, lastGood, modeLabel, msLabel, HISTORY, POLL_BAD_MS, POLL_OK_MS, type DbSample } from '../src/lib/dbStatus';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { console.log(`✓ ${name}`); return; }
  failed++; console.log(`✗ ${name}${got !== undefined ? ` — получено ${JSON.stringify(got)}` : ''}`);
};
const ok = (rtt = 40, dbMs = 3): DbSample => ({ at: Date.now(), reached: true, dbOk: true, rtt, dbMs });
const lost = (): DbSample => ({ at: Date.now(), reached: false, dbOk: false, rtt: null, dbMs: null });
const dbDown = (): DbSample => ({ at: Date.now(), reached: true, dbOk: false, rtt: 30, dbMs: null });

check('без замеров — проверка', stateOf([]) === 'checking');
check('быстрый ответ — норма', stateOf([ok()]) === 'ok');
check('сервер ответил 503 — база не отвечает', stateOf([ok(), dbDown()]) === 'db-down');
check('первый же замер без ответа — нет связи', stateOf([lost()]) === 'offline');
check('один промах после нормы — ещё не обрыв', stateOf([ok(), lost()]) === 'ok', stateOf([ok(), lost()]));
check('два промаха подряд — нет связи', stateOf([ok(), lost(), lost()]) === 'offline');
check('связь вернулась — норма', stateOf([lost(), lost(), ok()]) === 'ok');
check('один выброс задержки — не «медленно»', stateOf([ok(), ok(), ok(900)]) === 'ok', stateOf([ok(), ok(), ok(900)]));
check('стабильно долгая дорога — медленно', stateOf([ok(600), ok(700), ok(650)]) === 'slow');
check('медленная база при быстрой сети — медленно', stateOf([ok(30, 400), ok(30, 350), ok(30, 500)]) === 'slow');
check('нет связи — опрос чаще', pollDelay('offline') === POLL_BAD_MS && pollDelay('db-down') === POLL_BAD_MS);
check('норма — опрос реже', pollDelay('ok') === POLL_OK_MS && pollDelay('slow') === POLL_OK_MS);
let list: DbSample[] = [];
for (let i = 0; i < HISTORY + 10; i++) list = pushSample(list, ok(i));
check('история ограничена', list.length === HISTORY && list[list.length - 1].rtt === HISTORY + 9);
check('последний хороший ответ находится сквозь обрыв', lastGood([ok(11), lost(), lost()])?.rtt === 11);
check('нет ни одного хорошего — null', lastGood([lost(), dbDown()]) === null);
check('подпись локальной базы', modeLabel('LOCAL', 'sqlite') === 'Локальная · SQLite');
check('подпись общей базы', modeLabel('MYSQL', 'mysql') === 'Общая база компании · MySQL');
check('миллисекунды', msLabel(3.24) === '3.2 мс' && msLabel(120.6) === '121 мс' && msLabel(null) === '—');

if (failed) { console.log(`${failed} проверок провалено`); process.exit(1); }
console.log('Индикатор связи: все проверки пройдены');
