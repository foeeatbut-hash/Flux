/**
 * Перенос прежних замечаний Просмотра в сам PDF: пересчёт и выбор пометки.
 *
 * Что стережёт (src/lib/pdfMarkupTransfer.ts, server/routes/pdfMarkupTransfer.ts):
 *   - доли экрана переводятся в точки PDF с учётом поворота страницы — иначе
 *     облако на повёрнутом чертеже легло бы не туда;
 *   - облако, рамка и перо → рамка, стрелка → стрелка, записка/штамп/подпись →
 *     записка; текст замечания едет запиской с именем автора;
 *   - «учтено» и «отклонено» не теряются: они в тексте записки;
 *   - замечание на странице, которой в файле нет, пропускается;
 *   - сервер пропускает только проверенные фигуры.
 *
 * Запуск: npx tsx scripts/test-pdf-markup-transfer.ts
 */
import { toPdfPoint, hexColor, drawingsFor, type PageBox, type LegacyMarkup } from '../src/lib/pdfMarkupTransfer';
import { cleanDrawing } from '../server/routes/pdfMarkupTransfer';

let f = 0;
const ok = (n: string, c: boolean, d?: unknown) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d === undefined ? '' : JSON.stringify(d))));
const near = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

const A4: PageBox = { view: [0, 0, 595, 842], rotate: 0 };

console.log('1. Точки PDF');
ok('левый верхний угол экрана — верх листа', near(toPdfPoint(0, 0, A4), [0, 842]));
ok('правый нижний — начало координат справа', near(toPdfPoint(1, 1, A4), [595, 0]));
ok('середина — середина', near(toPdfPoint(0.5, 0.5, A4), [297.5, 421]));
const shifted: PageBox = { view: [10, 20, 110, 220], rotate: 0 };
ok('лист со сдвинутым /MediaBox', near(toPdfPoint(0, 0, shifted), [10, 220]) && near(toPdfPoint(1, 1, shifted), [110, 20]));
const r90: PageBox = { view: [0, 0, 595, 842], rotate: 90 };
ok('поворот 90: левый верх экрана — левый низ листа', near(toPdfPoint(0, 0, r90), [0, 0]));
ok('поворот 90: вправо по экрану — вверх по листу', near(toPdfPoint(1, 0, r90), [0, 842]));
ok('поворот 90: вниз по экрану — вправо по листу', near(toPdfPoint(0, 1, r90), [595, 0]));
const r180: PageBox = { view: [0, 0, 595, 842], rotate: 180 };
ok('поворот 180: левый верх экрана — правый низ листа', near(toPdfPoint(0, 0, r180), [595, 0]));
const r270: PageBox = { view: [0, 0, 595, 842], rotate: 270 };
ok('поворот 270: левый верх экрана — правый верх листа', near(toPdfPoint(0, 0, r270), [595, 842]));
ok('поворот −90 — то же, что 270', near(toPdfPoint(0.3, 0.7, { ...r270, rotate: -90 }), toPdfPoint(0.3, 0.7, r270)));

console.log('\n2. Цвет');
ok('#be123c', near(hexColor('#be123c'), [0xbe / 255, 0x12 / 255, 0x3c / 255]));
ok('непонятный цвет — красный замечаний', near(hexColor('жёлтый'), hexColor('#be123c')));

console.log('\n3. Вид пометки');
const base: LegacyMarkup = { id: 'm', page: 1, kind: 'CLOUD', x: 0.1, y: 0.1, w: 0.2, h: 0.1, color: '#be123c', strokeWidth: 2, createdBy: { name: 'Иванов И.' }, createdAt: '2026-09-01T10:00:00Z' };
const cloud = drawingsFor({ ...base, text: 'Нет отметки уровня' }, [A4]);
ok('облако — рамкой и запиской с текстом', cloud.length === 2 && cloud[0].kind === 'rect' && cloud[1].kind === 'note', cloud.map((d) => d.kind));
const rect = cloud[0] as any;
ok('рамка в точках PDF, меньший угол первым', rect.rect[0] < rect.rect[2] && rect.rect[1] < rect.rect[3] && near(rect.rect, [59.5, 673.6, 178.5, 757.8]), rect.rect);
const note = cloud[1] as any;
ok('записка с именем автора и временем', note.author === 'Иванов И.' && note.createdMs === Date.parse('2026-09-01T10:00:00Z'));
ok('без текста — только рамка', drawingsFor(base, [A4]).length === 1);
const arrow = drawingsFor({ ...base, kind: 'ARROW' }, [A4])[0] as any;
ok('стрелка — стрелкой, от начала к концу', arrow.kind === 'arrow' && near(arrow.from, [59.5, 757.8]) && near(arrow.to, [178.5, 673.6]), arrow);
ok('записка без текста — «Замечание»', (drawingsFor({ ...base, kind: 'NOTE' }, [A4])[0] as any).contents === 'Замечание');
ok('штамп — запиской «Штамп: …»', (drawingsFor({ ...base, kind: 'STAMP', text: 'Согласовано' }, [A4])[0] as any).contents === 'Штамп: Согласовано');
ok('подпись — с именем', (drawingsFor({ ...base, kind: 'SIGN' }, [A4])[0] as any).contents === 'Подпись: Иванов И.');
ok('перо — рамкой (линии у пера в Просмотре не было)', drawingsFor({ ...base, kind: 'PEN' }, [A4])[0].kind === 'rect');
ok('учтённое помечено в тексте', (drawingsFor({ ...base, kind: 'NOTE', text: 'ок', state: 'DONE' }, [A4])[0] as any).contents === 'Учтено: ок');
ok('отклонённое — тоже', (drawingsFor({ ...base, kind: 'NOTE', text: 'нет', state: 'REJECTED' }, [A4])[0] as any).contents === 'Отклонено: нет');
ok('страницы нет в файле — пропуск', drawingsFor({ ...base, page: 3 }, [A4]).length === 0);

console.log('\n4. Сервер принимает только проверенное');
ok('рамка проходит', !!cleanDrawing(cloud[0]));
ok('записка проходит, текст обрезается до 4000', (cleanDrawing({ ...note, contents: 'а'.repeat(5000) }) as any)?.contents.length === 4000);
ok('чужой вид — отказ', cleanDrawing({ kind: 'image', pageIndex: 0, color: [1, 0, 0], image: 'x', rect: [0, 0, 1, 1] }) === null);
ok('цвет вне 0..1 — отказ', cleanDrawing({ ...rect, color: [255, 0, 0] }) === null);
ok('не число в рамке — отказ', cleanDrawing({ ...rect, rect: [0, 0, 'a', 1] }) === null);
ok('пустая записка — отказ', cleanDrawing({ ...note, contents: '  ' }) === null);
ok('отрицательная страница — отказ', cleanDrawing({ ...rect, pageIndex: -1 }) === null);

console.log(f ? `\nПРОВАЛОВ: ${f}` : '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ');
process.exit(f ? 1 : 0);
