/**
 * Экран лицензии: «не смогли спросить» — не то же, что «ключа нет».
 *
 * Сбой связи ложился в то же состояние, что и отрицательный ответ сервера:
 * `{ licensed: false, reason: 'none', error: '<сообщение сети>' }`. Показ брал
 * `error` из другого места и прятал `reason === 'none'` — человеку выводили
 * обычное «программа ещё не активирована». При упавшем сервере он шёл искать
 * ключ, который у него уже лежал в почте.
 *
 * Второе, что проверяется здесь: гейт не ослаблен. Наружу пропускает ровно
 * одно состояние; сбой связи пропуском не считается, иначе выдернутый провод
 * стал бы способом обойти лицензию.
 *
 * Запуск: npx tsx scripts/test-license-gate.ts
 */

import { gateState, passes, reasonText, REASON_TEXT } from '../src/lib/licenseGate';

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) =>
  cond
    ? console.log('  ✓', name)
    : (failed++, console.error('  ✗', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)));

console.log('1. Четыре состояния, и они не путаются');
{
  ok('ещё не спрашивали — ждём', gateState({ status: null, failure: '' }).kind === 'loading');
  ok('лицензия есть — пропускаем', gateState({ status: { licensed: true }, failure: '' }).kind === 'licensed');
  ok('ответили «нет» — просим ключ',
    gateState({ status: { licensed: false, reason: 'none' }, failure: '' }).kind === 'unlicensed');
  ok('спросить не вышло — это своё состояние',
    gateState({ status: null, failure: 'сервер не ответил' }).kind === 'offline');
}

console.log('\n2. Ради чего всё: сбой связи не выдаётся за отсутствие ключа');
{
  const s = gateState({ status: null, failure: 'Failed to fetch' });
  ok('это не «нет ключа»', s.kind !== 'unlicensed', s.kind);
  ok('сказано, что проверить не смогли', s.kind === 'offline' && s.text.includes('Не удалось проверить'), s);
  ok('причина названа', s.kind === 'offline' && s.detail === 'Failed to fetch', s);

  // Прежняя подмена: сервер упал, а состояние собрали руками с reason: 'none'
  const прежнее = gateState({ status: { licensed: false, reason: 'none' }, failure: 'сервер не ответил' });
  ok('сбой сильнее подделанного ответа', прежнее.kind === 'offline', прежнее.kind);
}

console.log('\n3. Гейт не ослаблен');
{
  ok('пропускает только лицензию', passes(gateState({ status: { licensed: true }, failure: '' })));
  ok('сбой связи НЕ пропускает', !passes(gateState({ status: null, failure: 'нет сети' })));
  ok('ожидание НЕ пропускает', !passes(gateState({ status: null, failure: '' })));
  ok('отказ НЕ пропускает', !passes(gateState({ status: { licensed: false, reason: 'expired' }, failure: '' })));
  // Даже если сервер ответил «нет» и связь заодно отвалилась
  ok('ничто, кроме лицензии, не проходит',
    !passes(gateState({ status: { licensed: false }, failure: 'нет сети' })));
}

console.log('\n4. Причина отказа называется словами');
{
  for (const r of ['none', 'invalid', 'wrong_machine', 'expired']) {
    const s = gateState({ status: { licensed: false, reason: r as any }, failure: '' });
    ok(`«${r}» объяснён`, s.kind === 'unlicensed' && s.text === REASON_TEXT[r] && s.text.length > 20, s);
  }
  ok('незнакомая причина не роняет и не молчит', reasonText('что-то новое') === REASON_TEXT.none);
  ok('пустая причина — «не активирована»', reasonText('') === REASON_TEXT.none);
  ok('причины не повторяются', new Set(Object.values(REASON_TEXT)).size === Object.keys(REASON_TEXT).length);
}

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
