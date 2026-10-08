/**
 * Проверка скрипта пробы E3 (tools/e3-probe) без E3: разбор синтаксиса, запуск на подставном COM,
 * разбор журналов, запрет конструкций PowerShell 7 и, на Windows, самопроверка разборщика библиотек типов.
 *
 * Скрипт запускается у владельца в Windows PowerShell 5.1, где разбор ошибок не пересылается нам вторым кругом:
 * поэтому здесь ловится всё, что можно поймать до отправки. Где нет PowerShell — SKIP вслух (в контейнере его
 * можно подставить переменной FLUX_PWSH). На Windows CI запускается настоящий powershell.exe 5.1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let failed = 0, passed = 0;
const ok = (message: string) => { passed++; console.log(`✓ ${message}`); };
const bad = (message: string, detail?: unknown) => { failed++; console.error(`✗ ${message}${detail === undefined ? '' : `\n   ${String(detail).slice(0, 1500)}`}`); };
const check = (condition: unknown, message: string, detail?: unknown) => condition ? ok(message) : bad(message, detail);

const root = path.resolve('tools/e3-probe');
const scripts = [path.join(root, 'e3-probe.ps1'), ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.ps1')).map(f => path.join(root, 'lib', f)), path.join(root, 'test', 'fake-e3.ps1')];

// ---- статические проверки: работают везде, без PowerShell
{
  for (const file of scripts) {
    const buf = fs.readFileSync(file);
    check(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, `${path.relative(root, file)}: UTF-8 с BOM (иначе PowerShell 5.1 испортит кириллицу)`);
  }
  const cs = fs.readFileSync(path.join(root, 'lib', 'TypeInfoDump.cs'));
  check(cs[0] === 0xef && cs[1] === 0xbb && cs[2] === 0xbf, 'TypeInfoDump.cs: UTF-8 с BOM (csc читает без BOM в кодовой странице системы)');
  // PowerShell 5.1 не знает ??, ?., тернарного ?:, && и || — на 7-й версии они работают, и ошибка всплыла бы только у владельца.
  const forbidden: Array<[RegExp, string]> = [[/\?\?/, '??'], [/\?\./, '?.'], [/&&/, '&&'], [/\|\|/, '||'], [/\s\?\s[^:\n]+\s:\s/, 'тернарный ?:'], [/\bnew\s*\(/i, 'new()'], [/::new\(/, '[Тип]::new()']];
  for (const file of scripts) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const hits: string[] = [];
    lines.forEach((line, i) => {
      const code = line.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/#.*$/, '');
      for (const [re, name] of forbidden) if (re.test(code)) hits.push(`${i + 1}: ${name}`);
    });
    check(hits.length === 0, `${path.relative(root, file)}: нет конструкций PowerShell 7`, hits.join('; '));
  }
  // У объектов E3 (Job, Symbol, Device…) есть собственный метод GetType(): $x.GetType() вызывает его и возвращает данные E3,
  // а не тип .NET. Так проба в первом прогоне на настоящем проекте решила, что проект не открыт. Типы — только через Get-ClrType.
  for (const file of scripts) {
    const hits: string[] = [];
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/'[^']*'/g, "''").replace(/#.*$/, '');
      for (const m of code.matchAll(/(\$[\w.]+|\))\.GetType\(\)/g)) if (!/^\$(inner|Ex|e|failure)$/.test(m[1])) hits.push(`${i + 1}: ${m[0]}`);
      if (/\.GetType\(\)\.InvokeMember/.test(code)) hits.push(`${i + 1}: GetType().InvokeMember`);
    });
    if (!file.includes('fake-e3')) check(hits.length === 0, `${path.relative(root, file)}: нет $x.GetType() на значениях E3`, hits.join('; '));
  }
  const attrs = fs.readFileSync(path.join(root, 'attributes.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
  check(attrs.length >= 150 && new Set(attrs).size === attrs.length, `attributes.txt: ${attrs.length} уникальных имён`);
  check(attrs.every(a => !/\t|⏎/.test(a)), 'attributes.txt: только имена, без описаний');
  for (const required of ['GLOBAL_ID_IN_PROJECT', 'GLOBAL_BLOCK_ID', 'Device Designation']) check(attrs.includes(required), `attributes.txt содержит ${required}`);
  const cmd = fs.readFileSync(path.join(root, 'run.cmd'), 'utf8');
  check(/-ExecutionPolicy Bypass/.test(cmd) && /-STA/.test(cmd) && /\r\n/.test(cmd), 'run.cmd: Bypass, STA, перевод строки Windows');
  const libs = scripts.filter(f => f.includes(`${path.sep}lib${path.sep}`)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
  check(!/\(Cand '(Save|SaveAs)'/.test(libs) && !/Invoke-Com[^\n]*'Save'/.test(libs), 'ни один вариант вызова не сохраняет проект');
}

// ---- PowerShell
function findShell(): { command: string; label: string } | null {
  const candidates = [process.env.FLUX_PWSH, process.platform === 'win32' ? 'powershell.exe' : '', 'pwsh'].filter(Boolean) as string[];
  for (const command of candidates) {
    const r = spawnSync(command, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
    if (r.status === 0) return { command, label: `${command} ${r.stdout.trim()}` };
  }
  return null;
}

const shell = findShell();
if (!shell) {
  console.log('SKIP PowerShell не найден: разбор синтаксиса, запуск на подставном COM и самопроверка не выполнялись (в контейнере задайте FLUX_PWSH=<путь к pwsh>; на Windows CI используется powershell.exe 5.1).');
} else {
  console.log(`Оболочка: ${shell.label}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-probe-test-'));
  const run = (args: string[], env: Record<string, string> = {}, timeout = 300_000) =>
    spawnSync(shell.command, ['-NoProfile', ...args], { encoding: 'utf8', timeout, env: { ...process.env, ...env } });

  // разбор синтаксиса: настоящим парсером PowerShell
  {
    const parser = path.join(tmp, 'parse.ps1');
    fs.writeFileSync(parser, `param([string[]]$Files)
$bad = 0
foreach ($f in $Files) {
  $t = $null; $e = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e)
  if ($e.Count -gt 0) { $bad++; foreach ($x in $e) { Write-Output ('{0}:{1}: {2}' -f (Split-Path $f -Leaf), $x.Extent.StartLineNumber, $x.Message) } }
}
exit $bad
`);
    const r = run(['-File', parser, ...scripts]);
    check(r.status === 0, `синтаксис всех ${scripts.length} файлов .ps1 разбирается (${shell.label})`, r.stdout + r.stderr);
  }

  const runFake = (name: string, env: Record<string, string>, extra: string[] = []) => {
    const out = path.join(tmp, name);
    const r = run(['-File', path.join(root, 'e3-probe.ps1'), '-FakeCom', path.join(root, 'test', 'fake-e3.ps1'), '-NoConfirm', '-OutDir', out, ...extra], env);
    return { out, r };
  };

  // полный прогон на подставном COM
  {
    const { out, r } = runFake('full', {});
    check(r.status === 0, 'прогон на подставном COM завершился без ошибки', (r.stdout + r.stderr).slice(-1500));
    const read = (name: string) => fs.existsSync(path.join(out, name)) ? fs.readFileSync(path.join(out, name), 'utf8').replace(/^\uFEFF/, '') : '';
    for (const file of ['log.txt', 'log.json', 'log.ndjson', 'environment.json', 'api.json', 'summary.txt', 'attribute-check.csv', 'database-lists.txt']) check(fs.existsSync(path.join(out, file)), `создан ${file}`);
    check(fs.existsSync(`${out}.zip`), 'журнал заархивирован в .zip');
    {
      const t = read('log.txt');
      check(/Каталог по API/.test(t) && /НИЧЕГО не нажимайте — скрипт сам опрашивает 20 секунд/.test(t) && /панель «База данных» в окне проекта E3 \(дерево Символы\/Изделия\) ИЛИ окно редактора базы E3/.test(t), 'каталог по API: подсказка без нажатий и где выделять показана');
      check(/сек 1: .*Components 0/.test(t) && /сек 2: /.test(t) && !/сек 4: /.test(t) && /сек 3: .*Symbols 3/.test(t) && /поймано: app\.GetDatabaseTreeSelectedSymbols, вариант \[ref=\[object\[\]\]@\(\)\], имён 3/.test(t), 'каталог по API: опрос поймал выделение на 3-й секунде; вариант ref=$null не сработал, следующий сработал', t.slice(-2500));
      check(/Для чтения карточек уникальных изделий: 3/.test(t) && !/catalog\.dbe\.(progid|clsid)|DbeApplication.*New-Object/.test(t), 'каталог по API: имена из выделения прочитаны; новый экземпляр редактора базы не создаётся', t.slice(-1500));
      check(/символ «Вентилятор_ЗТД_К»: габарит 24 x 16/.test(t) && /символ «нет_символа»: Load не прошёл/.test(t), 'каталог по API: габарит символа читается после Load без размещения; нет символа — Load не прошёл', t.slice(-900));
      const sm = read('summary.txt');
      check(/КАТАЛОГ ПО API: выделение поймано на 3-й секунде.*app\.GetDatabaseTreeSelectedSymbols \[ref=\[object\[\]\]@\(\)\] = 3.*Имён всего 7, изделий 3, символов 3.*Первые 20: SYM_VALVE/.test(sm) && /КАТАЛОГ ПО API, габариты.*SYM_VALVE 24x16; Вентилятор_ЗТД_К 24x16/.test(sm), 'каталог по API: в сводке источник, вариант, число имён, первые 20 и габариты', sm.slice(0, 1500));
      let cat: any = {};
      try { cat = JSON.parse(read('catalog-api.json')); } catch (e) { bad('catalog-api.json разбирается как JSON', e); }
      check(cat.cards?.some((c: any) => c.GetName && c.attributes && Object.keys(c.attributes).length > 0 && c.GetPinIds?.length === 3) && cat.symbols?.length >= 3, 'каталог по API: карточка изделия с именем, атрибутами и выводами; габариты символов', JSON.stringify(cat).slice(0, 500));
    }
    let log: any = null;
    try { log = JSON.parse(read('log.json')); } catch (e) { bad('log.json разбирается как JSON', e); }
    if (log) {
      check(Array.isArray(log.attempts) && log.attempts.length > 200, `log.json: попыток ${log.attempts?.length}`);
      const first = log.attempts[0] ?? {};
      for (const key of ['op', 'candidate', 'args', 'ok', 'result', 'error', 'hresult', 'ms']) check(key in first, `запись журнала содержит «${key}»`);
      const jobRec = log.attempts.find((a: any) => a.op === 'app.job');
      check(jobRec?.ok && jobRec.result === 'COM-объект', 'app.job: объект проекта распознан как COM-объект (а не строка из его GetType)', JSON.stringify(jobRec));
      check(log.attempts.some((a: any) => a.op === 'job.info' && a.ok), 'job.info: вызовы у объекта проекта проходят');
      check(!log.attempts.some((a: any) => a.op === 'script.error'), 'ни один раздел не прерван ошибкой скрипта', log.attempts.filter((a: any) => a.op === 'script.error').map((a: any) => `${a.candidate}: ${a.error}`).join('; '));
      check(log.attempts.some((a: any) => !a.ok && a.hresult), 'ошибки COM записаны с HRESULT');
      check(!log.attempts.some((a: any) => /Save/.test(a.candidate) && a.op !== 'capability.save'), 'вызовов Save нет');
      const winners = new Map<string, string>(log.summary.filter((s: any) => s.tries > 0 && s.ok > 0).map((s: any) => [s.op, s.variant]));
      for (const op of ['connect.application', 'sheets.create', 'place.device.Create+Load+Place.s1.n0.effect', 'design.setname', 'wires.connect', 'export.dxf', 'export.png']) check(winners.has(op), `итоговая таблица: ${op} → ${winners.get(op) ?? 'нет'}`);
    }
    for (const line of read('log.ndjson').split(/\r?\n/).filter(Boolean)) { try { JSON.parse(line); } catch (e) { bad('log.ndjson: строка не JSON', line.slice(0, 200)); break; } }
    ok('log.ndjson: все строки — JSON');
    let api: any = null;
    try { api = JSON.parse(read('api.json')); } catch (e) { bad('api.json разбирается как JSON', e); }
    if (api) check(Object.keys(api.objects).length >= 5, `api.json: объектов ${Object.keys(api.objects).length}`);
    const txt = read('log.txt');
    const schemaTxt = read('database-schema.txt');
    check(/Компоненты \/ Components \(3 строк\)/.test(schemaTxt) && /колонки: Name, Version, Class/.test(schemaTxt), 'база напрямую: database-schema.txt содержит таблицы, колонки и число строк');
    check(read('database-names.txt').includes('клапан_DIx2_DOx2'), 'база напрямую: database-names.txt содержит имена компонентов');
    check(/найдено в базе «Компоненты», таблица Components/.test(txt), 'база напрямую: запасное решение найдено точным совпадением в базе');
    check(txt.includes('Проект НЕ сохранялся'), 'в журнале сказано, что проект не сохранялся');
    const traceFull = read('trace.log');
    check(/COM GetSheetIds/.test(traceFull) && /=== раздел 1\b/.test(traceFull), 'trace.log: метки «начинаю» для вызовов COM и разделов');
    check(/pid \d+/.test(txt.split('Выбран экземпляр')[1]?.split('\n')[0] ?? ''), 'в строке выбранного экземпляра есть pid');
    check(/Число устройств в проекте то же/.test(txt), 'после уборки число устройств в проекте то же');
    check(txt.includes('Временный лист удалён'), 'временный лист удалён');
    const summary = read('summary.txt');
    for (const part of ['ЧТО РАБОТАЕТ', 'ЧТО НЕ РАБОТАЕТ', 'ЧТО НАДО ЗАВЕСТИ В БАЗЕ E3', 'ИТОГОВАЯ ТАБЛИЦА']) check(summary.includes(part), `summary.txt: раздел «${part}»`);
    const csv = read('attribute-check.csv').split(/\r?\n/).filter(Boolean);
    check(csv.length === 154, `attribute-check.csv: по строке на каждое из 153 имён (+ заголовок), строк ${csv.length}`);
    check(/GLOBAL_ID_IN_PROJECT;да/.test(read('attribute-check.csv')), 'подставная база: GLOBAL_ID_IN_PROJECT найден в определениях');
  }

  // SetId вернул 0 (E3 не выбрал объект, исключения нет): Delete вызываться не должен, иначе удалится объект, выбранный раньше
  {
    const { out, r } = runFake('setid0', { E3_FAKE_SETID_ZERO: '1' });
    check(r.status === 0, 'SetId=0: прогон завершился без ошибки', (r.stdout + r.stderr).slice(-800));
    const nd = fs.existsSync(path.join(out, 'log.ndjson')) ? fs.readFileSync(path.join(out, 'log.ndjson'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) : [];
    const deletes = nd.filter((a: any) => /\.(Delete|Remove)$/.test(a.candidate) || /^(job\.)?(Delete|Remove)(Sheet|Device)$/.test(a.candidate));
    check(nd.length > 50 && deletes.length === 0, `SetId=0: ни одного вызова Delete/Remove (журнал ${nd.length} записей)`, deletes.map((a: any) => a.candidate).join(', '));
  }

  // заданного решения в базе нет: берётся первое найденное из запасных, и сводка говорит, какое
  {
    const { out, r } = runFake('fallback', {}, ['-SolutionName', 'Нет_такого_решения']);
    check(r.status === 0, 'запасное решение: прогон завершился без ошибки', (r.stdout + r.stderr).slice(-500));
    const summary = fs.readFileSync(path.join(out, 'summary.txt'), 'utf8');
    check(summary.includes('взято запасное «клапан_DIx2_DOx2»') && summary.includes('Решение для проверки вставки: клапан_DIx2_DOx2'), 'запасное решение: в сводке названо, какое взято', summary.slice(0, 500));
    check(fs.readFileSync(path.join(out, 'log.txt'), 'utf8').includes('Вставка на лист работает') || /Вставка на лист работает/.test(summary), 'запасное решение: вставка прошла');
  }

  // проект «не открыт», но в заголовке окна E3 есть файл проекта: в сводке должно быть противоречие, а не «откройте проект»
  {
    const { out, r } = runFake('contradiction', { E3_FAKE_NOPROJECT: '1', E3_FAKE_TITLE: 'PDH2.e3d - E³.cable - Лист 1' });
    check(r.status === 0, 'противоречие: прогон завершился без ошибки', (r.stdout + r.stderr).slice(-500));
    const summary = fs.readFileSync(path.join(out, 'summary.txt'), 'utf8');
    const logTxt = fs.readFileSync(path.join(out, 'log.txt'), 'utf8');
    check(/ПРОТИВОРЕЧИЕ/.test(summary) && !/НЕ ОТКРЫТ ПРОЕКТ/.test(logTxt), 'противоречие: сводка называет противоречие, «откройте проект» не пишется', summary.slice(0, 600));
  }

  // режим «только разместить»: имя кириллицей, активный лист, из записывающих вызовов — только создание устройства, загрузка и постановка символа
  {
    const name = 'клапан_DIx2_DOx2';
    const { out, r } = runFake('placeonly', {}, ['-PlaceOnly', name]);
    check(r.status === 0, 'только разместить: прогон завершился без ошибки', (r.stdout + r.stderr).slice(-600));
    const logTxt = fs.readFileSync(path.join(out, 'log.txt'), 'utf8');
    const trace = fs.readFileSync(path.join(out, 'trace.log'), 'utf8');
    check(logTxt.includes('ГОТОВО: изделие размещено') && logTxt.includes(`Имя: «${name}»`) && /лист «Лист 1» \(id 101\)/.test(logTxt), 'только разместить: изделие размещено на активном листе (id 101), имя кириллицей сохранено', logTxt.slice(-800));
    check(/Ctrl\+Z/.test(logTxt) && /Проект не сохранялся/.test(logTxt), 'только разместить: сказано, как отменить, и что проект не сохранялся');
    const calls = trace.split(/\r?\n/).map(l => l.replace(/^\uFEFF/, '').match(/^[\d:.]+ COM (\w+)\((.*)\)$/)).filter(Boolean).map(m => ({ name: m[1], args: m[2] }));
    const forbidden = calls.filter(c => /^(Delete|DeleteInstance|Remove|SetAttributeValue|AddAttributeValue|DeleteAttribute|Save\w*|SetName|SetFormat|Display|CreateConnection|PutInfo|SetActiveSheetId|ExportDXF|Export\w*|LoadPart|PlacePart\w*)$/.test(c.name) || (c.name === 'Create' && /^0,/.test(c.args)));
    check(forbidden.length === 0, 'только разместить: в журнале вызовов нет удаления, записи атрибутов, сохранения, временного листа и смены вида', forbidden.map(c => c.name + '(' + c.args + ')').join('; '));
    const writes = calls.filter(c => ['Create', 'Load', 'Place'].includes(c.name)).map(c => c.name);
    check(writes.join(',') === 'Load,Load,Create,Load,Place', 'только разместить: имя компонента — не символ: Load («1» и «») вернул 0, дальше запасной план Create, Load, Place', writes.join(','));
    check(calls.some(c => c.name === 'GetActiveSheetId'), 'только разместить: активный лист получен через Job.GetActiveSheetId');
    const summaryTxt = fs.readFileSync(path.join(out, 'summary.txt'), 'utf8');
    check(!/Окончательная уборка|Z\. Уборка/.test(logTxt) && !logTxt.includes('=== T.') && /Размещено изделие/.test(summaryTxt), 'только разместить: полной проверки, уборки и описи библиотеки нет, итог в сводке');
  }

  // «только разместить» по имени СИМВОЛА: главный план Symbol.Load -> Symbol.Place(лист, x, y, "0"), без запасных планов
  {
    const { out, r } = runFake('placeonly-symbol', {}, ['-PlaceOnly', 'SYM_VALVE']);
    const logTxt = fs.readFileSync(path.join(out, 'log.txt'), 'utf8');
    const trace = fs.readFileSync(path.join(out, 'trace.log'), 'utf8');
    check(r.status === 0 && logTxt.includes('ГОТОВО: изделие размещено') && /вызов symbol\.Load\+Place|Вызов: symbol\.Load\+Place/.test(logTxt), 'только разместить по символу: символ поставлен главным планом Symbol.Load + Symbol.Place', logTxt.slice(-700));
    const calls = trace.split(/\r?\n/).map(l => l.replace(/^\uFEFF/, '').match(/^[\d:.]+ COM (\w+)\((.*)\)$/)).filter(Boolean).map(m => ({ name: m[1], args: m[2] }));
    const writes = calls.filter(c => ['Create', 'Load', 'Place', 'LoadPart', 'PlacePart', 'PlacePartEx'].includes(c.name)).map(c => c.name);
    check(writes.join(',') === 'Load,Place', 'только разместить по символу: изменяющих вызовов ровно Load, Place', writes.join(','));
    const place = calls.find(c => c.name === 'Place');
    check(!!place && /^101, [\d.]+, [\d.]+, "0"$/.test(place.args), 'только разместить по символу: Place(лист 101, x, y, "0") — поворот строкой', place && place.args);
    check(/типы Place: Int32, Double, Double, String/.test(trace), 'в trace записаны типы аргументов перед вызовом', trace.split(/\r?\n/).filter(l => /типы/.test(l)).slice(0, 4).join(' | '));
  }

  // -CatalogOnly: только опрос выделения, без Y, без проекта, без размещения
  {
    const { out, r } = runFake('catalog-only', {}, ['-CatalogOnly']);
    const logTxt = fs.readFileSync(path.join(out, 'log.txt'), 'utf8');
    const trace = fs.readFileSync(path.join(out, 'trace.log'), 'utf8');
    check(r.status === 0 && /поймано: app\./.test(logTxt) && !/Окончательная уборка|=== T\./.test(logTxt), '-CatalogOnly: только опрос каталога', logTxt.slice(-600));
    check(!/COM (Create|Place|Load|Delete|SetAttributeValue|Save\w*|ImportDrawing\w*)\(/.test(trace.replace(/COM Load\(/g, 'COM LoadSym(')), '-CatalogOnly: ничего не создаётся, не размещается и не удаляется (Symbol.Load — чтение базы)');
  }

  // «только разместить» блок из файла .e3p (путь в кавычках, как при перетаскивании): Job.ImportDrawing на активный лист
  {
    const file = path.join(tmp, 'блок тест.e3p');
    fs.writeFileSync(file, 'fake');
    const { out, r } = runFake('placeonly-block', {}, ['-PlaceOnly', `"${file}"`]);
    const logTxt = fs.readFileSync(path.join(out, 'log.txt'), 'utf8');
    const trace = fs.readFileSync(path.join(out, 'trace.log'), 'utf8');
    check(r.status === 0 && logTxt.includes('ГОТОВО: вставлен блок из файла') && /устройств 2, блоков 0, символов на листе 3/.test(logTxt), 'блок из файла: добавилось 2 устройства и 3 символа, об этом сказано', logTxt.slice(-900));
    check(/Устройство: id \d+, имя «-B\d+»/.test(logTxt) && /Символ: id \d+/.test(logTxt) && /Вызов: job\.ImportDrawing/.test(logTxt), 'блок из файла: в отчёте id и имена устройств, id символов и вызов');
    check(/типы ImportDrawing: String, Int32, Double, Double/.test(trace), 'ImportDrawing вызван с типами String, Int32, Double, Double', trace.split(/\r?\n/).filter(l => /ImportDrawing/.test(l)).join(' | '));
    const calls = trace.split(/\r?\n/).map(l => l.replace(/^\uFEFF/, '').match(/^[\d:.]+ COM (\w+)\((.*)\)$/)).filter(Boolean).map(m => m[1]);
    const other = calls.filter(n => !/^(Get\w+|SetId|Create\w+|ImportDrawing|Count|Item)$/.test(n));
    check(other.length === 0 && calls.filter(n => n === 'ImportDrawing').length === 1 && !calls.includes('ImportDrawingEx'), 'блок из файла: кроме чтения и одного ImportDrawing ничего не вызвано', other.join(','));
  }
  {
    const { out, r } = runFake('placeonly-block-missing', {}, ['-PlaceOnly', path.join(tmp, 'нет-такого.e3p')]);
    const logTxt = fs.readFileSync(path.join(out, 'log.txt'), 'utf8');
    const trace = fs.readFileSync(path.join(out, 'trace.log'), 'utf8');
    check(r.status === 0 && logTxt.includes('не найден') && !/COM (ImportDrawing|Load|Place)\(/.test(trace), 'блок из файла: файла нет — понятное сообщение, ничего не вызвано');
  }

  // символа нет, компонент без символов в проекте: запасные планы PlacePart* не получают PSObject (фейк отвечает type mismatch),
  // план Б создаёт устройство без символа и ничего не удаляет
  {
    const { out, r } = runFake('placeonly-planb', {}, ['-PlaceOnly', 'Двигатель_М1']);
    const logTxt = fs.readFileSync(path.join(out, 'log.txt'), 'utf8');
    const ndjson = fs.readFileSync(path.join(out, 'log.ndjson'), 'utf8');
    const trace = fs.readFileSync(path.join(out, 'trace.log'), 'utf8');
    check(r.status === 0 && logTxt.includes('не найден в базе символов'), 'только разместить: символ не найден — так и сказано в журнале', logTxt.slice(-700));
    check(!/Type mismatch|80020005/i.test(ndjson), 'только разместить: ни один вызов не получил type mismatch (PSObject развёрнуты, типы приведены)', (ndjson.match(/.{80}Type mismatch.{80}/i) || [''])[0]);
    check(/COM PlacePart\("Двигатель_М1", "1", 50\.4|COM PlacePart\("Двигатель_М1", "1", [\d.]+, [\d.]+, 0\)/.test(trace) && /типы PlacePart: String, String, Double, Double, Double/.test(trace), 'PlacePart вызван со строками и double', trace.split(/\r?\n/).filter(l => /PlacePart/.test(l)).slice(0, 3).join(' | '));
    check(/COM Create\("FLUXPLACE_\d+", "", "", "Двигатель_М1"/.test(trace) && /Устройство создано без символа/.test(logTxt), 'план Б: устройство создано без символа, об этом сказано', logTxt.slice(-500));
    check(!/COM (Delete|Remove)\(/.test(trace), 'план Б ничего не удаляет');
  }

  // «только разместить»: компонента нет — ничего не создано, ничего не удалено
  {
    const { out, r } = runFake('placeonly-none', {}, ['-PlaceOnly', 'нет_такого_компонента']);
    const logTxt = fs.readFileSync(path.join(out, 'log.txt'), 'utf8');
    const calls = fs.readFileSync(path.join(out, 'trace.log'), 'utf8').split(/\r?\n/);
    check(r.status === 0 && logTxt.includes('разместить не удалось') && logTxt.includes('Ничего не создано'), 'только разместить: нет компонента — понятное сообщение, ничего не создано', logTxt.slice(-600));
    check(!calls.some(l => /COM (Delete|Remove|SetAttributeValue)\(/.test(l)), 'только разместить: при неудаче тоже ничего не удаляется');
  }

  // «по списку названий»: -NamesFile читает названия из файла (UTF-8 с BOM, CRLF, кириллица, повторы, пустые строки) и ТОЛЬКО спрашивает E3
  {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const namesFile = path.join(tmp, 'e3-names.txt');
    fs.writeFileSync(namesFile, Buffer.concat([bom, Buffer.from('SYM_VALVE\r\n  Вентилятор_ЗТД_К \r\nКлапан_К24_КП2\r\nДвигатель_М1\r\n\r\nsym_valve\r\nдатчик_DI_условный_ДГП_2\r\nПодсхема_Тест\r\nнет_такого_имени\r\n', 'utf8')]));
    // без -NoConfirm и без ввода: режим чтения не просит Y
    const out = path.join(tmp, 'names');
    const r = spawnSync(shell.command, ['-NoProfile', '-File', path.join(root, 'e3-probe.ps1'), '-FakeCom', path.join(root, 'test', 'fake-e3.ps1'), '-OutDir', out, '-NamesFile', namesFile], { encoding: 'utf8', input: '', timeout: 300_000, env: process.env });
    const read = (name: string) => fs.existsSync(path.join(out, name)) ? fs.readFileSync(path.join(out, name), 'utf8').replace(/^﻿/, '') : '';
    const logTxt = read('log.txt'), trace = read('trace.log');
    check(r.status === 0, '-NamesFile: завершился без ошибки', (r.stdout + r.stderr).slice(-800));
    check(/Названий: 7 \(строк в файле 10, пустых 2, повторов 1\)/.test(logTxt), '-NamesFile: пустые строки и повтор (без учёта регистра) отброшены, краевые пробелы обрезаны', logTxt.match(/Названий:.*/)?.[0]);
    check(logTxt.includes('ИТОГ: символ 2 · компонент/подсхема 4 · не найдено 1'), '-NamesFile: сводка «символ N · компонент/подсхема M · не найдено K»', logTxt.match(/ИТОГ:.*/)?.[0]);
    check(!/Нажмите клавишу Y|Введите Y/.test(logTxt) && !/COM (Create|CreateSheet|Place|PlacePart\w*|LoadPart|LoadAndCreate|CreateBlock|Delete|Remove|SetAttributeValue|Save\w*|ImportDrawing\w*)\(/.test(trace), '-NamesFile: без подтверждения Y и без единого пишущего вызова (вставка, лист, LoadPart, атрибуты, Save)');
    check(/Проект до и после: компонентов 3 -> 3, устройств 1 -> 1 \(не изменился\)/.test(logTxt), '-NamesFile: число компонентов и устройств проекта до и после одно и то же');
    let rep: any = {};
    try { rep = JSON.parse(read('names-report.json')); } catch (e) { bad('names-report.json разбирается как JSON', e); }
    const item = (n: string) => (rep.items ?? []).find((i: any) => i.name === n) ?? {};
    check(rep.items?.length === 7 && rep.counts?.symbol === 2 && rep.counts?.component === 3 && rep.counts?.subcircuit === 1 && rep.counts?.notfound === 1, 'names-report.json: 7 имён, счётчики символ 2 / компонент 3 / подсхема 1 / не найдено 1', JSON.stringify(rep.counts));
    check(item('SYM_VALVE').kind === 'symbol' && item('SYM_VALVE').width === 24 && item('SYM_VALVE').height === 16 && /Symbol\.Load\("SYM_VALVE", "1"\)/.test(item('SYM_VALVE').call) && /GetArea/.test(item('SYM_VALVE').call), 'символ: Symbol.Load с версией "1" и габарит 24 x 16 из GetArea без размещения', JSON.stringify(item('SYM_VALVE')));
    check(item('Вентилятор_ЗТД_К').kind === 'symbol' && item('Вентилятор_ЗТД_К').error === '', 'кириллица в файле дошла до E3 без искажений (имя с пробелами по краям найдено как символ)');
    check(item('Клапан_К24_КП2').kind === 'component' && item('Клапан_К24_КП2').via === 'api' && /Component\.Search\("Клапан_К24_КП2"/.test(item('Клапан_К24_КП2').call) && item('Клапан_К24_КП2').details?.GetName === 'Клапан_К24_КП2' && item('Клапан_К24_КП2').details?.pins === 3, 'компонент: Component.Search, прочитаны имя, версия, тип, число выводов', JSON.stringify(item('Клапан_К24_КП2')));
    check(item('датчик_DI_условный_ДГП_2').kind === 'component' && item('датчик_DI_условный_ДГП_2').via === 'db' && item('датчик_DI_условный_ДГП_2').details?.table === 'Components', 'компонент, найденный только в таблице базы: вид, таблица, via=db');
    check(item('Подсхема_Тест').kind === 'subcircuit' && item('Подсхема_Тест').details?.table === 'Blocks', 'подсхема: таблица базы с названием блока даёт вид «подсхема»');
    check(item('нет_такого_имени').kind === 'notfound' && /Symbol\.Load/.test(item('нет_такого_имени').error) && /Component\.Search/.test(item('нет_такого_имени').error), 'не найдено: в ошибке названы все проверенные вызовы');
    check(typeof item('SYM_VALVE').ms === 'number' && rep.info?.avgMsPerName > 0 && /в среднем .* мс на имя/.test(logTxt), 'время на имя записано в отчёт и журнал');
    check(read('names-notfound.txt').trim() === 'нет_такого_имени' && /Не найдены \(1\):\s+нет_такого_имени/.test(logTxt), 'список не найденных: в журнале и в names-notfound.txt');
    const summary = read('summary.txt');
    check(/ПРОВЕРКА ПО СПИСКУ НАЗВАНИЙ[\s\S]*символ 2 · компонент\/подсхема 4 · не найдено 1[\s\S]*нет_такого_имени/.test(summary), 'summary.txt: раздел «Проверка по списку названий» со сводкой и не найденными');
    check(!/Размещение образцов/.test(summary) && !fs.existsSync(path.join(out, 'export')), 'без -PlaceSample листа и картинок нет');
    const log = JSON.parse(read('log.json'));
    check(!log.attempts.some((a: any) => a.op === 'script.error') && !log.attempts.some((a: any) => /Type mismatch|80020005/i.test(String(a.error))), '-NamesFile: ни один раздел не прерван, type mismatch нет');
  }

  // имя файла неверное, файл не в UTF-8 — понятные сообщения, чтение не рушится
  {
    const { out, r } = runFake('names-missing', {}, ['-NamesFile', path.join(tmp, 'нет-такого-файла.txt')]);
    const logTxt = fs.readFileSync(path.join(out, 'log.txt'), 'utf8');
    check(r.status === 0 && logTxt.includes('файл со списком названий не найден') && logTxt.includes('Скачать названия для пробы'), '-NamesFile: файла нет — сказано, где его взять', logTxt.slice(-500));
    const cp = path.join(tmp, 'cp1251.txt');
    fs.writeFileSync(cp, Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0d, 0x0a]));   // «Привет» в кодовой странице 1251, не UTF-8
    const r2 = runFake('names-cp1251', {}, ['-NamesFile', cp]);
    const log2 = fs.readFileSync(path.join(r2.out, 'log.txt'), 'utf8');
    check(r2.r.status === 0 && log2.includes('не в UTF-8'), '-NamesFile: файл не в UTF-8 — предупреждение, а не тихо искажённые результаты', log2.slice(-500));
    const empty = path.join(tmp, 'empty.txt');
    fs.writeFileSync(empty, Buffer.from([0xef, 0xbb, 0xbf, 0x0d, 0x0a]));
    const r3 = runFake('names-empty', {}, ['-NamesFile', empty]);
    check(r3.r.status === 0 && fs.readFileSync(path.join(r3.out, 'log.txt'), 'utf8').includes('нет ни одного названия'), '-NamesFile: пустой файл — понятное сообщение');
  }

  // -PlaceSample: первые N найденных на временный лист, картинка листа, уборка
  {
    const file = path.join(tmp, 'e3-names-sample.txt');
    fs.writeFileSync(file, '﻿SYM_VALVE\r\nнет_такого\r\nклапан_DIx2_DOx2\r\nДвигатель_М1\r\nВентилятор_ЗТД_К\r\n', 'utf8');
    const { out, r } = runFake('names-place', {}, ['-NamesFile', file, '-PlaceSample', '3']);
    const read = (name: string) => fs.existsSync(path.join(out, name)) ? fs.readFileSync(path.join(out, name), 'utf8').replace(/^﻿/, '') : '';
    const logTxt = read('log.txt'), trace = read('trace.log');
    check(r.status === 0 && logTxt.includes('ИТОГ размещения: поставлено 2 из 3; картинок листа: 1'), '-PlaceSample 3: первые три найденных (не считая ненайденного), два встали, картинка снята', logTxt.slice(-1200));
    check(/Размещаю «SYM_VALVE» \(символ\)/.test(logTxt) && /Размещаю «клапан_DIx2_DOx2» \(компонент\)/.test(logTxt) && /Размещаю «Двигатель_М1» \(компонент\)/.test(logTxt) && !/Размещаю «Вентилятор_ЗТД_К»/.test(logTxt) && !/Размещаю «нет_такого»/.test(logTxt), '-PlaceSample 3: берутся первые найденные по порядку файла');
    check(/Symbol\.Place|COM Place\(/.test(trace) && /COM Create\("", "", "", "клапан_DIx2_DOx2"/.test(trace), 'символ ставится Symbol.Place, компонент — запасным планом (Device.Create + символ)');
    check(/COM Create\(0, "__flux_names__"/.test(trace) && logTxt.includes('Временный лист удалён.') && /Число устройств в проекте то же: 1/.test(logTxt), 'временный лист создан и удалён, устройства прежние');
    check(/Удаляю созданные пробой устройства: 2/.test(logTxt) && !/COM Delete\(\)?.*501/.test(trace), 'созданные пробой устройства удалены, чужое (501) не тронуто');
    check(/COM ExportImage\("PNG", 0, /.test(trace) && fs.existsSync(path.join(out, 'export', 'names-sheet.png')) && /картинка листа \.png: sheet\.ExportImage/.test(logTxt) && /картинка листа \.emf: перебрано вариантов/.test(logTxt), 'картинка листа: сработавший вызов (ExportImage PNG) назван в журнале, остальные форматы честно не вышли');
    check(!/COM Save\w*\(/.test(trace) && logTxt.includes('Проект НЕ сохранялся.'), '-PlaceSample: проект не сохраняется');
    let rep: any = {};
    try { rep = JSON.parse(read('names-report.json')); } catch (e) { bad('names-report.json (PlaceSample) разбирается', e); }
    const ps = rep.info?.placeSample ?? {};
    check(ps.requested === 3 && ps.placed === 2 && ps.devicesRemoved === 2 && ps.devicesBefore === 1 && ps.devicesAfter === 1 && ps.exports?.[0]?.ext === 'png', 'names-report.json: итог размещения (запрошено, поставлено, удалено устройств, картинка)', JSON.stringify(ps));
    const sym = (rep.items ?? []).find((i: any) => i.name === 'SYM_VALVE')?.placed;
    check(sym?.ok === true && sym.symbols?.length === 1 && sym.area?.length === 4 && /symbol\.Load\+Place/.test(sym.call), 'names-report.json: у образца вызов, символы и рамка на листе (для обрезки картинки)', JSON.stringify(sym));
    check(/Размещение образцов на временном листе: поставлено 2 из 3/.test(read('summary.txt')) && /ЭКСПОРТ ЛИСТА\s+png: sheet\.ExportImage/.test(read('summary.txt')), 'summary.txt: размещение и экспорт листа');
  }

  // -PlaceSample требует Y (на Windows CI вход по stdin зависит от кодовой страницы консоли, поэтому там только -NoConfirm)
  if (process.platform !== 'win32') {
    const file = path.join(tmp, 'e3-names-y.txt');
    fs.writeFileSync(file, '﻿SYM_VALVE\r\n', 'utf8');
    const ask = (name: string, input: string) => {
      const out = path.join(tmp, name);
      const r = spawnSync(shell.command, ['-NoProfile', '-File', path.join(root, 'e3-probe.ps1'), '-FakeCom', path.join(root, 'test', 'fake-e3.ps1'), '-OutDir', out, '-NamesFile', file, '-PlaceSample', '1'], { encoding: 'utf8', input, timeout: 300_000, env: process.env });
      return { out, r, trace: fs.existsSync(path.join(out, 'trace.log')) ? fs.readFileSync(path.join(out, 'trace.log'), 'utf8') : '', log: fs.existsSync(path.join(out, 'log.txt')) ? fs.readFileSync(path.join(out, 'log.txt'), 'utf8') : '' };
    };
    const no = ask('names-place-no', 'n\n');
    check(no.r.status === 0 && no.log.includes('ИТОГ: символ 1') && no.log.includes('Отменено: ничего не изменено.') && !/COM Create\(0, "__flux_names__"/.test(no.trace), '-PlaceSample без Y: чтение выполнено, лист не создан, ничего не изменено', no.log.slice(-500));
    const yes = ask('names-place-yes', 'Y\n');
    check(yes.r.status === 0 && yes.log.includes('Временный лист удалён.') && /ИТОГ размещения: поставлено 1 из 1/.test(yes.log), '-PlaceSample с Y: образец поставлен, лист удалён', yes.log.slice(-500));
  } else console.log('SKIP -PlaceSample с вводом Y через stdin — только не на Windows; путь -NoConfirm проверен выше.');

  // -PlaceSample без открытого проекта: чтение выполнено, размещение отказано
  {
    const file = path.join(tmp, 'e3-names-np.txt');
    fs.writeFileSync(file, '﻿SYM_VALVE\r\n', 'utf8');
    const { out, r } = runFake('names-place-noproject', { E3_FAKE_NOPROJECT: '1' }, ['-NamesFile', file, '-PlaceSample', '1']);
    const logTxt = fs.readFileSync(path.join(out, 'log.txt'), 'utf8');
    const trace = fs.readFileSync(path.join(out, 'trace.log'), 'utf8');
    check(r.status === 0 && logTxt.includes('ИТОГ: символ 1') && logTxt.includes('Размещение требует открытого проекта') && !/COM Create\(0, "__flux_names__"/.test(trace), '-PlaceSample без проекта: чтение есть, размещения нет', logTxt.slice(-600));
  }

  // вопрос про имя перед подтверждением Y (на Windows CI вход по stdin зависит от кодовой страницы консоли, поэтому там только параметр)
  if (process.platform !== 'win32') {
    const out = path.join(tmp, 'placeonly-ask');
    const r = spawnSync(shell.command, ['-NoProfile', '-File', path.join(root, 'e3-probe.ps1'), '-FakeCom', path.join(root, 'test', 'fake-e3.ps1'), '-OutDir', out], { encoding: 'utf8', input: 'клапан_DIx2_DOx2\nY\n', timeout: 300_000, env: process.env });
    const logTxt = fs.existsSync(path.join(out, 'log.txt')) ? fs.readFileSync(path.join(out, 'log.txt'), 'utf8') : '';
    check(r.status === 0 && logTxt.includes('ГОТОВО: изделие размещено'), 'вопрос про имя: введённое имя и один Y приводят к размещению', (r.stdout + r.stderr).slice(-600));
    check(logTxt.includes('Введено: «клапан_DIx2_DOx2»') && logTxt.includes('U+043A U+043B U+0430 U+043F U+0430 U+043D'), 'вопрос про имя: введённая строка и коды символов записаны в журнал');
    const skip = spawnSync(shell.command, ['-NoProfile', '-File', path.join(root, 'e3-probe.ps1'), '-FakeCom', path.join(root, 'test', 'fake-e3.ps1'), '-OutDir', path.join(tmp, 'placeonly-skip')], { encoding: 'utf8', input: '\nY\n', timeout: 300_000, env: process.env });
    check(skip.status === 0 && !/ГОТОВО: изделие размещено/.test(skip.stdout) && /Лист/.test(skip.stdout), 'вопрос про имя: Enter без имени ведёт к полной проверке');
  } else console.log('SKIP вопрос про имя через stdin — только не на Windows (кодовая страница консоли CI не UTF-8); имя через -PlaceOnly проверено выше.');

  // обрыв процесса посреди работы (как первый настоящий прогон): в журнале должна остаться метка виновника
  {
    const { out, r } = runFake('die', { E3_FAKE_DIE_AT_VERSION: '1' });
    const trace = fs.existsSync(path.join(out, 'trace.log')) ? fs.readFileSync(path.join(out, 'trace.log'), 'utf8').trim().split(/\r?\n/) : [];
    check(r.status === 9, 'обрыв: процесс завершился кодом 9 (подставной обрыв)', `${r.status} ${(r.stdout + r.stderr).slice(-300)}`);
    check(/COM GetVersion/.test(trace[trace.length - 1] ?? ''), 'обрыв: последняя строка trace.log называет вызов, на котором всё оборвалось', trace.slice(-3).join(' | '));
    const logTxt = fs.existsSync(path.join(out, 'log.txt')) ? fs.readFileSync(path.join(out, 'log.txt'), 'utf8') : '';
    check(logTxt.includes('=== 1. Подключение к E3 ==='), 'обрыв: log.txt сохранил всё до места обрыва');
  }

  // проект не открыт: скрипт не падает и не пытается ничего менять
  {
    const { out, r } = runFake('noproject', { E3_FAKE_NOPROJECT: '1' });
    check(r.status === 0, 'без открытого проекта скрипт завершается без ошибки', (r.stdout + r.stderr).slice(-800));
    const summary = fs.existsSync(path.join(out, 'summary.txt')) ? fs.readFileSync(path.join(out, 'summary.txt'), 'utf8') : '';
    check(/Проект в E3 не открыт/.test(summary), 'summary.txt сообщает, что проект не открыт');
    const earlyOut = fs.readFileSync(path.join(out, 'log.txt'), 'utf8');
    check(earlyOut.includes('НЕ ОТКРЫТ ПРОЕКТ') && earlyOut.indexOf('НЕ ОТКРЫТ ПРОЕКТ') < earlyOut.indexOf('=== 1b'), 'без проекта: «откройте копию проекта» сказано сразу после подключения, до описи API');
    check(earlyOut.includes('=== T.') && earlyOut.includes('=== R.'), 'без проекта: прогон дошёл до описи библиотеки типов и итогов');
    const log = JSON.parse(fs.readFileSync(path.join(out, 'log.json'), 'utf8').replace(/^\uFEFF/, ''));
    check(!log.attempts.some((a: any) => /^(place|sheets\.create|attr\.)/.test(a.op)), 'без проекта ничего не создавалось и не писалось');
  }

  // Windows: настоящий Add-Type и настоящий ITypeInfo на системном COM-объекте
  if (process.platform === 'win32') {
    const r = run(['-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'e3-probe.ps1'), '-SelfCheck', '-OutDir', path.join(tmp, 'selfcheck')], {}, 180_000);
    check(r.status === 0, 'самопроверка на Windows: C# собирается, ITypeInfo читает FileSystemObject', (r.stdout + r.stderr).slice(-2000));
  } else console.log('SKIP самопроверка ITypeInfo (Add-Type и COM) — только Windows; на CI запускается в verify-windows-shell.yml.');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nПройдено ${passed}, провалено ${failed}`);
process.exit(failed ? 1 : 0);
