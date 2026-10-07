/**
 * Сборка паспорта тега без сервера и базы: примечания, состав, дубли.
 * Запуск: npx tsx scripts/test-tag-passport-data.ts
 */
import { passportNotes, compositionOf, duplicatesOf, excerptAround, procurementView } from '../server/tagPassportData';

let ok = 0;
let fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { ok++; return; }
  fail++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got).slice(0, 400)}`}`);
};

const stages = [{ id: 'added', label: 'Добавлен' }, { id: 'ordered', label: 'Заказан' }];
const base = { tagId: 't1', code: 'AHU-2', stages, notebook: [], cad: [] };

console.log('Примечания');
const notes = passportNotes({
  ...base,
  meta: {
    descriptions: [
      { id: 'd1', text: 'Старое', comment: '', status: 'info', createdBy: 'А', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'd2', text: 'Новое', comment: 'пояснение', createdBy: 'Б', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-05T00:00:00.000Z', updatedBy: 'В' },
      { id: 'd3', text: '', comment: '' },
    ],
    procurement: { note: 'Ждём счёт', stageLog: { ordered: { at: '2026-02-01T00:00:00.000Z', by: 'Г' } } },
  },
  notebook: [
    { id: 'n1', title: 'Созвон', text: 'Говорили про AHU-2 и AHU-21', updatedAt: '2026-02-15T00:00:00.000Z' },
    { id: 'n2', title: 'Про соседа', text: 'Только AHU-21', updatedAt: '2026-02-16T00:00:00.000Z' },
  ],
  cad: [{ elementId: 'e1', elementName: 'бл1', at: null, tagNotes: JSON.stringify([{ identifier: 'AHU-2', verdict: 'invalid', why: 'нет слота', phrase: 'Тег AHU-2 для вентилятора' }, { identifier: 'X', verdict: 'assigned', why: '' }]) }],
  procNoteSetBy: { by: 'Д', at: '2026-02-10T00:00:00.000Z' },
});
check('пустое описание отброшено', !notes.some((n) => n.id === 'tags:d3'));
check('источники подписаны', ['Теги', 'Закупка', 'Заметки', 'САПР'].every((l) => notes.some((n) => n.sourceLabel === l)), notes.map((n) => n.sourceLabel));
check('сортировка: новые сверху, без даты — в конце', notes[0].id === 'tags:d2' && notes[notes.length - 1].source === 'cad', notes.map((n) => n.id));
check('правка комментария показана отдельно от создания', notes.find((n) => n.id === 'tags:d2')?.editedBy === 'В');
check('заметка про соседний код не приплетена', !notes.some((n) => n.id === 'notebook:n2') && notes.some((n) => n.id === 'notebook:n1'));
check('примечание закупки несёт автора из истории', notes.find((n) => n.kind === 'note')?.author === 'Д');
check('вердикт САПР словами, пустое свидетельство отброшено', notes.filter((n) => n.source === 'cad').length === 1 && notes.find((n) => n.source === 'cad')?.status === 'не принят');
check('подпись этапа — по названию, не по коду', notes.find((n) => n.kind === 'stage')?.text === 'Этап «Заказан»');
check('битый JSON САПР не роняет сборку', passportNotes({ ...base, meta: {}, cad: [{ elementId: 'e', elementName: 'x', at: null, tagNotes: '{не json' }] }).length === 0);
const long = 'а'.repeat(300) + ' AHU-2 ' + 'б'.repeat(300);
check('фрагмент заметки короткий и содержит код', excerptAround(long, 'AHU-2').includes('AHU-2') && excerptAround(long, 'AHU-2').length < 200);

console.log('Состав и дубли');
const row = (id: string, identifier: string, meta: object = {}) => ({ id, identifier, metadata: JSON.stringify(meta) });
const tags = [
  row('p', 'AHU-1', { mainName: 'Установка', connections: ['a'] }),
  row('a', 'AHU-1-F', { parentId: 'p', connections: ['m'], mainName: 'Вентилятор' }),
  row('m', 'AHU-1-M', { connections: ['a', 'p'] }),
  row('o', 'AHU-9', { parentId: 'a' }),
];
const comp = compositionOf(tags[1], tags);
check('родитель — по parentId', comp.parent?.id === 'p');
check('состав — по connections и по parentId у потомков', comp.children.map((c) => c.id).sort().join() === 'm,o');
check('цикл в данных не возвращает тег и родителя в состав потомка', comp.children.every((c) => !c.children.some((x) => x.id === 'a' || x.id === 'p')), comp.children);
const compOld = compositionOf(tags[2], tags);
check('родитель находится и по одной лишь связи у родителя', compOld.parent?.id === 'a', compOld.parent);
check('дубль: «А»/«Н» русскими — тот же код', duplicatesOf({ id: 'x', identifier: 'AHU-2' }, [row('y', 'АНU-2'), row('z', 'AHU-21')]).map((d) => d.id).join() === 'y');
check('дубль: разделитель между цифрами значим', duplicatesOf({ id: 'x', identifier: 'бл2.1' }, [row('y', 'бл21')]).length === 0);

console.log('Закупка');
const pv = procurementView({ procurement: { stage: 'ordered', supplier: 'S', stageLog: { ordered: { at: '2026-02-01T00:00:00.000Z', by: 'Г' }, added: { at: '2026-01-01T00:00:00.000Z', by: 'Г' } } } }, stages);
check('этап словами, отметки по порядку этапов', pv.stageLabel === 'Заказан' && pv.stageLog.map((l) => l.id).join() === 'added,ordered', pv);
check('без закупки — первый этап', procurementView({}, stages).stageId === 'added');

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
