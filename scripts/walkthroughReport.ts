/**
 * Отчёт обхода: results.json + список сценариев аудита → docs/audit-walkthrough.md.
 *
 * Отдельно от самого обхода нарочно: обход ходит по программе и пишет
 * наблюдения, а это складывает из них документ. Перепутать их значило бы
 * править отчёт, не трогая наблюдений, — а тогда отчёту нельзя верить.
 *
 * Запуск: npx tsx scripts/walkthroughReport.ts [путь/к/ui-scenarios.json]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const FRAMES = process.env.FLUX_FRAMES || resolve('.walkthrough');
const RESULTS = `${FRAMES}/results.json`;
const SCEN = process.argv[2] || '';
const OUT = resolve('docs/audit-walkthrough.md');

interface Step { id: string; verdict: string; note: string; frames?: string[] }
interface Scenario { id: string; section: string; scenario: string }

if (!existsSync(RESULTS)) {
  console.error(`Нет ${RESULTS} — сначала пройдите разделы: npx tsx scripts/walkthrough.ts`);
  process.exit(1);
}

const steps: Step[] = JSON.parse(readFileSync(RESULTS, 'utf8'));
const scen: Scenario[] = SCEN && existsSync(SCEN) ? JSON.parse(readFileSync(SCEN, 'utf8')) : [];
const byId = new Map(scen.map((s) => [s.id, s]));

const MARK: Record<string, string> = {
  'ПРОЙДЕН': '✅',
  'НЕ ПРОЙДЕН': '❌',
  'НЕ ПРОВЕРЕНО': '⏸',
};

const passed = steps.filter((s) => s.verdict === 'ПРОЙДЕН').length;
const failed = steps.filter((s) => s.verdict === 'НЕ ПРОЙДЕН').length;
const skipped = steps.filter((s) => s.verdict === 'НЕ ПРОВЕРЕНО').length;

// Разделы в том порядке, в каком по ним шли
const order: string[] = [];
const bySection = new Map<string, Step[]>();
for (const s of steps) {
  const sec = byId.get(s.id)?.section || 'Прочее';
  if (!bySection.has(sec)) { bySection.set(sec, []); order.push(sec); }
  bySection.get(sec)!.push(s);
}

const frames = existsSync(FRAMES) ? readdirSync(FRAMES).filter((f) => f.endsWith('.png')) : [];

const lines: string[] = [];
lines.push('# Обход разделов: что проверено живой программой');
lines.push('');
lines.push('Внешний аудит 18.09.2026 составил 125 сценариев приёмки и **не выполнил ни');
lines.push('одного**: браузер аудитора отвечал `ERR_BLOCKED_BY_CLIENT`, и весь раздел');
lines.push('«интерфейс» остался со статусом «не запускалось». Здесь эти же 125 сценариев');
lines.push('пройдены на поднятой программе.');
lines.push('');
lines.push('Отчёт складывается из наблюдений обхода, а не пишется руками:');
lines.push('`npx tsx scripts/walkthrough.ts` ходит по разделам и пишет `results.json`,');
lines.push('`npx tsx scripts/walkthroughReport.ts` собирает из него этот файл.');
lines.push('');
lines.push(`| Итог | Сценариев |`);
lines.push(`|---|---|`);
lines.push(`| ✅ пройден | ${passed} |`);
lines.push(`| ❌ не пройден | ${failed} |`);
lines.push(`| ⏸ не проверялся в этом контейнере | ${skipped} |`);
lines.push(`| **всего** | **${steps.length}** |`);
lines.push('');
lines.push('«Не проверялся» — не то же, что «пройден», и в сводку успехов не идёт. У');
lines.push('каждой такой строки названа причина: нет Windows и Electron, нет второго живого');
lines.push('сотрудника, нет настоящего почтового сервера, нет принтера, либо действие');
lines.push('пишет в рабочую базу владельца и обходом не делается.');
lines.push('');
lines.push('## Чего в этом контейнере проверить нельзя');
lines.push('');
lines.push('Говорю прямо, а не закрываю молча:');
lines.push('');
lines.push('- **Windows и Electron живьём.** Родной слой страницы Браузера, стикер');
lines.push('  Блокнота, пульт захвата, печать, скачивание файлов, обновление программы.');
lines.push('- **Масштаб экрана 125/150/200 % и два монитора с разным DPI.** Нужна');
lines.push('  настоящая система с настройками экрана.');
lines.push('- **Второй живой сотрудник.** Совместная правка, конфликты, права, отметки');
lines.push('  прочтения, «кто сейчас в программе».');
lines.push('- **Настоящие IMAP и SMTP.** Вся Почта, кроме поведения без подключения.');
lines.push('- **Принтер.** Печать документа, чертежа и руководства.');
lines.push('');
lines.push(`Кадры «до» и «после» лежат рядом с прогоном (\`${FRAMES.replace(process.cwd() + '/', '')}\`,`);
lines.push(`снимков ${frames.length}); в репозиторий они не кладутся — это доказательство`);
lines.push('одного прогона, а не часть программы.');
lines.push('');
lines.push('## Построчно');
lines.push('');

for (const sec of order) {
  const list = bySection.get(sec)!;
  const p = list.filter((s) => s.verdict === 'ПРОЙДЕН').length;
  lines.push(`### ${sec} — ${p} из ${list.length}`);
  lines.push('');
  lines.push('| Сценарий | Итог | Что делали и что вышло |');
  lines.push('|---|---|---|');
  for (const s of list.sort((a, b) => a.id.localeCompare(b.id))) {
    const text = byId.get(s.id)?.scenario || '';
    const note = s.note.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const head = text ? `**${s.id}** ${text.replace(/\|/g, '\\|')}` : `**${s.id}**`;
    lines.push(`| ${head} | ${MARK[s.verdict] || s.verdict} | ${note} |`);
  }
  lines.push('');
}

writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`Готово: ${OUT} — ${steps.length} строк, ${passed} пройдено, ${failed} не пройдено, ${skipped} не проверялось`);
