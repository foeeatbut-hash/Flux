/**
 * Прежние замечания Просмотра → пометки в самом PDF (редактор Flux Office).
 *
 * Просмотр хранил пометку в долях страницы, как её видно на экране: (0,0) —
 * левый верхний угол повёрнутой страницы. PDF мерит точками от левого
 * нижнего угла листа, до поворота. Здесь — пересчёт и выбор вида пометки;
 * записывает сервер (server/routes/pdfMarkupTransfer.ts) родным кодом
 * редактора.
 *
 * Перо в Просмотре хранило только рамку, без линии, — оно переносится рамкой.
 * Текст замечания едет запиской с именем автора: так его видно в любом
 * просмотрщике PDF.
 */

export interface LegacyMarkup {
  id: string;
  page: number;
  kind: string;
  x: number; y: number; w: number; h: number;
  color: string;
  strokeWidth?: number;
  text?: string | null;
  state?: string;
  createdAt?: string;
  createdBy?: { name?: string } | null;
}

/** Страница PDF: /MediaBox (view) и поворот в градусах */
export interface PageBox { view: [number, number, number, number]; rotate: number }

export type Drawing =
  | { kind: 'rect'; pageIndex: number; color: [number, number, number]; width: number; rect: [number, number, number, number] }
  | { kind: 'arrow'; pageIndex: number; color: [number, number, number]; width: number; from: [number, number]; to: [number, number] }
  | { kind: 'note'; pageIndex: number; color: [number, number, number]; at: [number, number]; contents: string; author?: string; createdMs?: number };

/** Доля страницы на экране → точка PDF */
export function toPdfPoint(fx: number, fy: number, box: PageBox): [number, number] {
  const [x0, y0, x1, y1] = box.view;
  const W = x1 - x0, H = y1 - y0;
  switch (((box.rotate % 360) + 360) % 360) {
    // Лист повёрнут по часовой: слева направо на экране — снизу вверх на листе
    case 90: return [x0 + fy * W, y0 + fx * H];
    case 180: return [x1 - fx * W, y0 + fy * H];
    case 270: return [x1 - fy * W, y1 - fx * H];
    default: return [x0 + fx * W, y1 - fy * H];
  }
}

export function hexColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const v = m ? parseInt(m[1], 16) : 0xbe123c;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const STATE: Record<string, string> = { DONE: 'Учтено', REJECTED: 'Отклонено' };

/** Рамка из двух углов: PDF хочет [x1,y1,x2,y2] с меньшими первыми */
function rectOf(m: LegacyMarkup, box: PageBox): [number, number, number, number] {
  const a = toPdfPoint(m.x, m.y, box), b = toPdfPoint(m.x + m.w, m.y + m.h, box);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** Пометки для одного замечания. Страницы нет в файле — замечание пропускается */
export function drawingsFor(m: LegacyMarkup, pages: PageBox[]): Drawing[] {
  const pageIndex = Math.max(0, Math.round(m.page) - 1);
  const box = pages[pageIndex];
  if (!box) return [];
  const color = hexColor(m.color);
  const width = Math.min(12, Math.max(0.5, Number(m.strokeWidth) || 2));
  const author = m.createdBy?.name || undefined;
  const createdMs = m.createdAt ? Date.parse(m.createdAt) || undefined : undefined;
  const text = String(m.text || '').trim();
  const state = STATE[m.state || ''];
  const say = (body: string) => (state ? `${state}: ${body}` : body);
  const note = (contents: string): Drawing => ({
    kind: 'note', pageIndex, color, at: toPdfPoint(m.x, m.y, box), contents: say(contents),
    ...(author ? { author } : {}), ...(createdMs ? { createdMs } : {}),
  });
  switch (m.kind) {
    case 'ARROW': {
      const out: Drawing[] = [{ kind: 'arrow', pageIndex, color, width, from: toPdfPoint(m.x, m.y, box), to: toPdfPoint(m.x + m.w, m.y + m.h, box) }];
      return text ? [...out, note(text)] : out;
    }
    case 'NOTE': return [note(text || 'Замечание')];
    case 'STAMP': return [note(text ? `Штамп: ${text}` : 'Штамп')];
    case 'SIGN': return [note(`Подпись${author ? `: ${author}` : ''}${text ? ` — ${text}` : ''}`)];
    // Облако, рамка и перо — рамкой; текст — запиской в её углу
    default: {
      const out: Drawing[] = [{ kind: 'rect', pageIndex, color, width, rect: rectOf(m, box) }];
      return text ? [...out, note(text)] : out;
    }
  }
}
