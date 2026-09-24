/**
 * Шаблон по умолчанию: «Бланк-заказ ВЕЗА», собранный по E06-2002.
 *
 * Состав тот же, что у принятого комплекта: титул, учёт ревизий и лист
 * «бланк-заказ» на каждый тип клапана. Отличия от ручного файла намеренные:
 *  - колонки таблицы позиций одни на все листы: Номер б/з, Наименование,
 *    Ширина, Высота, Диаметр, Кол-во, TAG (в E06 они съезжали D/E ↔ E/F);
 *  - номер бланк-заказа и строки б/з считаются, а не копируются с соседнего
 *    листа;
 *  - колонтитул берёт номер документа и ревизию из выпуска.
 */
import type { BlankTemplate, Block, FieldPair, SpecRow, TableColumn } from './model';
import { t2 } from '../model';

const f = (id: string, ru: string, en: string, value: string): FieldPair => ({ id, label: t2(ru, en), value });
const col = (id: string, ru: string, en: string, value: string, span = 1, align?: 'left' | 'center'): TableColumn =>
  ({ id, title: t2(ru, en), value, span, ...(align ? { align } : {}) });
const specRow = (key: string, ru: string, en: string, options?: string[]): SpecRow =>
  ({ id: key, label: t2(ru, en), value: `{spec.${key}.value|default:-}`, unit: t2(`{spec.${key}.unit}`, `{spec.${key}.unit}`), ...(options ? { options } : {}) });

const TITLE_BLOCK: Block = { id: 'title', type: 'title', text: t2('{family.code}', '{family.code}'), logo: 'logo', height: 3 };

const HEADER: Block = {
  id: 'header', type: 'fields', labelSpan: 1, valueSpan: 3,
  pairs: [
    f('orderNo', 'Бланк-заказ №', 'Order form No.', '{orderNo|default:-}'),
    f('date', 'от', 'dated', '{doc.date|date}'),
    f('object', 'Объект', 'Object', '{doc.object}'),
    f('subobject', 'Подобъект', 'Sub-object', '{doc.subobject|default:-}'),
    f('customer', 'Заказчик', 'Customer', '{doc.customer}'),
    f('executor', 'Исполнитель', 'Prepared by', '{doc.executor}'),
    f('phone', 'Телефон/Факс', 'Phone/Fax', '{doc.phone|default:-}'),
    f('type', 'Тип', 'Type', '{family.typeLabel}'),
  ],
};

const ITEMS: Block = {
  id: 'items', type: 'table', source: 'items', emptyText: 'Нет позиций',
  columns: [
    col('orderLine', 'Номер б/з', 'Order line', '{orderLine|default:{n}}'),
    col('designation', 'Наименование', 'Designation', '{designation}', 2, 'left'),
    col('W', 'Ширина В, мм', 'Width B, mm', '{W}'),
    col('H', 'Высота Н, мм', 'Height H, mm', '{H}'),
    col('D', 'Диаметр D, мм', 'Diameter D, mm', '{D}'),
    col('qty', 'Кол-во', 'Qty', '{qty}'),
    col('tags', 'TAG номер', 'TAG No.', '{tags|lines}', 1, 'left'),
  ],
};

const SPECS: Block = {
  id: 'specs', type: 'specs', labelSpan: 2, valueSpan: 5, unitSpan: 1,
  rows: [
    specRow('purpose', 'Назначение', 'Purpose', ['отсечной', 'регулирующий', 'обратный', 'нормально открытый', 'нормально закрытый', 'дымовой', 'двойного действия']),
    specRow('material', 'Материал изготовления', 'Material'),
    specRow('leakage', 'Класс утечки (EN 1751)', 'Leakage class (EN 1751)'),
    specRow('pressure', 'Рабочее давление', 'Operating pressure'),
    specRow('tempWork', 'Температура эксплуатации', 'Operating temperature'),
    specRow('tempStore', 'Температура хранения / консервации', 'Storage temperature'),
    specRow('fire', 'Огнестойкость по ГОСТ Р 53301', 'Fire resistance (GOST R 53301)'),
    specRow('climate', 'Климатическое исполнение ГОСТ 15150', 'Climate (GOST 15150)'),
    specRow('ex', 'Взрывозащита', 'Explosion protection', ['общепром', 'взрывозащищённый']),
    specRow('exMarking', 'Маркировка взрывозащиты', 'Ex marking'),
    specRow('blades', 'Раскрытие лопаток', 'Blade opening'),
    specRow('mechanism', 'Основной исполнительный механизм', 'Main actuator', ['-', 'ручка', 'электропривод', 'электромагнит']),
  ],
};

const ACTUATORS: Block = {
  id: 'actuators', type: 'table', source: 'actuators', visibleIf: '{hasActuators|yesno:1/}',
  title: t2('Информация по электроприводу', 'Actuator information'),
  columns: [
    col('orderLine', '№ б/з', 'Order line', '{orderLine|default:{n}}'),
    col('drive', 'Марка привода', 'Actuator model', '{drive}', 2),
    col('count', 'К-во приводов на 1 клапан, шт.', 'Actuators per damper', '{driveCount}'),
    col('actTags', 'TAG номер привода', 'Actuator TAG', '{actuatorTags|lines}', 2, 'left'),
    col('boxTags', 'Тег коробки', 'Box TAG', '{boxTags|lines|default:-}', 2, 'left'),
  ],
};

const ACT_INFO: Block = {
  id: 'actInfo', type: 'fields', labelSpan: 2, valueSpan: 6, visibleIf: '{hasActuators|yesno:1/}',
  pairs: [
    f('maker', 'Изготовитель', 'Manufacturer', '{family.manufacturer}'),
    f('voltage', 'Напряжение питания', 'Supply voltage', '{items.0.facts.voltage|suffix: В|default:-}'),
    f('switches', 'Наличие конечных выключателей', 'Limit switches', '1 открыто, 1 закрыто'),
    f('box', 'Распределительная коробка', 'Junction box', '{items.0.boxModel|default:-}'),
  ],
};

const HEATING: Block = {
  id: 'heating', type: 'table', source: 'heating', visibleIf: '{hasHeating|yesno:1/}',
  title: t2('Информация по обогреву клапана', 'Damper heating information'),
  columns: [
    col('orderLine', '№ б/з', 'Order line', '{orderLine|default:{n}}'),
    col('voltage', 'Напряжение питания, В', 'Supply voltage, V', '{heating.voltage|default:220}'),
    col('kw300', 'Номинальная мощность после 300 с, кВт', 'Rated power after 300 s, kW', '{heating.kw300|default:-}', 2),
    col('kwStart', 'Пусковая мощность, кВт', 'Starting power, kW', '{heating.kwStart|default:-}'),
    col('sections', 'Кол-во греющих секций', 'Heating sections', '{heating.sections|default:-}'),
    col('tags', 'TAG обогрева', 'Heating TAG', '{heating.tags|lines|default:-}', 2, 'left'),
  ],
};

const NAMEPLATE_NOTE: Block = {
  id: 'plateNote', type: 'text', breakBefore: true, tone: 'bold',
  title: t2('Информация по шильду клапана', 'Damper nameplate'),
  text: t2(
    '1. Клапаны изготовить с легко читаемой паспортной табличкой из нержавеющей стали, закреплённой на корпусе клапана.',
    '1. Dampers shall be supplied with a legible stainless steel nameplate fixed to the damper body.',
  ),
};

const NAMEPLATE: Block = {
  id: 'plate', type: 'fields', labelSpan: 3, valueSpan: 5,
  title: t2('Перечень информации, наносимой на паспортную табличку клапана', 'Information to be shown on the nameplate'),
  pairs: [
    f('pProject', 'Наименование проекта', 'Project name', '{doc.object}'),
    f('pContract', 'Контракт', 'Contract', '{doc.contract|default:{doc.poNo}}'),
    f('pOwner', 'Владелец', 'Owner', '{doc.owner|default:{doc.customer}}'),
    f('pContractor', 'Подрядчик', 'Contractor', '{doc.contractor}'),
    f('pMaker', 'Изготовитель', 'Manufacturer', '{family.manufacturer}'),
    f('pOrder', 'Заказ покупателя', 'Buyer order', '{orderNo|default:ХХХХХХХ}'),
    f('pTag', 'TAG-номер', 'TAG number', 'ХХХХХХХ'),
    f('pSerial', 'Заводской номер', 'Serial number', 'ХХХХХХХ'),
    f('pType', 'Обозначение типа', 'Type designation', 'Клапан / Damper'),
    f('pStd', 'Стандарт изготовления', 'Design standard', '{family.standard|default:ХХХХХХХ}'),
    f('pSheet', 'Опросный лист', 'Data sheet', '{doc.docNo}'),
    f('pWeight', 'Масса', 'Total weight', 'ХХХХХХХ'),
    f('pDate', 'Месяц / год изготовления', 'Month / Year', 'ХХХХХХХ'),
    f('pCountry', 'Страна изготовления', 'Producing country', 'Россия / Russia'),
  ],
};

export function defaultBlankTemplate(): BlankTemplate {
  return {
    version: 1,
    name: 'Бланк-заказ ВЕЗА',
    columns: [20, 23, 24, 16, 16, 16, 11, 22],
    style: { font: 'Arial', size: 10, titleSize: 16, headFill: 'D9E2F3', labelFill: 'F2F2F2', border: 'thin' },
    page: {
      paper: 'A4', orientation: 'portrait', fitWidth: true,
      margins: { top: 15, bottom: 15, left: 15, right: 10 },
      footer: { center: 'Стр. / Page {page} из / of {pages}', right: '{doc.docNo}{doc.rev|prefix:_}' },
    },
    sheets: [
      {
        id: 'cover', name: 'Титул', repeat: 'none',
        blocks: [
          { id: 'coverTitle', type: 'title', text: t2('Листы технических данных на клапаны', 'Valve Data Sheets'), logo: 'logo', height: 3 },
          {
            id: 'coverFields', type: 'fields', labelSpan: 2, valueSpan: 6,
            pairs: [
              f('cObject', 'Объект', 'Plant', '{doc.object}'),
              f('cPlant', 'Установка', 'Unit', '{doc.plant|default:-}'),
              f('cContractor', 'Подрядчик', 'Contractor', '{doc.contractor}'),
              f('cOwner', 'Владелец', 'Owner', '{doc.owner|default:{doc.customer}}'),
              f('cCPN', 'Номер проекта подрядчика', 'Contractor project No.', '{doc.contractorProjectNo|default:-}'),
              f('cOPN', 'Номер проекта владельца', 'Owner project No.', '{doc.ownerProjectNo|default:-}'),
              f('cVendor', 'Поставщик', 'Vendor', '{doc.vendor|default:ООО «ВЕЗА»}'),
              f('cPO', 'Номер заказа (PO)', 'Purchase order', '{doc.poNo|default:-}'),
              f('cMR', 'Номер заявки (MR)', 'Material requisition', '{doc.mrNo|default:-}'),
              f('cTag', 'TAG', 'TAG', 'Все позиции / All items'),
              f('cDoc', 'Номер документа', 'Document No.', '{doc.docNo}'),
            ],
          },
          {
            id: 'coverFamilies', type: 'table', source: 'families', title: t2('Состав комплекта', 'Contents'),
            columns: [
              col('code', 'Лист', 'Sheet', '{code}', 2),
              col('type', 'Тип', 'Type', '{typeLabel}', 3, 'left'),
              col('order', 'Бланк-заказ №', 'Order form No.', '{orderNo|default:-}', 1),
              col('items', 'Позиций', 'Lines', '{items}'),
              col('qty', 'Штук', 'Qty', '{qty}'),
            ],
          },
          {
            id: 'coverRevs', type: 'table', source: 'revisions', title: t2('Выпуски', 'Issues'), emptyText: 'Первый выпуск',
            columns: [
              col('rev', 'Рев.', 'Rev.', '{rev}'),
              col('date', 'Дата', 'Date', '{date|date}'),
              col('reason', 'Назначение выпуска', 'Reason for issue', '{reason}', 3, 'left'),
              col('prepared', 'Разработал', 'Prepared', '{prepared}'),
              col('checked', 'Проверил', 'Checked', '{checked}'),
              col('approved', 'Утвердил', 'Approved', '{approved}'),
            ],
          },
          {
            id: 'codes', type: 'text', tone: 'note',
            text: t2(
              'Коды рассмотрения: A — принято; B — принято с замечаниями; C — не принято, переработать; D — для информации; Q — вопрос.',
              'Review codes: A — accepted; B — accepted with comments; C — rejected, revise; D — for information; Q — query.',
            ),
          },
        ],
      },
      {
        id: 'revisions', name: 'Учёт ревизий', repeat: 'none',
        blocks: [
          { id: 'revTitle', type: 'title', text: t2('Учёт ревизий', 'Record of revisions') },
          {
            id: 'revTable', type: 'table', source: 'revisions', emptyText: 'Первый выпуск',
            columns: [
              col('rev', 'Ред. №', 'Rev. No.', '{rev}'),
              col('date', 'Дата', 'Date', '{date|date}'),
              col('reason', 'Описание изменения', 'Description of change', '{reason}', 6, 'left'),
            ],
          },
        ],
      },
      {
        id: 'order', name: '{family.code}{execSuffix}', repeat: 'family-exec', printTitleRows: 3,
        blocks: [TITLE_BLOCK, HEADER, ITEMS, SPECS, ACTUATORS, ACT_INFO, HEATING, NAMEPLATE_NOTE, NAMEPLATE],
      },
    ],
  };
}

/** Пустой шаблон для «Создать с нуля»: одна таблица позиций на лист */
export function emptyBlankTemplate(): BlankTemplate {
  const t = defaultBlankTemplate();
  return {
    ...t,
    name: 'Новый шаблон',
    sheets: [{ id: 'order', name: '{family.code}', repeat: 'family', blocks: [TITLE_BLOCK, HEADER, ITEMS] }],
  };
}
