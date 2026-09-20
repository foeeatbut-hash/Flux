/**
 * Храповик поверхностей: где раздел может показаться человеку.
 *
 * Зачем он нужен, видно из истории. Право доступа спрашивали пять мест из
 * четырнадцати. Настоящим заслоном был один — рама раздела, — а панель задач,
 * рабочий стол, плитки Главной, строка Ctrl+K, руководство и подсказки
 * помощника не спрашивали вовсе. Закреплённый раздел оставался кнопкой на
 * панели после снятия права; поиск находил его по названию; руководство
 * показывало статью. Ни одно из этих мест не «сломалось» — их просто забыли,
 * и забыли молча.
 *
 * Поэтому здесь список: каждая поверхность обязана либо звать политику
 * (`src/lib/appPolicy.ts`), либо стоять в оговорках с причиной. Добавили
 * пятнадцатую — проверка падает, пока её не провели через ту же воронку.
 * Идиома та же, что у `REACHABLE_ELSEWHERE` в test-architecture.
 *
 * Запуск: npx tsx scripts/test-play-policy.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';

let f = 0;
const ok = (n: string, c: boolean, d?: any) =>
  (c ? console.log('  ✓', n) : (f++, console.error('  ✗', n, d !== undefined ? JSON.stringify(d) : '')));

const ROOT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Поверхности, на которых человек может увидеть раздел или попасть в него.
 * Значение — как именно файл обязан спрашивать политику.
 */
const SURFACES: Record<string, string[]> = {
  'src/components/StartMenu.tsx': ['visibleSections'],
  'src/components/Taskbar.tsx': ['visibleSections'],
  'src/components/Desktop.tsx': ['visibleSections'],
  'src/components/CommandBar.tsx': ['visibleSections'],
  'src/screens/Dashboard.tsx': ['visibleSections'],
  'src/components/SectionFrame.tsx': ['sectionAccess'],
  // Окно — единственный способ показать раздел, и потому последний заслон
  // сразу для всех входов: значка, плитки, ссылки, подсказки помощника
  'src/store/windowStore.ts': ['sectionAccess'],
  // Адресная строка: скрытый раздел не должен оставаться в ней после попытки
  'src/components/WindowsLayer.tsx': ['sectionAccess'],
  // Руководство и помощник: статья и демонстрация — такой же способ узнать о
  // разделе, как его название в Пуске
  'src/screens/Handbook.tsx': ['allowEntitlement'],
  'src/store/assistantStore.ts': ['allowEntitlement'],
  'src/components/assistant/Chat.tsx': ['allowEntitlement'],
  // Лист Параметров — тоже вход: по нему видно, что платформа существует
  'src/screens/SettingsScreen.tsx': ['canManagePlay'],
  // Карточка сотрудника: список игр виден только тому, кому они открыты
  'src/screens/UsersManagement.tsx': ['canOpenApp'],
};

/**
 * Поверхности, которые политику НЕ зовут, и почему это правильно.
 *
 * Причина обязана объяснять, откуда берётся отбор, а не просто разрешать.
 */
const GUARDED_ELSEWHERE: Record<string, string> = {
  'src/components/DeskSwitcher.tsx': 'показывает уже открытые окна; открыть закрытый раздел нечем (windowStore)',
  'src/components/SnapAssist.tsx': 'раскладывает уже открытые окна',
  'src/components/TaskbarPeek.tsx': 'список окон одной кнопки панели задач, отобранной политикой',
  'src/App.tsx': 'берёт из реестра только заголовок открытого окна',
  'src/components/desktop/DeskIcon.tsx': 'рисует значок; состав стола отбирает Desktop.tsx',
};

console.log('1. Каждая поверхность спрашивает политику');
for (const [file, needles] of Object.entries(SURFACES)) {
  const src = read(file);
  const missing = needles.filter((n) => !src.includes(n));
  ok(`${file} зовёт политику`, missing.length === 0, missing);
}

console.log('\n2. Оговорки не протухли');
{
  // Файл, переставший существовать, — это оговорка, разрешающая ничего.
  // Такая оговорка однажды прикроет настоящую дыру
  for (const file of Object.keys(GUARDED_ELSEWHERE)) {
    let exists = true;
    try { read(file); } catch { exists = false; }
    ok(`${file} существует`, exists);
  }
  for (const file of Object.keys(SURFACES)) {
    let exists = true;
    try { read(file); } catch { exists = false; }
    ok(`${file} существует`, exists);
  }
  const both = Object.keys(SURFACES).filter((p) => GUARDED_ELSEWHERE[p]);
  ok('ни один файл не стоит в обоих списках', both.length === 0, both);
}

console.log('\n3. Потребители реестра разделов учтены');
{
  // Каждый файл, читающий SECTIONS, обязан быть либо поверхностью, либо
  // оговоркой. Новый потребитель, про который забыли, — это новая дыра
  const consumers: string[] = [];
  const walk = (dir: string) => {
    const { readdirSync, statSync } = require('fs') as typeof import('fs');
    for (const e of readdirSync(join(ROOT, dir))) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const rel = `${dir}/${e}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e)) {
        const src = readFileSync(join(ROOT, rel), 'utf8');
        if (/from ['"][^'"]*workspace\/sections['"]/.test(src)) consumers.push(rel);
      }
    }
  };
  walk('src');
  ok(`потребителей реестра найдено: ${consumers.length}`, consumers.length >= 10, consumers.length);
  const unknown = consumers.filter((p) => !SURFACES[p] && !GUARDED_ELSEWHERE[p]);
  ok('все потребители реестра названы поимённо', unknown.length === 0, unknown);
}

console.log('\n4. Скрытый раздел объявлен скрытым');
{
  const src = read('src/workspace/sections.tsx');
  const play = /\{ path: '\/play'[^\n]*\}/.exec(src)?.[0] || '';
  ok('раздел /play есть в реестре', !!play);
  ok('у него объявлено право платформы', play.includes('entitlement: APP_PLAY'), play.slice(0, 120));
  ok('и молчаливый отказ', play.includes("accessMode: 'stealth'"), play.slice(0, 120));

  // Молчаливый отказ обязан уводить, а не объяснять: объяснение — это и есть
  // сообщение о том, что раздел существует
  const frame = read('src/components/SectionFrame.tsx');
  ok('рама уводит скрытый раздел на Главную', /access === 'hide'[\s\S]{0,120}Navigate to="\/"/.test(frame));
}

console.log('\n5. Сервер отказывает молча');
{
  const access = read('server/play/access.ts');
  ok('отказ — 404, а не 403', access.includes("res.status(404)") && !access.includes('res.status(403)'));
  ok('в теле отказа нет слова «Play»', !/error: '[^']*Play/.test(access));
  ok('заслон стоит на всём префиксе', access.includes("app.use('/api/play'"));
  ok('ключи платформы вырезаются из чужой карты прав', access.includes('stripPlayKeys'));

  const server = read('server.ts');
  ok('заслон подключён', server.includes('registerPlayAccess(app)'));
  ok('запрос доступа подключён', server.includes('registerPolicyRoutes(app)'));
  // Заслон обязан стоять раньше маршрутов платформы: иначе первый же
  // обработчик, подключённый выше, окажется открытым
  const guard = server.indexOf('registerPlayAccess(app)');
  const play = server.indexOf("'/api/play/");
  ok('заслон стоит раньше маршрутов платформы', guard > 0 && (play < 0 || guard < play), { guard, play });
}

console.log('\n6. Правило одно на окно и на сервер');
{
  const shared = read('play/policy.ts');
  ok('общее правило не тянет React и express', !/from '(react|express)'/.test(shared));
  ok('общее правило не тянет src/ и server/', !/from '\.\.\/(src|server)\//.test(shared));
  ok('окно берёт решение из общего правила', read('src/lib/appPolicy.ts').includes("from '../../play/policy'"));
  ok('сервер берёт решение оттуда же', read('server/play/access.ts').includes("from '../../play/policy.js'"));
}

console.log(f === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${f}`);
process.exit(f === 0 ? 0 : 1);
