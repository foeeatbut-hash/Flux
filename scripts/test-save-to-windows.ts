/**
 * «Выгрузить в Windows» без окна сохранения (браузер): путь в ответе — просто
 * имя файла. Раньше он собирался из `parent.name`, то есть из имени
 * окна-родителя (window.parent), и человек видел «имя фрейма/Смета.xlsx».
 */
import { saveBytes } from '../src/lib/saveToWindows';

let ok = 0; let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { ok++; console.log('✓', name); }
  else { fail++; console.error('✗', name, '\n   получено:', JSON.stringify(got), '\n   ожидалось:', JSON.stringify(want)); }
};

(async () => {
  const clicks: { href: string; download: string }[] = [];
  // Минимум браузера: ссылка для скачивания, которую можно «нажать», и window.parent с чужим именем
  (globalThis as any).document = { createElement: () => { const link: any = { click() { clicks.push({ href: link.href, download: link.download }); } }; return link; } };
  (globalThis as any).parent = { name: 'чужой-фрейм' };
  const result = await saveBytes('Смета.xlsx', new Uint8Array([1, 2, 3]));
  eq('скачивание в браузере удалось', result.ok, true);
  eq('путь в ответе — имя файла, без имени окна-родителя', result.path, 'Смета.xlsx');
  eq('браузеру отдано то же имя', clicks.map((click) => click.download), ['Смета.xlsx']);
  eq('человек не отменял, ошибки нет', [result.canceled, result.error], [false, '']);

  delete (globalThis as any).parent;
  const without = await saveBytes('Отчёт.docx', new Uint8Array([1]));
  eq('без window.parent скачивание тоже удаётся (раньше падало на ReferenceError)', [without.ok, without.path], [true, 'Отчёт.docx']);

  console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
