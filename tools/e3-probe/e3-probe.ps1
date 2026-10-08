<#
.SYNOPSIS
  Проверка API E3.series для Flux. Не зависит от Flux: только E3, PowerShell 5.1, ничего не устанавливается.

.DESCRIPTION
  Подключается к запущенному E3 через COM (CT.Application, CT.Dispatcher) и проверяет всё, что нужно E3Flux:
  листы и поля, атрибуты, базу, вставку решения, обозначения, выводы и провода, графику и экспорт,
  остальные объекты проекта, выделение, скорость. Каждая операция пробуется по всем известным именам методов;
  ничто не прерывается на первой ошибке.

  Работает только на временном листе __flux_probe__ и временных объектах, в конце всё удаляет и возвращает
  атрибуты как были. Проект НЕ сохраняется.

  Результат — папка e3-probe-<дата-время> рядом со скриптом и архив .zip с ней.

.PARAMETER SolutionName
  Имя типового решения (компонента, блока, символа) для проверки вставки. По умолчанию Клапан_К24_КП2.
.PARAMETER NoConfirm
  Не спрашивать подтверждение «Y» и выбор экземпляра E3.
.PARAMETER KeepSheet
  Не удалять временный лист в конце — посмотреть глазами.
.PARAMETER ProcessId
  Номер процесса E3, если запущено несколько.
.PARAMETER OutDir
  Куда писать журналы (по умолчанию — рядом со скриптом).
.PARAMETER SelfCheck
  Проверка самого скрипта без E3: собирает разборщик библиотек типов и снимает опись у Scripting.FileSystemObject.
.PARAMETER FakeCom
  Только для проверок: путь к скрипту с подставным COM-объектом.
#>
[CmdletBinding()]
param(
    [string]$SolutionName = 'Клапан_К24_КП2',
    [switch]$NoConfirm,
    [switch]$KeepSheet,
    [int]$ProcessId = 0,
    [string]$OutDir = '',
    [switch]$SelfCheck,
    [string]$FakeCom = ''
)

$ErrorActionPreference = 'Continue'
$script:ProbeRoot = $PSScriptRoot
if (-not $script:ProbeRoot) { $script:ProbeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }
$script:SolutionName = $SolutionName
$script:NoConfirm = [bool]$NoConfirm
$script:KeepSheet = [bool]$KeepSheet
$script:ProcessId = $ProcessId
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

foreach ($module in @('core', 'apidump', 'connect', 'sheets', 'attributes', 'database', 'placeplans', 'place', 'graphics', 'project', 'report')) {
    . (Join-Path $script:ProbeRoot ('lib\' + $module + '.ps1'))
}

function Invoke-Step {
    # Один раздел: любая ошибка внутри записывается, и работа идёт дальше.
    param([string]$Name, [scriptblock]$Body)
    try { & $Body }
    catch {
        $inner = Get-InnerException $_.Exception
        Write-Human ('✕ раздел «' + $Name + '» прерван непредвиденной ошибкой: ' + $inner.Message) 'Red'
        Add-Finding 'bad' ('Раздел «' + $Name + '» прерван ошибкой скрипта: ' + $inner.Message)
        $rec = [ordered]@{ seq = 0; step = $script:Step; op = 'script.error'; candidate = $Name; args = ''; ok = $false; type = $inner.GetType().Name; result = $null; error = $inner.Message; hresult = (Get-HResult $inner); busy = $false; ms = 0 }
        $script:Seq++; $rec.seq = $script:Seq; Add-Record $rec
    }
    Save-Json
}

# ---------------------------------------------------------------- самопроверка без E3
if ($SelfCheck) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $base = if ($OutDir) { $OutDir } else { Join-Path $env:TEMP ('e3-probe-selfcheck-' + $stamp) }
    Initialize-Log $base
    Write-Section 'S' 'Самопроверка скрипта (без E3)'
    $selfFails = 0
    if (-not (Initialize-TypeInfo)) { Write-Human '✕ C# разборщика библиотек типов не собрался' 'Red'; exit 1 }
    Write-Human '✓ C# разборщика библиотек типов собран'
    try {
        $fso = New-Object -ComObject 'Scripting.FileSystemObject'
        $names = Export-ApiObject $fso 'FileSystemObject'
        if ($names.Count -gt 20 -and ($names -contains 'FileExists')) { Write-Human ('✓ опись FileSystemObject: членов ' + $names.Count) }
        else { Write-Human ('✕ опись FileSystemObject неполная: ' + $names.Count) 'Red'; $selfFails++ }
        Save-ApiJson
        $json = Get-Content (Join-Path $script:LogDir 'api.json') -Raw -Encoding UTF8
        $null = ConvertFrom-Json $json
        Write-Human '✓ api.json разбирается как JSON'
        $reg = Get-ProgIdRegistration 'Scripting.FileSystemObject'
        if ($reg.clsid) { Write-Human ('✓ реестр: ' + $reg.clsid + ' -> ' + $reg.server) } else { Write-Human ('✕ реестр: ' + $reg.error) 'Red'; $selfFails++ }
        # опись библиотеки типов из файла на диске — тот путь, которым пользуется Step-TypeLibrary
        if ($reg.typeLibPath) {
            $doc = [FluxTypeInfo]::LibraryFile([string]$reg.typeLibPath, 'FileSystemObject')
            if ($doc[1] -match 'FileSystemObject' -and $doc[0] -match '"guid"') { Write-Human ('✓ библиотека типов из файла ' + $reg.typeLibPath + ': ' + $doc[1].Length + ' знаков') }
            else { Write-Human '✕ библиотека типов из файла не содержит FileSystemObject' 'Red'; $selfFails++ }
        } else { Write-Human '— путь к библиотеке типов FileSystemObject в реестре не найден, опись из файла не проверена.' 'Yellow' }
        $r = Invoke-Attempt -Op 'self.fso.FileExists' -Label 'fso.FileExists' -ArgsText 'C:\Windows\notepad.exe' -Action { Invoke-Com -Target $fso -Name 'FileExists' -CallArgs @('C:\Windows\notepad.exe') -RefIdx @() }
        if (-not $r.Ok -or $r.Value.Ret -ne $true) { $selfFails++ }
        $r = Invoke-Attempt -Op 'self.fso.nomethod' -Label 'fso.NoSuchMethod' -ArgsText '' -Action { Invoke-Com -Target $fso -Name 'NoSuchMethod' -CallArgs @() -RefIdx @() }
        if ($r.Ok) { $selfFails++ } else { Write-Human ('✓ несуществующий метод даёт ошибку с HRESULT 0x' + $r.Record.hresult) }
    } catch { Write-Human ('✕ самопроверка: ' + $_.Exception.Message) 'Red'; $selfFails++ }
    Save-Json
    Write-Human ('Самопроверка завершена, провалов: ' + $selfFails)
    exit $selfFails
}

# ---------------------------------------------------------------- обычный запуск
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if ($OutDir) { $base = $OutDir } else { $base = Join-Path $script:ProbeRoot ('e3-probe-' + $stamp) }
Initialize-Log $base
if ($FakeCom) { $script:Fake = $true; . $FakeCom }
Write-Human 'Проверка API E3.series для Flux' 'Cyan'
Write-Human ('Журналы: ' + $script:LogDir)
Write-Human 'Скрипт работает только на временном листе, проект не сохраняет, всё созданное удаляет.'
Write-Human 'ПЕРЕД ЗАПУСКОМ: откройте в E3 КОПИЮ тестового проекта (не рабочий). Без открытого проекта будет снята только опись API.' 'Yellow'
Write-Human 'Если окно долго ничего не пишет, подождите 5 минут; потом закройте его и пришлите папку журналов целиком: последняя строка trace.log покажет, где встало.'

$exitCode = 0
try {
    Invoke-Step 'Окружение' { Step-Environment }
    Invoke-Step 'Подключение' { $r = @(Step-Connect); $script:Connected = ($r.Count -gt 0 -and $r[-1] -eq $true) }
    if ($script:Connected) {
        Invoke-Step 'Проект открыт?' { Step-ProjectCheck }
        Invoke-Step 'Версия и проект' { $r = @(Step-AppInfo); $script:ProjectOpen = ($r.Count -gt 0 -and $r[-1] -eq $true) }
        if ($script:Job) {
            Invoke-Step 'Объекты проекта' { Step-CreateJobObjects }
        }
        if (-not $script:ProjectOpen) {
            Invoke-Step 'Без проекта' { Step-NoProject }
            if ((Get-TitleProjectFile) -ne '') { Write-Human 'Проект определён как не открытый, но заголовок окна E3 называет файл проекта — это противоречие, смотрите сводку и trace.log. Пришлите журнал целиком.' 'Yellow' }
            else { Write-Human 'Проект в E3 не открыт — дальнейшие проверки невозможны. Откройте ТЕСТОВЫЙ проект и запустите снова.' 'Yellow' }
        } else {
            $proceed = $true
            if (-not $script:NoConfirm) {
                Write-Human ''
                Write-Human ('Проект в E3: «' + $script:ProjectName + '»') 'Yellow'
                Write-Human ('Путь: ' + $script:ProjectPath) 'Yellow'
                Write-Human 'Скрипт создаст на нём временный лист, вставит и удалит решение, временно запишет и вернёт атрибуты. Проект не сохраняется.' 'Yellow'
                Write-Human 'Это тестовый проект или его копия?' 'Yellow'
                # Почему клавиша, а не Read-Host: ConsoleKey.Y — физическая клавиша и
                # не зависит от раскладки («Н» в русской даёт ту же клавишу). Read-Host
                # при chcp 65001 в Windows PowerShell 5.1 портит кириллицу, и ответ
                # «Н» приходит как «?» или пустой строкой, поэтому список букв не спасал.
                Write-Human 'Нажмите клавишу Y (в любой раскладке), чтобы продолжить; любая другая клавиша — выход' 'Yellow'
                try {
                    $k = [Console]::ReadKey($true)
                    $ok = ($k.Key -eq [ConsoleKey]::Y) -or (@('Y','y','Н','н','Д','д') -contains [string]$k.KeyChar)
                    $got = ('клавиша ' + $k.Key + ', символ ' + [int][char]$k.KeyChar)
                } catch {
                    # Перенаправленный ввод (без консоли): ответ строкой
                    $a = ([string](Read-Host 'Введите Y и Enter')).Trim()
                    $ok = @('Y','y','Н','н','Д','д','да','Да','yes') -contains $a
                    $got = ('строка «' + $a + '»')
                }
                Add-Finding 'note' ('Ответ на подтверждение: ' + $got)
                if (-not $ok) { $proceed = $false }
            }
            if (-not $proceed) {
                Write-Human 'Отменено: ничего не изменено.' 'Yellow'
                Add-Finding 'note' 'Запуск отменён пользователем до изменений.'
            } else {
                Import-OwnerAttributes
                try {
                    Invoke-Step 'Листы' { [void](Step-Sheets) }
                    Invoke-Step 'Размеры проекта' { Step-ProjectSize }
                    Invoke-Step 'Атрибуты проекта и листа' { Step-ProjectAttributes }
                    Invoke-Step 'База E3' { Step-Database }
                    Invoke-Step 'Вставка' { Step-Place }
                    if ($script:Kept) {
                        $script:PrimaryDevice = @($script:Kept.Devices)[0]
                        $script:PrimarySymbol = @($script:Kept.Symbols)[0]
                    }
                    Invoke-Step 'Атрибуты на устройстве' { Step-PlacedAttributes }
                    Invoke-Step 'Атрибуты владельца' {
                        $carriers = @(
                            @{ Id = 'project'; Label = 'Проект'; Target = $script:Job; TL = 'job'; ReadOnly = $true; Prepare = { } },
                            @{ Id = 'sheet'; Label = 'Лист'; Target = $script:Objects['Sheet']; TL = 'sheet'; ReadOnly = $false; Prepare = { [void](Use-Sheet $script:ProbeSheetId) } }
                        )
                        if ($null -ne $script:PrimaryDevice) {
                            $carriers += @{ Id = 'device'; Label = 'Изделие'; Target = (Get-DevObj); TL = 'device'; ReadOnly = $false; Prepare = { [void](Invoke-Quiet (Get-DevObj) 'SetId' @($script:PrimaryDevice)) } }
                            if ($null -ne $script:Objects['Block']) { $carriers += @{ Id = 'block'; Label = 'Блок'; Target = $script:Objects['Block']; TL = 'block'; ReadOnly = $false; Prepare = { [void](Invoke-Quiet $script:Objects['Block'] 'SetId' @($script:PrimaryDevice)) } } }
                            $pins = @(Get-PlacedPins)
                            if ($pins.Count -gt 0 -and $null -ne $script:Objects['Pin']) { $script:PrimaryPin = $pins[0]; $carriers += @{ Id = 'pin'; Label = 'Пин'; Target = $script:Objects['Pin']; TL = 'pin'; ReadOnly = $false; Prepare = { [void](Invoke-Quiet $script:Objects['Pin'] 'SetId' @($script:PrimaryPin)) } } }
                        }
                        if ($null -ne $script:PrimarySymbol -and $null -ne $script:Objects['Symbol']) { $carriers += @{ Id = 'symbol'; Label = 'Символ'; Target = $script:Objects['Symbol']; TL = 'symbol'; ReadOnly = $false; Prepare = { [void](Invoke-Quiet $script:Objects['Symbol'] 'SetId' @($script:PrimarySymbol)) } } }
                        Step-OwnerAttributes $carriers
                    }
                    Invoke-Step 'Обозначения' { Step-Designation }
                    Invoke-Step 'Выводы и провода' { Step-Wires }
                    Invoke-Step 'Графика и экспорт' { Step-Graphics }
                    Invoke-Step 'Остальные объекты' { Step-OtherObjects }
                    Invoke-Step 'Выделение и сообщения' { Step-Interaction }
                    Invoke-Step 'Активный лист' { Step-Activate }
                    Invoke-Step 'Перебор и скорость' { Step-Search }
                    Invoke-Step 'Возможности' { Step-Capabilities }
                } finally {
                    # Уборка выполняется всегда: и при ошибке, и при Ctrl+C.
                    Invoke-Step 'Уборка' { Step-Cleanup }
                }
                Invoke-Step 'Устойчивость' { Step-Resilience }
            }
        }
    }
    # Опись всей библиотеки типов — последней: читает файл на диске и, даже если что-то пойдёт не так, всё остальное уже записано.
    Invoke-Step 'Библиотека типов' { Step-TypeLibrary }
} catch {
    Write-Human ('✕ непредвиденная ошибка: ' + $_.Exception.Message) 'Red'
    $exitCode = 1
} finally {
    Invoke-Step 'Итоги' { Step-Report }
}
exit $exitCode
