/**
 * Проверка перед отправкой: что Studio проверяет сама, а что честно не проверяет.
 *
 * Каждая строка отчёта — одно из трёх: «выполнено», «не прошло» или «не проверяется
 * автоматически» (с объяснением, чем это проверяется иначе). Отправка недоступна, пока
 * есть хоть одно «не прошло»; отчёт целиком уходит владельцу в подписанном запросе.
 *
 * Таблица связок из плана (docs/roadmap/modules.md, «Проверка связок») разобрана по тому,
 * что можно доказать без запуска Flux: договор, привязки и чтения, контрольные примеры,
 * пределы, изоляция по тексту кода, методология текстов формы. Права, офлайн и файлы
 * Проводника зависят от настоящего Flux и помечены «не проверяется автоматически».
 */
import { needOfLiteralUrl } from '../../modules/permissions/netLiteral';
import { validManifest } from '../../modules/schemas';
import { CONTRACT_VERSION, type ModuleManifest, resources } from '../../modules/contract';
import { validateModuleForm } from '../../modules/validateForm';
import { CONTROLS_FILE, LIMITS, LOGIC_FILES, languageOf } from '../../modules/engine/types';
import { wasmProblem } from '../../modules/engine/wasmInspect';
import { parseControls } from '../../modules/engine/controls';
import { MODULE_BUNDLE_MAX, MODULE_VERSION } from '../../modules/trust/claims';
import { compareVersions } from '../../shared/versionCompare';
import { pageProblem, pageFiles, PAGE_ENTRY, PAGE_MIN_FLUX } from '../../modules/page/model';
import { exportsItem, programsItem } from './programChecks';
import type { ControlsEngine } from './controlsEngine';
import type { ProjectFiles } from './templates';

export type CheckStatus = 'ok' | 'fail' | 'manual';
export interface CheckItem { id: string; title: string; status: CheckStatus; detail: string }
export interface CheckReport { v: 1; ok: boolean; at: number; studio: string; items: CheckItem[] }

const text = (files: ProjectFiles, name: string): string | null => files[name] ? Buffer.from(files[name]).toString('utf8') : null;
const item = (id: string, title: string, status: CheckStatus, detail: string): CheckItem => ({ id, title, status, detail });

/** Что запрещено в тексте логики: программа изолирована, и эти обращения всё равно закрыты, но лучше узнать об этом сразу */
const FORBIDDEN_CODE: Array<[RegExp, string]> = [
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\b\s*\(/, 'сетевой вызов (сеть программам закрыта; внешние программы — через подключения в manifest.json)'],
  [/\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/, 'хранилище браузера (состояние хранит оболочка: flux state)'],
  [/\b(?:window\.parent|parent\.postMessage|top\.|ipcRenderer|require\s*\(\s*['"]electron)/, 'выход за пределы окна программы'],
  [/\beval\s*\(|new\s+Function\s*\(/, 'динамическое выполнение кода (запрещено CSP)'],
  [/\bimport\s*\(/, 'динамическое подключение файлов'],
];
/** Вызовы записи в данные Flux: договор v1 — только чтение */
const WRITE_CALL = /\bflux\s*\.\s*(?:write|set|update|create|delete|remove|save|patch|put)\w*\s*\(/;
/** Рекламные слова, которыми методология запрещает подписывать интерфейс (01-design.md, раздел 6) */
/**
 * Страница (договор v2): что в её файлах закрыто CSP во Flux. Находим сразу, чтобы разработчик не узнал об этом
 * только при запуске: сеть (адреса http/https/ws и fetch), хранилища, eval, встроенные скрипты и стили.
 */
const PAGE_FORBIDDEN: Array<[RegExp, string]> = [
  [/(?<![.\w])fetch\s*\(|\b(?:XMLHttpRequest|WebSocket|EventSource|importScripts)\b|\bsendBeacon\b/, 'сетевой вызов: кадр страницы в сеть не ходит; интернет и внешние программы — через flux.net.fetch и подключения в manifest.json'],
  [/\b(?:localStorage|sessionStorage|indexedDB|document\.cookie|caches)\b/, 'хранилище браузера: состояние окна хранит Flux (flux.state)'],
  [/\b(?:window\.parent|parent\.(?:document|location|postMessage)|top\.|window\.top|ipcRenderer)/, 'выход за пределы кадра страницы'],
  [/\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/, 'динамическое выполнение кода (CSP без eval)'],
  [/\bwindow\.open\s*\(|\blocation\s*\.\s*(?:href|assign|replace)\s*=/, 'переход или новое окно из страницы: свои окна открывает flux.windows.open'],
];
/** В html: внешние адреса ресурсов, встроенные скрипты, теги и атрибуты style (CSP страницы их не пускает) */
function pageHtmlProblems(html: string): string[] {
  const out: string[] = [];
  if (/(?:src|href|action)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html)) out.push('ссылка на внешний адрес: ресурсы страницы лежат в пакете');
  if (/<script(?![^>]*\bsrc=)[^>]*>\s*[^<\s]/i.test(html)) out.push('встроенный <script>: вынесите код в файл (CSP запрещает встроенные скрипты)');
  if (/<style[\s>]/i.test(html) || /\sstyle\s*=/i.test(html)) out.push('встроенные стили (<style> или атрибут style): вынесите в .css файл (CSP запрещает)');
  if (/\son[a-z]+\s*=/i.test(html)) out.push('обработчик события в атрибуте (onclick…): подпишитесь из скрипта');
  return out;
}
const ADVERT = /мгновенн|сквозн|в реальном времени|интеллектуальн|революцион|уникальн/i;

/**
 * Обращения `flux.net.fetch` и объявленные разрешения: адрес в коде без `permissions` (или заведомо закрытый адрес) —
 * проблема здесь, а не отказ у людей; лишнее разрешение, которым код не пользуется, тоже проблема: люди соглашаются на каждое.
 * Адреса из переменных не видны — их проверит запуск; закрыто всегда: петля, этот компьютер, метаданные облака.
 */
function netItem(manifest: ModuleManifest, scripts: string[]): CheckItem {
  // Обращения к программам (kind program) к сети не относятся — их проверяет programsItem
  const declared = new Set((manifest.permissions || []).flatMap(p => p.kind === 'internet' || p.kind === 'lan' ? [p.kind] : []));
  const hasConnections = (manifest.connections || []).length > 0;
  const problems: string[] = [];
  let calls = 0;
  const needs = new Set<'internet' | 'lan'>();
  for (const body of scripts) {
    calls += [...body.matchAll(/\bnet\s*\.\s*fetch\s*\(/g)].length;
    for (const m of body.matchAll(/\bnet\s*\.\s*fetch\s*\(\s*(['"`])(https?:\/\/[^'"`$]*)/gi)) {
      const need = needOfLiteralUrl(m[2]);
      if (need === 'closed') problems.push(`адрес ${m[2].slice(0, 60)} закрыт всегда (этот компьютер или метаданные облака): локальный сервер открывается подключением в manifest.json`);
      else if (need) needs.add(need);
    }
  }
  for (const need of needs) if (!declared.has(need)) problems.push(`flux.net.fetch к ${need === 'internet' ? 'адресу в интернете' : 'адресу локальной сети'} без разрешения «${need}» в permissions manifest.json`);
  if (calls > 0 && !declared.size && !hasConnections) problems.push('flux.net.fetch без permissions и без подключений в manifest.json: Flux откажет');
  for (const kind of declared) if (calls === 0) problems.push(`разрешение «${kind}» объявлено, но flux.net.fetch в коде не вызывается: люди соглашаются на каждое разрешение, не просите лишнего`);
  return item('page-net', 'Страница: обращения по сети и разрешения', problems.length ? 'fail' : 'ok',
    problems.join('; ') || (calls ? `обращений flux.net.fetch: ${calls}; нужное объявлено (${[...declared].join(', ') || 'подключения'}); настоящую проверку делает запуск` : 'сеть не используется, разрешений сети нет'));
}

function readsUsedInCode(source: string): string[] {
  return [...new Set([...source.matchAll(/\.read\s*\(\s*['"]([a-z]+)['"]/g)].map(m => m[1]))];
}

/** Источники значений формы: flux.<ресурс>… */
function resourcesInForm(form: any): string[] {
  const out = new Set<string>();
  const add = (bind: unknown) => { const m = /^flux\.([a-z]+)/.exec(String(bind)); if (m) out.add(m[1]); };
  for (const group of form?.groups || []) for (const field of group.fields || []) add(field.bind);
  for (const table of form?.tables || []) add(table.bind);
  return [...out];
}

function methodologyProblems(form: any): string[] {
  const problems: string[] = [];
  const labels: Array<[string, string]> = [];
  for (const group of form?.groups || []) {
    labels.push(['заголовок группы', group.title]);
    for (const field of group.fields || []) labels.push(['подпись поля', field.label]);
  }
  for (const table of form?.tables || []) {
    labels.push(['заголовок таблицы', table.title]);
    for (const column of table.columns || []) labels.push(['заголовок колонки', column.label]);
  }
  for (const [kind, value] of labels) {
    const label = String(value ?? '');
    if (!label.trim()) { problems.push(`${kind} не заполнен`); continue; }
    if (label.length > 60) problems.push(`${kind} «${label.slice(0, 30)}…» длиннее 60 знаков`);
    if (ADVERT.test(label)) problems.push(`${kind} «${label}»: рекламное слово (раздел 6 методологии)`);
    // Заглавными бывают только аббревиатуры и коды: слово из 4+ заглавных букв подряд — крик
    if (/(^|\s)[А-ЯЁA-Z]{4,}(\s|$)/.test(label)) problems.push(`${kind} «${label}»: слово заглавными буквами`);
    if (/[.!]$/.test(label.trim()) || /!/.test(label)) problems.push(`${kind} «${label}»: без точки и восклицательного знака на конце`);
  }
  return problems;
}

function png(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

export interface CheckInput {
  files: ProjectFiles;
  changelog: string;
  studioVersion: string;
  engine: ControlsEngine | null;
}

export async function runChecks(input: CheckInput): Promise<CheckReport> {
  const { files } = input;
  const items: CheckItem[] = [];

  // 1. Договор ---------------------------------------------------------------
  let manifest: ModuleManifest | null = null;
  const contract: string[] = [];
  try { manifest = JSON.parse(text(files, 'manifest.json') || ''); } catch { contract.push('manifest.json не читается как JSON'); }
  if (manifest && !validManifest(manifest)) {
    // Разрешения и exports — формат v3: старый Flux не знает эти разделы и не примет такой выпуск за v1/v2
    const asked = (manifest as ModuleManifest).permissions !== undefined ? 'permissions (интернет, локальная сеть, обращение к программам)' : (manifest as ModuleManifest).exports !== undefined ? 'exports (методы для других программ)' : '';
    contract.push(asked && (manifest as ModuleManifest).contractVersion !== 3
      ? `раздел ${asked} — формат v3: укажите contractVersion 3`
      : 'manifest.json не соответствует формату программы (id, версия, entries, reads, logic, language, для страницы — contractVersion 2 и ui, для permissions и exports — contractVersion 3; у обращения к программе — идентификатор, не равный своему, и текст для человека)');
  }
  if (manifest && validManifest(manifest)) {
    if (!MODULE_VERSION.test(manifest.version)) contract.push('версия — три числа через точку');
    if (manifest.contractVersion > CONTRACT_VERSION) contract.push(`программе нужен формат v${manifest.contractVersion}, а Studio знает v${CONTRACT_VERSION}: обновите Studio`);
    if (!files[manifest.logic]?.length) contract.push(`нет файла логики ${manifest.logic}`);
    if (!manifest.entries.length) contract.push('entries пуст: программе негде появиться');
  }
  const isPage = !!manifest && (manifest as ModuleManifest).ui === 'page';
  if (isPage) { const problem = pageProblem(files, (manifest as ModuleManifest).pages); if (problem) contract.push(problem); }
  else if (!files['form.json']) contract.push('нет form.json');
  if (!isPage && (manifest as ModuleManifest | null)?.permissions?.length) contract.push('permissions (интернет, локальная сеть, обращение к программам) нужны только программе со своим экраном: flux.net.fetch и flux.programs.call есть на странице');
  if (isPage) {
    const need = (manifest as ModuleManifest).store?.requires?.flux;
    if (!need || compareVersions(need, PAGE_MIN_FLUX) < 0) contract.push(`для страницы укажите store.requires.flux не ниже ${PAGE_MIN_FLUX}: старый Flux её не запустит, а Store спрячет установку`);
  }
  const total = Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0);
  if (total > MODULE_BUNDLE_MAX) contract.push(`проект больше ${MODULE_BUNDLE_MAX / 1024 / 1024} МиБ`);
  items.push(item('contract', 'Формат: manifest.json и состав пакета', contract.length ? 'fail' : 'ok', contract.join('; ') || (isPage ? `manifest.json соответствует формату v2, страница ${PAGE_ENTRY} на месте` : 'manifest.json соответствует формату v1, файлы на месте')));
  if (!manifest || !validManifest(manifest)) return finish(items, input);

  // 2. Привязки и чтения -----------------------------------------------------
  const binding: string[] = [];
  let form: any = null;
  if (!isPage) try { form = JSON.parse(text(files, 'form.json') || ''); validateModuleForm(form, manifest.id, manifest.reads); }
  catch (e: any) { binding.push(String(e?.message || 'form.json не читается').replace(/^form\.json модуля «[^»]*»: /, '')); }
  const language = languageOf(manifest);
  const source = language === 'wasm' ? '' : text(files, manifest.logic) || '';
  for (const resource of readsUsedInCode(source)) {
    if (!(resources as readonly string[]).includes(resource)) binding.push(`логика читает неизвестный ресурс «${resource}»`);
    else if (!manifest.reads.includes(resource as any)) binding.push(`логика читает «${resource}», но его нет в reads файла manifest.json`);
  }
  if (WRITE_CALL.test(source)) binding.push('вызов записи в данные Flux: формат v1 допускает только чтение');
  items.push(item('bindings', isPage ? 'Чтения данных' : 'Источники значений формы и чтения данных', binding.length ? 'fail' : 'ok', binding.join('; ') || (isPage ? 'чтения объявлены в reads, записи нет' : 'все источники значений есть в схеме данных, чтения объявлены в reads, записи нет')));

  // 3. Связи с данными Flux (часть таблицы связок) ---------------------------
  const usedResources = new Set([...resourcesInForm(form), ...readsUsedInCode(source)]);
  const links: string[] = [];
  if (usedResources.has('equipment') && !manifest.entries.some(e => e === 'equipment')) links.push('читает оборудование, но не объявляет вход из карточки позиции (entries: equipment)');
  if (usedResources.has('tag') && !manifest.entries.some(e => e === 'tag')) links.push('читает тег, но не объявляет вход из карточки тега (entries: tag)');
  items.push(item('links', 'Проект, оборудование, теги, спецификации: чтение без записи', links.length ? 'fail' : 'ok',
    links.join('; ') || (usedResources.size ? `читает: ${[...usedResources].join(', ')}; запись невозможна в этом формате` : 'данные Flux не читает')));
  items.push(item('links-manual', 'Файлы Проводника, выпуск документов, права, офлайн', 'manual',
    'Не проверяется автоматически: зависит от настоящего Flux. Проверяют набор связок Flux в CI и владелец при запуске в тестовом Flux.'));

  // 4. Изоляция по тексту кода ----------------------------------------------
  const isolation: string[] = [];
  if (language !== 'wasm') for (const [pattern, reason] of FORBIDDEN_CODE) if (pattern.test(source)) isolation.push(reason);
  let wasm = '';
  if (language === 'wasm') {
    wasm = wasmProblem(files[manifest.logic] || new Uint8Array(0));
    if (wasm) isolation.push(wasm);
  }
  items.push(item('isolation', 'Изоляция: нет сети, хранилищ, выхода из окна', isolation.length ? 'fail' : 'ok',
    isolation.join('; ') || (language === 'wasm' ? 'импорты .wasm — только разрешённые Flux' : 'в тексте логики нет запрещённых обращений; сама изоляция проверяется при запуске во Flux')));

  const exported = exportsItem(manifest, language, source);
  if (exported) items.push(exported);

  // 4а. Страница: нарушения CSP, обращения в сеть, размер, обе темы -------------
  if (isPage) {
    const csp: string[] = [], themeIssues: string[] = [];
    const sources = pageFiles(files).filter(f => /\.(?:js|mjs|html|css|svg)$/i.test(f));
    let usesTokens = false, hardColors = false;
    for (const file of sources) {
      const body = text(files, file) || '';
      const found = new Set<string>();
      if (/\.html$/i.test(file)) for (const reason of pageHtmlProblems(body)) found.add(reason);
      if (/\.(?:js|mjs)$/i.test(file)) for (const [pattern, reason] of PAGE_FORBIDDEN) if (pattern.test(body)) found.add(reason);
      if (/\.css$/i.test(file)) {
        if (/@import\s+(?:url\()?['"]?(?:https?:)?\/\//i.test(body) || /url\(\s*['"]?(?:https?:)?\/\//i.test(body)) found.add('внешний адрес в стилях');
        if (/var\(--flux-/.test(body)) usesTokens = true;
        if (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(body)) hardColors = true;
      }
      if (/\.html$/i.test(file) && /flux-ui\.v1\.css/.test(body)) usesTokens = true;
      if (/\.(?:js|mjs)$/i.test(file) && /--flux-|flux\.theme|onTheme/.test(body)) usesTokens = true;
      for (const reason of found) csp.push(`${file}: ${reason}`);
    }
    items.push(item('page-csp', 'Страница: нет нарушений CSP и обращений в сеть', csp.length ? 'fail' : 'ok',
      csp.join('; ') || 'в файлах страницы нет сети, хранилищ, eval, встроенных скриптов и стилей; настоящую проверку делает запуск (CSP-нарушения видны в журнале)'));
    if (hardColors && !usesTokens) themeIssues.push('цвета в стилях заданы жёстко и нет токенов Flux (var(--flux-…)): в одной из тем текст может оказаться нечитаемым');
    const scripts = sources.map(f => text(files, f) || '').filter((_, i) => /\.(?:js|mjs)$/i.test(sources[i]));
    items.push(netItem(manifest, scripts));
    const programs = programsItem(manifest, scripts);
    if (programs) items.push(programs);
    items.push(item('page-themes', 'Страница: работа в светлой и тёмной теме', themeIssues.length ? 'fail' : 'ok',
      themeIssues.join('; ') || 'цвета берутся из токенов темы Flux; вид в обеих темах подтверждают снимки (раздел «Запуск» → «Снять обе темы»)'));
  }

  // 5. Пределы времени и памяти ---------------------------------------------
  const limits: string[] = [];
  const logicBytes = files[manifest.logic]?.length || 0;
  if (language === 'wasm' && logicBytes > LIMITS.wasmFileBytes) limits.push('файл .wasm больше 8 МиБ');
  if (language === 'python' && logicBytes > LIMITS.pythonFileBytes) limits.push('файл Python больше 1 МиБ');
  if (language === 'typescript' && logicBytes > 1024 * 1024) limits.push('файл логики больше 1 МиБ');

  // 6. Контрольные примеры ---------------------------------------------------
  const controlsText = text(files, CONTROLS_FILE);
  const exportsCompute = language === 'typescript' ? /\bexport\s+(?:async\s+)?function\s+compute\b|\bexport\s+(?:const|let)\s+compute\b|exports\.compute\b/.test(source) : true;
  if (controlsText === null) {
    if (language === 'typescript' && !exportsCompute) {
      items.push(item('controls', 'Контрольные примеры', 'manual', 'Не проверяется автоматически: логика на обработчиках (setup), без функции compute; запустите её на тестовой базе.'));
    } else {
      items.push(item('controls', 'Контрольные примеры', 'fail', `Нужен файл ${CONTROLS_FILE}: «вход → ожидаемый выход с допуском». Для Python и WebAssembly он обязателен.`));
    }
  } else if (!input.engine) {
    const parsed = parseControls(controlsText);
    items.push(item('controls', 'Контрольные примеры', typeof parsed === 'string' ? 'fail' : 'manual', typeof parsed === 'string' ? parsed : 'Не проверяется автоматически: расчёт в этой сборке недоступен.'));
  } else {
    const outcome = await input.engine.run(language, files, manifest.logic, controlsText);
    if (outcome.kind === 'invalid') items.push(item('controls', 'Контрольные примеры', 'fail', outcome.reason));
    else if (outcome.kind === 'unavailable') {
      const parsed = parseControls(controlsText);
      items.push(item('controls', 'Контрольные примеры', typeof parsed === 'string' ? 'fail' : 'manual', typeof parsed === 'string' ? parsed : `Файл примеров разобран; ${outcome.reason}`));
    } else if (!outcome.report.ok) {
      const first = outcome.report.failures[0];
      items.push(item('controls', 'Контрольные примеры', 'fail',
        `${outcome.report.failures.length} из ${outcome.cases} не сошлись; «${first.name}»: ${first.error || `${first.path}: ждали ${JSON.stringify(first.expected)}, получили ${JSON.stringify(first.actual)}`}`));
      if (outcome.report.failures.some(f => f.error === 'TIMEOUT' || f.error === 'MEMORY')) limits.push('расчёт не уложился во время или память');
    } else {
      items.push(item('controls', 'Контрольные примеры', 'ok', `Сошлись все ${outcome.cases} (самый долгий расчёт ${outcome.slowestMs} мс)`));
      if (outcome.slowestMs > LIMITS.timeoutMs / 2) limits.push(`расчёт занял ${outcome.slowestMs} мс — больше половины предела ${LIMITS.timeoutMs / 1000} с`);
    }
  }
  items.push(item('limits', 'Пределы времени и памяти', limits.length ? 'fail' : 'ok',
    limits.join('; ') || `Расчёт ограничен ${LIMITS.timeoutMs / 1000} с и ${language === 'python' ? 'памятью Pyodide' : language === 'wasm' ? 'максимумом памяти из файла' : 'памятью потока'}; размеры файлов в пределах`));

  // 7. Методология интерфейса (проверочный список 01-design.md, раздел 8) -----
  const method = methodologyProblems(form);
  if (!isPage) items.push(item('methodology', 'Методология: тексты формы', method.length ? 'fail' : 'ok', method.join('; ') || 'подписи по правилам раздела 6: без рекламы, заглавных слов, точек на конце'));
  items.push(item('methodology-visual', 'Методология: цвета, размеры, обе темы', isPage ? 'manual' : 'ok',
    isPage ? 'Не проверяется автоматически: страницу рисует сам разработчик. Набор Flux (/_flux/flux-ui.v1.css) даёт цвета, меры и компоненты по словарю методологии; владелец смотрит снимки и пробный запуск.'
      : 'Форма собирается компонентами Flux из form.json: цвета только из токенов, меры и обе темы заданы оболочкой.'));

  // 8. «Что нового» и снимки -------------------------------------------------
  const log = input.changelog.trim();
  items.push(item('changelog', '«Что нового»', !log ? 'fail' : log.length > 4000 ? 'fail' : 'ok',
    !log ? 'Заполните «что нового»: без него пользователь в Flux Store не поймёт, зачем обновляться' : log.length > 4000 ? 'Не длиннее 4000 знаков' : `${log.length} знаков`));
  const shots = manifest.store?.screenshots || [];
  const shotProblems: string[] = [];
  if (!shots.length) shotProblems.push('снимите окно программы в светлой и тёмной теме (нижняя панель «Запуск» → «Снять обе темы»)');
  for (const shot of shots) {
    const bytes = files[shot];
    if (!bytes) shotProblems.push(`нет файла ${shot}`);
    else if (shot.endsWith('.png') && !png(bytes)) shotProblems.push(`${shot} не PNG`);
    else if (bytes.length > 2 * 1024 * 1024) shotProblems.push(`${shot} больше 2 МиБ`);
  }
  items.push(item('screenshots', 'Снимки обеих тем', shotProblems.length ? 'fail' : 'ok', shotProblems.join('; ') || `${shots.length} снимк. в пакете`));

  return finish(items, input);
}

function finish(items: CheckItem[], input: CheckInput): CheckReport {
  return { v: 1, ok: items.every(i => i.status !== 'fail'), at: Date.now(), studio: input.studioVersion, items };
}

/** Короткий текст отчёта для подписанного запроса (предел поля meta.checks — 16000 знаков) */
export function reportForRequest(report: CheckReport): string {
  const compact = (limit: number) => JSON.stringify({ ...report, items: report.items.map(i => ({ ...i, detail: i.detail.slice(0, limit) })) });
  for (const limit of [400, 200, 80, 0]) { const out = compact(limit); if (out.length <= 15_000) return out; }
  return JSON.stringify({ v: 1, ok: report.ok, at: report.at, studio: report.studio, items: [] });
}
