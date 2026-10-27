/**
 * Контракт «стекла» и вида окон (docs/methodology/01-design.md, раздел 4).
 *
 * Другие экраны берут `.fx-glass` и переменные `--flux-glass-*`, не читая
 * index.css, поэтому контракт проверяется по тексту: класс есть, выключенная
 * прозрачность и prefers-reduced-transparency дают сплошной фон, у окна есть
 * активное и фоновое состояние в обеих темах. Живой замер — в снимках
 * (win-look) и в scripts/test-design-live.ts.
 */
import { readFileSync } from 'node:fs';

const css = readFileSync('src/index.css', 'utf8');
const layer = readFileSync('src/components/WindowsLayer.tsx', 'utf8');
const glass = readFileSync('src/lib/glass.ts', 'utf8');
let failed = 0;
const ok = (name: string, cond: boolean) => { if (cond) console.log('  ✓', name); else { failed++; console.error('  ✗', name); } };

ok('переменные стекла объявлены', ['--flux-glass-level', '--flux-glass-alpha:', '--flux-glass-alpha-soft', '--flux-glass-blur', '--flux-glass-sat'].every((v) => css.includes(v)));
ok('класс .fx-glass есть, цвет берёт из --fx-glass-tint', /\.fx-glass[^{]*\{[^}]*--fx-glass-tint/.test(css));
ok('размытие включается только под классом flux-glass', /:root\.flux-glass \.fx-glass[^{]*\{[^}]*backdrop-filter/.test(css));
ok('prefers-reduced-transparency даёт сплошной фон без размытия', /prefers-reduced-transparency: reduce\)\s*\{[^@]*backdrop-filter: none/.test(css));
ok('без flux-glass у .fx-glass сплошной фон', /\.fx-glass,[^{]*\{\s*background: var\(--fx-glass-tint, var\(--flux-surface\)\)/.test(css));

for (const v of ['--flux-win-head', '--flux-win-head-idle', '--flux-win-line', '--flux-win-line-idle', '--flux-win-shade', '--flux-shadow-win', '--flux-shadow-win-idle', '--flux-shadow-win-drag']) {
  const n = css.split(`${v}:`).length - 1;
  ok(`${v} задан в светлой и тёмной теме`, n >= 2);
}
ok('у окна есть состояние data-active', css.includes('.fx-win[data-active="true"]') && layer.includes("data-active={isTop ? 'true' : 'false'}"));
ok('у активного окна нет зелёной рамки (только у «подглядывания»)', !/data-active="true"\][^{]*\{[^}]*emerald/.test(css));
ok('настройка хранится и применяется через lib/glass', glass.includes('flux-glass') && glass.includes('--flux-glass-level'));

if (failed) { console.error(`\n${failed} провалов`); process.exit(1); }
console.log('\nВсе проверки контракта стекла пройдены');
