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
 *
 * Части наборов (api, flow, layout и живым) нужен поднятый сервер — без него
 * они упадут, об этом сказано в начале прогона.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const live = args.includes('--live');
const words = args.filter((a) => !a.startsWith('--'));

const files = readdirSync('scripts')
  .filter((f) => /^test-.*\.ts$/.test(f))
  .filter((f) => live || words.length > 0 || !f.includes('live'))
  .filter((f) => words.length === 0 || words.some((w) => f.includes(w)))
  .sort();

const serverUp = spawnSync('curl', ['-s', '-o', '/dev/null', '-m', '2', 'localhost:3000/api/health']).status === 0;
if (!serverUp) console.log('Сервер на :3000 не отвечает — наборы, которым он нужен, упадут.\n');

const started = Date.now();
const failed: string[] = [];
for (const f of files) {
  const r = spawnSync('npx', ['tsx', `scripts/${f}`], { encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 64 << 20 });
  if (r.status === 0) continue;
  failed.push(f);
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const lines = out.split('\n').filter((l) => /✗|Error|ПРОВАЛ|провал/.test(l)).slice(0, 12);
  const why = r.error ? `  ${r.error.message}` : lines.length ? lines.join('\n') : out.trim().split('\n').slice(-6).join('\n');
  console.log(`✗ ${f} (код ${r.status ?? 'нет'})\n${why}\n`);
}

const min = ((Date.now() - started) / 60_000).toFixed(1);
console.log(`Наборов: ${files.length}, провалено: ${failed.length}, ${min} мин.`);
process.exit(failed.length ? 1 : 0);
