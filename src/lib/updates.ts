/**
 * Обновление программы: сравнение версий, адрес файла и разбор отказов.
 *
 * Здесь то, что раньше было размазано по виджету и главному процессу и оттого
 * молчало. Обновление у портативной программы — единственное действие, которое
 * заменяет саму программу, и человеку в нём нужно ровно одно: нажал — и через
 * минуту работает новая версия. Всё остальное он видеть не должен, а если не
 * получилось — обязан прочитать, ПОЧЕМУ, а не «Error invoking remote method».
 *
 * Здесь — сторона окна: сравнение версий, адрес файла и что показывать на
 * кнопке. Правила самого скачивания живут у главного процесса
 * (electron/updates.ts), потому что решаются там же, где качается файл, а
 * окно кода главного процесса не видит и видеть не должно.
 *
 * Без React и без сети: правила проверяются скриптом (scripts/test-updates.ts),
 * потому что ошибиться здесь легко, а увидеть ошибку можно только на чужой
 * машине в день выпуска.
 */

/** Новее ли выложенная версия той, что запущена */
export function isNewer(latest: string, current: string): boolean {
  // Суффиксы вроде «-beta» дают NaN при Number() — оставляем цифры и точки
  const parts = (v: string) => String(v || '').split('-')[0].split('.').map((x) => Number(x) || 0);
  const l = parts(latest);
  const c = parts(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

/**
 * Полный адрес файла обновления. Относительный путь достраивается адресом
 * сервера, с которым программа и так работает.
 */
export function fileUrlOf(fileUrl: string, base: string): string {
  const raw = String(fileUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const b = String(base || '').replace(/\/+$/, '');
  return `${b}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

/** Что мешает начать обновление прямо сейчас; пустая строка — ничего */
export function blocker(o: {
  electron: boolean; packaged: boolean; portable: boolean; fileUrl: string;
}): string {
  if (!o.electron) {
    return 'Обновление ставится только в самой программе. В браузере файл можно лишь скачать.';
  }
  if (!o.packaged) return 'Это режим разработки — обновление здесь не ставится.';
  if (!o.fileUrl) {
    return 'У релиза нет файла. Владельцу Flux нужно загрузить подписанный exe в общую базу.';
  }
  if (!o.portable) {
    return 'Программа запущена не портативным файлом — обновление поставит обычный установщик.';
  }
  return '';
}

/**
 * Номер версии из имени собранного файла: `Flux-0.90.0-x64.exe` → `0.90.0`.
 *
 * Нужно затем, чтобы номер не набирали руками. Ровно на этом обновления и
 * встали: в поле версии оказалось «90», запись о релизе ушла всем, а файл лежал
 * под своим настоящим именем — и каждый сотрудник получал «файла этой версии
 * нет». Имя файла знает правду, человек — не всегда.
 */
export function versionFromFileName(name: string): string {
  // Хвост после номера — либо предвыпуск («-beta.2»), либо разрядность сборки
  // («-x64»). Второе к версии отношения не имеет и в неё попадать не должно
  const m = String(name || '')
    .match(/(\d+\.\d+\.\d+(?:-(?!x64|x86|ia32|arm64|win|setup|portable)[0-9A-Za-z.]+)?)/i);
  return m ? m[1] : '';
}

/**
 * Что не так с набранным номером версии; пустая строка — всё в порядке.
 *
 * `current` — версия запущенной программы, если её есть с чем сравнить.
 */
export function versionProblem(version: string, current?: string): string {
  const v = String(version || '').trim();
  if (!v) return 'Укажите номер версии';
  if (v.length > 40 || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v)) {
    return `«${v}» — не номер версии. Версия пишется тремя числами через точку: 0.90.0.`;
  }
  if (current && !isNewer(v, current) && v !== current) {
    return `Версия ${v} не новее запущенной (${current}) — сотрудники обновление не увидят.`;
  }
  return '';
}

/** Строка хода дела для одной кнопки: человек видит этап, а не проценты в никуда */
export type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'failed';

export function phaseLabel(phase: Phase, percent = 0): string {
  switch (phase) {
    case 'checking': return 'Сверяю версии…';
    case 'downloading': return `Скачиваю… ${Math.round(percent)}%`;
    case 'verifying': return 'Проверяю файл…';
    case 'installing': return 'Закрываюсь и обновляюсь…';
    default: return '';
  }
}
