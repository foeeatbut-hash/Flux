/**
 * Снимок окна для обращения.
 *
 * Отдельный модуль, а не добавка к `electron/capture.ts`: у того своя корзина,
 * свои команды и распознавание, и предложение «приложить снимок» не должно
 * ничего из этого запускать. Пересечение здесь было бы дефектом, который
 * замечают поздно: сотрудник прикладывает картинку к идее, а у него меняются
 * теги в проекте.
 *
 * Правило доступа простое и жёсткое: снимается ОКНО ОТПРАВИТЕЛЯ. Номер чужого
 * окна из запроса не принимается вовсе — иначе любая страница, открытая внутри
 * встроенного браузера, смогла бы попросить снимок соседнего окна с чужой
 * перепиской. Весь рабочий стол сюда тоже не входит: это отдельный явный выбор
 * человека, а не побочный результат нажатия «приложить снимок».
 */

import { ipcMain, BrowserWindow } from 'electron';

/** Меньше этого выделять нечего: попадёт случайное движение мышью. */
const MIN_REGION = 16;

interface Region { x: number; y: number; width: number; height: number }

/** Целое неотрицательное число или ноль: из окна приходит что угодно. */
const whole = (value: unknown): number => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Уложить выделение внутрь окна.
 *
 * Выделение приходит в независимых точках (DIP) клиентской области — тех же, в
 * которых работает разметка. Пересчёт в настоящие пиксели делает Electron: он
 * знает масштаб именно этого экрана, а окно на втором мониторе с другим
 * масштабом посчитало бы это неверно.
 */
export function fitRegion(raw: any, bounds: { width: number; height: number }): Region | null {
  const x = Math.max(0, Math.min(whole(raw?.x), bounds.width));
  const y = Math.max(0, Math.min(whole(raw?.y), bounds.height));
  const width = Math.min(whole(raw?.width), bounds.width - x);
  const height = Math.min(whole(raw?.height), bounds.height - y);
  if (width < MIN_REGION || height < MIN_REGION) return null;
  return { x, y, width, height };
}

/**
 * Снять окно отправителя целиком или его часть.
 *
 * Возвращается PNG строкой data:. Через файл на диске делать нельзя: снимок
 * почти всегда содержит рабочие данные, и оставлять его во временной папке
 * после отправки — тихая утечка, о которой никто не вспомнит.
 *
 * `raw` пустой — снимаем окно целиком; заданный, но негодный — отказываем.
 * Подставлять вместо непонятного выделения всё окно нельзя: человек увидел бы
 * в предпросмотре не то, что выделял, и приложил бы лишнее.
 */
async function capture(event: any, raw: unknown, needRegion: boolean): Promise<any> {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) return { ok: false, error: 'Окно не найдено' };
  try {
    const bounds = window.getContentBounds();
    const box = { width: bounds.width, height: bounds.height };
    const wants = needRegion || !!raw;
    const region = wants ? fitRegion(raw, box) : null;
    if (wants && !region) return { ok: false, error: `Выделение меньше ${MIN_REGION}×${MIN_REGION} точек` };

    const image = region
      ? await window.webContents.capturePage(region)
      : await window.webContents.capturePage();
    const size = image.getSize();
    if (!size.width || !size.height) return { ok: false, error: 'Снимок вышел пустым' };
    return {
      ok: true,
      dataUrl: image.toDataURL(),
      width: size.width, height: size.height,
      // Размер в независимых точках нужен окну, чтобы посчитать настоящий
      // коэффициент, а не умножать вслепую на devicePixelRatio
      viewport: region ? { width: region.width, height: region.height } : box,
    };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export function setupFeedbackCapture(): void {
  ipcMain.handle('feedback:capture-window', (event: any, raw: unknown) => capture(event, raw, false));
  ipcMain.handle('feedback:capture-region', (event: any, raw: unknown) => capture(event, raw, true));
}
