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

  const runFake = (name: string, env: Record<string, string>) => {
    const out = path.join(tmp, name);
    const r = run(['-File', path.join(root, 'e3-probe.ps1'), '-FakeCom', path.join(root, 'test', 'fake-e3.ps1'), '-NoConfirm', '-OutDir', out], env);
    return { out, r };
  };

  // полный прогон на подставном COM
  {
    const { out, r } = runFake('full', {});
    check(r.status === 0, 'прогон на подставном COM завершился без ошибки', (r.stdout + r.stderr).slice(-1500));
    const read = (name: string) => fs.existsSync(path.join(out, name)) ? fs.readFileSync(path.join(out, name), 'utf8').replace(/^\uFEFF/, '') : '';
    for (const file of ['log.txt', 'log.json', 'log.ndjson', 'environment.json', 'api.json', 'summary.txt', 'attribute-check.csv', 'database-lists.txt']) check(fs.existsSync(path.join(out, file)), `создан ${file}`);
    check(fs.existsSync(`${out}.zip`), 'журнал заархивирован в .zip');
    let log: any = null;
    try { log = JSON.parse(read('log.json')); } catch (e) { bad('log.json разбирается как JSON', e); }
    if (log) {
      check(Array.isArray(log.attempts) && log.attempts.length > 200, `log.json: попыток ${log.attempts?.length}`);
      const first = log.attempts[0] ?? {};
      for (const key of ['op', 'candidate', 'args', 'ok', 'result', 'error', 'hresult', 'ms']) check(key in first, `запись журнала содержит «${key}»`);
      check(!log.attempts.some((a: any) => a.op === 'script.error'), 'ни один раздел не прерван ошибкой скрипта', log.attempts.filter((a: any) => a.op === 'script.error').map((a: any) => `${a.candidate}: ${a.error}`).join('; '));
      check(log.attempts.some((a: any) => !a.ok && a.hresult), 'ошибки COM записаны с HRESULT');
      check(!log.attempts.some((a: any) => /Save/.test(a.candidate) && a.op !== 'capability.save'), 'вызовов Save нет');
      const winners = new Map<string, string>(log.summary.filter((s: any) => s.tries > 0 && s.ok > 0).map((s: any) => [s.op, s.variant]));
      for (const op of ['connect.application', 'sheets.create', 'place.sheet.PlacePart.v.effect', 'design.setname', 'wires.connect', 'export.dxf']) check(winners.has(op), `итоговая таблица: ${op} → ${winners.get(op) ?? 'нет'}`);
    }
    for (const line of read('log.ndjson').split(/\r?\n/).filter(Boolean)) { try { JSON.parse(line); } catch (e) { bad('log.ndjson: строка не JSON', line.slice(0, 200)); break; } }
    ok('log.ndjson: все строки — JSON');
    let api: any = null;
    try { api = JSON.parse(read('api.json')); } catch (e) { bad('api.json разбирается как JSON', e); }
    if (api) check(Object.keys(api.objects).length >= 5, `api.json: объектов ${Object.keys(api.objects).length}`);
    const txt = read('log.txt');
    check(txt.includes('Проект НЕ сохранялся'), 'в журнале сказано, что проект не сохранялся');
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

  // проект не открыт: скрипт не падает и не пытается ничего менять
  {
    const { out, r } = runFake('noproject', { E3_FAKE_NOPROJECT: '1' });
    check(r.status === 0, 'без открытого проекта скрипт завершается без ошибки', (r.stdout + r.stderr).slice(-800));
    const summary = fs.existsSync(path.join(out, 'summary.txt')) ? fs.readFileSync(path.join(out, 'summary.txt'), 'utf8') : '';
    check(/Проект в E3 не открыт/.test(summary), 'summary.txt сообщает, что проект не открыт');
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
