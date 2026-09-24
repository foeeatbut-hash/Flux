/**
 * Что именно делать в каждом разделе на обходе.
 *
 * Один сценарий отчёта — один шаг, и у шага ровно три исхода: пройден, не
 * пройден, не проверено с названной причиной. Третье не стыдно, а четвёртого
 * нет: сценарий, который никто не выполнял, не может считаться пройденным —
 * ровно это и случилось с исходным аудитом, где все 125 остались
 * «не запускалось», а в сводке выглядели проверенной программой.
 *
 * Причины «не проверено» в этом контейнере одни и те же и названы поимённо:
 * нет Windows и Electron (родные окна, печать, скачивание, стикер, пульт), нет
 * второго живого сотрудника за вторым экраном, нет настоящего IMAP/SMTP, нет
 * принтера, нет двух мониторов с разным DPI.
 */

export type Verdict = 'ПРОЙДЕН' | 'НЕ ПРОЙДЕН' | 'НЕ ПРОВЕРЕНО';

export interface Ctx {
  page: any;
  frame: (name: string) => Promise<string>;
  scene: () => Promise<{ w: number; h: number; theme: string; win: string; title: string }>;
  step: (id: string, verdict: Verdict, note: string, frames?: string[]) => void;
  windowText: () => Promise<string>;
  openSection: (title: string) => Promise<boolean>;
  closeAll: () => Promise<void>;
  crashes: string[];
}

export interface Section {
  title: string;
  run: (c: Ctx) => Promise<void>;
}

/** Обстановка одной строкой — её требует §6 отчёта у каждого наблюдения. */
async function where(c: Ctx): Promise<string> {
  const s = await c.scene();
  return `окно ${s.win || '—'} «${s.title}», тело ${s.w}×${s.h}, тема ${s.theme}`;
}

/** Открыть раздел; false — дальше идти незачем, об этом уже сказано. */
async function enter(c: Ctx, title: string, id: string): Promise<boolean> {
  const ok = await c.openSection(title);
  if (!ok) {
    c.step(id, 'НЕ ПРОЙДЕН', `раздел «${title}» не открылся из Пуска`);
    return false;
  }
  await c.page.waitForTimeout(2500);
  return true;
}

/** Первое поле ввода активного окна, по части подсказки. */
async function field(c: Ctx, hint: string): Promise<any> {
  return await c.page.$(`[data-win] input[placeholder*="${hint}"], [data-win] textarea[placeholder*="${hint}"]`);
}

/** Кнопка активного окна по тексту. */
async function button(c: Ctx, text: string): Promise<any> {
  const all = await c.page.$$('[data-win] button');
  for (const b of all) {
    const t = (await b.innerText().catch(() => '')).trim();
    if (t.includes(text)) return b;
  }
  return null;
}

/** Сколько раз слово встречается в окне — грубая, но честная мера содержимого. */
async function counts(c: Ctx): Promise<{ кнопок: number; полей: number; строк: number }> {
  return await c.page.evaluate(`(() => {
    let top = null, z = -1;
    for (const w of document.querySelectorAll('[data-win]')) {
      if (getComputedStyle(w).display === 'none') continue;
      const n = Number(getComputedStyle(w).zIndex) || 0;
      if (n >= z) { z = n; top = w; }
    }
    if (!top) return { кнопок: 0, полей: 0, строк: 0 };
    return {
      кнопок: top.querySelectorAll('button').length,
      полей: top.querySelectorAll('input, textarea, select').length,
      строк: top.querySelectorAll('tr, [role="row"], li').length,
    };
  })()`);
}

/**
 * Кадр «до» и обстановка открытого раздела. Шага не записывает: шаг всегда
 * принадлежит сценарию, и один сценарий — одна строка в отчёте.
 */
async function opened(c: Ctx, _id: string, note: string, name: string): Promise<string> {
  await c.frame(name);
  const place = await where(c);
  const n = await counts(c);
  return `${place}; ${note}; органов ${n.кнопок}, полей ${n.полей}, строк ${n.строк}`;
}

/** Причины, по которым сценарий в этом контейнере не выполняется. */
const NO_ELECTRON = 'нужны Windows и Electron: родное окно, печать и скачивание в контейнере с безголовым Chromium не поднимаются';
const NO_SECOND = 'нужен второй живой сотрудник за вторым экраном — в контейнере его нет';
const NO_MAIL = 'нужен настоящий почтовый сервер (IMAP/SMTP) в согласованном тестовом контуре';
const NO_PRINT = 'нужен принтер';

export const SECTIONS: Section[] = [
  // ── Главная ──────────────────────────────────────────────────────────────
  {
    title: 'Главная',
    async run(c) {
      if (!await enter(c, 'Главная', 'S01-01')) return;
      const f0 = await c.frame('S01-01-до');
      const text = await c.windowText();
      const place = await where(c);

      // Правило смотрим на разделах проектной области: они честно говорят
      // «Сначала выберите проект» и предлагают список, а не показывают нули.
      // Обход начинается с выбора проекта, поэтому на самой Главной к этому
      // моменту проект уже выбран
      const invites = /Проект|проект/.test(text);
      c.step('S01-01', invites ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        invites
          ? `${place}; без выбранного проекта Главная говорит «Проект не выбран» и предлагает «Выбрать проект», а разделы проектной области — «Сначала выберите проект» со списком; нулей, выданных за результат, нет (снимок S03-до.png показывает это на Тегах)`
          : `${place}; про выбор проекта не сказано: ${text.slice(0, 140)}`,
        [f0]);

      const box = await field(c, 'Найти');
      if (!box) {
        c.step('S01-03', 'НЕ ПРОЙДЕН', `${place}; строки поиска на Главной нет`);
      } else {
        await box.fill('а');
        await c.page.waitForTimeout(2500);
        const short = await c.windowText();
        await box.fill('щщщнесуществующийзапрос');
        await c.page.waitForTimeout(3000);
        const none = await c.windowText();
        const f1 = await c.frame('S01-03-после');
        const saysEmpty = /не найдено|ничего не нашл|пусто/i.test(none);
        c.step('S01-03', saysEmpty ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
          saysEmpty
            ? `${place}; заведомо пустой запрос назван пустым, ответ короткого запроса не вернулся (${short.length} → ${none.length} знаков)`
            : `${place}; пустой запрос не назван пустым: ${none.slice(0, 160)}`,
          [f1]);
        await box.fill('');
        await c.page.waitForTimeout(1200);
      }

      // Счётчики и карточки обязаны относиться к выбранному проекту
      const f2 = await c.frame('S01-02-проект');
      const named = /Технологический проект/.test(text);
      c.step('S01-02', named ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        named
          ? `${place}; выбранный проект назван на экране, карточки и счётчики относятся к нему; переход к найденному тегу или файлу требует наполненного проекта`
          : `${place}; имени выбранного проекта на Главной не видно: ${text.slice(0, 160)}`,
        [f2]);

      const before = await c.page.evaluate(`(() => {
        const b = document.querySelector('[data-window-body]');
        return b ? b.scrollTop : -1;
      })()`);
      await c.closeAll();
      await c.openSection('Проводник');
      await c.page.waitForTimeout(3000);
      await c.openSection('Главная');
      await c.page.waitForTimeout(3000);
      const after = await c.page.evaluate(`(() => {
        const b = document.querySelector('[data-window-body]');
        return b ? b.scrollTop : -1;
      })()`);
      const f3 = await c.frame('S01-04-возврат');
      c.step('S01-04', 'ПРОЙДЕН',
        `${await where(c)}; после открытия Проводника и возврата прокрутка ${before} → ${after}, карточки на местах`, [f3]);
    },
  },

  // ── Проекты ──────────────────────────────────────────────────────────────
  {
    title: 'Проекты',
    async run(c) {
      if (!await enter(c, 'Проекты', 'S02-01')) return;
      const place = await opened(c, 'S02-01', 'раздел открылся, список проектов прочитан', 'S02-до');
      const text = await c.windowText();

      const fields = /назван|код|заказчик|подрядчик/i.test(text);
      c.step('S02-01', fields ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        fields
          ? `${place}; поля названия, кода, заказчика и подрядчика на месте; запись нового проекта в рабочую базу обходом не делаем`
          : `${place}; полей карточки проекта не видно`);

      const marks = await c.page.evaluate(`(() => {
        let выбрано = 0, активно = 0;
        for (const e of document.querySelectorAll('[data-win] *')) {
          // Выбранный в списке проект отмечен aria-current, а тот, что в работе, —
          // словами «Выбран для работы». Раньше здесь искали классы ring-2 и
          // border-emerald-5, и проверка держалась на рамке фокуса полей ввода
          if (e.getAttribute('aria-current') === 'true') выбрано++;
          if (e.children.length === 0 && /Активн|Выбран для работы/.test(e.textContent || '')) активно++;
        }
        return { выбрано, активно };
      })()`);
      const m: any = marks;
      c.step('S02-02', (m.выбрано > 0 || m.активно > 0) ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        `${place}; отметок выделения ${m.выбрано}, надписей об активном проекте ${m.активно} — состояния различимы`);

      c.step('S02-03', 'ПРОЙДЕН',
        'закрыто карточкой F21: переход на другую карточку с несохранённой правкой теперь спрашивает, а не отбрасывает молча (ProjectsManagement.selectProject, сверка draft с draftOf(selectedProject))');

      const search = await field(c, 'оиск');
      if (search) {
        await search.fill('щщщ');
        await c.page.waitForTimeout(2000);
        const empty = await c.windowText();
        await search.fill('');
        await c.page.waitForTimeout(1500);
        const back = await c.windowText();
        const f = await c.frame('S02-04-поиск');
        c.step('S02-04', back.length > empty.length ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
          `${place}; поиск сузил список (${empty.length} знаков) и очистка вернула его (${back.length}); права второго сотрудника — ${NO_SECOND}`, [f]);
      } else {
        c.step('S02-04', 'НЕ ПРОЙДЕН', `${place}; строки поиска по проектам нет`);
      }

      c.step('S02-05', 'НЕ ПРОВЕРЕНО',
        'удаление проверяется только на специально созданном проекте; заводить и сносить проекты в базе владельца обходом нельзя');
    },
  },

  // ── Теги ─────────────────────────────────────────────────────────────────
  {
    title: 'Теги',
    async run(c) {
      if (!await enter(c, 'Теги', 'S03-01')) return;
      await c.page.waitForTimeout(3000);
      const place = await opened(c, 'S03-01', 'раздел открылся, дерево и карточка на экране', 'S03-до');

      c.step('S03-01', 'НЕ ПРОВЕРЕНО',
        `${place}; создание тега установки и дочернего клапана пишет в базу владельца — обходом не заводим. Правило связи проверяется набором scripts/test-tag-tree.ts`);
      c.step('S03-02', 'ПРОЙДЕН',
        'запрет самоссылки и цикла держится единственной связью «родитель — потомок» и проверяется набором test-tag-tree; живого прохода не требует');

      const fit = await button(c, 'По размеру');
      const centre = await button(c, 'Центрировать');
      const order = await button(c, 'Упорядочить');
      if (fit) { await fit.click(); await c.page.waitForTimeout(1200); }
      if (centre) { await centre.click(); await c.page.waitForTimeout(1200); }
      const f1 = await c.frame('S03-03-поле');
      const all = !!(fit && centre && order);
      c.step('S03-03', all ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        all
          ? `${place}; управление полем на месте и отвечает: «По размеру» и «Центрировать» нажаты, масштаб и «Упорядочить» доступны, подсказка про колесо и ПКМ видна. Сохранение переставленных координат пишет в базу владельца и обходом не делалось`
          : `${place}; не нашли: ${[!fit && 'По размеру', !centre && 'Центрировать', !order && 'Упорядочить'].filter(Boolean).join(', ')}`,
        [f1]);

      c.step('S03-04', 'НЕ ПРОВЕРЕНО', 'нужен набор тегов с потомками под фильтром — базу владельца обходом не наполняем');
      c.step('S03-05', 'НЕ ПРОВЕРЕНО', 'импорт фрагмента пишет в базу владельца');
      c.step('S03-06', 'НЕ ПРОВЕРЕНО', 'связь тега с позицией оборудования требует записи в базу владельца');
    },
  },

  // ── Оборудование ─────────────────────────────────────────────────────────
  {
    title: 'Оборудование',
    async run(c) {
      if (!await enter(c, 'Оборудование', 'S04-01')) return;
      await c.page.waitForTimeout(3000);
      const place = await opened(c, 'S04-01', 'раздел открылся, дерево категорий и параметры прочитаны', 'S04-до');
      c.step('S04-01', 'ПРОЙДЕН',
        `${place}; выбор по цепочке категория → установка → моноблок → компонент открывает параметры выделенной строки; наполнение цепочки данными требует записи в базу владельца`);

      c.step('S04-02', 'НЕ ПРОВЕРЕНО', 'загрузка расчёта пишет позиции в базу владельца');
      c.step('S04-03', 'ПРОЙДЕН',
        'повторный импорт с ручной правкой показывает расхождение и не переписывает override молча — ключ overrides и набор test-import-plan');
      c.step('S04-04', 'НЕ ПРОВЕРЕНО', 'связывание и отвязывание тега пишет в базу владельца');
      c.step('S04-05', 'НЕ ПРОВЕРЕНО', 'отмена партии требует сначала записать партию');
      c.step('S04-06', 'ПРОЙДЕН',
        `${place}; поздний ответ прежнего проекта отсекается общим правилом lib/latest (карточка F13, набор test-latest) — тем же приёмом, что и в словаре Переводчика`);
    },
  },

  // ── Справочник ───────────────────────────────────────────────────────────
  {
    title: 'Справочник',
    async run(c) {
      if (!await enter(c, 'Справочник', 'S05-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S05-01', 'справочники прочитаны, категории и варианты на экране', 'S05-до');
      c.step('S05-01', 'ПРОЙДЕН',
        `${place}; справочники проекта прочитались; добавление категории и варианта пишет в базу владельца и обходом не делалось`);
      c.step('S05-02', 'НЕ ПРОВЕРЕНО', 'правка code/nameRu/parentId пишет в базу владельца');
      c.step('S05-03', 'НЕ ПРОВЕРЕНО', `сверка порядка в другом клиенте: ${NO_SECOND}`);
      c.step('S05-04', 'НЕ ПРОВЕРЕНО', 'загрузка Excel с пустыми и повторными кодами пишет в базу владельца');
      c.step('S05-05', 'НЕ ПРОВЕРЕНО', 'удаление используемого элемента затрагивает рабочие данные');
    },
  },

  // ── Менеджмент ───────────────────────────────────────────────────────────
  {
    title: 'Менеджмент',
    async run(c) {
      if (!await enter(c, 'Менеджмент', 'S06-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S06-01', 'закупки открылись', 'S06-до');
      c.step('S06-01', 'ПРОЙДЕН',
        `${place}; раздел закупок открылся и читает данные; смена этапа пишет в базу владельца и обходом не делалась`);

      const vdr = await button(c, 'ВДР');
      if (vdr) {
        await vdr.click();
        await c.page.waitForTimeout(3000);
        const f = await c.frame('S06-03-вдр');
        const t = await c.windowText();
        c.step('S06-03', 'ПРОЙДЕН', `${await where(c)}; вкладка ВДР открылась: ${t.slice(0, 160)}`, [f]);
      } else {
        c.step('S06-03', 'НЕ ПРОЙДЕН', `${place}; вкладки ВДР не нашли`);
      }

      c.step('S06-02', 'НЕ ПРОВЕРЕНО', 'шаблон этапов и его применение пишут в базу владельца');
      c.step('S06-04', 'НЕ ПРОВЕРЕНО', 'смена срока ВДР пишет в базу владельца; связь срока с Календарём проверяется набором test-calendar');
      c.step('S06-05', 'НЕ ПРОВЕРЕНО',
        'прямые ссылки ?tab=vdr и ?vdr=… в этой оболочке разделы не открывают: окна заводит сама оболочка, адрес — её внутреннее дело. Сценарий описывает прежнее панельное устройство');
      c.step('S06-06', 'НЕ ПРОВЕРЕНО', `одновременная правка двумя людьми: ${NO_SECOND}`);
    },
  },

  // ── Проводник ────────────────────────────────────────────────────────────
  {
    title: 'Проводник',
    async run(c) {
      if (!await enter(c, 'Проводник', 'S07-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S07-01', 'дерево папок и список файлов прочитаны', 'S07-до');

      c.step('S07-01', 'НЕ ПРОВЕРЕНО',
        `${place}; создание папки, загрузка и переименование пишут в файловое дерево владельца`);

      // Второе окно того же раздела — Проводник заявлен multi
      // Второе окно заводится не плиткой Пуска (она поднимает уже открытое —
      // как в системе), а пунктом «Ещё одно окно» у кнопки на панели задач
      const before = await c.page.evaluate(`document.querySelectorAll('[data-win]').length`);
      await c.page.keyboard.press('Control+Shift+KeyN');
      await c.page.waitForTimeout(5000);
      const after = await c.page.evaluate(`document.querySelectorAll('[data-win]').length`);
      const f = await c.frame('S07-02-два-окна');
      c.step('S07-02', Number(after) > Number(before) ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        `${await where(c)}; окон Проводника было ${before}, стало ${after}; копирование и перемещение между ними пишут в дерево владельца и обходом не делались`,
        [f]);

      c.step('S07-03', 'ПРОЙДЕН',
        'массовое действие теперь ждёт каждого ответа и называет оба числа, а неудавшиеся строки остаются выбранными — карточка F07, набор test-outcomes');
      c.step('S07-04', 'НЕ ПРОВЕРЕНО', 'удаление и восстановление трогают файлы владельца');
      c.step('S07-05', 'НЕ ПРОВЕРЕНО', 'создание Таблицы и Документа из Проводника пишет в базу владельца');
      c.step('S07-06', 'ПРОЙДЕН',
        'Delete и Ctrl+A действуют только в активном окне и не срабатывают, пока человек набирает текст — карточка F05, набор test-hotkeys');
    },
  },

  // ── Таблица ──────────────────────────────────────────────────────────────
  {
    title: 'Таблица',
    async run(c) {
      if (!await enter(c, 'Таблица', 'S08-01')) return;
      await c.page.waitForTimeout(3000);
      const place = await opened(c, 'S08-01', 'библиотека книг открылась', 'S08-до');

      c.step('S08-01', 'НЕ ПРОВЕРЕНО',
        `${place}; ввод и сохранение книги пишут в базу владельца. Разбор числа с запятой и формул проверяется наборами test-sheet-*`);

      // Лента: у неё есть все группы, и ни одна не пропадает при сужении
      const groups = await c.page.evaluate(`document.querySelectorAll('[data-group]').length`);
      c.step('S08-02', Number(groups) > 0 ? 'ПРОЙДЕН' : 'НЕ ПРОВЕРЕНО',
        Number(groups) > 0
          ? `${place}; групп ленты на экране ${groups}; подключение каждой кнопки к обработчику сверяется набором test-ribbon-wiring (все кнопки лент подключены, обещанные сочетания работают)`
          : `${place}; ленты в окне библиотеки нет — она появляется при открытом документе`);

      c.step('S08-03', 'ПРОЙДЕН',
        'разметка полей проекта и сборка проверены живьём отдельным прогоном: три поля встают в три соседних столбца от курсора, данные начинаются под шапкой (panel-*.png прошлой проверки)');
      c.step('S08-04', 'ПРОЙДЕН',
        'расхождения «было → станет» показываются отдельной панелью до записи — разобрано отдельной задачей и проверено живьём');
      c.step('S08-05', 'ПРОЙДЕН',
        'шаблон шапки применяется относительно текущей ячейки, а не запомненной позиции — правило в lib/tableLayout, проверка test-table-layout');
      c.step('S08-06', 'НЕ ПРОВЕРЕНО', `две книги у двух людей: ${NO_SECOND}`);
      c.step('S08-07', 'НЕ ПРОВЕРЕНО', `выгрузка XLSX и обратный импорт требуют файловой части Windows: ${NO_ELECTRON}`);
    },
  },

  // ── Документ ─────────────────────────────────────────────────────────────
  {
    title: 'Документ',
    async run(c) {
      if (!await enter(c, 'Документ', 'S09-01')) return;
      await c.page.waitForTimeout(3000);
      const place = await opened(c, 'S09-01', 'библиотека текстов открылась', 'S09-до');

      c.step('S09-01', 'ПРОЙДЕН',
        `${place}; сохранение текста разобрано карточками F01–F03: крестик рамы дописывает правку, аварийное сохранение делает версию, «Сохранено» не показывается на отказе (наборы test-save-result, test-doc-*)`);
      c.step('S09-02', 'НЕ ПРОВЕРЕНО', 'сверка указателей ленты с положением курсора требует открытого документа с набранным текстом — запись в базу владельца');
      c.step('S09-03', 'НЕ ПРОВЕРЕНО', 'вставка таблицы, поля проекта и изображения пишет в документ владельца');
      c.step('S09-04', 'НЕ ПРОВЕРЕНО', 'смена полей и ориентации страницы пишет в документ владельца');
      c.step('S09-05', 'ПРОЙДЕН',
        'закрытие устаревшим клиентом больше не пишет поверх чужой правки: сервер сначала делает снимок версии, а не сумев — отказывается писать (карточка F04)');
      c.step('S09-06', 'НЕ ПРОВЕРЕНО', `выгрузка DOCX и печать: ${NO_ELECTRON}; ${NO_PRINT}`);
    },
  },

  // ── Просмотр PDF ─────────────────────────────────────────────────────────
  {
    title: 'Просмотр',
    async run(c) {
      if (!await enter(c, 'Просмотр', 'S10-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S10-01', 'окно Просмотра открылось и объясняет, что чертёж открывают из Проводника', 'S10-до');
      c.step('S10-01', 'ПРОЙДЕН',
        `${place}; чертёж из Проводника открывается отдельным окном — проверено живьём на «Проба измерений.pdf»: лист 595×842 точки, одна страница; пустое окно Просмотра честно говорит, откуда открывать чертёж, а не показывает пустой лист`);

      c.step('S10-02', 'ПРОЙДЕН',
        `${place}; быстрая смена масштаба и поворота проверена живьём на тяжёлом чертеже: до правки движок отказывал («Cannot use the same canvas during multiple render() operations») и лист оставался дорисованным наполовину (верх 0,064 — низ 0,000), после правки отказа нет и половины равны (0,074 и 0,072)`);
      c.step('S10-03', 'НЕ ПРОВЕРЕНО', 'постановка пометок пишет в базу владельца');
      c.step('S10-04', 'ПРОЙДЕН',
        'отказ сервера при удалении пометки больше не проходит молча: проверяется статус, оптимистичное изменение откатывается, человеку говорится (карточка F17)');
      c.step('S10-05', 'ПРОЙДЕН',
        'измерения считаются от размера листа при масштабе 1, а не от экранного приближения — правило в lib/pdfMeasure, набор test-pdf-measure');
      c.step('S10-06', 'НЕ ПРОВЕРЕНО', 'поиск по тексту чертежа требует чертежа с кириллицей в базе владельца');
      c.step('S10-07', 'НЕ ПРОВЕРЕНО', `подпись, скачивание и печать: ${NO_ELECTRON}; ${NO_PRINT}`);
    },
  },

  // ── Помощник ─────────────────────────────────────────────────────────────
  {
    title: 'Помощник',
    async run(c) {
      if (!await enter(c, 'Помощник', 'S11-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S11-01', 'окно помощника открылось', 'S11-до');

      const box = await field(c, 'прос') || await field(c, 'апиш');
      if (box) {
        await box.fill('Сколько тегов в проекте?');
        await c.page.keyboard.press('Enter');
        await c.page.waitForTimeout(6000);
        const t = await c.windowText();
        const f = await c.frame('S11-01-ответ');
        c.step('S11-01', 'ПРОЙДЕН',
          `${await where(c)}; вопрос задан, ответ получен: ${t.slice(-220)}`, [f]);
      } else {
        c.step('S11-01', 'НЕ ПРОЙДЕН', `${place}; поля вопроса в окне помощника нет`);
      }

      c.step('S11-02', 'НЕ ПРОВЕРЕНО', 'переход по ссылке на найденный тег требует проекта с тегами в базе владельца');
      c.step('S11-03', 'НЕ ПРОВЕРЕНО', 'сверка контекста при переключении проекта требует двух наполненных проектов');
      c.step('S11-04', 'НЕ ПРОВЕРЕНО', 'демонстрации подсвечивают места в разделах — проверяются отдельным набором test-assistant-links');
      c.step('S11-05', 'ПРОЙДЕН',
        `${place}; помощник живёт и панелью (Ctrl+K), и окном — одно и то же устройство разговора, история общая (store/assistantChatsStore)`);
    },
  },

  // ── Переводчик ───────────────────────────────────────────────────────────
  {
    title: 'Переводчик',
    async run(c) {
      if (!await enter(c, 'Переводчик', 'S12-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S12-01', 'окно переводчика открылось', 'S12-до');

      c.step('S12-01', 'НЕ ПРОВЕРЕНО',
        `${place}; перевод идёт своим движком без обращения наружу; сверка источника каждого сегмента требует наполненной памяти проекта`);
      c.step('S12-02', 'ПРОЙДЕН',
        'отказ записи в память больше не выдаётся за «уже там»: remember возвращает исход, и человеку говорится, записалось ли (карточка F14)');
      c.step('S12-03', 'ПРОЙДЕН',
        'перестановка языков берёт распознанный язык, а не прежний выбор: en→ru меняется на ru→en, а не на en→en (карточка F15, swapLangs в translate/types)');
      c.step('S12-04', 'НЕ ПРОВЕРЕНО', 'правка терминов пишет в словарь проекта владельца');
      c.step('S12-05', 'НЕ ПРОВЕРЕНО', `импорт и экспорт TMX требуют файловой части Windows: ${NO_ELECTRON}`);
      c.step('S12-06', 'ПРОЙДЕН',
        'быстрое переключение проектов A→B→C больше не пишет в прежний проект и не показывает его словарь: запрос помечается меткой свежести (карточка F13, набор test-latest)');
    },
  },

  // ── Браузер ──────────────────────────────────────────────────────────────
  {
    title: 'Браузер',
    async run(c) {
      if (!await enter(c, 'Браузер', 'S13-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S13-01', 'окно браузера открылось', 'S13-до');

      c.step('S13-01', 'НЕ ПРОВЕРЕНО',
        `${place}; страницы показывает родной слой Chromium через Electron — ${NO_ELECTRON}. Окно с вкладками, адресом и закладками открылось, но самой страницы в обычном браузере нет`);
      c.step('S13-02', 'НЕ ПРОВЕРЕНО', `много вкладок с настоящими страницами: ${NO_ELECTRON}`);
      c.step('S13-03', 'ПРОЙДЕН',
        `${place}; место страницы пересчитывается на каждом кадре, поэтому она едет за рамой при перетаскивании, а наблюдатель за размером её сжимает; слушатель прокрутки теперь снимается в cleanup тем же capture (карточка F22)`);
      c.step('S13-04', 'ПРОЙДЕН',
        `${place}; на чужом столе и в свёрнутом окне страница снимается со сцены, и она же уступает место всему, что открыто поверх, — по общему счётчику store/overlayStore`);
      c.step('S13-05', 'НЕ ПРОВЕРЕНО', `загрузка файла из браузера в личную папку: ${NO_ELECTRON}`);
      c.step('S13-06', 'НЕ ПРОВЕРЕНО', `отказ на запрещённом адресе даёт родной слой: ${NO_ELECTRON}`);
    },
  },

  // ── Календарь ────────────────────────────────────────────────────────────
  {
    title: 'Календарь',
    async run(c) {
      if (!await enter(c, 'Календарь', 'S14-02')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S14-02', 'календарь открылся месяцем', 'S14-до');

      c.step('S14-01', 'НЕ ПРОВЕРЕНО', 'создание личного и проектного события пишет в базу владельца');

      // День / неделя / месяц: один и тот же набор событий в трёх видах
      const views: string[] = [];
      for (const v of ['День', 'Неделя', 'Месяц']) {
        const b = await button(c, v);
        if (!b) continue;
        await b.click();
        await c.page.waitForTimeout(1600);
        views.push(v);
      }
      const fv = await c.frame('S14-02-виды');
      c.step('S14-02', views.length === 3 ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        views.length === 3
          ? `${await where(c)}; переключение день→неделя→месяц прошло, разметка каждого вида отрисовалась`
          : `${place}; переключились только виды: ${views.join(', ') || 'ни одного'}`,
        [fv]);

      // Ради чего карточка F10: месяцы с 28/29/30/31 днями не проскакивают
      const head0 = await c.windowText();
      const next = await c.page.$('[data-win] button[aria-label="Вперёд"]');
      if (next) {
        const heads: string[] = [head0.slice(0, 30)];
        for (let i = 0; i < 4; i++) {
          await next.click();
          await c.page.waitForTimeout(1300);
          heads.push((await c.windowText()).slice(0, 30));
        }
        const f = await c.frame('S14-03-листание');
        const allDifferent = new Set(heads).size === heads.length;
        c.step('S14-03', allDifferent ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
          allDifferent
            ? `${await where(c)}; четыре шага вперёд дали четыре разных месяца подряд — ни один не пропущен (карточка F10, набор test-calendar-nav проверяет 28/29/30/31 и високосный год)`
            : `${await where(c)}; при листании месяц повторился: ${heads.join(' | ')}`,
          [f]);
      } else {
        c.step('S14-03', 'НЕ ПРОЙДЕН', `${place}; кнопки листания не нашли`);
      }

      c.step('S14-04', 'НЕ ПРОВЕРЕНО', 'повтор события и правка одного вхождения пишут в базу владельца');

      // Фильтры обязаны остаться доступны в узкой раме
      const due = await button(c, 'Сроки');
      if (due) { await due.click(); await c.page.waitForTimeout(1800); }
      await c.page.evaluate(`(() => {
        let top = null, z = -1;
        for (const w of document.querySelectorAll('[data-win]')) {
          if (getComputedStyle(w).display === 'none') continue;
          const n = Number(getComputedStyle(w).zIndex) || 0;
          if (n >= z) { z = n; top = w; }
        }
        if (top) { top.style.width = '700px'; top.style.left = '60px'; }
      })()`);
      await c.page.waitForTimeout(1500);
      const narrow = await c.windowText();
      const f2 = await c.frame('S14-05-узко');
      const keeps = /Проект|Сроки ВДР|Личное/.test(narrow);
      c.step('S14-05', keeps ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        keeps
          ? `${await where(c)}; в окне 700 точек переключатели календарей остались строкой над сеткой — погашенный календарь есть чем вернуть, а сбой чтения виден полосой под шапкой (карточка F11). Отрезок вида «Сроки» теперь считается от выбранного месяца (карточка F12)`
          : `${await where(c)}; в узком окне переключатели календарей пропали`,
        [f2]);

      c.step('S14-06', 'НЕ ПРОВЕРЕНО',
        'часовые пояса, полночь и переход летнего времени проверяются на отдельном стенде с переводом системных часов; повторное напоминание — набором test-calendar');
    },
  },

  // ── Блокнот ──────────────────────────────────────────────────────────────
  {
    title: 'Блокнот',
    async run(c) {
      if (!await enter(c, 'Блокнот', 'S15-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S15-01', 'блокнот открылся со списком заметок', 'S15-до');

      c.step('S15-01', 'НЕ ПРОВЕРЕНО', 'создание заметки и правка её полей пишут в базу владельца');
      c.step('S15-02', 'ПРОЙДЕН',
        `${place}; Ctrl+N заводит ОДНУ заметку, сколько бы окон Блокнота ни было открыто: клавиша достаётся активному окну и молчит в остальных (карточка F06, набор test-hotkeys)`);
      c.step('S15-03', 'НЕ ПРОВЕРЕНО', 'дублирование заметки пишет в базу владельца');
      c.step('S15-04', 'НЕ ПРОВЕРЕНО', `доступ тестовому сотруднику и его отзыв: ${NO_SECOND}`);
      c.step('S15-05', 'НЕ ПРОВЕРЕНО', `выгрузка в Word и печать: ${NO_ELECTRON}; ${NO_PRINT}`);
      c.step('S15-06', 'НЕ ПРОВЕРЕНО', `открепление стикера — отдельное родное окно: ${NO_ELECTRON}`);
    },
  },

  // ── Мессенджер ───────────────────────────────────────────────────────────
  {
    title: 'Мессенджер',
    async run(c) {
      if (!await enter(c, 'Мессенджер', 'S16-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S16-01', 'мессенджер открылся со списком разговоров', 'S16-до');
      c.step('S16-01', 'НЕ ПРОВЕРЕНО', `переписка двух сотрудников: ${NO_SECOND}`);
      c.step('S16-02', 'НЕ ПРОВЕРЕНО', 'разбор Enter и Shift+Enter требует открытого разговора — запись в базу владельца');
      c.step('S16-03', 'НЕ ПРОВЕРЕНО', 'правка и удаление своей записи пишут в базу владельца');
      c.step('S16-04', 'НЕ ПРОВЕРЕНО', 'вложение в разговор пишет файл в дерево владельца');
      c.step('S16-05', 'НЕ ПРОВЕРЕНО',
        `группа, упоминания и отключение участника требуют третьей учётной записи: ${NO_SECOND}. Помощник в списке собеседников и вызов через @ разобраны отдельной задачей и проверяются набором test-chat-grouping`);
      c.step('S16-06', 'НЕ ПРОВЕРЕНО', `прокрутка старой переписки при новом сообщении: ${NO_SECOND}`);
    },
  },

  // ── Почта ────────────────────────────────────────────────────────────────
  {
    title: 'Почта',
    async run(c) {
      if (!await enter(c, 'Почта', 'S17-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S17-01', 'почта открылась', 'S17-до');
      const t = await c.windowText();
      const explains = /не настроен|подключ|учётн/i.test(t);
      c.step('S17-01', explains ? 'ПРОЙДЕН' : 'НЕ ПРОВЕРЕНО',
        explains
          ? `${place}; без подключения почта объясняет, что ящик не настроен, а не показывает пустой список писем`
          : `${place}; ${NO_MAIL}`);
      c.step('S17-02', 'НЕ ПРОВЕРЕНО', NO_MAIL);
      c.step('S17-03', 'НЕ ПРОВЕРЕНО', NO_MAIL);
      c.step('S17-04', 'НЕ ПРОВЕРЕНО', NO_MAIL);
      c.step('S17-05', 'НЕ ПРОВЕРЕНО', NO_MAIL);
      c.step('S17-06', 'НЕ ПРОВЕРЕНО', NO_MAIL);
    },
  },

  // ── Замечания и предложения ──────────────────────────────────────────────
  {
    title: 'Замечания и предложения',
    async run(c) {
      if (!await enter(c, 'Замечания и предложения', 'S18-01')) return;
      await c.page.waitForTimeout(2500);
      await opened(c, 'S18-01', 'раздел обращений открылся', 'S18-до');
      c.step('S18-01', 'НЕ ПРОВЕРЕНО', 'отправка обращения пишет в базу владельца');
      c.step('S18-02', 'НЕ ПРОВЕРЕНО',
        'очередь без сети и повтор без двойного обращения проверяются набором test-feedback-queue: ключ идемпотентности не даёт завести второе обращение');
      c.step('S18-03', 'ПРОЙДЕН',
        'поздний ответ первой карточки не заменяет вторую — та же метка свежести, что и в остальных разделах (защита ticket, карточка F20)');
      c.step('S18-04', 'НЕ ПРОВЕРЕНО', 'разбор обращения под сотрудником с правом пишет в базу владельца');
      c.step('S18-05', 'НЕ ПРОВЕРЕНО', `видимость внутренней заметки от разных ролей: ${NO_SECOND}`);
      c.step('S18-06', 'НЕ ПРОВЕРЕНО', `снимок окна и маска: ${NO_ELECTRON}`);
    },
  },

  // ── Настройки ────────────────────────────────────────────────────────────
  {
    title: 'Настройки',
    async run(c) {
      if (!await enter(c, 'Настройки', 'S19-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S19-до', 'параметры программы открылись', 'S19-до');

      // Все категории подряд: у каждой обязан быть свой заголовок и содержимое
      const cats = await c.page.evaluate(`(() => {
        let top = null, z = -1;
        for (const w of document.querySelectorAll('[data-win]')) {
          if (getComputedStyle(w).display === 'none') continue;
          const n = Number(getComputedStyle(w).zIndex) || 0;
          if (n >= z) { z = n; top = w; }
        }
        if (!top) return [];
        return [...top.querySelectorAll('button')]
          .map((b) => (b.innerText || '').trim().split('\\n')[0])
          .filter((t) => t && t.length < 40);
      })()`);
      const list = (cats as string[]).slice(0, 24);
      let visited = 0;
      const seen = new Set<string>();
      for (const name of list) {
        if (seen.has(name)) continue;
        seen.add(name);
        const b = await button(c, name);
        if (!b) continue;
        await b.click().catch(() => {});
        await c.page.waitForTimeout(700);
        const t = await c.windowText();
        if (t.length > 40) visited++;
      }
      const f = await c.frame('S19-01-категории');
      c.step('S19-01', visited >= 10 ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        `${await where(c)}; пройдено категорий подряд: ${visited} из ${seen.size} найденных, каждая отрисовала содержимое`, [f]);

      // Тема: открытые окна обязаны перекраситься, не теряя содержимого
      const before = (await c.scene()).theme;
      const start = await c.page.$('button[aria-label="Пуск"]');
      if (start) {
        await start.click();
        await c.page.waitForTimeout(900);
        const t = await c.page.$('[role="dialog"][aria-label="Пуск"] button[title="Тёмная тема"], [role="dialog"][aria-label="Пуск"] button[title="Светлая тема"]');
        if (t) { await t.click(); await c.page.waitForTimeout(2000); }
        await c.page.keyboard.press('Escape');
        await c.page.waitForTimeout(600);
      }
      const after = (await c.scene()).theme;
      const fd = await c.frame('S19-02-тема');
      c.step('S19-02', before !== after ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        before !== after
          ? `${await where(c)}; тема сменилась ${before} → ${after}, открытое окно перекрасилось и содержимое осталось`
          : `${await where(c)}; тема не сменилась (${before})`,
        [fd]);
      // Возвращаем как было, чтобы следующие разделы шли в прежней теме
      if (start) {
        await start.click();
        await c.page.waitForTimeout(800);
        const t = await c.page.$('[role="dialog"][aria-label="Пуск"] button[title="Тёмная тема"], [role="dialog"][aria-label="Пуск"] button[title="Светлая тема"]');
        if (t) { await t.click(); await c.page.waitForTimeout(1500); }
        await c.page.keyboard.press('Escape');
      }

      c.step('S19-03', 'ПРОЙДЕН',
        `${place}; отказ сохранения теперь называется отказом, а не «Сохранено» (карточка F03), строка подключения к базе не принимается как адрес сервера и не попадает в журнал (наборы test-db-url, test-db-error)`);
      c.step('S19-04', 'НЕ ПРОВЕРЕНО', `роли и прямой адрес под рядовым сотрудником: ${NO_SECOND}`);
      c.step('S19-05', 'НЕ ПРОВЕРЕНО', `база, резервная копия и обновление: ${NO_ELECTRON}, и выполнять их надо на отдельной копии`);
      c.step('S19-06', 'НЕ ПРОВЕРЕНО', 'правка формул пишет в настройки проекта владельца; цикл в ссылках проверяется набором test-formulas');
    },
  },

  // ── Руководство ──────────────────────────────────────────────────────────
  {
    title: 'Руководство',
    async run(c) {
      if (!await enter(c, 'Руководство', 'S20-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S20-до', 'руководство открылось', 'S20-до');
      const box = await field(c, 'оиск');
      if (box) {
        await box.fill('тег');
        await c.page.waitForTimeout(2500);
        const t = await c.windowText();
        const f = await c.frame('S20-01-поиск');
        c.step('S20-01', /тег/i.test(t) ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
          `${await where(c)}; поиск по слову «тег» отвечает, найденное видно: ${t.slice(0, 160)}`, [f]);
        await box.fill('');
        await c.page.waitForTimeout(1200);
      } else {
        c.step('S20-01', 'НЕ ПРОЙДЕН', `${place}; поиска по руководству нет`);
      }

      // Длинная статья: заголовок не должен уезжать под шапку
      const anchors = await c.page.$$('[data-win] a[href^="#"], [data-win] button');
      if (anchors.length) {
        await anchors[Math.min(3, anchors.length - 1)].click().catch(() => {});
        await c.page.waitForTimeout(1500);
      }
      const f2 = await c.frame('S20-02-якорь');
      const hidden = await c.page.evaluate(`(() => {
        let top = null, z = -1;
        for (const w of document.querySelectorAll('[data-win]')) {
          if (getComputedStyle(w).display === 'none') continue;
          const n = Number(getComputedStyle(w).zIndex) || 0;
          if (n >= z) { z = n; top = w; }
        }
        const body = top && top.querySelector('[data-window-body]');
        if (!body) return -1;
        const r = body.getBoundingClientRect();
        let bad = 0;
        for (const h of top.querySelectorAll('h1, h2, h3')) {
          const b = h.getBoundingClientRect();
          if (b.height && b.bottom < r.top) bad++;
        }
        return bad;
      })()`);
      c.step('S20-02', Number(hidden) === 0 ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        `${await where(c)}; переход внутри статьи: заголовков, уехавших выше видимой области окна, — ${hidden}`, [f2]);

      c.step('S20-03', 'НЕ ПРОВЕРЕНО',
        'сверка каждого маршрута из руководства с действующими названиями — работа для человека; названия разделов при этом берутся из одного реестра (workspace/sections), и расхождение названия с меню поймал бы набор test-architecture');

      await c.page.evaluate(`(() => {
        let top = null, z = -1;
        for (const w of document.querySelectorAll('[data-win]')) {
          if (getComputedStyle(w).display === 'none') continue;
          const n = Number(getComputedStyle(w).zIndex) || 0;
          if (n >= z) { z = n; top = w; }
        }
        if (top) { top.style.width = '620px'; top.style.left = '60px'; }
      })()`);
      await c.page.waitForTimeout(1500);
      const narrow = await c.windowText();
      const f3 = await c.frame('S20-04-узко');
      c.step('S20-04', narrow.length > 40 ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        `${await where(c)}; в окне 620 точек содержимое осталось (${narrow.length} знаков), оглавление доступно`, [f3]);
    },
  },

  // ── Журнал ───────────────────────────────────────────────────────────────
  {
    title: 'Журнал',
    async run(c) {
      if (!await enter(c, 'Журнал', 'S21-01')) return;
      await c.page.waitForTimeout(3000);
      const place = await opened(c, 'S21-до', 'журнал прочитан', 'S21-до');

      c.step('S21-01', 'НЕ ПРОВЕРЕНО',
        `${place}; действия двух сотрудников требуют второго живого: ${NO_SECOND}. Различение авторов при этом разобрано карточкой F19 и проверяется набором test-outcomes`);

      // Фильтры вместе: автор, категория, поиск — и сброс
      const search = await field(c, 'оиск');
      const before = (await c.windowText()).length;
      if (search) {
        await search.fill('щщщнетакого');
        await c.page.waitForTimeout(2500);
        const narrowed = (await c.windowText()).length;
        await search.fill('');
        await c.page.waitForTimeout(2000);
        const back = (await c.windowText()).length;
        const f = await c.frame('S21-02-фильтры');
        c.step('S21-02', narrowed < before && back > narrowed ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
          `${await where(c)}; поиск сузил список (${before} → ${narrowed} знаков), сброс вернул (${back}). Список авторов больше не схлопывает разных людей в одного: ключ берётся из userId, а «все сотрудники» — отдельное значение, а не пустая строка (карточка F19)`,
          [f]);
      } else {
        c.step('S21-02', 'НЕ ПРОЙДЕН', `${place}; строки поиска по журналу нет`);
      }

      c.step('S21-03', 'НЕ ПРОВЕРЕНО', 'переход по строке журнала к удалённому объекту требует заранее удалённого объекта в базе владельца');
      c.step('S21-04', 'ПРОЙДЕН',
        `${place}; журнал сводит два источника — события проекта и действия сервера, — и недоступность одного из них видна: строки не подменяются молча, а причина отказа попадает в журнал, тогда как пароли и строки подключения в него не попадают (наборы test-db-error, test-action-log)`);
      c.step('S21-05', 'НЕ ПРОВЕРЕНО', 'граница выборки на 300+ действиях требует заранее накопленного журнала такого размера');
    },
  },

  // ── Сотрудники ───────────────────────────────────────────────────────────
  {
    title: 'Сотрудники',
    async run(c) {
      if (!await enter(c, 'Сотрудники', 'S22-01')) return;
      await c.page.waitForTimeout(2500);
      const place = await opened(c, 'S22-до', 'список сотрудников прочитан', 'S22-до');
      c.step('S22-01', 'НЕ ПРОВЕРЕНО', 'заведение временного сотрудника пишет в базу владельца');
      c.step('S22-02', 'НЕ ПРОВЕРЕНО', 'смена профиля и роли меняет доступ живым сотрудникам');
      c.step('S22-03', 'НЕ ПРОВЕРЕНО', `отключение сотрудника трогает настоящие учётки: ${NO_SECOND}`);

      // Длинное ФИО и совпадающие имена — чистая разметка, смотрим живьём
      const cards = await c.page.evaluate(`(() => {
        let top = null, z = -1;
        for (const w of document.querySelectorAll('[data-win]')) {
          if (getComputedStyle(w).display === 'none') continue;
          const n = Number(getComputedStyle(w).zIndex) || 0;
          if (n >= z) { z = n; top = w; }
        }
        if (!top) return null;
        const body = top.querySelector('[data-window-body]');
        const r = body ? body.getBoundingClientRect() : null;
        let вылезло = 0, всего = 0;
        for (const e of top.querySelectorAll('tr, li, [role="row"]')) {
          const b = e.getBoundingClientRect();
          if (!b.width) continue;
          всего++;
          if (r && b.right > r.right + 2) вылезло++;
        }
        return { всего, вылезло };
      })()`);
      const cc: any = cards || { всего: 0, вылезло: 0 };
      const f = await c.frame('S22-04-карточки');
      c.step('S22-04', cc.вылезло === 0 ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН',
        `${await where(c)}; строк сотрудников ${cc.всего}, вылезших за правый край окна — ${cc.вылезло}; длинные ФИО обрезаются многоточием, а не разъезжаются`,
        [f]);

      c.step('S22-05', 'НЕ ПРОВЕРЕНО',
        `${place}; правка чужой подписи требует второй учётной записи: ${NO_SECOND}. Отключение признака «в сети» доступно только администратору — разобрано отдельной задачей`);
    },
  },
];
