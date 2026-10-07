import { validateWindowsName } from './paths';

/**
 * Свободное имя так, как предлагает Windows при совпадении: «Отчёт.docx» →
 * «Отчёт (2).docx», дальше (3), (4)… Расширение у папки не отделяется: точка в
 * «Версия 1.2» — часть имени. Номер вставляется перед последним расширением
 * файла, чтобы тип файла не менялся.
 */
export function freeWindowsName(name: string, taken: (candidate: string) => boolean, isDirectory = false): string {
  const dot = isDirectory ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  // Уже пронумерованное имя («Отчёт (2).docx») не превращается в «Отчёт (2) (2).docx»: счёт продолжается.
  const numbered = /^(.*) \((\d{1,4})\)$/u.exec(stem);
  const base = numbered ? numbered[1] : stem;
  for (let n = numbered ? Number(numbered[2]) + 1 : 2; n < 10_000; n++) {
    let candidate = `${base} (${n})${extension}`;
    // Длинное имя обрезается за счёт основы: предел Windows — 255 знаков на имя.
    if (candidate.length > 255) candidate = `${base.slice(0, Math.max(1, base.length - (candidate.length - 255)))} (${n})${extension}`;
    try { validateWindowsName(candidate); } catch { continue; }
    if (!taken(candidate)) return candidate;
  }
  throw new RangeError('Не нашлось свободного имени.');
}

/** Сравнение имён как в Windows: без учёта регистра. */
export const sameWindowsName = (a: string, b: string) => a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US');
