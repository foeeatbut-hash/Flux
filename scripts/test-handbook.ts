import fs from 'fs';
import path from 'path';
import { ARTICLES, search, forRoute } from '../src/handbook/registry';
import { anchorsOf, foldRu } from '../src/handbook/model';
import { FEATURES } from '../src/lib/permissions';
import { thingRu, linkRu, missingNames } from '../src/handbook/names';
import { resolveSectionPath } from '../src/lib/sectionAliases';

/**
 * Руководство не должно врать.
 *
 * Встроенная справка портится не потому, что её плохо написали, а потому что
 * программа едет дальше, а текст остаётся. Здесь проверяется то, что можно
 * проверить механически: раздел, на который ссылается статья, существует;
 * модель, которую она называет хранилищем, есть в схеме; поле связи есть в
 * модели; право есть в каталоге. Переименовали что-нибудь — набор падает, и
 * статью правят вместе с кодом, а не «когда-нибудь потом».
 *
 * Отдельная забота — язык. Руководство читает инженер, а не тот, кто писал
 * программу: английских имён таблиц и полей он видеть не должен. Имена в
 * статьях остаются английскими — по ним и идёт сверка со схемой, — но у
 * каждого обязан быть русский перевод, иначе английское слово доедет до
 * экрана.
 *
 * Прозу проверить нельзя, и мы не делаем вид, что можно.
 */

let ok = 0;
let fail = 0;
const eq = (name: string, got: any, want: any, extra?: any) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, JSON.stringify(got), '≠', JSON.stringify(want), extra ?? ''); }
};

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf-8');
const sectionsSrc = fs.readFileSync(path.join(root, 'src/workspace/sections.tsx'), 'utf-8');

// Модели схемы и поля каждой
const MODELS = new Map<string, string>();
for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) MODELS.set(m[1], m[2]);

// Разделы программы из реестра
const ROUTES = new Map<string, string>();
for (const m of sectionsSrc.matchAll(/path: '([^']+)', title: '([^']+)'/g)) ROUTES.set(m[1], m[2]);

const FEATURE_IDS = new Set(FEATURES.map((f) => f.id));

console.log('1. Каждый раздел программы описан');
{
  const described = new Set(ARTICLES.map((a) => a.route).filter(Boolean).map((route) => resolveSectionPath(String(route).split(/[?#]/, 1)[0])));
  const missing = [...ROUTES.keys()].filter((r) => !described.has(r));
  eq('в руководстве нет пропущенных разделов', missing, [], missing.map((r) => ROUTES.get(r)));

  const strayRoutes = [...new Set(ARTICLES.map((a) => a.route).filter(Boolean).map((route) => resolveSectionPath(String(route).split(/[?#]/, 1)[0])))].filter((r) => !ROUTES.has(r));
  eq('нет статей про несуществующие разделы', strayRoutes, []);
}

console.log('\n2. Заголовок статьи совпадает с названием раздела');
{
  const wrong: string[] = [];
  for (const a of ARTICLES) {
    if (!a.route) continue;
    const routePath = a.route.split(/[?#]/, 1)[0];
    const canonical = resolveSectionPath(routePath);
    // Внутренние места сохраняют собственные статьи, хотя ведут в то же окно.
    if (canonical !== routePath) continue;
    const title = ROUTES.get(canonical);
    // «Главная» описана статьёй «С чего начать» — это осознанно: статья шире
    // одного раздела. Остальные обязаны совпадать, иначе человек ищет по
    // названию из меню и не находит.
    if (a.route === '/') continue;
    if (title && title !== a.title) wrong.push(`${a.route}: «${a.title}» вместо «${title}»`);
  }
  eq('названия не разошлись с меню', wrong, []);
}

console.log('\n3. Названные хранилища есть в схеме');
{
  const unknown: string[] = [];
  for (const a of ARTICLES) {
    for (const model of a.stores || []) {
      if (!MODELS.has(model)) unknown.push(`${a.id}: ${model}`);
    }
  }
  eq('все модели существуют', unknown, []);
}

console.log('\n4. Связи ведут к настоящим моделям и полям');
{
  const badModel: string[] = [];
  const badField: string[] = [];
  for (const a of ARTICLES) {
    for (const [from, to, via] of a.links || []) {
      if (!MODELS.has(from)) { badModel.push(`${a.id}: ${from}`); continue; }
      if (!MODELS.has(to)) { badModel.push(`${a.id}: ${to}`); continue; }
      // В «via» пишем поле, иногда с пояснением после тире или через «и»
      const fields = via.split('—')[0].split(/\s+и\s+|,\s*/).map((s) => s.trim()).filter(Boolean);
      const body = MODELS.get(from) || '';
      for (const f of fields) {
        if (!f || /\s/.test(f)) continue; // пояснение словами, а не имя поля
        const has = new RegExp(`^\\s*${f}\\s`, 'm').test(body);
        if (!has) badField.push(`${a.id}: ${from}.${f}`);
      }
    }
  }
  eq('модели связей существуют', badModel, []);
  eq('поля связей существуют', badField, []);
}

console.log('\n5. Названные права есть в каталоге');
{
  const unknown: string[] = [];
  for (const a of ARTICLES) {
    for (const p of a.perms || []) if (!FEATURE_IDS.has(p)) unknown.push(`${a.id}: ${p}`);
  }
  eq('все права существуют', unknown, []);
}

console.log('\n6. Ссылки между статьями не висят в пустоте');
{
  const ids = new Set(ARTICLES.map((a) => a.id));
  const broken: string[] = [];
  for (const a of ARTICLES) for (const s of a.see || []) if (!ids.has(s)) broken.push(`${a.id} → ${s}`);
  eq('смежные статьи существуют', broken, []);

  const dupes = ARTICLES.map((a) => a.id).filter((id, i, arr) => arr.indexOf(id) !== i);
  eq('идентификаторы не повторяются', dupes, []);
}

console.log('\n7. Статья пригодна к чтению');
{
  const empty = ARTICLES.filter((a) => !a.lead.trim() || !a.tasks.length).map((a) => a.id);
  eq('у каждой статьи есть вступление и хотя бы одно дело', empty, []);

  const emptySteps = ARTICLES
    .flatMap((a) => a.tasks.map((t) => ({ a: a.id, t })))
    .filter(({ t }) => !t.steps.length || t.steps.some((s) => !s.trim()))
    .map(({ a, t }) => `${a}: ${t.title}`);
  eq('в делах нет пустых шагов', emptySteps, []);

  const noAnchors = ARTICLES.filter((a) => anchorsOf(a).length < 2).map((a) => a.id);
  eq('в каждой статье есть о чём сделать оглавление', noAnchors, []);
}

console.log('\n8. Поиск находит то, что должен');
{
  eq('«корзина» ведёт в Проводник', search('корзина')[0]?.article.id, 'explorer');
  eq('«Файлы Windows» ведёт в единый Проводник', search('Файлы Windows')[0]?.article.id, 'explorer');
  eq('«экспорт оборудования» ведёт в выгрузку данных', search('экспорт оборудования')[0]?.article.id, 'equipment-export');
  eq('«пароль приложения» ведёт в Почту', search('пароль приложения')[0]?.article.id, 'mail');
  eq('«бэкап» ведёт в резервные копии', search('бэкап')[0]?.article.id, 'backup');
  eq('«кто что может» ведёт в права', search('кто что может')[0]?.article.id, 'access');
  eq('«горячие клавиши» ведут в клавиши', search('горячие клавиши')[0]?.article.id, 'keys');
  // «ё» и «е» — одно и то же: человек не обязан помнить, как написано в тексте
  eq('поиск не различает ё и е', search('чертеж').length > 0, true);
  eq('однобуквенный запрос ничего не ищет', search('к'), []);
  eq('поиск требует все слова запроса', search('корзина оборудование').length, 0);
}

console.log('\n9. Вход из раздела');
{
  eq('у Почты есть своя статья', forRoute('/mail')?.id, 'mail');
  eq('у Тегов есть своя статья', forRoute('/registry')?.id, 'registry');
  eq('у выгрузки есть своя статья', forRoute('/equipment-export')?.id, 'equipment-export');
  eq('старый адрес Проводника Windows ведёт в общую статью программы', forRoute('/windows-files')?.id, 'explorer');
  eq('внутренняя папка общего доступа открывает статью места', forRoute('/explorer?view=shared')?.id, 'shared-files');
  eq('у локального файла Windows есть своя статья', forRoute('/windows-file')?.id, 'windows-file');
  eq('неизвестный путь не даёт статью', forRoute('/нет-такого'), null);
}

console.log('\n10. Списки синонимов опрятны');
{
  // Раньше здесь запрещались синонимы, совпадающие со словом из текста. Это
  // было ошибкой: поиск как раз добавляет вес за совпадение с этим списком,
  // и «корзина» в нём поднимает Проводник выше случайных упоминаний. Проверяем
  // то, что действительно ломает поиск.
  const empty: string[] = [];
  const dupes: string[] = [];
  const cased: string[] = [];
  for (const a of ARTICLES) {
    const list = a.also || [];
    for (const w of list) {
      if (!w.trim()) empty.push(a.id);
      if (w !== w.toLowerCase()) cased.push(`${a.id}: ${w}`);
    }
    const seen = new Set<string>();
    for (const w of list.map(foldRu)) {
      if (seen.has(w)) dupes.push(`${a.id}: ${w}`);
      seen.add(w);
    }
  }
  eq('нет пустых синонимов', empty, []);
  eq('синонимы не повторяются', dupes, []);
  eq('синонимы в нижнем регистре', cased, []);
}

console.log('\n11. Читателю показывают русские слова, а не имена из базы');
{
  const usedThings = new Set<string>();
  const usedLinks = new Set<string>();
  for (const a of ARTICLES) {
    (a.stores || []).forEach((x) => usedThings.add(x));
    (a.links || []).forEach(([from, to, via]) => { usedThings.add(from); usedThings.add(to); usedLinks.add(via); });
  }
  eq('у каждого хранилища есть русское имя', missingNames([...usedThings]), []);

  // Латиница в том, что увидит человек, — верный признак непереведённого имени
  const latin = /[A-Za-z]{3,}/;
  const rawThings = [...usedThings].filter((x) => latin.test(thingRu(x)));
  eq('в русских именах не осталось латиницы', rawThings, []);

  const rawLinks = [...usedLinks].filter((v) => latin.test(linkRu(v)));
  eq('в описаниях связей не осталось латиницы', rawLinks, []);

  // Сам показ: экран статьи обязан звать перевод, а не печатать поле как есть
  const view = fs.readFileSync(path.join(root, 'src/components/handbook/HandbookArticleView.tsx'), 'utf-8');
  eq('статья печатает переводы', /thingRu\(/.test(view) && /linkRu\(/.test(view), true);
}

console.log(`\n${ok} проверок пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
