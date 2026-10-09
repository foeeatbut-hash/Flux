/** Проверяет полный экспорт тегов и выбор обычных и добавочных полей. */
import { buildTagExchange, tagExchangeColumns } from '../src/lib/tagExchange';

let failed = 0;
const check = (name: string, condition: boolean, got?: unknown) => {
  if (condition) return;
  failed++;
  console.error(`  ✗ ${name}${got === undefined ? '' : ` — получили ${JSON.stringify(got)}`}`);
};

const tags = [
  {
    id: 'a', identifier: 'P-1', brand: 'Марка', department: 'ОВ', wbs: '1.2', fluid: 'Воздух', projectId: 'project-a', equipmentId: 'equipment-a', createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-03T04:05:06.000Z',
    metadata: JSON.stringify({ mainName: 'Вентилятор', descriptions: [{ status: 'critical' }], dynamicFields: { Взрыв: 'Да', Мощность: '2 кВт' }, customFlag: true }),
  },
  { id: 'b', identifier: 'P-2', metadata: JSON.stringify({ dynamicFields: { Взрыв: 'Нет' } }) },
];
const helpers = {
  lineage: (id: string) => id === 'a' ? 'P-1' : 'P-2',
  meta: (tag: any) => JSON.parse(tag.metadata),
  status: (tag: any) => JSON.parse(tag.metadata).descriptions?.some((item: any) => item.status === 'critical') ? 'critical' : 'draft',
};
const columns = tagExchangeColumns(tags);
check('добавочное поле Взрыв доступно отдельно', columns.some((column) => column.key === 'dynamic:Взрыв'));
check('неизвестный ключ metadata доступен отдельно', columns.some((column) => column.key === 'meta:customFlag'));
check('полный экспорт выбранного набора содержит каждое поле', columns.length >= 16);

const whole = buildTagExchange(tags, columns, helpers);
check('код и обычное поле попадают в экспорт', whole.rows[0][whole.headers.indexOf('Код тега')] === 'P-1'
  && whole.rows[0][whole.headers.indexOf('Марка')] === 'Марка');
check('наименование берётся из metadata отдельной колонкой', whole.rows[0][whole.headers.indexOf('Наименование')] === 'Вентилятор');
check('статус выводится понятной русской подписью', whole.rows[0][whole.headers.indexOf('Актуальность')] === 'Критично'
  && whole.rows[1][whole.headers.indexOf('Актуальность')] === 'Устарело');
check('базовые идентификаторы и даты Tag экспортируются', whole.rows[0][whole.headers.indexOf('ID проекта')] === 'project-a'
  && whole.rows[0][whole.headers.indexOf('ID оборудования')] === 'equipment-a'
  && whole.rows[0][whole.headers.indexOf('Создан')] === '2026-01-02T03:04:05.000Z');
check('взрывозащита выгружается для обоих тегов', whole.rows[0][whole.headers.indexOf('Взрыв')] === 'Да'
  && whole.rows[1][whole.headers.indexOf('Взрыв')] === 'Нет');
check('экспорт сохраняет все метаданные целиком', whole.rows[0][whole.headers.indexOf('Метаданные целиком')].includes('customFlag'));
check('выбранные поля ограничивают заголовки и значения', (() => {
  const selected = buildTagExchange(tags, columns.filter((column) => ['identifier', 'dynamic:Взрыв'].includes(column.key)), helpers);
  return selected.headers.join('|') === 'Код тега|Взрыв' && selected.rows[0].join('|') === 'P-1|Да';
})());
check('пустое дополнительное поле остаётся пустым', whole.rows[1][whole.headers.indexOf('Метаданные · customFlag')] === '');

console.log(`\nПроверка экспорта тегов: ${failed ? `${failed} провалено` : 'всё пройдено'}`);
process.exit(failed ? 1 : 0);
