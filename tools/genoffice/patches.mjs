/**
 * Правки исходников GenOffice перед сборкой Flux Office.
 *
 * Правок мало, и каждая — ровно то, чего у редактора нет, а Flux нужно. Они
 * делаются заменой строки, а не файлом .patch: закреплённый коммит не
 * меняется, а при его смене заменяемая строка либо найдётся, либо сборка
 * остановится с понятной причиной — молча собрать редактор без правки
 * нельзя (у сотрудника тогда пропал бы режим просмотра).
 *
 * Повторный запуск безопасен: уже внесённая правка узнаётся и пропускается.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PATCHES = [
  {
    // Файл правит другой сотрудник — у остальных только просмотр. Редактор
    // уже умеет «документ защищён»: этот флаг просто становится ещё одной
    // причиной защиты, и лента, колонтитулы и тело закрываются теми же
    // путями, что при защите паролем
    id: 'flux-read-only-state',
    file: 'apps/docs/src/renderer/App.tsx',
    find: "  const [readMode, setReadMode] = useState(false)\n",
    replace: "  const [readMode, setReadMode] = useState(false)\n" +
      "  // Flux Office: файл правит другой — только просмотр (tools/genoffice/patches.mjs)\n" +
      "  const [fluxReadOnly, setFluxReadOnly] = useState(false)\n" +
      "  useEffect(() => (window as any).desktop?.onFluxReadOnly?.((v: boolean) => setFluxReadOnly(v === true)), [])\n",
  },
  {
    id: 'flux-read-only-protect',
    file: 'apps/docs/src/renderer/App.tsx',
    find: "  const isProtected =\n    writeLocked ||\n",
    replace: "  const isProtected =\n    fluxReadOnly ||\n    writeLocked ||\n",
  },
];

/** Внести правки; вернуть, что сделано. Не нашлось места — ошибка */
export function applyPatches(src) {
  const done = [];
  for (const p of PATCHES) {
    const path = join(src, p.file);
    const text = readFileSync(path, 'utf8');
    if (text.includes(p.replace)) { done.push(`${p.id}: уже есть`); continue; }
    const at = text.indexOf(p.find);
    if (at < 0) throw new Error(`правка «${p.id}»: в ${p.file} не нашлось места — сменился исходник GenOffice?`);
    if (text.indexOf(p.find, at + 1) >= 0) throw new Error(`правка «${p.id}»: место в ${p.file} не единственное`);
    writeFileSync(path, text.slice(0, at) + p.replace + text.slice(at + p.find.length));
    done.push(`${p.id}: внесена`);
  }
  return done;
}
