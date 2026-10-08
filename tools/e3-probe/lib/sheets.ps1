# Раздел 2 и F: листы, формат, рабочее поле, единицы, временный лист, размеры проекта.

$script:ProbeSheetName = '__flux_probe__'
$script:ProbeSheetId = $null
$script:OrigSheetId = $null
$script:OrigFormat = ''
$script:SheetsList = @()

function Use-Sheet {
    param($Id)
    return (Invoke-Quiet $script:Objects['Sheet'] 'SetId' @($Id))
}

function Get-SheetIdCands {
    return @(
        (Cand 'GetSheetIds' @($null) @(0)), (Cand 'GetSheetIds' @($null, 0) @(0)), (Cand 'GetAllSheetIds' @($null) @(0)),
        (Cand 'GetSheetList' @($null) @(0)), (Cand 'GetSheetCount')
    )
}

function Get-UnitGuess {
    # По размеру рабочего поля угадываем единицы: сравниваем с форматами А4…А0 в мм, 0,1 мм и дюймах.
    param([double]$Width, [double]$Height)
    $formats = @(@('A4', 297, 210), @('A3', 420, 297), @('A2', 594, 420), @('A1', 841, 594), @('A0', 1189, 841))
    $factors = @(@('мм', 1.0), @('0,1 мм', 10.0), @('0,01 мм', 100.0), @('дюймы', (1 / 25.4)), @('мкм', 1000.0))
    $w = [math]::Max($Width, $Height); $h = [math]::Min($Width, $Height)
    $best = $null; $bestErr = 9.0
    foreach ($f in $formats) {
        foreach ($k in $factors) {
            $fw = $f[1] * $k[1]; $fh = $f[2] * $k[1]
            # рабочее поле меньше листа на рамку, поэтому допускаем отклонение вниз
            $err = [math]::Abs($w / $fw - 0.93) + [math]::Abs($h / $fh - 0.93)
            if ($err -lt $bestErr) { $bestErr = $err; $best = ($k[0] + ', формат около ' + $f[0]) }
        }
    }
    if ($bestErr -gt 0.5) { return 'не определились' }
    return $best
}

function Describe-Sheet {
    param([string]$Op, $Id, [string]$Title)
    $sh = $script:Objects['Sheet']
    if ($null -eq $sh) { return $null }
    [void](Use-Sheet $Id)
    $cands = @()
    foreach ($n in @('GetName', 'GetFormat', 'GetFormatName', 'GetSheetFormat', 'GetFormatId', 'GetAssignment', 'GetLocation', 'GetScale', 'GetSheetScale', 'GetGrid', 'GetGridSize', 'GetGridX', 'GetGridY', 'GetUnit', 'GetUnits', 'GetOrientation', 'GetWidth', 'GetHeight', 'IsLocked', 'GetSheetNumber', 'GetPosition', 'GetFormatNames')) { $cands += , (Cand $n) }
    $cands += , (Cand 'GetFormat' @($null, $null) @(0, 1))
    $cands += , (Cand 'GetFormatSize' @($null, $null) @(0, 1))
    $cands += , (Cand 'GetSize' @($null, $null) @(0, 1))
    $cands += , (Cand 'GetDrawingArea' @($null, $null, $null, $null) @(0, 1, 2, 3))
    $cands += , (Cand 'GetArea' @($null, $null, $null, $null) @(0, 1, 2, 3))
    $cands += , (Cand 'GetWorkArea' @($null, $null, $null, $null) @(0, 1, 2, 3))
    $cands += , (Cand 'GetSheetArea' @($null, $null, $null, $null) @(0, 1, 2, 3))
    $cands += , (Cand 'GetGrid' @($null, $null) @(0, 1))
    $cands += , (Cand 'GetSymbolIds' @($null) @(0))
    $cands += , (Cand 'GetSymbolIds' @($null, 0) @(0))
    $cands += , (Cand 'GetGraphIds' @($null) @(0))
    $cands += , (Cand 'GetTextIds' @($null) @(0))
    $cands += , (Cand 'GetNetSegmentIds' @($null) @(0))
    $cands += , (Cand 'GetDeviceIds' @($null) @(0))
    $cands += , (Cand 'GetAllIds' @($null) @(0))
    Write-Human ('-- ' + $Title)
    return (Try-Calls -Op $Op -Target $sh -TL 'sheet' -Cands $cands)
}

function Step-Sheets {
    Write-Section '2' 'Листы, формат, рабочее поле, единицы'
    $job = $script:Job
    $sh = $script:Objects['Sheet']
    if ($null -eq $sh) { Add-Finding 'bad' 'Объект листа (CreateSheetObject) создать не удалось: листы недоступны.'; return $false }

    $script:SheetsList = @(Get-Ids 'sheets' 'sheets.list' $job 'job' (Get-SheetIdCands))
    Write-Human ('Листов в проекте: ' + $script:SheetsList.Count)
    Add-Finding 'ok' ('Листов в проекте: ' + $script:SheetsList.Count)

    $activeCands = @((Cand 'GetActiveSheetId'), (Cand 'GetActiveSheet'), (Cand 'GetCurrentSheetId'), (Cand 'GetSelectedSheetId'), (Cand 'GetActiveSheetId' @($null) @(0)))
    $active = Try-Calls -Op 'sheets.active' -Target $job -TL 'job' -Cands $activeCands
    $activeId = $null
    foreach ($w in $active.Wins) { if ($w.Value -is [ValueType] -and [long]$w.Value -gt 0) { $activeId = $w.Value; break } }
    if ($null -eq $activeId -and $script:SheetsList.Count -gt 0) { $activeId = $script:SheetsList[0] }
    $script:OrigSheetId = $activeId
    $script:Env['activeSheetId'] = $activeId

    if ($null -ne $activeId) {
        $d = Describe-Sheet 'sheets.describe' $activeId ('Активный лист ' + $activeId)
        $fmt = ''
        foreach ($w in $d.Wins) { if ($w.Label -match 'GetFormat$|GetFormatName$|GetSheetFormat$' -and $w.Value -is [string] -and $w.Value -ne '') { $fmt = $w.Value; break } }
        $script:OrigFormat = $fmt
        $area = $null
        foreach ($w in $d.Wins) {
            if ($w.Label -match 'GetDrawingArea$|GetArea$|GetWorkArea$|GetSheetArea$' -and $w.Out.Count -eq 4 -and $null -ne $w.Out[0]) { $area = $w.Out; break }
        }
        if ($null -ne $area) {
            $aw = [math]::Abs([double]$area[2] - [double]$area[0]); $ah = [math]::Abs([double]$area[3] - [double]$area[1])
            $guess = Get-UnitGuess $aw $ah
            $script:Env['sheetFormat'] = $fmt
            $script:Env['drawingArea'] = @($area | ForEach-Object { [double]$_ })
            $script:Env['unitsGuess'] = $guess
            Write-Human ('Рабочее поле: ' + (($area | ForEach-Object { $_ }) -join ', ') + ' (' + [math]::Round($aw, 1) + ' x ' + [math]::Round($ah, 1) + '), единицы: ' + $guess)
            Add-Finding 'ok' ('Рабочее поле листа ' + [math]::Round($aw, 1) + ' x ' + [math]::Round($ah, 1) + ', единицы по размеру: ' + $guess + '; формат «' + $fmt + '».')
        } else { Add-Finding 'need' 'Рабочее поле листа (GetDrawingArea и аналоги) прочитать не удалось.' }
    } else { Add-Finding 'note' 'В проекте нет листов: формат активного листа взять негде.' }

    # --- остаток прошлой пробы
    $stale = 0
    foreach ($id in $script:SheetsList) {
        [void](Use-Sheet $id)
        $n = Get-QuietValue $sh 'GetName'
        if ($n -eq $script:ProbeSheetName) {
            $stale++
            [void](Remove-Sheet $id 'sheets.stale.delete')
        }
    }
    Write-Human ('Остатков прошлой пробы (__flux_probe__): ' + $stale)
    if ($stale -gt 0) { Add-Finding 'note' ('Удалён остаток прошлой пробы: листов ' + $stale) }

    # --- временный лист
    $before = @(Get-Ids 'sheets' 'sheets.list' $job 'job' (Get-SheetIdCands))
    $format = $script:OrigFormat
    $createCands = @(
        (Cand 'Create' @(0, $script:ProbeSheetName, $format, 0, 0)),
        (Cand 'Create' @(0, $script:ProbeSheetName, $format)),
        (Cand 'Create' @(0, $script:ProbeSheetName)),
        (Cand 'CreateSheet' @(0, $script:ProbeSheetName, $format)),
        (Cand 'Add' @($script:ProbeSheetName, $format))
    )
    [void](Invoke-Quiet $sh 'SetId' @(0))
    $c = Try-Calls -Op 'sheets.create' -Target $sh -TL 'sheet' -Cands $createCands -First
    if (-not $c.Ok) {
        # запасной путь: создание у проекта
        $c = Try-Calls -Op 'sheets.create' -Target $job -TL 'job' -Cands @((Cand 'CreateSheet' @($script:ProbeSheetName, $format)), (Cand 'AddSheet' @($script:ProbeSheetName, $format)), (Cand 'CreateSheet' @(0, $script:ProbeSheetName, $format))) -First
    }
    $newId = $null
    # Результат вызова считаем номером нового листа, только если это число, а не признак успеха, и такого листа раньше не было:
    # иначе уборка в конце удалила бы настоящий лист с номером 1.
    if ($c.Ok -and $c.Value -is [ValueType] -and $c.Value -isnot [bool] -and [long]$c.Value -gt 0 -and $before -notcontains $c.Value) { $newId = $c.Value }
    if ($null -eq $newId -and $c.Ok) {
        $after = @(Get-Ids 'sheets' 'sheets.list' $job 'job' (Get-SheetIdCands))
        $diff = @($after | Where-Object { $before -notcontains $_ })
        if ($diff.Count -gt 0) { $newId = $diff[0] }
    }
    if ($null -ne $newId) {
        [void](Use-Sheet $newId)
        $name = Get-QuietValue $sh 'GetName'
        $script:ProbeSheetId = $newId
        Write-Human ('Временный лист создан: id ' + $newId + ', имя «' + $name + '»')
        if ($name -ne $script:ProbeSheetName) {
            Add-Finding 'note' ('Имя временного листа в E3: «' + $name + '» вместо «' + $script:ProbeSheetName + '». Остаток найти по id ' + $newId + '.')
        }
        $d = Describe-Sheet 'sheets.describe.probe' $newId 'Временный лист'
        Add-Finding 'ok' 'Временный лист создан и удалён в конце (если не указан -KeepSheet).'
    } else {
        Add-Finding 'bad' 'Временный лист создать не удалось: проверки вставки, текстов и графики пропущены.'
        return $false
    }

    # --- список форматов и смена формата
    $fcands = @((Cand 'GetFormats' @($null) @(0)), (Cand 'GetFormatNames' @($null) @(0)), (Cand 'GetSheetFormats' @($null) @(0)), (Cand 'GetFormatList' @($null) @(0)), (Cand 'GetFormatCount'))
    $fr = Try-Calls -Op 'sheets.formats.job' -Target $job -TL 'job' -Cands $fcands
    $fr2 = Try-Calls -Op 'sheets.formats.sheet' -Target $sh -TL 'sheet' -Cands $fcands
    $formatNames = @()
    foreach ($r in @($fr, $fr2)) { if ($null -ne $r.Items -and $r.Items.Count -gt 0) { $formatNames = @($r.Items); break } }
    if ($formatNames.Count -gt 0) {
        Write-Human ('Форматов листа: ' + $formatNames.Count + ': ' + (($formatNames | Select-Object -First 12) -join ', '))
        Add-Finding 'ok' ('Список форматов листа читается (' + $formatNames.Count + ').')
    } else { Add-Finding 'need' 'Список форматов листа получить не удалось.' }
    $target = $format
    foreach ($f in $formatNames) { if ("$f" -ne $format) { $target = [string]$f; break } }
    [void](Use-Sheet $newId)
    $setCands = @((Cand 'SetFormat' @($target)), (Cand 'SetFormat' @($target, 0)), (Cand 'SetSheetFormat' @($target)), (Cand 'ChangeFormat' @($target)), (Cand 'SetFormatName' @($target)))
    $sf = Try-Calls -Op 'sheets.format.set' -Target $sh -TL 'sheet' -Cands $setCands -First
    if ($sf.Ok) {
        $back = Get-QuietValue $sh 'GetFormat'
        Write-Human ('Формат временного листа после смены: «' + $back + '»')
    }
    return $true
}

function Remove-Sheet {
    param($Id, [string]$Op = 'sheets.delete')
    $sh = $script:Objects['Sheet']
    # Если id не встал в обёртку, Delete ударил бы по листу, выбранному раньше (возможно, настоящему).
    if (-not (Select-Id $sh $Id)) { Write-Human ('! Лист ' + $Id + ' выбрать не удалось — не удаляем, чтобы не задеть чужой.') 'Yellow'; return $false }
    $r = Try-Calls -Op $Op -Target $sh -TL 'sheet' -Cands @((Cand 'Delete'), (Cand 'Delete' @(0)), (Cand 'Remove')) -First
    if (-not $r.Ok) { $r = Try-Calls -Op $Op -Target $script:Job -TL 'job' -Cands @((Cand 'DeleteSheet' @($Id)), (Cand 'RemoveSheet' @($Id))) -First }
    return $r.Ok
}

function Step-Activate {
    # Раздел C: перейти на лист и вернуть всё, как было.
    Write-Section 'C1' 'Активный лист и обновление вида'
    if ($null -eq $script:ProbeSheetId) { return }
    $job = $script:Job; $sh = $script:Objects['Sheet']
    [void](Use-Sheet $script:ProbeSheetId)
    $a = Try-Calls -Op 'ui.activate.sheet' -Target $sh -TL 'sheet' -Cands @((Cand 'Activate'), (Cand 'SetActive'), (Cand 'Display'), (Cand 'Show'), (Cand 'Select'), (Cand 'Open'), (Cand 'Jump')) -First
    $b = Try-Calls -Op 'ui.activate.job' -Target $job -TL 'job' -Cands @((Cand 'SetActiveSheetId' @($script:ProbeSheetId)), (Cand 'ActivateSheet' @($script:ProbeSheetId)), (Cand 'SetActiveSheet' @($script:ProbeSheetId)), (Cand 'DisplaySheet' @($script:ProbeSheetId)), (Cand 'OpenSheet' @($script:ProbeSheetId))) -First
    $now = Get-QuietValue $job 'GetActiveSheetId'
    Write-Human ('Активный лист после перехода: ' + (Format-Value $now))
    $script:Env['activateWorks'] = ($a.Ok -or $b.Ok)
    $refresh = Try-Calls -Op 'ui.refresh' -Target $script:App -TL 'app' -Cands @((Cand 'Refresh'), (Cand 'UpdateView'), (Cand 'Update'), (Cand 'RefreshView'), (Cand 'Redraw'), (Cand 'UpdateScreen')) -First
    $refresh2 = Try-Calls -Op 'ui.refresh.job' -Target $job -TL 'job' -Cands @((Cand 'Refresh'), (Cand 'UpdateView'), (Cand 'Redraw'), (Cand 'UpdateScreen'), (Cand 'RefreshView')) -First
    if ($null -ne $script:OrigSheetId) {
        $back = Try-Calls -Op 'ui.activate.restore' -Target $job -TL 'job' -Cands @((Cand 'SetActiveSheetId' @($script:OrigSheetId)), (Cand 'ActivateSheet' @($script:OrigSheetId)), (Cand 'SetActiveSheet' @($script:OrigSheetId))) -First
        if (-not $back.Ok) { [void](Use-Sheet $script:OrigSheetId); [void](Try-Calls -Op 'ui.activate.restore' -Target $sh -TL 'sheet' -Cands @((Cand 'Activate'), (Cand 'SetActive'), (Cand 'Display')) -First) }
    }
}

function Step-ProjectSize {
    # Раздел F: сколько чего в проекте — для оценки скорости чтения.
    Write-Section 'F' 'Проект: размеры, режим, блокировки'
    $job = $script:Job
    $counts = [ordered]@{}
    $counts['листов'] = $script:SheetsList.Count
    $dev = @(Get-Ids 'devices' 'project.devices' $job 'job' (Get-DeviceIdCands))
    $counts['устройств'] = $dev.Count
    $script:DeviceIds = $dev
    foreach ($pair in @(@('кабелей', 'GetCableIds'), @('цепей', 'GetNetIds'), @('сигналов', 'GetSignalIds'), @('символов', 'GetAllSymbolIds'), @('соединений', 'GetAllConnectionIds'), @('блоков', 'GetBlockIds'), @('групп', 'GetGroupIds'), @('текстов', 'GetTextIds'), @('графики', 'GetGraphIds'))) {
        $ids = @(Get-Ids ('count.' + $pair[1]) ('project.count.' + $pair[0]) $job 'job' @((Cand $pair[1] @($null) @(0)), (Cand $pair[1] @($null, 0) @(0)), (Cand ($pair[1] -replace 'Ids$', 'Count'))))
        $counts[$pair[0]] = $ids.Count
    }
    $script:Env['projectCounts'] = $counts
    Write-Human ('Размер проекта: ' + (($counts.Keys | ForEach-Object { $_ + ' ' + $counts[$_] }) -join ', '))
    Add-Finding 'ok' ('Размер проекта: ' + (($counts.Keys | ForEach-Object { $_ + ' ' + $counts[$_] }) -join ', ') + '.')

    $modeCands = @()
    foreach ($n in @('IsReadOnly', 'GetReadOnly', 'IsWritable', 'IsLocked', 'GetLockInfo', 'GetLockedBy', 'GetUser', 'GetUserName', 'GetMode', 'GetAccessMode', 'IsMultiUser', 'GetMultiUserMode', 'IsShared', 'GetSharedMode', 'IsModified', 'GetModified', 'GetUnits', 'GetUnit', 'GetMeasurementUnits', 'GetLengthUnit', 'GetGrid', 'GetGridSize', 'GetGridStep')) { $modeCands += , (Cand $n) }
    $modeCands += , (Cand 'GetGrid' @($null, $null) @(0, 1))
    $m = Try-Calls -Op 'project.mode' -Target $job -TL 'job' -Cands $modeCands
    $ro = $null
    foreach ($w in $m.Wins) { if ($w.Label -match 'IsReadOnly$|GetReadOnly$') { $ro = $w.Value } }
    if ($null -ne $ro) {
        if ([bool]$ro) { Add-Finding 'bad' 'Проект открыт только на чтение: запись в него из Flux невозможна.' } else { Add-Finding 'ok' 'Проект открыт на запись.' }
    } else { Add-Finding 'note' 'Открыт ли проект на запись, определить не удалось.' }
}
