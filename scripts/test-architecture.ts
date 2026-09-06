/**
 * Проверка границ между частями программы.
 *
 * То же, что в React-проектах делают правилом ESLint `import/no-restricted-paths`
 * (подход bulletproof-react), только без нового инструмента: у Flux нет ESLint,
 * зато есть привычка проверять всё скриптами в scripts/test-*.ts. Смысл правил
 * один — зависимости текут в одну сторону, слои не путаются, а разрастание
 * файлов не проходит незамеченным.
 *
 * Запуск: npx tsx scripts/test-architecture.ts
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d) : ''));

const ROOT = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e)) out.push(rel);
  }
  return out;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Пути импорта из файла: и статические, и динамические */
function importsOf(rel: string): string[] {
  const src = read(rel);
  const out: string[] = [];
  const re = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

const SRC = walk('src');
const ELECTRON = walk('electron');

console.log('1. Разделы рабочего стола независимы друг от друга');
// Раздел — экран, зарегистрированный в SECTIONS. Файлы screens/, которых там
// нет (TitlePanel, VdrPanel и т.п.) — по сути общие компоненты, им можно.
const sectionsSrc = read('src/workspace/sections.tsx');
const sectionNames = new Set(
  [...sectionsSrc.matchAll(/import\(['"]\.\.\/screens\/([A-Za-z0-9_]+)['"]\)/g)].map((m) => m[1]),
);
ok('реестр разделов прочитан', sectionNames.size >= 10, sectionNames.size);
for (const file of SRC.filter((p) => p.startsWith('src/screens/'))) {
  const self = file.replace(/^src\/screens\//, '').replace(/\.tsx?$/, '');
  for (const imp of importsOf(file)) {
    const target = imp.match(/^\.\/([A-Za-z0-9_]+)$|^\.\.\/screens\/([A-Za-z0-9_]+)$/);
    const name = target?.[1] || target?.[2];
    if (name && sectionNames.has(name)) {
      ok(`${self} не тянет раздел ${name}`, false, imp);
    }
  }
}
ok('ни один раздел не импортирован другим экраном', f === 0);

console.log('2. Хранилища не зависят от интерфейса');
for (const file of SRC.filter((p) => p.startsWith('src/store/'))) {
  const bad = importsOf(file).filter((i) => /(^|\/)(screens|components)\//.test(i));
  ok(`${file.replace('src/store/', '')} без экранов и компонентов`, bad.length === 0, bad);
}

console.log('3. Логические модули не зависят от React и состояния');
// capture / import / assistant разбирают текст и данные. Их держим пригодными
// для запуска в скрипте и в тесте — без React, без хранилищ, без сети.
for (const dir of ['src/capture', 'src/import', 'src/assistant', 'src/translate']) {
  for (const file of SRC.filter((p) => p.startsWith(dir + '/') && !p.endsWith('.tsx'))) {
    const bad = importsOf(file).filter((i) => /(^|\/)(screens|components|store)\//.test(i) || i === 'react');
    ok(`${relative(dir, file)} чист`, bad.length === 0, bad);
  }
}

console.log('4. Клиент и сервер не смешиваются');
const clientToServer = SRC.filter((p) => importsOf(p).some((i) => /(^|\/)server(\/|\.ts|$)/.test(i)));
ok('ни один файл src/ не импортирует серверный код', clientToServer.length === 0, clientToServer);
const electronToSrc = ELECTRON.filter((p) => importsOf(p).some((i) => i.includes('../src/')));
ok('главный процесс Electron не импортирует src/', electronToSrc.length === 0, electronToSrc);

console.log('5. Программа остаётся офлайн: никаких внешних ИИ-сервисов');
// Требование заказчика: программа работает на сервере компании, «ИИ» в ней
// программный — алгоритмы и локальная база знаний, а не вызовы чужого API.
// Инженер должен иметь возможность проверить любой вывод программы глазами.
const AI_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.deepseek.com',
  'api.cohere.ai',
  'openrouter.ai',
  'huggingface.co/api',
];
const offenders: string[] = [];
for (const file of [...SRC, ...ELECTRON, 'server.ts', ...walk('server')]) {
  const src = read(file);
  for (const host of AI_HOSTS) if (src.includes(host)) offenders.push(`${file} → ${host}`);
}
ok('нет обращений к внешним языковым моделям', offenders.length === 0, offenders);

// ── Токен сессии подставляет одна обёртка ──────────────────────────────────
// Экран, подставляющий Authorization руками, однажды взял токен из неверного
// ключа хранилища: заголовок уходил пустым, сервер отвечал «требуется вход», и
// человека выбрасывало на экран входа при открытии события календаря. Обёртка
// fetch (src/config/env.ts) знает верный ключ одна на всю программу.
const HAND_TOKEN = /Authorization['"`\s:]+[^\n]*localStorage\.getItem/;
const handToken = SRC.filter((f) => f !== 'src/config/env.ts' && HAND_TOKEN.test(read(f)));
ok('токен сессии никто не подставляет руками', handToken.length === 0, handToken);

console.log('6. Оболочка одна: панелей и левого меню нет');
// Оболочек было три — окна, панели рабочего стола и старое меню слева. Две
// убраны: разделы открываются окнами, и другого способа нет. Проверка стоит
// затем, чтобы ветка «а вдруг панели» не завелась заново — она заводится
// незаметно, одним `if`, и тянет за собой второй способ показать то же самое
{
  const GONE = ['flux_taskbar', 'ShellMode', 'openInActivePane', 'visiblePanes', 'WorkspaceRailControls'];
  for (const word of GONE) {
    const hit = SRC.filter((f) => read(f).includes(word));
    ok(`в src/ не осталось «${word}»`, hit.length === 0, hit);
  }
  const files = ['src/components/Workspace.tsx', 'src/components/RightRail.tsx'];
  for (const f of files) ok(`${f} удалён`, !SRC.includes(f));
}

console.log('7. Размер файлов не растёт (храповик)');
// Крупные файлы достались из истории проекта. Правило простое: новый файл не
// должен рождаться большим, а старый — расти. Уменьшать записанные числа после
// выноса кода в отдельные модули не только можно, но и нужно.
const BUDGET = 1200;
const LEGACY: Record<string, number> = {
  // Слой связей уехал в components/registry/BoardLinks, меню и мини-панель
  // карточки — в CardActions, панель дублей — в DuplicatesPanel, геометрия и
  // раскладка — в lib/tagLayout: планка ниже
  'src/screens/Registry.tsx': 5899,
  // Проверка и копирование SQLite вынесены отдельно, мастер-вход удалён.
  'server.ts': 4206,
  // Строки и значки уехали в components/explorer/FileItems.tsx, меню правой
  // кнопки — в components/explorer/ExplorerMenu.tsx: планка ниже
  'src/screens/Explorer.tsx': 2368,
  'src/screens/DictionaryEditor.tsx': 2279,
  // Пузырь сообщения уехал в components/chat/MessageBubble.tsx — планка ниже
  'src/screens/ChatManagement.tsx': 1864,
  'src/screens/ConstructorScreen.tsx': 1905,
  // Выбор оболочки ушёл вместе с панелями и левым меню — планка ниже
  'src/screens/SettingsScreen.tsx': 1494,
  // Типы ответа и два новых ответа уехали в src/assistant/ — планка ниже.
  // Приветствие уехало туда же (assistant/greeting), но файл всё равно чуть
  // выше планки: поднимать её не за что, живём в допуске
  'src/store/assistantStore.ts': 1246,
};
const SLACK = 50; // мелкие правки в старых файлах не должны ронять проверку
const all = [...SRC, ...ELECTRON, ...walk('server'), ...walk('scripts'), 'server.ts'];
for (const file of all) {
  const lines = read(file).replace(/\n$/, '').split('\n').length;
  const cap = LEGACY[file];
  if (cap !== undefined) {
    ok(`${file} не растёт (${lines} ≤ ${cap + SLACK})`, lines <= cap + SLACK, lines);
  } else {
    ok(`${file} в пределах ${BUDGET} строк`, lines <= BUDGET, lines);
  }
}
const gone = Object.keys(LEGACY).filter((p) => !all.includes(p));
ok('в списке крупных файлов нет исчезнувших путей', gone.length === 0, gone);

// ── Палитра ────────────────────────────────────────────────────────────────
// В программе объявлены зелёный акцент и три смысловых цвета: янтарный —
// предупреждение, розовый — конфликт, небесный — изменение. Всё остальное
// когда-то расползлось само: к версии 0.64 в разметке жило 230 обращений мимо
// системы, из них 167 — indigo, второй акцент, которого никто не объявлял.
// Проверка держит границу: чужой оттенок — это отказ, а не замечание.
//
// Палитры маркировки (цвет роли, цвет этапа закупки, цвет типа оборудования)
// — другое дело: там цвет выбирает человек и различать нужно много значений.
// Они перечислены поимённо и живут в отдельных файлах-справочниках.
const ALLOWED_HUES = ['emerald', 'slate', 'amber', 'rose', 'sky'];
// Перечисляем оттенки поимённо: по образцу «-любое слово-цифра» в сеть попадают
// border-l-2 и прочие направления с размерами
const HUE_NAMES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';
const LABEL_PALETTES = [
  'src/lib/roles.ts',              // цвет роли сотрудника
  'src/lib/procurementStages.ts',  // цвет этапа закупки
  'src/screens/Equipment.tsx',     // цвет типа оборудования
  'src/screens/LogsManagement.tsx', // цвет категории журнала
];
const STRAY = new RegExp(String.raw`\b(?:bg|text|border|ring|from|to|via|fill|stroke|decoration|accent|outline|divide|placeholder|caret|shadow)-(${HUE_NAMES})-\d`, 'g');
const strays: string[] = [];
for (const file of SRC) {
  if (!file.endsWith('.tsx') || LABEL_PALETTES.includes(file)) continue;
  const body = read(file);
  for (const m of body.matchAll(STRAY)) {
    if (!ALLOWED_HUES.includes(m[1])) strays.push(`${file}: ${m[0]}`);
  }
}
ok(`оформление держится палитры (найдено чужих оттенков: ${strays.length})`, strays.length === 0, strays.slice(0, 12));

// ── Тёмная тема: серая шкала в ней переставлена ──
//
// В `.dark` шкала slate переопределена, и ступени распределены по назначению,
// а не по яркости: 100 и 300 — светлый текст, 350–500 — приглушённый, а 200 и
// 600–950 отданы линиям и подложкам и остаются тёмными. Поэтому «dark:text-»
// с тёмной ступенью даёт тёмный текст на тёмном фоне.
//
// Так и было: 80 мест писали `dark:text-slate-200`, разумно полагая, что между
// светлыми 100 и 300 лежит тоже светлое. Замер показал 1.24 к 1 — надпись
// «Документ» в Конструкторе была не видна вовсе, как и подпись «Новая папка»
// в Проводнике (ровно цвет фона, 1 к 1).
//
// Читаемые ступени для текста в тёмной теме: 100, 105, 150, 255, 300, 350,
// 400, 405, 410, 450, 500, 503, 550 и 455 (приглушённая, но различимая — для
// недоступных кнопок, прочерков «нет значения» и разделителей).
//
// Список включает и полуступени: они объявлены псевдонимами (`--color-slate-250:
// var(--color-slate-200)`) и наследуют значение вместе с дырой. Именно на этом
// попался корень дерева в Проводнике — `dark:text-slate-250`, 1.36 к 1.
const DARK_TEXT_BAD = /\bdark:text-slate-(50|200|202|205|250|555|600|605|650|655|700|705|707|750|755|800|805|850|855|900|905|950|955|990)\b/g;
const darkText: string[] = [];
for (const file of SRC) {
  if (!file.endsWith('.tsx')) continue;
  const lines = read(file).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(DARK_TEXT_BAD)) {
      // Перевёрнутая плашка: светлая подложка, тёмный текст на ней — так и надо
      if (/dark:bg-slate-(50|100|300)\b/.test(lines[i])) continue;
      // Значок-подложка пустого состояния: он бледен намеренно и в обеих темах
      // одинаково (в светлой — slate-200/300 на белом). Цвет стоит на самом
      // значке, у которого задан размер, — по этому и отличаем от текста.
      if (/<[A-Z][A-Za-z]*\s[^>]*className="[^"]*\bw-\d/.test(lines[i])) continue;
      darkText.push(`${file}:${i + 1}: ${m[0]}`);
    }
  }
}
ok(`в тёмной теме текст не берёт ступени подложек (найдено: ${darkText.length})`, darkText.length === 0, darkText.slice(0, 12));

// ── truncate на flex-контейнере ничего не обрезает ──
//
// `truncate` — это overflow:hidden + text-overflow:ellipsis + nowrap, и
// многоточие ставится только собственному тексту элемента. У flex-контейнера
// своего текста нет: дети раскладываются как flex-элементы, и текст без
// `flex-1 min-w-0` не сжимается, а вылезает наружу.
//
// Так уже было дважды. Крестик вкладки из-за этого сидел ровно в середине, и
// нажатие в середину закрывало раздел. Заголовок заметки вылезал за карточку
// на 34 px, а карточка за колонку — на 22 px; ловилось только при заметке с
// названием по умолчанию, то есть у любого, кто нажал «создать».
const TRUNC_FLEX = /className=(?:"|\{`)([^"`]*\btruncate\b[^"`]*)/g;
const truncFlex: string[] = [];
for (const file of SRC) {
  if (!file.endsWith('.tsx')) continue;
  const lines = read(file).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(TRUNC_FLEX)) {
      const cls = m[1];
      // inline-flex/flex как display на том же элементе, что и truncate
      if (!/(?:^|\s)(?:inline-)?flex(?:$|\s)/.test(cls)) continue;
      truncFlex.push(`${file}:${i + 1}`);
    }
  }
}
ok(`truncate не стоит на flex-контейнере (найдено: ${truncFlex.length})`, truncFlex.length === 0, truncFlex.slice(0, 12));


// ── Каждый раздел должен быть доступен из оболочки ──
//
// Левое меню — отдельный список, написанный руками рядом с реестром разделов.
// Оно уже отставало: «Почта» появилась разделом, но в меню её не внесли, и
// попасть туда можно было только с плиток Главной. «Генератор» не попал ни
// туда, ни туда — раздел существовал, но открыть его было нечем; в итоге он и
// удалён: мёртвая программа в меню хуже отсутствующей.
//
// Исключения перечисляем поимённо и с причиной: раздел, до которого нельзя
// дотянуться, — это раздел, которого для человека нет.
const REACHABLE_ELSEWHERE: Record<string, string> = {
  '/': 'кнопка «показать стол» у края панели задач и значки на столе',
  '/settings': 'кнопка «шестерёнка» в подвале Пуска',
  '/logs': 'карточки на Главной',
  '/handbook': 'кнопка «Справка» в трее панели задач и F1',
  // Чертёж открывается двойным нажатием по файлу PDF в Проводнике. В меню его
  // нет намеренно: без файла показывать нечего, а пустой раздел «Чертёж» —
  // это обещание, которое некому исполнить
  '/pdf': 'двойное нажатие по файлу PDF в Проводнике',
  // Помощник открывается кнопкой в трее, строкой Ctrl+K и кнопкой «Открыть
  // окном» в самой панели. В левом меню его нет намеренно: он нужен поверх
  // работы, а не вместо неё
  '/assistant': 'кнопка помощника в трее, строка Ctrl+K, «Открыть окном» в панели',
};
{
  // Единственное меню разделов — Пуск. Он раскладывает их по объявленной
  // области: «Проект», «Общее» и семья Flux Office. Раздел со смешанной
  // областью в группы не попадает — значит вход к нему обязан быть назван
  // здесь поимённо
  const sectionsSrc = read('src/workspace/sections.tsx');
  const startSrc = read('src/lib/startMenu.ts');
  const office = new Set(
    [...(startSrc.match(/OFFICE_PATHS[^\]]*\]/) || [''])[0].matchAll(/'([^']+)'/g)].map((m) => m[1]),
  );
  const scoped = [...sectionsSrc.matchAll(/path: '([^']+)'[^\n]*?scope: '([a-z]+)'/g)]
    .map((m) => ({ path: m[1], scope: m[2] }));
  const unreachable = scoped
    .filter((e) => !REACHABLE_ELSEWHERE[e.path])
    .filter((e) => !office.has(e.path) && e.scope !== 'project' && e.scope !== 'global')
    .map((e) => e.path);
  ok(`каждый раздел открывается из Пуска (недоступных: ${unreachable.length})`, unreachable.length === 0, unreachable);
  ok('оговорки не протухли: каждая указывает на существующий раздел',
    Object.keys(REACHABLE_ELSEWHERE).every((p) => scoped.some((e) => e.path === p)),
    Object.keys(REACHABLE_ELSEWHERE).filter((p) => !scoped.some((e) => e.path === p)));
}

// ── Чьи данные в разделе: проектные или общие ──
//
// Разделение объявлено данными в реестре разделов, а показано подписями групп
// в левом меню. Это два разных списка, и разойтись они могут молча: раздел
// переедет в меню из одной группы в другую, а реестр останется прежним — и
// подпись над кнопкой начнёт врать. Сверяем.
console.log('\n8. Область данных раздела');
{
  const sectionsSrc = read('src/workspace/sections.tsx');
  const entries = [...sectionsSrc.matchAll(/path: '([^']+)', title: '([^']+)'[^\n]*?scope: '([a-z]+)'/g)]
    .map((m) => ({ path: m[1], title: m[2], scope: m[3] }));
  const paths = [...sectionsSrc.matchAll(/\{ path: '([^']+)'/g)].map((m) => m[1]);

  ok(`область объявлена у всех разделов (${entries.length} из ${paths.length})`,
    entries.length === paths.length,
    paths.filter((p) => !entries.some((e) => e.path === p)));

  const allowed = ['project', 'global', 'mixed'];
  const strange = entries.filter((e) => !allowed.includes(e.scope));
  ok('областей всего три: проектная, общая, смешанная', strange.length === 0, strange);

  // Пуск раскладывает разделы по ОБЪЯВЛЕННОЙ области, а не по своему списку:
  // пока список был отдельным (в левом меню), он мог молча разойтись с
  // реестром — раздел переезжал в другую группу, а подпись над ним начинала
  // врать. Теперь расходиться нечему, и проверять надо ровно это
  const startSrc = read('src/lib/startMenu.ts');
  ok('группа «Проект» берётся из области раздела', startSrc.includes("s.scope === 'project'"));
  ok('группа «Общее» — тоже', startSrc.includes("s.scope === 'global'"));
  ok('в Layout больше нет своего списка разделов', !read('src/components/Layout.tsx').includes('navGroups'));

  // Разделы, до которых из Пуска не дотянуться, области тоже обязаны объявить —
  // на них смотрит руководство и помощник.
  const orphan = entries.filter((e) => e.scope === 'mixed').map((e) => e.path);
  ok('смешанных разделов немного (Главная и Настройки)', orphan.length <= 2, orphan);
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
