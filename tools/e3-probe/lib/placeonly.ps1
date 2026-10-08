# Режим «только разместить»: один символ по имени символа (запасные планы — по компоненту с тем же именем) на АКТИВНОМ листе открытого проекта — и выход.
# Не создаётся временный лист, не пишутся атрибуты, ничего не удаляется, база и сохранение не затрагиваются.
# Отмена — обычными Ctrl+Z или Delete в E3.

function Read-PlaceName {
    # Спрашивает имя компонента. Кириллица в консоли PowerShell 5.1 при chcp 65001 может испортиться, поэтому
    # кодировка ввода выставляется явно, полученная строка и коды её символов пишутся в журнал, а испорченный ввод
    # (знаки «?» или U+FFFD вместо букв) заменяется содержимым файла place-name.txt (UTF-8) рядом со скриптом, если он есть.
    try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    Write-Human ''
    $raw = Read-Host 'Введите имя символа, имя подсхемы из базы E3 или путь к файлу блока .e3p (можно перетащить файл в окно). К — только проверка каталога. Enter — пропустить и идти к полной проверке'
    if ($null -eq $raw) { $raw = '' }
    $raw = $raw.Trim()
    # при перетаскивании файла в окно путь приходит в кавычках
    if ($raw.Length -ge 2 -and $raw.StartsWith('"') -and $raw.EndsWith('"')) { $raw = $raw.Substring(1, $raw.Length - 2).Trim() }
    if ($raw -eq 'К' -or $raw -eq 'к' -or $raw -eq 'K' -or $raw -eq 'k') { Write-Human 'Выбрано: только проверка каталога.'; return '::catalog' }
    $codes = (($raw.ToCharArray() | ForEach-Object { 'U+' + ([int]$_).ToString('X4') }) -join ' ')
    Write-Human ('Введено: «' + $raw + '» (знаков ' + $raw.Length + '; коды: ' + $codes + ')')
    if ($raw -match '[\?�\x00-\x1F]') {
        $file = Join-Path $script:ProbeRoot 'place-name.txt'
        if (Test-Path -LiteralPath $file) {
            $fromFile = ([System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)).Trim()
            Write-Human ('! Ввод с клавиатуры испорчен (кодовая страница консоли). Беру имя из ' + $file + ': «' + $fromFile + '»') 'Yellow'
            return $fromFile
        }
        Write-Human '! Ввод с клавиатуры испорчен (кодовая страница консоли). Создайте рядом со скриптом файл place-name.txt (UTF-8) с именем символа и запустите снова либо запустите с параметром -PlaceOnly "имя".' 'Yellow'
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

function Write-PlaceSuccess {
    param([string]$Name, $v, $newDev, $newSym, $sheetName, $sid, $point)
    $devName = ''; if ($newDev.Count -gt 0) { $dev = $script:Objects['Device']; if (Select-Id $dev $newDev[0]) { $devName = [string](Get-QuietValue $dev 'GetName') } }
    Write-Human ''
    $isSymbol = ($v.Label -like 'symbol.Load+Place*')
    $isPart = ($v.Label -like '*PlacePart*')
    Write-Human 'ГОТОВО: изделие размещено.' 'Green'
    Write-Human ('  Что вставлено: ' + $(if ($isSymbol) { 'вставлен символ' } elseif ($isPart) { 'вставлена подсхема/блок из базы' } else { 'создано устройство и поставлен его символ' }))
    Write-Human ('  Устройство: id ' + (@($newDev) -join ', ') + $(if ($devName) { ', обозначение «' + $devName + '»' } else { '' }))
    Write-Human ('  Символы на листе: id ' + ($newSym -join ', '))
    Write-Human ('  Имя: «' + $Name + '»; лист «' + $sheetName + '» (id ' + $sid + '); координаты (' + $point[0] + ', ' + $point[1] + ')')
    Write-Human ('  Вызов: ' + $v.Label + ' — ' + (($v.Steps | ForEach-Object { $_.T + '.' + $_.M + '(' + (Format-Args $_.A @()) + ')' }) -join ' → '))
    $script:LastPlaceLabel = $v.Label     # какой вызов сработал: его берёт отчёт режима -PlaceSample
    if (-not $script:TempSheetMode) { Write-Human '  Отменить: выделите изделие в E3 и нажмите Delete (или Ctrl+Z). Проект не сохранялся.' 'Yellow' }
    Add-Finding 'ok' ($(if ($isSymbol) { 'Вставлен символ «' } elseif ($isPart) { 'Вставлена подсхема/блок из базы «' } else { 'Размещено изделие «' }) + $Name + '» на листе «' + $sheetName + '» (id ' + $sid + ') в (' + $point[0] + ', ' + $point[1] + '): устройство ' + (@($newDev) -join ', ') + ', символы ' + ($newSym -join ', ') + ', вызов ' + $v.Label + '.')
}

function Get-NewOnSheet {
    param($DevBefore, $SymBefore)
    return @{
        Sym = @(@(Get-SheetSymbols) | Where-Object { $SymBefore -notcontains $_ })
        Dev = @(@(Get-AllDevices) | Where-Object { $DevBefore -notcontains $_ })
    }
}

function Step-PlaceBySymbol {
    # Главный план: Symbol.Load(имя символа, версия) -> Symbol.Place(лист, x, y, "0"). Успех — только если на листе появился
    # новый символ. Возвращает 'placed', 'notfound' (Load везде вернул 0) или 'failed' (Load прошёл, символ не встал).
    param([string]$Name, $Sid, $Point, $SheetName)
    $result = 'notfound'
    foreach ($ver in @('1', '')) {
        $v = @{ Id = 'symbol.Load+Place.v' + $ver; Label = 'symbol.Load+Place'; SheetId = $Sid; Steps = @(
            (New-PlanStep symbol Load @([string]$Name, [string]$ver) -Pos),
            (New-PlanStep symbol Place @([int]$Sid, [double]$Point[0], [double]$Point[1], [string]'0') -Pos)) }
        $v.A = @($v.Steps)[-1].A
        $devBefore = @(Get-AllDevices); $symBefore = @(Get-SheetSymbols)
        $r = Invoke-PlaceVariant $v ('place.only.symbol.v' + $ver)
        if ($script:PlanCtx.StepsDone -ge 1) { $result = 'failed' }
        if ($r.Ok) {
            $new = Get-NewOnSheet $devBefore $symBefore
            if ($new.Sym.Count -gt 0) { Write-PlaceSuccess $Name $v $new.Dev $new.Sym $SheetName $Sid $Point; return 'placed' }
        }
    }
    return $result
}

function Step-PlaceDevicePlanB {
    # План Б после неудачи символа и PlacePart*: Device.Create(уникальное имя, "", "", компонент, версия, 0) и, если символ
    # компонента известен по устройствам проекта, Symbol.Load + Symbol.Place. Ничего не удаляется: созданное остаётся владельцу.
    param([string]$Name, $Sid, $Point, $SheetName)
    $info = Resolve-Component $Name
    $comp = [string]$Name; $verList = @()
    if ($null -ne $info) { $comp = [string]$info.Name; foreach ($c in @($info.Version, '1', '', $info.VersionRaw)) { if ($verList -notcontains [string]$c) { $verList += [string]$c } } }
    else { $verList = @('1', '') }
    $devName = 'FLUXPLACE_' + (Get-Date -Format 'HHmmss')
    $created = $false
    foreach ($ver in $verList) {
        $v = @{ Id = 'planB.device.Create.v' + $ver; Label = 'device.Create (план Б)'; SheetId = $Sid; Steps = @((New-PlanStep device Create @($devName, '', '', $comp, [string]$ver, [int]0) -Pos -Save dev)) }
        $v.A = @($v.Steps)[-1].A
        $devBefore = @(Get-AllDevices); $symBefore = @(Get-SheetSymbols)
        $r = Invoke-PlaceVariant $v ('place.only.planB.create.v' + $ver)
        if (-not $r.Ok) { continue }
        $created = $true
        if ($null -ne $info -and @($info.Symbols).Count -gt 0) {
            foreach ($sym in @($info.Symbols)) {
                foreach ($sv in @('1', '', [string]$sym.Version)) {
                    $vs = @{ Id = 'planB.symbol.Load+Place'; Label = 'symbol.Load+Place (план Б)'; SheetId = $Sid; Steps = @(
                        (New-PlanStep symbol Load @([string]$sym.Name, [string]$sv) -Pos),
                        (New-PlanStep symbol Place @([int]$Sid, [double]$Point[0], [double]$Point[1], [string]'0') -Pos)) }
                    $vs.A = @($vs.Steps)[-1].A
                    $rs = Invoke-PlaceVariant $vs 'place.only.planB.symbol'
                    if ($rs.Ok) {
                        $new = Get-NewOnSheet $devBefore $symBefore
                        if ($new.Sym.Count -gt 0) { Write-PlaceSuccess $Name $vs $new.Dev $new.Sym $SheetName $Sid $Point; return 'placed' }
                    }
                }
            }
        }
        break
    }
    if ($created) {
        if ($script:TempSheetMode) {
            # Режим -PlaceSample: устройство потом удаляется по разнице с исходным списком (lib\namesplace.ps1)
            Write-Human ('! Устройство создано без символа, символ не найден (обозначение «' + $devName + '», компонент «' + $comp + '»). В конце оно будет удалено.') 'Yellow'
            Add-Finding 'note' ('План Б: устройство «' + $devName + '» создано без символа, символ не найден; удаляется в конце размещения образцов.')
        } else {
            Write-Human ('! Устройство создано без символа, символ не найден (обозначение «' + $devName + '», компонент «' + $comp + '»). Режим ничего не удаляет: уберите устройство в E3 сами (Delete или Ctrl+Z).') 'Yellow'
            Add-Finding 'bad' ('План Б: устройство «' + $devName + '» создано без символа, символ не найден; не удалено — уберите вручную.')
        }
        return 'device'
    }
    return 'none'
}

function Step-PlaceOnly {
    param([string]$Name)
    $Name = $Name.Trim().Trim('"').Trim()
    Write-Section 'P' ('Только разместить: «' + $Name + '» на активном листе')
    $blockFile = Resolve-BlockFile $Name
    if ($script:BlockMissing) {
        Write-Human ('✕ файл блока «' + $Name + '» не найден (ни по этому пути, ни рядом со скриптом).') 'Red'
        Add-Finding 'bad' ('Размещение: файл блока «' + $Name + '» не найден; ничего не размещено.'); return
    }
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
    if ($blockFile -ne '') {
        if (-not $script:NoConfirm) {
            Write-Human ('Будет вставлен БЛОК из файла ' + $blockFile + ' на этом листе (несколько устройств, проводов, символов). Больше ничего: не удаляется, проект не сохраняется.') 'Yellow'
            $answer = Read-Host 'Введите Y и нажмите Enter, чтобы вставить (любой другой ответ — выход)'
            if ($answer -ne 'Y' -and $answer -ne 'y') { Write-Human 'Отменено: ничего не изменено.' 'Yellow'; Add-Finding 'note' 'Вставка блока отменена пользователем до изменений.'; return }
        }
        $script:PlaceX = $point[0]; $script:PlaceY = $point[1]; $script:ProbeSheetId = $sid
        [void](Step-PlaceBlockFile $blockFile $sid $point $sheetName)
        return
    }
    if (-not $script:NoConfirm) {
        Write-Human ('Будет размещён ОДИН символ «' + $Name + '» на этом листе. Больше ничего: не удаляется, атрибуты не пишутся, проект не сохраняется.') 'Yellow'
        $answer = Read-Host 'Введите Y и нажмите Enter, чтобы разместить (любой другой ответ — выход)'
        if ($answer -ne 'Y' -and $answer -ne 'y') { Write-Human 'Отменено: ничего не изменено.' 'Yellow'; Add-Finding 'note' 'Размещение отменено пользователем до изменений.'; return }
    }
    $script:PlaceX = $point[0]; $script:PlaceY = $point[1]
    $script:ProbeSheetId = $sid      # Get-SheetSymbols и Invoke-PlaceVariant работают с этим номером; временного листа здесь нет
    $bySymbol = @(Step-PlaceBySymbol $Name $sid $point $sheetName)[-1]
    if ($bySymbol -eq 'placed') { return }
    if ($bySymbol -eq 'notfound') {
        Write-Human ('! Символ «' + $Name + '» не найден в базе символов (Symbol.Load вернул 0 для версий «1» и «»). Пробую запасные планы по компоненту с тем же именем.') 'Yellow'
        Add-Finding 'note' ('Символ «' + $Name + '» не найден в базе символов: Symbol.Load вернул 0.')
    } else {
        Write-Human ('! Символ «' + $Name + '» загружен, но на листе не появился. Пробую запасные планы.') 'Yellow'
        Add-Finding 'note' ('Символ «' + $Name + '»: Symbol.Load прошёл, Symbol.Place не поставил символ на лист.')
    }
    $variants = @(Get-PlaceVariants $Name $point[0] $point[1] $sid -PlaceOnly)
    Write-Human ('Способов размещения к проверке: ' + $variants.Count)
    $tried = @()
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
                Write-PlaceSuccess $Name $v $newDev $newSym $sheetName $sid $point
                return
            }
            if ($newDev.Count -gt 0 -or $created.Count -gt 0) { break }   # что-то создалось без символа: дальше не пробуем, чтобы не плодить
            continue
        }
        if ($created.Count -gt 0) { break }                              # устройство создалось, а символ не встал: не плодим новых
    }
    if (@($script:PlanCtx.Created).Count -eq 0) {
        $planB = @(Step-PlaceDevicePlanB $Name $sid $point $sheetName)[-1]
        if ($planB -eq 'placed') { return }
        if ($planB -eq 'device') { $tried += 'device.Create (план Б)'; Write-Human ''; Write-Human ('✕ символ «' + $Name + '» на листе не размещён.') 'Red'; return }
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
