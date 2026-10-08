# Ядро пробы: журнал, вызов COM, перебор кандидатов имён.
# Подключается из e3-probe.ps1 точкой (dot-source), поэтому все $script:-переменные общие.
# Только Windows PowerShell 5.1: без ?., ??, тернарного ?: и &&.

$script:Fake = $false
$script:Records = New-Object System.Collections.ArrayList
$script:Seq = 0
$script:Step = ''
$script:Winners = [ordered]@{}      # операция -> список сработавших вариантов
$script:Failed = [ordered]@{}       # операция -> число неудачных попыток (если ни одна не сработала)
$script:Findings = New-Object System.Collections.ArrayList   # для summary.txt: @{Kind; Text}
$script:Known = @{}                 # ключ -> вариант вызова, который сработал (для тихих повторов)
$script:BusyCodes = @('80010001', '8001010A', '8001010B', '80010108')
$script:Utf8Bom = New-Object System.Text.UTF8Encoding($true)
$script:LogDir = ''

function Initialize-Log {
    param([string]$Directory)
    # Папка рядом со скриптом может быть закрыта на запись (Program Files, архив, сетевой диск): тогда журналы молча
    # пропали бы, а владелец прислал бы пустоту. Проверяем запись заранее и при отказе уходим во временную папку.
    $writable = $false
    try {
        New-Item -ItemType Directory -Force -Path $Directory -ErrorAction Stop | Out-Null
        $check = Join-Path $Directory '.write-check'
        [System.IO.File]::WriteAllText($check, 'x')
        Remove-Item $check -Force -ErrorAction Stop
        $writable = $true
    } catch { }
    if (-not $writable) {
        $Directory = Join-Path ([System.IO.Path]::GetTempPath()) ('e3-probe-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Force -Path $Directory | Out-Null
        Write-Host ('! В папку рядом со скриптом писать нельзя, журналы пойдут сюда: ' + $Directory) -ForegroundColor Yellow
    }
    $script:LogDir = $Directory
    $script:TxtPath = Join-Path $Directory 'log.txt'
    $script:NdPath = Join-Path $Directory 'log.ndjson'
    $script:JsonPath = Join-Path $Directory 'log.json'
    $script:TracePath = Join-Path $Directory 'trace.log'
}

function Write-Trace {
    # Запись «начинаю X» ДО действия, которое может зависнуть или уронить процесс. Файл дописывается и закрывается
    # на каждой строке, поэтому последняя строка trace.log при обрыве называет виновника. Пишется для каждого COM-вызова.
    param([string]$Text)
    if (-not $script:TracePath) { return }
    Append-File $script:TracePath ((Get-Date -Format 'HH:mm:ss.fff') + ' ' + $Text + "`r`n")
}

function Append-File {
    param([string]$Path, [string]$Text)
    # Дописываем и закрываем файл на каждой строке: если E3 или скрипт упадёт, всё до этого места уже на диске.
    try { [System.IO.File]::AppendAllText($Path, $Text, $script:Utf8Bom) } catch { }
}

function Write-Human {
    param([string]$Line, [string]$Color = '')
    if ($Color -ne '') { Write-Host $Line -ForegroundColor $Color } else { Write-Host $Line }
    if ($script:TxtPath) { Append-File $script:TxtPath ($Line + "`r`n") }
}

function Write-Section {
    param([string]$Id, [string]$Title)
    $script:Step = $Id
    Write-Trace ('=== раздел ' + $Id + ': ' + $Title)
    Write-Human ''
    Write-Human ('=== ' + $Id + '. ' + $Title + ' ===') 'Cyan'
}

function Get-ClrType {
    # Настоящий тип .NET значения. Писать $x.GetType() для объектов E3 нельзя: у многих из них (Job, Symbol, Device…) есть
    # собственный метод GetType(), PowerShell вызывает его, и вместо типа приходит строка или число из E3.
    param($Value)
    if ($null -eq $Value) { return $null }
    return [System.Object].GetMethod('GetType').Invoke($Value, $null)
}

function Test-ComObject {
    param($Value)
    if ($null -eq $Value) { return $false }
    if ($script:Fake) { return ($Value -is [System.Management.Automation.PSCustomObject]) }
    return ($Value -is [System.__ComObject])
}

function Format-Value {
    param($Value, [int]$Max = 300)
    if ($null -eq $Value) { return '(null)' }
    $text = ''
    if ($Value -is [string]) { $text = '"' + $Value + '"' }
    elseif ($Value -is [System.Array]) {
        $parts = @(); $n = 0
        foreach ($x in $Value) { if ($n -ge 12) { $parts += '...'; break }; $parts += (Format-Value $x 80); $n++ }
        $text = '[' + $Value.Length + '] ' + ($parts -join ', ')
    }
    elseif ($Value -is [ValueType]) { $text = [string]$Value + ' <' + (Get-ClrType $Value).Name + '>' }
    elseif (Test-ComObject $Value) { $text = 'COM-объект' }
    else { $text = [string]$Value + ' <' + (Get-ClrType $Value).Name + '>' }
    if ($text.Length -gt $Max) { $text = $text.Substring(0, $Max) + '…' }
    return ($text -replace "[\r\n]+", ' | ')
}

function Format-Args {
    param([object[]]$CallArgs, [int[]]$Refs)
    if ($null -eq $CallArgs -or $CallArgs.Length -eq 0) { return '' }
    $parts = @()
    for ($i = 0; $i -lt $CallArgs.Length; $i++) {
        if ($Refs -contains $i) { $parts += 'ref' } else { $parts += (Format-Arg $CallArgs[$i]) }
    }
    return ($parts -join ', ')
}

function Format-Plain {
    # Значение для сводки и environment.json: без кавычек и типов
    param($Value, [int]$Max = 250)
    if ($null -eq $Value) { return '' }
    if ($Value -is [System.Array]) { return (Format-Value $Value $Max) }
    $t = ([string]$Value) -replace "[\r\n]+", ' | '
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max) + '…' }
    return $t
}

function Format-Arg {
    # Аргумент вызова для журнала: короче и без типов, чем Format-Value
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { if ($Value.Length -gt 50) { return '"' + $Value.Substring(0, 50) + '…"' }; return '"' + $Value + '"' }
    return [string]$Value
}

function Get-HResult {
    param($Ex)
    try { return ('{0:X8}' -f ([int]$Ex.HResult)) } catch { return '' }
}

function Get-InnerException {
    param($Ex)
    $e = $Ex
    while ($null -ne $e.InnerException) { $e = $e.InnerException }
    return $e
}

function Add-Record {
    param($Record)
    [void]$script:Records.Add($Record)
    try { Append-File $script:NdPath ((ConvertTo-Json $Record -Compress -Depth 4) + "`r`n") } catch { }
}

function Save-Json {
    if ($script:FinalJsonWritten) { return }
    # Полный журнал одним файлом; во время работы он перезаписывается после каждого раздела.
    try {
        $doc = [ordered]@{ attempts = @($script:Records.ToArray()) }
        $text = ConvertTo-Json $doc -Depth 6
        [System.IO.File]::WriteAllText($script:JsonPath, $text, $script:Utf8Bom)
    } catch { Append-File $script:TxtPath ('! не удалось записать log.json: ' + $_.Exception.Message + "`r`n") }
}

function Add-Finding {
    # kind: ok | bad | need | note — из этого собирается summary.txt для владельца
    param([string]$Kind, [string]$Text)
    [void]$script:Findings.Add(@{ Kind = $Kind; Text = $Text })
}

function Invoke-Com {
    # Один вызов члена COM-объекта поздним связыванием. RefIdx — номера параметров, которые E3 заполняет сам (ref/out).
    param($Target, [string]$Name, [object[]]$CallArgs, [int[]]$RefIdx)
    if ($null -eq $CallArgs) { $CallArgs = @() }
    Write-Trace ('COM ' + $Name + '(' + (Format-Args $CallArgs $RefIdx) + ')')
    if ($script:Fake) {
        $method = $Target.PSObject.Methods[$Name]
        if ($null -eq $method) { throw (New-Object System.MissingMethodException('Нет члена ' + $Name)) }
        $wrapped = [object[]]@(,$CallArgs)
        $ret = $method.Invoke($wrapped)
        return [pscustomobject]@{ Ret = $ret; Args = $CallArgs; IsCom = $true }
    }
    $flags = [System.Reflection.BindingFlags]::InvokeMethod
    $mods = $null
    if ($null -eq $RefIdx -or $RefIdx.Length -eq 0) {
        $flags = $flags -bor [System.Reflection.BindingFlags]::GetProperty
    } else {
        $modifier = New-Object System.Reflection.ParameterModifier($CallArgs.Length)
        foreach ($i in $RefIdx) { $modifier[$i] = $true }
        $mods = [System.Reflection.ParameterModifier[]]@($modifier)
    }
    # Тип берём как [System.__ComObject], а не $Target.GetType(): у Job и других объектов E3 есть свой метод GetType().
    $ret = [System.__ComObject].InvokeMember($Name, $flags, $null, $Target, $CallArgs, $mods, $null, $null)
    return [pscustomobject]@{ Ret = $ret; Args = $CallArgs; IsCom = $true }
}

function Invoke-Attempt {
    # Выполняет одно действие, замеряет время и пишет запись в журнал. Ничего не бросает наружу.
    param([string]$Op, [string]$Label, [scriptblock]$Action, [string]$ArgsText = '', [int[]]$Refs = @(), [switch]$Silent)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $rec = [ordered]@{ seq = 0; step = $script:Step; op = $Op; candidate = $Label; args = $ArgsText; ok = $false; type = $null; result = $null; error = $null; hresult = $null; busy = $false; ms = 0 }
    $outValue = $null
    try {
        $raw = @(& $Action)
        $outValue = $null
        if ($raw.Count -eq 1) { $outValue = $raw[0] } elseif ($raw.Count -gt 1) { $outValue = $raw }
        $rec.ok = $true
        if ($null -ne $outValue -and $outValue.PSObject.Properties['IsCom'] -and $outValue.IsCom) {
            $text = Format-Value $outValue.Ret
            foreach ($i in $Refs) { $text += ' ; ref' + $i + '=' + (Format-Value $outValue.Args[$i] 200) }
            $rec.result = $text
            if ($null -ne $outValue.Ret) { $rec.type = (Get-ClrType $outValue.Ret).Name }
        } else {
            $rec.result = Format-Value $outValue
            if ($null -ne $outValue) { $rec.type = (Get-ClrType $outValue).Name }
        }
    } catch {
        $inner = Get-InnerException $_.Exception
        $rec.error = ($inner.Message -replace "[\r\n]+", ' | ')
        $rec.hresult = Get-HResult $inner
        $rec.type = $inner.GetType().Name
        if ($script:BusyCodes -contains $rec.hresult) { $rec.busy = $true }
    }
    $sw.Stop()
    $rec.ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
    $script:Seq++
    $rec.seq = $script:Seq
    Add-Record $rec
    if ($rec.ok) {
        if (-not $script:Winners.Contains($Op)) { $script:Winners[$Op] = New-Object System.Collections.ArrayList }
        [void]$script:Winners[$Op].Add($Label)
        if ($script:Failed.Contains($Op)) { $script:Failed.Remove($Op) }
    } elseif (-not $script:Winners.Contains($Op)) {
        if ($script:Failed.Contains($Op)) { $script:Failed[$Op] = $script:Failed[$Op] + 1 } else { $script:Failed[$Op] = 1 }
    }
    if (-not $Silent) {
        $mark = if ($rec.ok) { '✓' } else { '✕' }
        $tail = if ($rec.ok) { $rec.result } else { $rec.error + $(if ($rec.hresult) { ' [0x' + $rec.hresult + ']' } else { '' }) + $(if ($rec.busy) { ' (E3 ЗАНЯТ)' } else { '' }) }
        $line = '{0} {1}  {2}({3})  {4} мс  -> {5}' -f $mark, $Op, $Label, $ArgsText, $rec.ms, $tail
        Write-Human $line $(if ($rec.ok) { '' } else { 'DarkGray' })
    }
    return [pscustomobject]@{ Ok = $rec.ok; Value = $outValue; Record = $rec }
}

function Cand {
    # Вариант вызова: имя метода, аргументы, номера ref-параметров
    param([string]$M, [object[]]$A = @(), [int[]]$R = @())
    return @{ M = $M; A = $A; R = $R }
}

function Convert-ToItems {
    # Достаёт список значений из массива, который E3 вернул в ref-параметре или результатом вызова.
    param($Ret, $CallArgs, $Refs)
    $items = New-Object System.Collections.ArrayList
    $src = $null
    foreach ($i in $Refs) { if ($CallArgs[$i] -is [System.Array]) { $src = $CallArgs[$i]; break } }
    if ($null -eq $src -and $Ret -is [System.Array]) { $src = $Ret }
    if ($null -ne $src) {
        foreach ($x in $src) {
            if ($null -eq $x -or $x -is [System.DBNull]) { continue }
            if ($x -is [string] -and $x -eq '') { continue }
            if ($x -is [ValueType] -and $x -eq 0) { continue }
            [void]$items.Add($x)
        }
    }
    return , $items.ToArray()
}

function Try-Calls {
    # Перебирает варианты вызова одной операции. -First — остановиться на первом сработавшем.
    param([string]$Op, $Target, [string]$TL, [object[]]$Cands, [switch]$First, [switch]$Silent)
    $res = @{ Ok = $false; Value = $null; Out = @(); Winner = $null; WinCand = $null; Items = $null; Wins = (New-Object System.Collections.ArrayList) }
    if ($null -eq $Target) { return $res }
    foreach ($cand in $Cands) {
        $callArgs = $cand.A.Clone()
        $label = $TL + '.' + $cand.M
        $argText = Format-Args $cand.A $cand.R
        $action = { Invoke-Com -Target $Target -Name $cand.M -CallArgs $callArgs -RefIdx $cand.R }
        $r = Invoke-Attempt -Op $Op -Label $label -ArgsText $argText -Refs $cand.R -Action $action -Silent:$Silent
        if (-not $r.Ok) { continue }
        $outs = @(); foreach ($i in $cand.R) { $outs += , $callArgs[$i] }
        $items = Convert-ToItems $r.Value.Ret $callArgs $cand.R
        [void]$res.Wins.Add(@{ Label = $label; Value = $r.Value.Ret; Out = $outs; Items = $items; Cand = $cand })
        if (-not $res.Ok) { $res.Ok = $true; $res.Value = $r.Value.Ret; $res.Out = $outs; $res.Winner = $label; $res.WinCand = $cand; $res.Items = $items }
        elseif ($res.Items.Count -eq 0 -and $items.Count -gt 0) { $res.Items = $items; $res.WinCand = $cand; $res.Winner = $label }
        if ($First) { break }
    }
    return $res
}

function Invoke-Quiet {
    # Вызов без записи в журнал: для повторов, которые уже описаны, и для массовых проходов. $null — не получилось.
    param($Target, [string]$Name, [object[]]$CallArgs = @(), [int[]]$Refs = @())
    if ($null -eq $Target) { return $null }
    try { return (Invoke-Com -Target $Target -Name $Name -CallArgs $CallArgs -RefIdx $Refs) } catch { return $null }
}

function Select-Id {
    # Ставит id в обёртку объекта и подтверждает выбор. E3 на неверный id исключения не бросает: при успехе SetId
    # возвращает сам id, при неудаче 0, а в обёртке остаётся прежний объект. Поэтому «вызов прошёл» ещё не значит «выбран»;
    # перед любым Delete проверяем, что вернулся именно этот id.
    param($Target, $Id)
    $r = Invoke-Quiet $Target 'SetId' @($Id)
    if ($null -eq $r -or $null -eq $r.Ret -or $r.Ret -is [bool]) { return $false }
    try { return ([long]$r.Ret -eq [long]$Id) } catch { return $false }
}

function Get-QuietValue {
    param($Target, [string]$Name, [object[]]$CallArgs = @())
    $r = Invoke-Quiet $Target $Name $CallArgs
    if ($null -eq $r) { return $null }
    return $r.Ret
}

function Get-Ids {
    # Список идентификаторов: первый раз — со всеми вариантами в журнал, потом тихо тем вариантом, что сработал.
    param([string]$Key, [string]$Op, $Target, [string]$TL, [object[]]$Cands)
    if ($script:Known.ContainsKey($Key)) {
        $cand = $script:Known[$Key]
        if ($cand.None) { return @() }
        $callArgs = $cand.A.Clone()
        $r = Invoke-Quiet $Target $cand.M $callArgs $cand.R
        if ($null -eq $r) { return @() }
        $items = Convert-ToItems $r.Ret $callArgs $cand.R
        return @($items)
    }
    $res = Try-Calls -Op $Op -Target $Target -TL $TL -Cands $Cands
    if ($res.WinCand) { $script:Known[$Key] = $res.WinCand } else { $script:Known[$Key] = @{ None = $true } }
    if ($null -eq $res.Items) { return @() }
    return @($res.Items)
}

function New-ComWrapper {
    # Обёртка объекта (Sheet, Device, Symbol…) от родителя: пробует имена по очереди и берёт первую работающую.
    param([string]$Op, $Parent, [string]$PL, [string[]]$Names)
    $cands = @(); foreach ($n in $Names) { $cands += , (Cand $n) }
    $res = Try-Calls -Op $Op -Target $Parent -TL $PL -Cands $cands -First
    if ($res.Ok) { return $res.Value }
    return $null
}

function Test-Property {
    param($Object, [string]$Name)
    return ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name])
}
