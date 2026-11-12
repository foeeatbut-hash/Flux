// Храповик словаря: слово «подпрограмма» убрано из Flux по решению владельца
// (11 ноября 2026) — у человека и у разработчика это просто «программа».
// Набор падает, если слово появилось снова вне исторических записей:
// датированных решений в документах и фразы о самом переименовании.
import { execFileSync } from 'child_process';

const DATE = /\d{1,2} (января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря) 20\d\d/;
const RENAME_NOTE = /вместо «подпрограммы»|Переименование «подпрограммы»|не «подпрограммы»/;
// Сам набор называет слово, а файлы хода — рабочие записи исполнителей.
const SELF = 'scripts/test-program-naming.ts';

const out = execFileSync('git', ['grep', '-I', '-n', '-i', 'подпрограмм'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
const bad: string[] = [];
for (const row of out) {
  const m = /^([^:]+):(\d+):(.*)$/.exec(row);
  if (!m) continue;
  const [, file, , text] = m;
  if (file === SELF || file.startsWith('.claude/progress/')) continue;
  if (file.startsWith('docs/') && (DATE.test(text) || RENAME_NOTE.test(text))) continue;
  bad.push(`${file}:${m[2]}`);
}
if (bad.length) {
  console.error(`ПРОВАЛ: слово «подпрограмма» вне исторических записей (${bad.length}):\n${bad.slice(0, 30).join('\n')}`);
  process.exit(1);
}
console.log('Слово «подпрограмма» осталось только в датированных исторических записях');
