/**
 * Все наборы scripts/test-*.ts одним запуском, а в вывод — только провалы.
 *
 * Зачем отдельный запуск: полный прогон печатает тысячи строк «✓», и читать их
 * целиком — время и место в контексте, хотя нужен один ответ: что упало и чем.
 * Здесь вывод набора показывается, только если он завершился с ошибкой, и то
 * лишь строки с «✗» и ошибками.
 *
 *   npx tsx scripts/run-checks.ts              # всё, кроме *live*
 *   npx tsx scripts/run-checks.ts --live       # вместе с живыми наборами
 *   npx tsx scripts/run-checks.ts layout flow  # только наборы с этими словами в имени
 *   npx tsx scripts/run-checks.ts --times      # плюс самые долгие наборы
 *
 * Наборы идут параллельно, но не все. Те, что ходят на поднятый сервер :3000
 * (api, flow, layout, живые…) или поднимают свой, делят одну базу, один
 * предел частоты и одного администратора — вместе они мешали бы друг другу
 * и падали бы не по своей вине. Они идут цепочкой по одному, а остальные в это
 * время — в соседних потоках. Без сервера первые упадут, об этом сказано в
 * начале прогона.
 *
 * tsx запускается напрямую, без npx: npx на каждом из 140 наборов стоил
 * полсекунды — больше, чем многие наборы работают.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { cpus } from 'node:os';

const args = process.argv.slice(2);
const live = args.includes('--live');
const showTimes = args.includes('--times');
const words = args.filter((a) => !a.startsWith('--'));

const files = readdirSync('scripts')
  .filter((f) => /^test-.*\.ts$/.test(f))
  .filter((f) => live || words.length > 0 || !f.includes('live'))
  .filter((f) => words.length === 0 || words.some((w) => f.includes(w)))
  .sort();

// Кому нужен общий сервер или свой порт. Признак — по тексту набора: адрес
// сервера (FLUX_API, localhost:3000), запуск server.ts или своего listen().
// Живые наборы — всегда сюда. Замер накладных расходов (diagnostics-overhead)
// поднимает свой сервер и меряет время: под нагрузкой соседей он врёт.
const SHARED = /FLUX_API|localhost:3000|127\.0\.0\.1:3000|['"]server\.ts['"]|\.listen\(/;
const shared = (f: string) => f.includes('live') || SHARED.test(readFileSync(`scripts/${f}`, 'utf8'));
const chain = files.filter(shared);
const free = files.filter((f) => !chain.includes(f));

// Наборы берут адрес сервера из FLUX_API — второй сервер (своя рабочая копия,
// порт 3101) проверяется так же, как основной
const BASE = process.env.FLUX_API || 'http://localhost:3000';
const serverUp = spawnSync('curl', ['-s', '-o', '/dev/null', '-m', '2', `${BASE}/api/health`]).status === 0;
if (chain.length && !serverUp) console.log(`Сервер на ${BASE} не отвечает — наборы, которым он нужен, упадут.\n`);

const TSX = 'node_modules/.bin/tsx';
const TIMEOUT = 15 * 60_000;
const WORKERS = Math.max(2, Math.min(6, cpus().length));

type Result = { file: string; ok: boolean; ms: number };
const results: Result[] = [];

function run(file: string): Promise<void> {
  return new Promise((resolve) => {
    const t = Date.now();
    const child = spawn(TSX, [`scripts/${file}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d: Buffer) => { if (out.length < 64 << 20) out += d; };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { out += `\nпрерван по времени (${TIMEOUT / 60_000} мин)`; child.kill('SIGKILL'); }, TIMEOUT);
    child.on('close', (code) => {
      clearTimeout(timer);
      results.push({ file, ok: code === 0, ms: Date.now() - t });
      if (code !== 0) {
        const lines = out.split('\n').filter((l) => /✗|ПРОВАЛ|^\s*\w*Error\b|Error:|прерван по времени/.test(l)).slice(0, 12);
        const why = lines.length ? lines.join('\n') : out.trim().split('\n').slice(-6).join('\n');
        console.log(`✗ ${file} (код ${code ?? 'нет'})\n${why}\n`);
      }
      resolve();
    });
    child.on('error', (e) => { out += `\n${e.message}`; });
  });
}

async function drain(queue: string[]) {
  while (queue.length) await run(queue.shift()!);
}

async function main() {
  const started = Date.now();
  const queue = [...free];
  await Promise.all([
    drain([...chain]),
    // Цепочка занимает один поток, свободные наборы — остальные
    ...Array.from({ length: chain.length ? WORKERS - 1 : WORKERS }, () => drain(queue)),
  ]);

  const failed = results.filter((r) => !r.ok);
  if (showTimes) {
    console.log('Самые долгие:');
    for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 10)) {
      console.log(`  ${(r.ms / 1000).toFixed(1).padStart(6)} с  ${r.file}${chain.includes(r.file) ? ' (цепочка)' : ''}`);
    }
  }
  const min = ((Date.now() - started) / 60_000).toFixed(1);
  console.log(`Наборов: ${files.length}, провалено: ${failed.length}, ${min} мин.`);
  process.exit(failed.length ? 1 : 0);
}

main();
