/**
 * Откуда берётся снимок для обращения.
 *
 * Три способа, и все три — по явному действию человека. Ничего не снимается
 * само: снимок окна почти всегда содержит рабочие данные, а иногда и чужую
 * переписку в соседней панели.
 *
 * В обычном браузере по http съёмки окна нет вовсе — и обходить это не надо:
 * показываются доступные способы (вставить из буфера, выбрать файл), а не
 * кнопка, которая молча ничего не делает.
 */

import { ALLOWED_IMAGE_MIME } from '../../feedback/contracts';

export interface Shot {
  blob: Blob;
  /** Настоящий размер снимка в точках изображения. */
  width: number;
  height: number;
  /**
   * Размер в независимых точках окна.
   *
   * Нужен, чтобы посчитать фактический коэффициент из двух размеров, а не
   * умножать на `devicePixelRatio`: на втором мониторе с другим масштабом и при
   * масштабе страницы он показывает не то, и выделение уезжает тем сильнее, чем
   * дальше от начала координат.
   */
  viewport: { width: number; height: number };
}

const bridge = (): any => (window as any).electron?.ipcRenderer;

/** Съёмка своего окна доступна только в установленной программе. */
export const canCaptureWindow = (): boolean => typeof bridge()?.invoke === 'function';

/**
 * Дождаться настоящего нарисованного кадра.
 *
 * Без этого снимок делается до того, как окно перерисовалось без формы, и на
 * картинке остаётся сама форма обращения — ровно то, что человек прятал.
 * Двойной кадр здесь не суеверие: первый заканчивает текущую отрисовку, второй
 * гарантирует, что она попала на экран.
 */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 16)));
  });
}

const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => (await fetch(dataUrl)).blob();

async function ask(channel: string, region?: { x: number; y: number; width: number; height: number }): Promise<Shot> {
  const invoke = bridge()?.invoke;
  if (!invoke) throw new Error('Съёмка окна доступна только в установленной программе');
  const answer = await invoke(channel, region || null);
  if (!answer?.ok) throw new Error(answer?.error || 'Снимок не получился');
  return {
    blob: await dataUrlToBlob(String(answer.dataUrl)),
    width: Number(answer.width) || 0,
    height: Number(answer.height) || 0,
    viewport: {
      width: Number(answer.viewport?.width) || 0,
      height: Number(answer.viewport?.height) || 0,
    },
  };
}

/** Своё окно целиком. Форму прячет вызывающий — здесь только ожидание кадра. */
export async function captureWindow(): Promise<Shot> {
  await nextFrame();
  return ask('feedback:capture-window');
}

/** Выделенная часть своего окна; координаты — в точках клиентской области. */
export async function captureRegion(region: { x: number; y: number; width: number; height: number }): Promise<Shot> {
  await nextFrame();
  return ask('feedback:capture-region', region);
}

/** Картинка из буфера обмена: работает и в браузере. */
export function imageFromPaste(event: ClipboardEvent): File | null {
  const items = Array.from(event.clipboardData?.items || []);
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

/** Годится ли файл картинкой снимка. Проверка по-настоящему — на сервере. */
export const looksLikeImage = (type: string): boolean =>
  (ALLOWED_IMAGE_MIME as readonly string[]).includes(String(type).toLowerCase());
