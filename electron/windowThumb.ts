/**
 * Уменьшенный снимок окна программы для панели задач.
 *
 * Отдельный модуль, а не добавка к `feedbackCapture.ts`: тот отдаёт крупный PNG
 * для обращения, а здесь нужна крошечная JPEG-картинка, которую просят десятки
 * раз в минуту при наведении мыши. Правило доступа то же жёсткое: снимается
 * окно ОТПРАВИТЕЛЯ, чужой номер окна из запроса не принимается.
 *
 * Снимок берётся из страницы (`capturePage`), а не с экрана: окна Flux — это
 * разметка внутри одной страницы, и системный снимок области вместе с
 * чужими программами и подсказками тут был бы лишним и небезопасным.
 */
import { ipcMain, BrowserWindow } from 'electron';
import { fitRegion } from './feedbackCapture';

/** Дольше ширины карточки на панели картинке незачем: лишний вес по IPC */
const MAX_W = 480;
const MIN_W = 48;

export function setupWindowThumb(): void {
  ipcMain.handle('taskbar:window-thumb', async (event: any, raw: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: 'Окно не найдено' };
    try {
      const bounds = win.getContentBounds();
      const region = fitRegion(raw, { width: bounds.width, height: bounds.height });
      if (!region) return { ok: false, error: 'Область слишком мала' };
      const wanted = Number((raw as any)?.maxWidth);
      const target = Math.max(MIN_W, Math.min(MAX_W, Number.isFinite(wanted) ? Math.round(wanted) : 320));
      const image = await win.webContents.capturePage(region);
      const size = image.getSize();
      if (!size.width || !size.height) return { ok: false, error: 'Снимок вышел пустым' };
      // Уменьшаем в основном процессе: через IPC идёт готовая мелочь, а не кадр
      // в натуральную величину
      const small = size.width > target ? image.resize({ width: target, quality: 'good' }) : image;
      const out = small.getSize();
      return { ok: true, dataUrl: `data:image/jpeg;base64,${small.toJPEG(72).toString('base64')}`, width: out.width, height: out.height };
    } catch (error: any) {
      return { ok: false, error: String(error?.message || error) };
    }
  });
}
