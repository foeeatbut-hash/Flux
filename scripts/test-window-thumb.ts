/**
 * Правила снимков окон для карточек над панелью задач.
 *
 * Снимок дорог, а наведение мыши частое; ошибка здесь не падает, а показывает
 * в карточке чужое содержимое (окно, закрытое другим) или кадр, в который
 * попала сама карточка. Поэтому «когда снимать» проверяется отдельно от IPC.
 *
 * Запуск: npx tsx scripts/test-window-thumb.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverage, shouldCapture, THUMB_TTL, MAX_COVER, type Thumb } from '../src/lib/windowThumb';
import { INVOKE_CHANNELS } from '../electron/ipcAllow';

let failed = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const NOW = 1_000_000;
const fresh: Thumb = { url: 'data:', w: 10, h: 10, at: NOW - 100 };
const stale: Thumb = { url: 'data:', w: 10, h: 10, at: NOW - THUMB_TTL - 1 };
const ask = (over = {}) => ({ minimized: false, covered: 0, panelShown: false, now: NOW, ...over });

console.log('Когда снимать');
{
  check('видимое окно без снимка снимается', shouldCapture(ask()));
  check('свёрнутое не снимается: его нет на экране', !shouldCapture(ask({ minimized: true })));
  check('и «принудительно» свёрнутое не снимается', !shouldCapture(ask({ minimized: true, force: true })));
  check('свежий снимок не повторяется', !shouldCapture(ask({ cached: fresh })));
  check('устаревший переснимается', shouldCapture(ask({ cached: stale })));
  check('пока карточка на экране — не снимать: она попадёт в кадр', !shouldCapture(ask({ panelShown: true })));
  check('перед сворачиванием снимают не глядя на свежесть и карточку', shouldCapture(ask({ cached: fresh, panelShown: true, force: true })));
  check('закрытое другим окном не снимается: на картинке было бы чужое', !shouldCapture(ask({ covered: MAX_COVER + 0.01 })));
  check('слегка закрытое снимается', shouldCapture(ask({ covered: MAX_COVER - 0.01 })));
  check('закрытое не снимается и принудительно', !shouldCapture(ask({ covered: 0.9, force: true })));
}

console.log('Сколько окна закрыто');
{
  const win = { x: 100, y: 100, w: 400, h: 300 };
  check('рядом — ноль', coverage(win, [{ x: 600, y: 100, w: 200, h: 300 }]) === 0);
  check('целиком накрыто — единица', coverage(win, [{ x: 0, y: 0, w: 1000, h: 1000 }]) === 1);
  const half = coverage(win, [{ x: 300, y: 100, w: 400, h: 300 }]);
  check('половина шириной в половину окна', Math.abs(half - 0.5) < 1e-9, half);
  check('два перекрытия складываются, но не больше единицы', coverage(win, [{ x: 0, y: 0, w: 1000, h: 1000 }, { x: 0, y: 0, w: 1000, h: 1000 }]) === 1);
  check('окно без площади не ломает расчёт', coverage({ x: 0, y: 0, w: 0, h: 10 }, [{ x: 0, y: 0, w: 5, h: 5 }]) === 0);
}

console.log('Граница с основным процессом');
{
  check('канал снимка разрешён в списке IPC', INVOKE_CHANNELS.has('taskbar:window-thumb'));
  const main = readFileSync(join(__dirname, '../electron/main.ts'), 'utf8');
  check('обработчик подключён в основном процессе', main.includes('setupWindowThumb()'));
  const handler = readFileSync(join(__dirname, '../electron/windowThumb.ts'), 'utf8');
  // Снимается окно ОТПРАВИТЕЛЯ: номер чужого окна из запроса не принимается
  check('снимается окно отправителя', handler.includes('BrowserWindow.fromWebContents(event.sender)'));
  check('номер окна из запроса не читается', !/BrowserWindow\.(fromId|getAllWindows)/.test(handler));
}

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки снимков окон пройдены');
