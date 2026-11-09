/**
 * COM для подпрограмм: сквозной вызов метода и свойства по имени.
 *
 * Во Flux нет моста к E3 в главном процессе (docs/e3-integration.md, этап C ещё
 * не сделан), поэтому здесь общий способ подключения «COM-объект по имени» — на
 * существующем в приложении шаблоне: долгоживущий помощник Windows PowerShell
 * (как electron/nativeDesktopRunner.ts), поздним связыванием через
 * `[System.__ComObject].InvokeMember`, как подтверждено пробой E3 (4.3):
 * значения разворачиваются из PSObject, у объекта не зовётся `GetType()`,
 * ref-параметры передаются через ParameterModifier. Новых нативных
 * зависимостей нет. Другие ОС и проверки: `ComBackend` подменяется поддельным.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectError } from '../modules/connections/model';

export type ComValue = unknown;
/** Объект COM в ответе: подпрограмма получает номер, а не сам объект */
export interface ComObjectRef { $com: number }
export interface ComBackend {
  available(): boolean;
  open(progId: string): Promise<number>;
  invoke(handle: number, kind: 'call' | 'get' | 'set', name: string, args: ComValue[], value?: ComValue): Promise<ComValue>;
  release(handle: number): Promise<void>;
  /** Закрыть всё, что держит помощник (подпрограммы закрыты или приложение завершается) */
  shutdown(): Promise<void>;
}

/** Помощник: строка JSON на запрос и на ответ; ошибки COM возвращаются как ответ, а не роняют процесс */
export const COM_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $enc
[Console]::OutputEncoding = $enc
$script:objects = @{}
$script:next = 0
function Unwrap($v) { if ($v -is [System.Management.Automation.PSObject]) { return $v.PSObject.BaseObject }; return $v }
function Register($o) { $script:next++; $script:objects[$script:next] = $o; return $script:next }
# JSON -> значение для COM: числа как double/int, ссылки на объекты разворачиваются, массивы остаются object[]
function ToCom($v) {
  $v = Unwrap $v
  if ($null -eq $v) { return $null }
  if ($v -is [System.Management.Automation.PSCustomObject]) {
    $names = @($v.PSObject.Properties | ForEach-Object { $_.Name })
    if ($names -contains '$com') { $o = $script:objects[[int]$v.'$com']; if ($null -eq $o) { throw 'Нет такого COM-объекта' }; return $o }
    throw 'Объект JSON нельзя передать в COM'
  }
  if ($v -is [System.Array]) { $r = New-Object object[] $v.Length; for ($i = 0; $i -lt $v.Length; $i++) { $r[$i] = ToCom $v[$i] }; return ,$r }
  if ($v -is [decimal]) { return [double]$v }
  return $v
}
function FromCom($v, $depth) {
  $v = Unwrap $v
  if ($null -eq $v) { return $null }
  if ($v -is [string] -or $v -is [bool]) { return $v }
  if ($v -is [int] -or $v -is [long] -or $v -is [short] -or $v -is [byte] -or $v -is [uint32] -or $v -is [uint16]) { return $v }
  if ($v -is [double] -or $v -is [single] -or $v -is [decimal]) { $d = [double]$v; if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $null }; return $d }
  if ($v -is [datetime]) { return $v.ToString('o') }
  if ($v -is [System.Array]) { if ($depth -gt 4) { return $null }; $r = @(); foreach ($e in $v) { $r += ,(FromCom $e ($depth + 1)) }; return ,$r }
  if ([System.Runtime.InteropServices.Marshal]::IsComObject($v)) { return @{ '$com' = (Register $v) } }
  return [string]$v
}
function Invoke-Member($target, $kind, $name, $arr, $outIdx) {
  $flags = [System.Reflection.BindingFlags]::InvokeMethod
  $mods = $null
  if ($kind -eq 'get') { $flags = [System.Reflection.BindingFlags]::GetProperty }
  elseif ($kind -eq 'set') { $flags = [System.Reflection.BindingFlags]::SetProperty }
  elseif ($outIdx.Count -eq 0) { $flags = $flags -bor [System.Reflection.BindingFlags]::GetProperty }
  else {
    $m = New-Object System.Reflection.ParameterModifier($arr.Length)
    foreach ($i in $outIdx) { $m[$i] = $true }
    $mods = [System.Reflection.ParameterModifier[]]@($m)
  }
  # Тип берём как __ComObject: у Job и других объектов E3 есть собственный GetType()
  return [System.__ComObject].InvokeMember($name, $flags, $null, $target, $arr, $mods, $null, $null)
}
function Reply($id, $ok, $value, $err) {
  $o = @{ id = $id; ok = $ok }
  if ($ok) { $o.value = $value } else { $o.error = $err }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 12))
  [Console]::Out.Flush()
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    switch ($req.op) {
      'open' {
        $t = [type]::GetTypeFromProgID([string]$req.progId, $true)
        # Запущенный экземпляр (E3 уже открыта инженером) предпочтительнее нового процесса
        $o = $null
        try { $o = [System.Runtime.InteropServices.Marshal]::GetActiveObject([string]$req.progId) } catch { $o = $null }
        if ($null -eq $o) { $o = [Activator]::CreateInstance($t) }
        Reply $id $true (Register $o) $null
      }
      'release' {
        $o = $script:objects[[int]$req.handle]
        if ($null -ne $o) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) } catch {} ; $script:objects.Remove([int]$req.handle) }
        Reply $id $true $true $null
      }
      'invoke' {
        $target = $script:objects[[int]$req.handle]
        if ($null -eq $target) { throw 'Нет такого COM-объекта' }
        $raw = @($req.args)
        $arr = New-Object object[] $raw.Length
        $outIdx = New-Object System.Collections.ArrayList
        for ($i = 0; $i -lt $raw.Length; $i++) {
          $a = Unwrap $raw[$i]
          if ($a -is [System.Management.Automation.PSCustomObject] -and (@($a.PSObject.Properties | ForEach-Object { $_.Name }) -contains '$out')) { [void]$outIdx.Add($i); $arr[$i] = $null }
          else { $arr[$i] = ToCom $a }
        }
        if ($req.kind -eq 'set') {
          $arr2 = New-Object object[] ($arr.Length + 1)
          for ($i = 0; $i -lt $arr.Length; $i++) { $arr2[$i] = $arr[$i] }
          $arr2[$arr.Length] = ToCom $req.value
          $arr = $arr2
        }
        $ret = Invoke-Member $target $req.kind ([string]$req.name) $arr @($outIdx)
        $value = FromCom $ret 0
        if ($outIdx.Count -gt 0) {
          $outs = @{}
          foreach ($i in $outIdx) { $outs[[string]$i] = FromCom $arr[$i] 0 }
          $value = @{ ret = $value; out = $outs }
        }
        Reply $id $true $value $null
      }
      'shutdown' { Reply $id $true $true $null; exit }
      default { throw 'Неизвестная операция' }
    }
  } catch {
    $e = $_.Exception
    while ($null -ne $e.InnerException) { $e = $e.InnerException }
    $hr = ''
    try { $hr = ('{0:X8}' -f $e.HResult) } catch {}
    Reply $(if ($null -ne $req) { $req.id } else { 0 }) $false $null ($hr + ' ' + ($e.Message -replace '[\r\n]+', ' '))
  }
}
`;

interface Pending { resolve: (value: ComValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/** Долгоживущий помощник PowerShell; запускается при первом обращении и завершается, когда COM-объектов не осталось */
export class PowerShellComBackend implements ComBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private dir = '';
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private seq = 0;
  private live = new Set<number>();
  constructor(private timeoutMs = 20_000) {}

  available() { return process.platform === 'win32'; }

  private async start() {
    if (this.child) return;
    this.starting ||= (async () => {
      this.dir = await mkdtemp(join(tmpdir(), 'flux-com-helper-'));
      const script = join(this.dir, 'com.ps1');
      // Windows PowerShell 5.1 распознаёт UTF-8 по BOM
      await writeFile(script, '﻿' + COM_HELPER_SCRIPT, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onData(chunk));
      child.stderr.on('data', () => { /* ошибки приходят ответом; stderr только предупреждения PowerShell */ });
      child.on('exit', () => this.onExit(child));
      child.on('error', () => this.onExit(child));
    })().finally(() => { this.starting = null; });
    await this.starting;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/^﻿/, '').trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try {
        const reply = JSON.parse(line) as { id: number; ok: boolean; value?: ComValue; error?: string };
        const item = this.pending.get(reply.id);
        if (!item) continue;
        this.pending.delete(reply.id);
        clearTimeout(item.timer);
        if (reply.ok) item.resolve(reply.value);
        else item.reject(new ConnectError('FAILED', String(reply.error || '').slice(0, 300)));
      } catch { /* строка не от помощника: пропускаем */ }
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams) {
    if (this.child !== child) return;
    this.child = null;
    this.live.clear();
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new ConnectError('FAILED', 'helper exited')); }
    this.pending.clear();
    const dir = this.dir; this.dir = '';
    if (dir) void rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  private async send(message: Record<string, unknown>): Promise<ComValue> {
    await this.start();
    const child = this.child;
    if (!child) throw new ConnectError('UNAVAILABLE', 'no helper');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      // Зависший вызов COM (E3 занята диалогом) не держит подпрограмму вечно: помощник перезапускается
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ConnectError('TIMEOUT')); this.child?.kill(); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...message })}\n`);
    });
  }

  async open(progId: string) {
    const handle = Number(await this.send({ op: 'open', progId }));
    this.live.add(handle);
    return handle;
  }
  invoke(handle: number, kind: 'call' | 'get' | 'set', name: string, args: ComValue[], value?: ComValue) {
    return this.send({ op: 'invoke', handle, kind, name, args, ...(kind === 'set' ? { value } : {}) });
  }
  async release(handle: number) {
    await this.send({ op: 'release', handle }).catch(() => {});
    this.live.delete(handle);
  }
  async shutdown() {
    const child = this.child;
    if (!child) return;
    await this.send({ op: 'shutdown' }).catch(() => {});
    child.kill();
  }
}

/** Платформа без COM: любой вызов — «недоступно», а не падение */
export class NoComBackend implements ComBackend {
  available() { return false; }
  async open(): Promise<number> { throw new ConnectError('UNAVAILABLE', 'COM только в Windows'); }
  async invoke(): Promise<ComValue> { throw new ConnectError('UNAVAILABLE'); }
  async release() { /* нечего */ }
  async shutdown() { /* нечего */ }
}
export const defaultComBackend = (): ComBackend => process.platform === 'win32' ? new PowerShellComBackend() : new NoComBackend();
