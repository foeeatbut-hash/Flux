/**
 * Подпись сотрудника: удаление фона, размер и проверка файла, обрезка полей.
 *
 * Эти проверки жили в test-formulas.ts, хотя к формулам не относятся: они
 * закрывают src/lib/signature.ts. Формулы документа удалены, подпись осталась.
 */
import { cutBackground, inkRatio, fitToHeight, checkFile, DEFAULT_THRESHOLD,
         inkBounds, suggestThreshold, looksEmpty } from '../src/lib/signature.js';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d) : ''));

console.log('11. Подпись: удаление фона');
/** Полоска: белый фон, серый край, чёрный штрих */
const strip = () => new Uint8ClampedArray([
  255, 255, 255, 255,   // белый — фон
  240, 240, 240, 255,   // почти белый — тоже фон
  128, 128, 128, 255,   // серый — край штриха
  20, 20, 20, 255,      // чёрный — штрих
]);

const s1 = strip();
cutBackground(s1, DEFAULT_THRESHOLD);
ok('белый фон стал прозрачным', s1[3] === 0, s1[3]);
ok('почти белый тоже убран', s1[7] === 0, s1[7]);
ok('чёрный штрих остался непрозрачным', s1[15] === 255, s1[15]);
ok('серый край не выброшен целиком', s1[11] > 0, s1[11]);

const s0 = strip();
cutBackground(s0, 0);
ok('порог 0 не трогает ничего', s0[3] === 255 && s0[15] === 255);

const s100 = strip();
cutBackground(s100, 100);
ok('порог 100 стирает всё', inkRatio(s100) === 0, inkRatio(s100));

ok('доля чернил считается', Math.abs(inkRatio(strip()) - 1) < 1e-9);
ok('порог вне диапазона не ломает', (() => { const x = strip(); cutBackground(x, 999); return inkRatio(x) === 0; })());

console.log('12. Подпись: размер и проверка файла');
ok('низкая картинка не растягивается', JSON.stringify(fitToHeight(400, 100, 300)) === JSON.stringify({ w: 400, h: 100 }));
ok('высокая уменьшается с пропорциями', JSON.stringify(fitToHeight(1200, 600, 300)) === JSON.stringify({ w: 600, h: 300 }), fitToHeight(1200, 600, 300));
ok('png принимается', checkFile({ type: 'image/png', size: 1000 }) === null);
ok('pdf отвергается понятным текстом', /PNG/.test(String(checkFile({ type: 'application/pdf', size: 10 }))), checkFile({ type: 'application/pdf', size: 10 }));
ok('слишком большой файл отвергается', /8 МБ/.test(String(checkFile({ type: 'image/png', size: 9e6 }))), checkFile({ type: 'image/png', size: 9e6 }));



console.log('13. Подпись: обрезка полей и подбор порога');
{
  // Лист 6×4 с точкой посередине — как скан с большими полями
  const W = 6, H = 4;
  const sheet = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < sheet.length; i += 4) { sheet[i] = sheet[i+1] = sheet[i+2] = 250; sheet[i+3] = 255; }
  const put = (x: number, y: number) => { const o = (y * W + x) * 4; sheet[o] = sheet[o+1] = sheet[o+2] = 10; };
  put(2, 1); put(3, 1);

  const t = suggestThreshold(sheet);
  ok('порог подобран в разумных пределах', t >= 5 && t <= 95, t);
  cutBackground(sheet, t);
  ok('после подбора бумага ушла', sheet[3] === 0, sheet[3]);
  ok('штрих остался', sheet[(1 * W + 2) * 4 + 3] > 0);

  const b = inkBounds(sheet, W, H, 0);
  ok('границы штриха найдены', !!b && b.x === 2 && b.y === 1 && b.w === 2 && b.h === 1, b);
  const bp = inkBounds(sheet, W, H, 2);
  ok('запас вокруг штриха не вылезает за лист', !!bp && bp.x === 0 && bp.y === 0 && bp.w === 6 && bp.h === 4, bp);

  const blank = new Uint8ClampedArray(W * H * 4);
  ok('на пустой картинке границ нет', inkBounds(blank, W, H) === null);
  ok('пустая картинка распознаётся как пустая', looksEmpty(blank));
  ok('картинка со штрихом пустой не считается', !looksEmpty(sheet));
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
