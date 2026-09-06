/**
 * Подмена программы новой версией — сторона, которая трогает диск.
 *
 * Правила (доводы, сроки, стоит ли пробовать ещё раз) лежат в updates.ts и
 * проверяются скриптом. Здесь только то, что скриптом не проверить: ожидание
 * ухода старого процесса, копирование файла и запуск.
 *
 * Отдельным файлом, потому что это НЕ запуск программы. Помощник не создаёт
 * окна, не просит замок одиночного запуска (старая версия ещё жива, и замок
 * закрыл бы помощника первым же делом) и вообще ничего не знает про остальную
 * программу.
 *
 * Почему не cmd-файл, как было раньше: `detached` и `windowsHide` на Windows
 * несовместимы, и окно консоли появлялось всегда, а закрыть его приходилось
 * руками. Новая версия — графическая программа, консоли у неё не бывает.
 */
import { app, dialog } from 'electron';
import fs from 'fs';
import { spawn } from 'child_process';
import { appendLog } from './logs';
import {
  WAIT_EXIT_MS, COPY_PAUSE_MS, retryCopy, type ApplyPlan,
} from './updates';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Жив ли процесс. Сигнал 0 ничего не делает — только спрашивает */
function alive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

/** Дождаться ухода старой программы: пока она жива, файл занят */
async function waitGone(pid: number): Promise<boolean> {
  const until = Date.now() + WAIT_EXIT_MS;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await sleep(200);
  }
  return true;
}

/** Запустить программу и забыть о ней: помощник уходит следом */
function launch(exe: string): void {
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Положить себя на место старого файла и запустить его.
 *
 * Себя — это тот файл, который человек запустил: у портативной сборки это
 * `PORTABLE_EXECUTABLE_FILE`, а не временная копия распаковки. Скопировать его
 * можно и на ходу: запущенный exe заперт на запись, но не на чтение.
 */
export async function applyUpdate(plan: ApplyPlan): Promise<void> {
  const self = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  appendLog('INFO', 'Обновление', `Ставлю новую версию на место ${plan.target}`);

  const gone = await waitGone(plan.waitPid);
  if (!gone) appendLog('WARN', 'Обновление', 'Старая версия не завершилась вовремя — пробую всё равно');

  let tried = 0;
  for (;;) {
    try {
      fs.copyFileSync(self, plan.target);
      appendLog('INFO', 'Обновление', 'Файл программы заменён, запускаю новую версию');
      launch(plan.target);
      app.exit(0);
      return;
    } catch (err: any) {
      tried += 1;
      if (retryCopy(err?.code, tried)) { await sleep(COPY_PAUSE_MS); continue; }
      // Остаться без программы человек не должен: говорим, что случилось, и
      // возвращаем ту версию, которая у него была
      const why = `${err?.code || ''} ${err?.message || err}`.trim();
      appendLog('ERROR', 'Обновление', `Не удалось заменить файл программы: ${why}`);
      try {
        dialog.showErrorBox(
          'Обновление не установилось',
          `Не удалось заменить файл программы:\n${plan.target}\n\n${why}\n\n`
          + 'Запускаю прежнюю версию. Закройте программу полностью и попробуйте ещё раз '
          + 'или замените файл вручную — новый лежит в папке загрузок.',
        );
      } catch (_) { /* окна может не быть вовсе */ }
      try { if (fs.existsSync(plan.target)) launch(plan.target); } catch (_) { /* нечего запускать */ }
      app.exit(1);
      return;
    }
  }
}
