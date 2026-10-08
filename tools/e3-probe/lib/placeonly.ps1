# Режим «только разместить»: одно изделие по имени компонента на АКТИВНОМ листе открытого проекта — и выход.
# Не создаётся временный лист, не пишутся атрибуты, ничего не удаляется, база и сохранение не затрагиваются.
# Отмена — обычными Ctrl+Z или Delete в E3.

function Read-PlaceName {
    # Спрашивает имя компонента. Кириллица в консоли PowerShell 5.1 при chcp 65001 может испортиться, поэтому
    # кодировка ввода выставляется явно, полученная строка и коды её символов пишутся в журнал, а испорченный ввод
    # (знаки «?» или U+FFFD вместо букв) заменяется содержимым файла place-name.txt (UTF-8) рядом со скриптом, если он есть.
    try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    Write-Human ''
    $raw = Read-Host 'Разместить одно изделие на открытом листе? Введите имя компонента (Enter — пропустить и идти к полной проверке)'
    if ($null -eq $raw) { $raw = '' }
    $raw = $raw.Trim()
    $codes = (($raw.ToCharArray() | ForEach-Object { 'U+' + ([int]$_).ToString('X4') }) -join ' ')
    Write-Human ('Введено: «' + $raw + '» (знаков ' + $raw.Length + '; коды: ' + $codes + ')')
    if ($raw -match '[\?�\x00-\x1F]') {
        $file = Join-Path $script:ProbeRoot 'place-name.txt'
        if (Test-Path -LiteralPath $file) {
            $fromFile = ([System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)).Trim()
            Write-Human ('! Ввод с клавиатуры испорчен (кодовая страница консоли). Беру имя из ' + $file + ': «' + $fromFile + '»') 'Yellow'
            return $fromFile
        }
        Write-Human '! Ввод с клавиатуры испорчен (кодовая страница консоли). Создайте рядом со скриптом файл place-name.txt (UTF-8) с именем компонента и запустите снова либо запустите с параметром -PlaceOnly "имя".' 'Yellow'
        return ''
    }
    return $raw
}

function Find-FreePoint {
    # Свободная точка активного листа: сетка кандидатов от левого верхнего угла рабочего поля; берётся первая, где нет
    # символов. Нет данных о поле — фиксированная точка (100,100), как в полной проверке.
    param($Sheet, $SheetId)
    $fallback = @($script:PlaceX, $script:PlaceY)
    $r = Invoke-Quiet $Sheet 'GetDrawingArea' @($null, $null, $null, $null) @(0, 1, 2, 3)
    if ($null -eq $r -or $r.Args.Length -lt 4) { return $fallback }
    try { $xMin = [double]$r.Args[0]; $yMin = [double]$r.Args[1]; $xMax = [double]$r.Args[2]; $yMax = [double]$r.Args[3] } catch { return $fallback }
    $w = $xMax - $xMin; $h = $yMax - $yMin
    if ($w -le 0 -or $h -le 0) { return $fallback }
    $boxes = New-Object System.Collections.ArrayList
    $sym = $script:Objects['Symbol']
    $rs = Invoke-Quiet $Sheet 'GetSymbolIds' @($null) @(0)
    if ($null -ne $rs -and $null -ne $sym) {
        $symIds = Convert-ToItems $rs.Ret $rs.Args @(0)
        $n = 0
        foreach ($sid in $symIds) {
            if ($n -ge 400) { break }; $n++
            if (-not (Select-Id $sym $sid)) { continue }
            $a = Invoke-Quiet $sym 'GetPlacedArea' @($null, $null, $null, $null) @(0, 1, 2, 3)
            if ($null -eq $a) { continue }
            try { [void]$boxes.Add(@([double]$a.Args[0], [double]$a.Args[1], [double]$a.Args[2], [double]$a.Args[3])) } catch { }
        }
    }
    $bw = 0.12 * $w; $bh = 0.12 * $h
    for ($row = 0; $row -lt 5; $row++) {
        for ($col = 0; $col -lt 6; $col++) {
            $x = $xMin + 0.08 * $w + $col * 0.15 * $w
            $y = $yMax - 0.12 * $h - $row * 0.15 * $h
            $busy = $false
            foreach ($b in $boxes) {
                $lo = [math]::Min($b[0], $b[2]); $hi = [math]::Max($b[0], $b[2]); $lo2 = [math]::Min($b[1], $b[3]); $hi2 = [math]::Max($b[1], $b[3])
                if ($x -lt $hi -and ($x + $bw) -gt $lo -and ($y - $bh) -lt $hi2 -and $y -gt $lo2) { $busy = $true; break }
            }
            if (-not $busy) { return @([math]::Round($x, 1), [math]::Round($y, 1)) }
        }
    }
    return @([math]::Round($xMin + 0.08 * $w, 1), [math]::Round($yMax - 0.12 * $h, 1))
}

function Step-PlaceOnly {
    param([string]$Name)
    Write-Section 'P' ('Только разместить: «' + $Name + '» на активном листе')
    # объекты нужны только для размещения и чтения
    $script:Job = Get-QuietValue $script:App 'CreateJobObject'
    if ($null -eq $script:Job) { Write-Human '✕ объект проекта не создан.' 'Red'; Add-Finding 'bad' 'Размещение: объект проекта не создан.'; return }
    foreach ($kind in @('Sheet', 'Device', 'Symbol', 'Component')) { $script:Objects[$kind] = Get-QuietValue $script:Job ('Create' + $kind + 'Object') }
    $sheet = $script:Objects['Sheet']
    $rActive = Invoke-Quiet $script:Job 'GetActiveSheetId'
    $sid = $null; if ($null -ne $rActive -and (Test-Positive $rActive)) { $sid = [int]$rActive.Ret }
    if ($null -eq $sid -or -not (Select-Id $sheet $sid)) {
        Write-Human '✕ активный лист определить не удалось (Job.GetActiveSheetId). Откройте лист и запустите снова.' 'Red'
        Add-Finding 'bad' 'Размещение: активный лист не определился (Job.GetActiveSheetId).'; return
    }
    $sheetName = Get-QuietValue $sheet 'GetName'
    $point = Find-FreePoint $sheet $sid
    Write-Human ('Активный лист: «' + $sheetName + '» (id ' + $sid + '); точка вставки: (' + $point[0] + ', ' + $point[1] + ')')
    if (-not $script:NoConfirm) {
        Write-Human ('Будет создано ОДНО изделие по компоненту «' + $Name + '» на этом листе. Больше ничего: не удаляется, атрибуты не пишутся, проект не сохраняется.') 'Yellow'
        $answer = Read-Host 'Введите Y и нажмите Enter, чтобы разместить (любой другой ответ — выход)'
        if ($answer -ne 'Y' -and $answer -ne 'y') { Write-Human 'Отменено: ничего не изменено.' 'Yellow'; Add-Finding 'note' 'Размещение отменено пользователем до изменений.'; return }
    }
    $script:PlaceX = $point[0]; $script:PlaceY = $point[1]
    $variants = @(Get-PlaceVariants $Name $point[0] $point[1] $sid -PlaceOnly)
    Write-Human ('Способов размещения к проверке: ' + $variants.Count)
    $tried = @()
    $script:ProbeSheetId = $sid      # Get-SheetSymbols и Invoke-PlaceVariant работают с этим номером; временного листа здесь нет
    foreach ($v in $variants) {
        $devBefore = @(Get-AllDevices)
        $symBefore = @(Get-SheetSymbols)
        $r = Invoke-PlaceVariant $v ('place.only.' + $v.Id)
        $tried += $v.Label
        $created = @($script:PlanCtx.Created)
        if ($r.Ok) {
            $newSym = @(@(Get-SheetSymbols) | Where-Object { $symBefore -notcontains $_ })
            $newDev = @(@(Get-AllDevices) | Where-Object { $devBefore -notcontains $_ })
            if ($newSym.Count -gt 0) {
                $devName = ''; if ($newDev.Count -gt 0) { $dev = $script:Objects['Device']; if (Select-Id $dev $newDev[0]) { $devName = [string](Get-QuietValue $dev 'GetName') } }
                Write-Human ''
                Write-Human 'ГОТОВО: изделие размещено.' 'Green'
                Write-Human ('  Устройство: id ' + (@($newDev) -join ', ') + $(if ($devName) { ', обозначение «' + $devName + '»' } else { '' }))
                Write-Human ('  Символы на листе: id ' + ($newSym -join ', '))
                Write-Human ('  Компонент: «' + $Name + '»; лист «' + $sheetName + '» (id ' + $sid + '); координаты (' + $point[0] + ', ' + $point[1] + ')')
                Write-Human ('  Вызов: ' + $v.Label + ' — ' + (($v.Steps | ForEach-Object { $_.T + '.' + $_.M + '(' + (Format-Args $_.A @()) + ')' }) -join ' → '))
                Write-Human '  Отменить: выделите изделие в E3 и нажмите Delete (или Ctrl+Z). Проект не сохранялся.' 'Yellow'
                Add-Finding 'ok' ('Размещено изделие «' + $Name + '» на листе «' + $sheetName + '» (id ' + $sid + ') в (' + $point[0] + ', ' + $point[1] + '): устройство ' + (@($newDev) -join ', ') + ', символы ' + ($newSym -join ', ') + ', вызов ' + $v.Label + '.')
                return
            }
            if ($newDev.Count -gt 0 -or $created.Count -gt 0) { break }   # что-то создалось без символа: дальше не пробуем, чтобы не плодить
            continue
        }
        if ($created.Count -gt 0) { break }                              # устройство создалось, а символ не встал: не плодим новых
    }
    $left = @($script:PlanCtx.Created)
    Write-Human ''
    Write-Human ('✕ изделие «' + $Name + '» разместить не удалось. Пробовали: ' + (($tried | Select-Object -Unique) -join '; ') + '.') 'Red'
    if ($left.Count -gt 0) {
        Write-Human ('! В проекте мог остаться созданный без символа объект (id ' + ($left -join ', ') + '). Найдите его в дереве проекта и удалите (Delete или Ctrl+Z).') 'Yellow'
        Add-Finding 'bad' ('Размещение «' + $Name + '» не удалось; в проекте мог остаться объект без символа, id ' + ($left -join ', ') + ': удалите вручную.')
    } else {
        Write-Human '  Ничего не создано. Подробности — в trace.log и log.txt; пришлите папку журналов.'
        Add-Finding 'bad' ('Размещение «' + $Name + '» не удалось ни одним способом (пробовали: ' + (($tried | Select-Object -Unique) -join '; ') + '); ничего не создано.')
    }
}
