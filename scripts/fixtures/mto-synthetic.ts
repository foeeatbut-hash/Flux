/**
 * Синтетический MTO для проверки импорта Конструктора.
 *
 * Настоящего MTO в репозитории нет и быть не должно — это данные заказчика.
 * Этот повторяет его строение: шапка «Item / Поз.» на двух языках, строки
 * систем (A01, B02…), разделитель «Ventilation system», мультитеги в одной
 * ячейке, решётки DA, которые импорт обязан пропустить, код продукции.
 * Тексты описаний — из проверенных примеров test-catalog-core, размеры
 * подставляются. Код проекта 9900 выдуман.
 *
 * Запуск (записать xlsx для живого обхода):
 *   npx tsx scripts/fixtures/mto-synthetic.ts <путь.xlsx>
 */
export interface SyntheticMto {
  rows: string[][];
  /** Чего ждать от импорта */
  expect: { valveRows: number; qty: number; skipped: number; byFamily: Record<string, number> };
}

type Kind = { code: string; family: string; text: (w: number, h: number) => string; round?: boolean; product: string };

const KINDS: Kind[] = [
  { code: 'DF', family: 'КПУ-1Н', product: 'VVFIP0097', text: (w, h) => `Fire damper, rectangular cross-section;${w}x${h}(h); Fire resistance - EI 60. Function - normally open. Design - explosion proof; Damper type - duct damper Control - open/closed. electromechanical spring return actuator in explosion proof enclosure - 1pc. Rated voltage - 24 V (DC). Junction box with a terminal strip - yes / Клапан противопожарный прямоугольного сечения; ${w}x${h}(h); Предел огнестойкости - EI 60. Функциональное назначение - нормально открытый. Исполнение - взрывозащищенное` },
  { code: 'DS', family: 'КПУ-ДД', product: 'VVFIP0112', text: (w, h) => `Double acting fire fighting wheel damper ${h}(h)x${w}; Fire resistance - EI 15. Function - double acting. Design - explosion proof; Drive type - reversing drive MBE(24). Rated voltage - 24 V (DC). Junction box with a terminal strip - no` },
  { code: 'DV', family: 'ГЕРМИК-П', product: 'VFLA10003', text: (w, h) => `Damper, rectangular section ${w}x${h} with manual control ; - / Заслонка с прямоугольным сечением ${w}x${h} с ручным управлением; -` },
  { code: 'DN', family: 'ТЮЛЬПАН-1', product: 'VNRTO0000', text: (w, h) => `Check channel valve; petal; ${h}(h)x${w}; Execution - explosion-proof; Operating pressure - not more than 1500; Climatic execution UKhL2; Spatial orientation - vertical; Leakage ABAP class - 1; Control - no drive Клапан обратный канальный; лепестковый` },
  { code: 'DN', family: 'НЕРПА-КО', product: 'VNRTO0010', round: true, text: (d) => `Check channel valve; -; Ø${d}; Execution - general industrial; carbon steel with protective coating; Leakage ABAP class - 2 / Клапан обратный канальный; углеродистая сталь` },
  { code: 'DP', family: 'КИД', product: 'VIDP00002', text: (w, h) => `Overpressure valve; ${w}x${h}(h); general industrial execution; opening pressure customization range - from 20 to 150 Pa / Клапан избыточного давления` },
  { code: 'DW', family: 'ГЕРМИК-С', product: 'VFLA20001', text: (w, h) => `Heat-insulated damper, ${h}(h)x${w}, with perimeter heating, design - explosion proof; electrical/mechanical actuator without spring return - 2 pce.; rated voltage - 230 V (AC) / Клапан утепленный` },
  { code: 'DW', family: 'КЕДР-С', product: 'VFLA30001', text: (w, h) => `Air vent valve; ${h} (h) x${w} with perimeter heating; execution - general industrial; nominal voltage - 24 V (DC); leakage class - 3; junction box with terminal block - no` },
];

/** Сколько строк каждого вида: в сумме 150 строк клапанов, как у настоящего файла по порядку величины */
const PLAN: Array<[number, number]> = [[0, 70], [1, 6], [2, 30], [3, 20], [4, 5], [5, 9], [6, 6], [7, 4]];
const SIZES: Array<[number, number]> = [[900, 400], [1000, 800], [500, 500], [600, 400], [800, 600]];
const DIAMETERS = [900, 630, 400];

export function syntheticMto(): SyntheticMto {
  const rows: string[][] = [
    ['Item / Поз.', '', 'Name and technical characteristics / Наименование и техническая характеристика', 'Type, package, reference to document, data sheet / Тип,марка, обозначение документа, опросного листа', 'Product Code / Код продукции', 'Supplier / Поставщик', 'Unit of measure/ Ед. изме- рения', 'Qty / Кол.', 'Weight, kg. / Масса 1 ед., кг', 'Note / Примечание'],
    ['', '', '', '', '', '', '', '', '', ''],
    ['', '', 'Ventilation system / Система вентиляции', '', '', '', '', '', '', ''],
  ];
  const expect = { valveRows: 0, qty: 0, skipped: 0, byFamily: {} as Record<string, number> };
  let pos = 1;
  let n = 0;
  const systems = ['A01', 'B01', 'B02', 'B03', 'B04'];
  const counters: Record<string, number> = {};
  for (const [kindIdx, count] of PLAN) {
    const k = KINDS[kindIdx];
    for (let i = 0; i < count; i++, n++) {
      const sys = systems[Math.floor(n / 30) % systems.length];
      if (n % 30 === 0) rows.push(['', '', sys, '', '', '', '', '', '', '']);
      // Каждая пятая строка — два тега в одной ячейке, как в MTO
      const twin = i % 5 === 4;
      const tagOf = () => { counters[k.code] = (counters[k.code] || 0) + 1; return `9900-${sys}-${k.code}-${String(counters[k.code]).padStart(3, '0')}`; };
      const tags = twin ? [tagOf(), tagOf()] : [tagOf()];
      const [w, h] = SIZES[(i + kindIdx) % SIZES.length];
      const text = k.round ? k.text(DIAMETERS[i % DIAMETERS.length], 0) : k.text(w, h);
      rows.push([tags.join(', '), String(pos++), text, '', `${k.product}${String(i).padStart(2, '0')}`, '', 'pcs. / шт.', String(tags.length), '40', '']);
      expect.valveRows++;
      expect.qty += tags.length;
      expect.byFamily[k.family] = (expect.byFamily[k.family] || 0) + 1;
      // Решётки идут вперемешку с клапанами — импорт должен их пропустить
      if (n % 15 === 7) {
        rows.push([`9900-${sys}-DA-${String(n).padStart(3, '0')}`, String(pos++), 'Grille / Решётка 300x150', '', 'VGRIL00001', '', 'pcs. / шт.', '4', '1', '']);
        expect.skipped++;
      }
    }
  }
  return { rows, expect };
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) { console.error('Укажите путь к xlsx'); process.exit(2); }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = require('xlsx');
  const { rows, expect } = syntheticMto();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Синтетический MTO для проверки Конструктора']]), 'Title');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Specification Спецификация');
  XLSX.writeFile(wb, out);
  console.log(JSON.stringify(expect));
}
