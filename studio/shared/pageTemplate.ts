/**
 * Заготовка «страница»: калькулятор со своим экраном кодом (договор v2).
 *
 * Показывает всё, что разработчик рисует сам: поле ввода, кнопку, таблицу результата и график на canvas.
 * Расчёт один на все языки: страница отдаёт числа логике через flux.compute (Python, WebAssembly), а для
 * TypeScript считает сама тем же кодом — логика на TypeScript в Flux не вызывается, страница и есть её окно.
 * Оформление — набор Flux (/_flux/flux-ui.v1.css) плюс свой style.css на токенах темы.
 */
export const PAGE_INDEX = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Калькулятор с графиком</title>
  <link rel="stylesheet" href="/_flux/flux-ui.v1.css">
  <link rel="stylesheet" href="/ui/style.css">
</head>
<body>
  <main class="fx-body fx-stack app">
    <h1 class="fx-title">Статистика чисел</h1>
    <div>
      <label class="fx-label" for="numbers">Числа через пробел, запятую или с новой строки</label>
      <textarea id="numbers" class="fx-textarea" rows="3">12 18 7 25 30 9</textarea>
    </div>
    <div class="fx-row">
      <button id="run" class="fx-btn fx-btn-primary" type="button">Рассчитать</button>
      <button id="open" class="fx-btn" type="button">Загрузить числа из файла</button>
      <button id="save" class="fx-btn" type="button" disabled>Сохранить таблицу</button>
      <span id="status" class="fx-muted" role="status"></span>
    </div>
    <table class="fx-table" aria-label="Результат">
      <thead><tr><th>Показатель</th><th class="num">Значение</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <canvas id="chart" width="560" height="200" aria-label="График значений"></canvas>
  </main>
  <script src="/_flux/flux.v1.js"></script>
  <script src="/ui/app.js"></script>
</body>
</html>
`;

export const PAGE_STYLE = `.app { max-width: 640px; }
#chart { width: 100%; max-width: 560px; height: auto; border: 1px solid var(--flux-line); border-radius: var(--flux-radius); background: var(--flux-surface); }
`;

export const PAGE_SCRIPT = `// Страница программы: обычный JavaScript. Flux даёт только flux.* (см. types/flux.d.ts).
const NAMES = [['count', 'Значений'], ['sum', 'Сумма'], ['mean', 'Среднее'], ['rms', 'Среднеквадратичное'], ['min', 'Наименьшее'], ['max', 'Наибольшее']];
const $ = id => document.getElementById(id);
let values = [], stats = null;

function parse(text) {
  return text.split(/[\\s;,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
}
// Тот же расчёт, что в логике; для TypeScript flux.compute недоступен, и считает сама страница
function calcLocal(list) {
  const count = list.length, sum = list.reduce((a, b) => a + b, 0);
  return { count, sum, mean: count ? sum / count : 0, rms: count ? Math.sqrt(list.reduce((a, b) => a + b * b, 0) / count) : 0, min: count ? Math.min(...list) : 0, max: count ? Math.max(...list) : 0 };
}
async function calculate(list) {
  try {
    const out = await flux.compute({ v: 1, context: flux.context, flux: { equipment: { params: list.map(v => ({ value: String(v) })) } }, state: {} });
    return out.calc.out;
  } catch (e) {
    if (e.code === 'UNAVAILABLE') return calcLocal(list);
    throw e;
  }
}
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function draw() {
  const canvas = $('chart'), g = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  g.clearRect(0, 0, w, h);
  if (!values.length) return;
  const max = Math.max(...values, 1), step = w / values.length;
  g.fillStyle = css('--flux-accent');
  values.forEach((v, i) => { const bar = (h - 24) * Math.max(v, 0) / max; g.fillRect(i * step + 6, h - 16 - bar, step - 12, bar); });
  g.fillStyle = css('--flux-text-muted'); g.font = '11px sans-serif'; g.textAlign = 'center';
  values.forEach((v, i) => g.fillText(String(v), i * step + step / 2, h - 3));
}
function show() {
  $('rows').replaceChildren(...NAMES.map(([key, title]) => {
    const row = document.createElement('tr'), name = document.createElement('td'), cell = document.createElement('td');
    name.textContent = title; cell.className = 'num'; cell.textContent = stats ? String(Math.round(stats[key] * 1e6) / 1e6) : '—';
    row.append(name, cell); return row;
  }));
  $('save').disabled = !stats;
  draw();
}
async function run() {
  $('status').textContent = 'Считаю…';
  try {
    values = parse($('numbers').value);
    stats = await calculate(values);
    $('status').textContent = '';
    await flux.state.set({ numbers: $('numbers').value });
  } catch (e) { stats = null; $('status').textContent = e.message; }
  show();
}
$('run').addEventListener('click', run);
$('save').addEventListener('click', async () => {
  const csv = NAMES.map(([key, title]) => title + ';' + stats[key]).join('\\n');
  try { await flux.saveFile('statistika.csv', csv, 'text/csv'); } catch (e) { $('status').textContent = e.message; }
});
// Файл пользователя: Flux сам покажет диалог выбора, программа получит имя и содержимое только выбранного файла
$('open').addEventListener('click', async () => {
  try {
    const file = await flux.openFile({ accept: ['.csv', '.txt'] });
    $('numbers').value = file.text();
    await run();
    $('status').textContent = 'Загружен файл ' + file.name;
  } catch (e) { if (e.code !== 'CANCELLED') $('status').textContent = e.message; }
});
// Тема меняется без перезагрузки: график берёт цвета из токенов заново
flux.onTheme(draw);
flux.ready.then(async () => {
  const saved = await flux.state.get();
  if (typeof saved.numbers === 'string') $('numbers').value = saved.numbers;
  run();
});
`;
