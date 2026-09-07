// Тесты распознавания запросов ИИ-чата: npx tsx scripts/test-assistant.ts
import { resolveQuery } from '../src/store/assistantStore';

let ok = 0, fail = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d?: string) => { if (c) ok++; else { fail++; fails.push(`✗ ${n}${d ? ' — ' + d : ''}`); } };

const DATA: any = {
  projectId: 'p1',
  projects: [{ id: 'p1', name: 'ДГП-2', status: 'active' }],
  tags: [
    { id: 't1', identifier: '3700-K02-HV-209', brand: 'ВР-80', department: 'ОВиК', fluid: 'Воздух', mainName: 'Вентилятор вытяжной', actuality: 'critical', stageId: 'added', stageLabel: 'Добавлен', supplier: '' },
    { id: 't2', identifier: '3700-K02-HV-209', brand: 'ВР-80', department: 'ОВиК', fluid: 'Воздух', mainName: 'Вентилятор вытяжной (дубль)', actuality: 'actual', stageId: 'ordered', stageLabel: 'Заказан', supplier: 'ВЕЗА' },
    { id: 't3', identifier: '3700-C01-AHU-001', brand: 'ВЕРОСА-670', department: 'ОВиК', fluid: 'Воздух', mainName: 'Приточная установка', actuality: 'actual', stageId: 'purchased', stageLabel: 'Куплен', supplier: 'ВЕЗА' },
    { id: 't4', identifier: '3700-V03-KL-011', brand: 'КЛОП-1', department: 'ОВиК', fluid: 'Воздух', mainName: 'Клапан огнезадерживающий', actuality: 'warning', stageId: 'added', stageLabel: 'Добавлен', supplier: '' },
  ],
  components: [
    // У изделия ЕСТЬ характеристики: без них вся ветка ответов про величины
    // («какой расход у …») оставалась непроверенной, а сломать её было легко
    { id: 'c1', name: 'Двигатель вентилятора', itemCode: 'BLM-1', systemName: '3700-C01-AHU-001', category: 'AHU', monoblockName: 'M1', status: 'ok', hasConflict: false,
      tags: ['3700-C01-AHU-001'],
      specsTotal: 4,
      specs: [
        { key: 'Расход воздуха', value: '20000', unit: 'м³/ч', group: 'Аэродинамика' },
        { key: 'Мощность', value: '5.5', unit: 'кВт', group: 'Электрика' },
        { key: 'Частота вращения (nдв)', value: '1435', unit: 'об/мин', group: 'Электрика' },
        { key: 'Масса', value: '633', unit: 'кг', group: 'Конструкция' },
      ] },
  ],
  stages: [{ id: 'added', label: 'Добавлен' }, { id: 'ordered', label: 'Заказан' }, { id: 'approved', label: 'Утверждён' }, { id: 'purchased', label: 'Куплен' }],
  duplicates: [{ code: '3700-K02-HV-209', count: 2, ids: ['t1', 't2'] }],
  notes: [{ id: 'n1', title: 'Подбор калорифера для П1', updatedAt: '' }, { id: 'n2', title: 'Замечания по монтажу', updatedAt: '' }],
  recentLogs: [{ description: 'Обновлены спецификации вентилятора', userName: 'Раупов Х.Х.', targetRoute: '/equipment', createdAt: '' }],
  counts: { tags: 4, components: 1, systems: 1, users: 3, notes: 2, folders: 1, files: 5, projects: 1, duplicates: 1, critical: 1, warning: 1 },
};

const R = (text: string, last: any = null) => resolveQuery(text, false, last, DATA);
const hasAction = (m: any, kind: string) => (m.actions || []).some((a: any) => a.kind === kind);

(async () => {
  // Прямой код тега → карточка + действия
  {
    const { message, result } = await R('где 3700-K02-HV-209');
    check('код: карточка позиции', message.text.includes('3700-K02-HV-209'));
    check('код: кнопка «на холсте»', hasAction(message, 'focus-tag'));
    check('код: кнопка «найти дубли»', hasAction(message, 'find-duplicates'), JSON.stringify(message.actions));
    check('код: сохранён контекст', result?.kind === 'tags');
  }

  // Характеристики позиции: ветка, ради которой словарь и живёт в помощнике
  {
    const { message } = await R('какой расход воздуха у 3700-C01-AHU-001');
    check('характеристики: расход найден', message.text.includes('20000'), message.text);
    check('характеристики: единица названа', message.text.includes('м³/ч'), message.text);
    check('характеристики: кнопка «показать в оборудовании»', hasAction(message, 'focus-equipment'));
  }
  {
    // Опечатка не должна ломать вопрос: инженер печатает быстро
    const { message } = await R('какая мощнось у 3700-C01-AHU-001');
    check('характеристики: опечатка «мощнось» понята', message.text.includes('5.5'), message.text);
  }
  {
    // В бланках половина величин подписана обозначением, а не словом
    const { message } = await R('какой N у 3700-C01-AHU-001');
    check('характеристики: обозначение «N» понято как мощность', message.text.includes('5.5'), message.text);
  }
  {
    const { message } = await R('характеристики 3700-C01-AHU-001');
    check('характеристики: таблица целиком', !!message.table && (message.table.rows || []).length === 4, JSON.stringify(message.table?.rows?.length));
    check('характеристики: сказано, сколько показано', /показано 4 параметр/.test(message.text), message.text);
  }
  {
    // Тег есть, изделия за ним нет: раньше молча показывалась карточка тега
    // с этапом закупки, и человек считал, что ответили про расход
    const { message } = await R('какой расход у 3700-V03-KL-011');
    check('характеристики: честный ответ про отсутствие оборудования',
      /нет привязанного оборудования/.test(message.text), message.text);
    check('характеристики: и подсказано, где связать', hasAction(message, 'open-section'), JSON.stringify(message.actions));
  }

  // Дубли
  {
    const { message } = await R('покажи дубли');
    check('дубли: найдено', message.text.includes('дублей: 1') || message.text.includes('Нашёл дублей'));
    check('дубли: таблица', !!message.table);
    // Ответ раскрывает группы в отдельные экземпляры: у каждого свои кнопки —
    // общая «найти дубли» тут не нужна, нужна привязка к конкретной позиции
    const items = message.list || [];
    check('дубли: список экземпляров', items.length >= 2, String(items.length));
    check('дубли: у экземпляра «На холсте»', items.every((i: any) => (i.actions || []).some((a: any) => a.kind === 'focus-tag')));
    check('дубли: у экземпляра «Переименовать»', items.every((i: any) => (i.actions || []).some((a: any) => a.kind === 'prompt-rename-tag')));
  }
  { const { message } = await R('сколько повторов'); check('дубли синоним «повторов»', !!message.table, message.text); }

  // Проблемы / критичные
  {
    const { message } = await R('что требует внимания');
    check('проблемы: список', !!message.table && message.text.includes('внимания'), message.text);
    check('проблемы: критичный+проверить (2)', (message.table?.rows.length || 0) === 2);
  }
  { const { message } = await R('какие косяки'); check('проблемы синоним «косяки»', !!message.table, message.text); }

  // Закупки
  {
    const { message } = await R('что не заказано');
    check('закупки: не заказано (2 в added)', (message.table?.rows.length || 0) === 2, String(message.table?.rows.length));
    check('закупки: кнопка Менеджмент', hasAction(message, 'open-section'));
  }
  { const { message } = await R('что куплено'); check('закупки: куплено (1)', (message.table?.rows.length || 0) === 1, String(message.table?.rows.length)); }
  { const { message } = await R('что в просрочке'); check('закупки синоним «просрочка»', !!message.table, message.text); }

  // Сводка
  {
    const { message } = await R('сводка по проекту');
    check('сводка: показатели', message.text.includes('Тегов: 4') && message.text.includes('внимания'));
  }
  { const { message } = await R('готовность проекта'); check('сводка синоним «готовность»', message.text.includes('Тегов'), message.text); }

  // Поиск заметок
  {
    const { message } = await R('найди заметку про калорифер');
    check('заметки: найдено', message.text.includes('калорифер') || message.text.includes('Нашёл заметок'), message.text);
  }

  // История
  {
    const { message } = await R('что изменилось');
    check('история: последние изменения', message.text.includes('спецификации') || message.text.includes('изменения'), message.text);
  }

  // Поиск тегов по склонению/синониму
  {
    const { message } = await R('покажи вентиляторы');
    check('поиск: вентиляторы (склонение)', !!message.table && (message.table?.rows.length || 0) >= 2, String(message.table?.rows.length));
  }
  {
    const { message } = await R('покажи установки');
    check('поиск: установки', !!message.table, message.text);
  }

  // Навигационные команды
  {
    const { message } = await R('открой менеджмент');
    check('навигация: открой менеджмент', hasAction(message, 'open-section') && message.actions![0].route === '/management');
  }
  {
    const { message } = await R('создай заметку про клапаны');
    check('команда: создать заметку', hasAction(message, 'create-note'));
    check('команда: заголовок заметки', message.actions![0].noteTitle?.includes('клапан'), message.actions![0].noteTitle);
  }

  // Follow-up контекст
  {
    const { message } = await R('а сколько их?', { kind: 'tags', ids: ['t1', 't2', 't3'], label: 'вентиляторы' });
    check('контекст: сколько их → 3', message.text.includes('3'), message.text);
  }
  {
    const { message } = await R('выгрузи', { kind: 'tags', ids: ['t1'], label: 'вентиляторы' });
    check('контекст: выгрузи → кнопки экспорта', hasAction(message, 'export-excel'));
  }

  // Опечатки
  {
    const { message } = await R('пакажи дубли');
    check('опечатка «пакажи» всё равно дубли', !!message.table, message.text);
  }

  // Честное «не знаю»
  {
    const { message } = await R('абырвалг зюзюка мырк пщ');
    check('фоллбэк: три темы', (message.actions?.length || 0) >= 3, JSON.stringify(message.actions?.map((a:any)=>a.label)));
  }

  // Приветствие. Помощник встречал рассказом о себе на пять строк — первое,
  // что видел человек, было единственным, чего он не просил
  {
    const { helloText } = await import('../src/assistant/greeting');
    // По фамилии в отделе не здороваются, а в старых профилях есть только
    // строка ФИО: имя в ней второе слово
    check('зовёт по имени и отчеству из полей',
      helloText({ firstName: 'Хамид', middleName: 'Хамидович', name: 'Раупов Хамид Хамидович' })
        === 'Здравствуйте, Хамид Хамидович! Чем могу помочь?');
    check('разбирает старую строку ФИО',
      helloText({ name: 'Раупов Хамид Хамидович' }) === 'Здравствуйте, Хамид Хамидович! Чем могу помочь?',
      helloText({ name: 'Раупов Хамид Хамидович' }));
    check('одно слово — оно и есть имя',
      helloText({ name: 'Админ' }) === 'Здравствуйте, Админ! Чем могу помочь?', helloText({ name: 'Админ' }));
    // Служебная запись устроена не как ФИО, и второе слово в ней — не имя
    check('служебную запись не разбирает на части',
      helloText({ name: 'Главный администратор (RaupovKhKh)' })
        === 'Здравствуйте, Главный администратор (RaupovKhKh)! Чем могу помочь?',
      helloText({ name: 'Главный администратор (RaupovKhKh)' }));
    check('без имени тоже здоровается', helloText(null) === 'Здравствуйте! Чем могу помочь?');
    check('пустое место именем не считается', helloText({ name: '   ' }) === 'Здравствуйте! Чем могу помочь?');
    check('о себе больше не рассказывает', !helloText({ name: 'Иванов Иван' }).includes('понимаю обычную речь'));
  }

  console.log(`\nАссистент: пройдено ${ok}, провалено ${fail}`);
  if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
})();
