# Режим -PlaceSample N (вместе с -NamesFile): первые N найденных названий ставятся на ВРЕМЕННЫЙ лист, снимается картинка
# листа, временный лист и всё созданное пробой удаляется. Это единственная часть режима «по списку названий», которая пишет в
# проект, поэтому перед ней — подтверждение Y (без -NoConfirm). Проект не сохраняется.
#   символ  — Symbol.Load + Symbol.Place (Step-PlaceBySymbol из lib\placeonly.ps1);
#   компонент / подсхема — запасные планы из lib\placeplans.ps1 (Job.LoadPart + Sheet.PlacePart, Device.Create + символ, …),
#   затем план Б. Успех — только если на листе появился символ.
# Картинка: те же кандидаты экспорта, что в полной проверке (Sheet.Export / Sheet.ExportImage / Job.ExportPDF);
# в журнале (export.<формат>) видно, какой вызов сработал.

$script:NamesSheetName = '__flux_names__'
$script:LastPlaceLabel = ''
$script:TempSheetMode = $false         # истинно, пока идёт размещение на временном листе: «Отменить вручную» в сообщениях не нужно

function Confirm-KeyY {
    # Клавиша, а не Read-Host: ConsoleKey.Y не зависит от раскладки, а Read-Host при chcp 65001 портит кириллицу (см. e3-probe.ps1).
    param([string]$Prompt)
    Write-Human $Prompt 'Yellow'
    try {
        $k = [Console]::ReadKey($true)
        $ok = ($k.Key -eq [ConsoleKey]::Y) -or (@('Y', 'y', 'Н', 'н', 'Д', 'д') -contains [string]$k.KeyChar)
    } catch {
        $a = ([string](Read-Host 'Введите Y и Enter')).Trim()
        $ok = @('Y', 'y', 'Н', 'н', 'Д', 'д', 'да', 'Да', 'yes') -contains $a
    }
    return $ok
}

function New-NamesSheet {
    # Временный лист того же формата, что активный. Возвращает @{ Id; Name; Orig } или $null. Остатки прошлых запусков с тем же
    # именем удаляются (имя занято только пробой).
    $sh = $script:Objects['Sheet']; $job = $script:Job
    $orig = $null
    $ra = Invoke-Quiet $job 'GetActiveSheetId'
    if ($null -ne $ra -and (Test-Positive $ra)) { $orig = [int]$ra.Ret }
    $format = ''
    if ($null -ne $orig -and (Select-Id $sh $orig)) { $f = Get-QuietValue $sh 'GetFormat'; if ($null -ne $f) { $format = [string]$f } }
    $before = @(Get-Ids 'sheets' 'sheets.list' $job 'job' (Get-SheetIdCands))
    foreach ($id in $before) {
        if (-not (Select-Id $sh $id)) { continue }
        if ([string](Get-QuietValue $sh 'GetName') -eq $script:NamesSheetName) { Write-Human ('Остаток прошлой пробы (лист ' + $id + ') удаляю.'); [void](Remove-Sheet $id 'names.sheet.stale') }
    }
    $before = @(Get-Ids 'sheets' 'sheets.list' $job 'job' (Get-SheetIdCands))
    [void](Invoke-Quiet $sh 'SetId' @(0))
    $c = Try-Calls -Op 'names.sheet.create' -Target $sh -TL 'sheet' -First -Cands @(
        (Cand 'Create' @(0, $script:NamesSheetName, $format, 0, 0)), (Cand 'Create' @(0, $script:NamesSheetName, $format)), (Cand 'Create' @(0, $script:NamesSheetName)))
    $newId = $null
    # Номером нового листа результат считается, только если это число, которого раньше не было: иначе уборка ударила бы по настоящему листу
    if ($c.Ok -and $c.Value -is [ValueType] -and $c.Value -isnot [bool] -and [long]$c.Value -gt 0 -and $before -notcontains $c.Value) { $newId = $c.Value }
    if ($null -eq $newId -and $c.Ok) {
        $diff = @(@(Get-Ids 'sheets' 'sheets.list' $job 'job' (Get-SheetIdCands)) | Where-Object { $before -notcontains $_ })
        if ($diff.Count -gt 0) { $newId = $diff[0] }
    }
    if ($null -eq $newId) { return $null }
    [void](Select-Id $sh $newId)
    return @{ Id = $newId; Name = [string](Get-QuietValue $sh 'GetName'); Orig = $orig }
}

function Get-NamesSlot {
    # Точка k-го образца на ПУСТОМ временном листе: сетка 4 в ряд по рабочему полю (GetDrawingArea), сверху вниз. Образцы не
    # налезают друг на друга и в кадре картинки идут в порядке списка; поля нет — шаг от (100, 100), как в полной проверке.
    param($Sid, [int]$K)
    [void](Use-Sheet $Sid)
    $r = Invoke-Quiet $script:Objects['Sheet'] 'GetDrawingArea' @($null, $null, $null, $null) @(0, 1, 2, 3)
    try {
        $xMin = [double]$r.Args[0]; $yMin = [double]$r.Args[1]; $xMax = [double]$r.Args[2]; $yMax = [double]$r.Args[3]
        $w = $xMax - $xMin; $h = $yMax - $yMin
        if ($w -gt 0 -and $h -gt 0) { return @([math]::Round($xMin + 0.08 * $w + ($K % 4) * 0.22 * $w, 1), [math]::Round($yMax - 0.12 * $h - [math]::Floor($K / 4) * 0.2 * $h, 1)) }
    } catch { }
    return @(($script:PlaceX + ($K % 4) * 60), ($script:PlaceY + [math]::Floor($K / 4) * 60))
}

function Place-NameSample {
    # Один образец на временный лист. Возвращает запись о размещении.
    param($Item, $Sid, [string]$SheetName, [int]$K)
    $name = [string]$Item.name
    $sym = $script:Objects['Symbol']
    $point = Get-NamesSlot $Sid $K
    $script:PlaceX = $point[0]; $script:PlaceY = $point[1]
    $script:PlanCtx = @{ Created = @(); StepsDone = 0 }
    $script:LastPlaceLabel = ''
    $devBefore = @(Get-AllDevices); $symBefore = @(Get-SheetSymbols)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Human ''
    Write-Human ('-- Размещаю «' + $name + '» (' + (Get-NamesKindText $Item) + ') в (' + $point[0] + ', ' + $point[1] + ')')
    $result = 'none'
    if ($Item.kind -eq 'symbol') { $result = @(Step-PlaceBySymbol $name $Sid $point $SheetName)[-1] }
    if ($result -ne 'placed') {
        $variants = @(Get-PlaceVariants $name $point[0] $point[1] $Sid -PlaceOnly)
        foreach ($v in $variants) {
            $dB = @(Get-AllDevices); $sB = @(Get-SheetSymbols)
            $r = Invoke-PlaceVariant $v ('names.place.' + $v.Id)
            $created = @($script:PlanCtx.Created)
            if ($r.Ok) {
                $newSym = @(@(Get-SheetSymbols) | Where-Object { $sB -notcontains $_ })
                $newDev = @(@(Get-AllDevices) | Where-Object { $dB -notcontains $_ })
                if ($newSym.Count -gt 0) { Write-PlaceSuccess $name $v $newDev $newSym $SheetName $Sid $point; $result = 'placed'; break }
                if ($newDev.Count -gt 0 -or $created.Count -gt 0) { break }    # создалось без символа: дальше не плодим
                continue
            }
            if ($created.Count -gt 0) { break }
        }
        if ($result -ne 'placed' -and @($script:PlanCtx.Created).Count -eq 0) {
            $planB = @(Step-PlaceDevicePlanB $name $Sid $point $SheetName)[-1]
            if ($planB -eq 'placed') { $result = 'placed' }
        }
    }
    $newSyms = @(@(Get-SheetSymbols) | Where-Object { $symBefore -notcontains $_ })
    $newDevs = @(@(Get-AllDevices) | Where-Object { $devBefore -notcontains $_ })
    $area = $null
    foreach ($id in $newSyms) {
        if (-not (Select-Id $sym $id)) { continue }
        $a = Invoke-Quiet $sym 'GetPlacedArea' @($null, $null, $null, $null) @(0, 1, 2, 3)
        if ($null -eq $a) { continue }
        try {
            $b = @([double]$a.Args[0], [double]$a.Args[1], [double]$a.Args[2], [double]$a.Args[3])
            if ($null -eq $area) { $area = $b } else { $area = @([math]::Min($area[0], $b[0]), [math]::Min($area[1], $b[1]), [math]::Max($area[2], $b[2]), [math]::Max($area[3], $b[3])) }
        } catch { }
    }
    $ok = ($result -eq 'placed' -and $newSyms.Count -gt 0)
    if ($ok) { Write-Human ('✓ «' + $name + '»: символов на листе ' + $newSyms.Count + ', вызов ' + $script:LastPlaceLabel + ', ' + [math]::Round($sw.Elapsed.TotalMilliseconds, 0) + ' мс') 'Green' }
    else { Write-Human ('✕ «' + $name + '»: на листе не появился символ' + $(if ($newDevs.Count -gt 0) { ' (создано устройств ' + $newDevs.Count + ' — будут удалены в конце)' } else { '' })) 'Yellow' }
    return [ordered]@{ ok = $ok; call = $script:LastPlaceLabel; point = @($point[0], $point[1]); devices = @($newDevs); symbols = @($newSyms); area = $area; ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1) }
}

function Export-NamesSheet {
    # Картинка временного листа: по каждому формату перебираются кандидаты экспорта из описи; побеждает первый, давший непустой файл.
    param($Sid)
    $sh = $script:Objects['Sheet']; $job = $script:Job
    $dir = Join-Path $script:LogDir 'export'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    [void](Use-Sheet $Sid)
    [void](Try-Calls -Op 'names.export.activate' -Target $sh -TL 'sheet' -Cands @((Cand 'Display')) -First -Silent)
    $done = New-Object System.Collections.ArrayList
    foreach ($ext in @('png', 'emf', 'svg', 'pdf')) {
        $path = Join-Path $dir ('names-sheet.' + $ext)
        $seen = @{}; $tried = 0; $lastError = ''; $won = $false
        foreach ($c in @(Get-ExportCandidates $ext $path $sh $job)) {
            $key = $c.L + '.' + $c.M + '(' + (($c.A | ForEach-Object { [string]$_ }) -join ',') + ')'
            if ($seen.ContainsKey($key)) { continue }; $seen[$key] = $true
            if ($c.L -eq 'sheet') { [void](Use-Sheet $Sid) }
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
            $callArgs = $c.A.Clone()
            $action = {
                $r = Invoke-Com -Target $c.T -Name $c.M -CallArgs $callArgs -RefIdx $c.R
                if (-not (Test-Path -LiteralPath $path) -or (Get-Item -LiteralPath $path).Length -eq 0) { throw 'вызов прошёл, но файл не появился' }
                $r
            }
            $tried++
            $r = Invoke-Attempt -Op ('names.export.' + $ext) -Label ($c.L + '.' + $c.M) -ArgsText (Format-Args $c.A @()) -Action $action -Silent
            if (-not $r.Ok) { $lastError = $c.L + '.' + $c.M + ': ' + $r.Record.error; continue }
            $size = (Get-Item -LiteralPath $path).Length
            Write-Human ('✓ картинка листа .' + $ext + ': ' + $c.L + '.' + $c.M + '(' + (Format-Args $c.A @()) + '), ' + $size + ' байт, ' + $r.Record.ms + ' мс -> ' + $path) 'Green'
            [void]$script:ExportResults.Add(@{ Ext = $ext; Call = ($c.L + '.' + $c.M); Size = $size; Ms = $r.Record.ms })   # для раздела «Экспорт листа» сводки
            [void]$done.Add([ordered]@{ ext = $ext; call = ($c.L + '.' + $c.M + '(' + (Format-Args $c.A @()) + ')'); bytes = $size; ms = $r.Record.ms; file = ('export\names-sheet.' + $ext) })
            $won = $true; break
        }
        if (-not $won) { Write-Human ('✕ картинка листа .' + $ext + ': перебрано вариантов ' + $tried + ', файла нет; последняя ошибка — ' + $lastError) 'DarkGray' }
    }
    if ($done.Count -eq 0) { Add-Finding 'need' 'PlaceSample: картинку листа ни одним вызовом экспорта снять не удалось (см. trace.log, export.*).' }
    else { Add-Finding 'ok' ('PlaceSample: картинка листа снята: ' + (($done | ForEach-Object { $_.ext + ' — ' + $_.call }) -join '; ') + '.') }
    return @($done)
}

function Step-NamesPlace {
    param($Found)
    Write-Section 'NP' ('Размещение образцов на временном листе: ' + @($Found).Count)
    if ($script:ProjectNameEarly -eq '') {
        Write-Human 'Размещение требует открытого проекта: откройте КОПИЮ тестового проекта и запустите снова. Чтение по списку выполнено.' 'Yellow'
        Add-Finding 'bad' 'PlaceSample: в E3 не открыт проект, ничего не размещалось.'
        return
    }
    $script:ProjectName = $script:ProjectNameEarly
    if (-not $script:NoConfirm) {
        Write-Human ''
        Write-Human ('Проект в E3: «' + $script:ProjectNameEarly + '»') 'Yellow'
        Write-Human ('Образцов к размещению: ' + @($Found).Count + ' (' + ((@($Found) | ForEach-Object { $_.name }) -join ', ') + ')') 'Yellow'
        Write-Human 'Скрипт создаст временный лист, поставит на него образцы, снимет картинку листа и удалит всё созданное. Проект не сохраняется.' 'Yellow'
        Write-Human 'Подсхемы ставятся через Job.LoadPart: деталь может остаться в списке компонентов проекта — закройте проект БЕЗ сохранения.' 'Yellow'
        Write-Human 'Это тестовый проект или его копия?' 'Yellow'
        if (-not (Confirm-KeyY 'Нажмите клавишу Y (в любой раскладке), чтобы продолжить; любая другая клавиша — выход')) {
            Write-Human 'Отменено: ничего не изменено.' 'Yellow'
            Add-Finding 'note' 'PlaceSample отменён пользователем до изменений.'
            return
        }
    }
    $sh = $script:Objects['Sheet']
    $devStart = @(Get-AllDevices)
    $compStart = (Get-ProjectCount).Components
    $sheet = New-NamesSheet
    if ($null -eq $sheet) { Write-Human '✕ временный лист создать не удалось — размещение пропущено.' 'Red'; Add-Finding 'bad' 'PlaceSample: временный лист создать не удалось.'; return }
    $script:ProbeSheetId = $sheet.Id
    $script:OrigSheetId = $sheet.Orig
    $script:TempSheetMode = $true
    Write-Human ('Временный лист: id ' + $sheet.Id + ', имя «' + $sheet.Name + '»')
    $placed = New-Object System.Collections.ArrayList
    $exports = @()
    try {
        $k = 0
        foreach ($item in @($Found)) {
            $rec = Place-NameSample $item $sheet.Id $sheet.Name $k
            $k++
            $item['placed'] = $rec
            [void]$placed.Add($rec)
        }
        $exports = @(Export-NamesSheet $sheet.Id)
    } finally {
        # Уборка выполняется всегда: и при ошибке, и при Ctrl+C. Удаляется только созданное пробой: устройства, которых не было
        # в начале, и временный лист с её именем.
        $script:TempSheetMode = $false
        $mine = @(@(Get-AllDevices) | Where-Object { $devStart -notcontains $_ })
        if ($mine.Count -gt 0) { Write-Human ('Удаляю созданные пробой устройства: ' + $mine.Count); [void](Remove-DeviceAndSymbols $mine @() 'names.cleanup.device') }
        if ($null -ne $sheet.Orig) { [void](Try-Calls -Op 'names.cleanup.activate' -Target $script:Job -TL 'job' -Cands @((Cand 'SetActiveSheetId' @($sheet.Orig)), (Cand 'ActivateSheet' @($sheet.Orig))) -First -Silent) }
        if ($script:KeepSheet) {
            Write-Human ('Временный лист ОСТАВЛЕН (-KeepSheet): id ' + $sheet.Id + ', имя «' + $script:NamesSheetName + '». Удалите его вручную.') 'Yellow'
            Add-Finding 'note' ('PlaceSample: временный лист оставлен по просьбе (-KeepSheet): удалите лист «' + $script:NamesSheetName + '» вручную.')
        } elseif ((Select-Id $sh $sheet.Id) -and [string](Get-QuietValue $sh 'GetName') -eq $script:NamesSheetName) {
            [void](Remove-Sheet $sheet.Id 'names.cleanup.sheet')
            $left = @(Get-Ids 'sheets' 'sheets.list' $script:Job 'job' (Get-SheetIdCands))
            if ($left -contains $sheet.Id) { Write-Human '! Временный лист не удалён.' 'Yellow'; Add-Finding 'bad' ('PlaceSample: временный лист id ' + $sheet.Id + ' («' + $script:NamesSheetName + '») удалить не удалось: удалите его вручную.') }
            else { Write-Human 'Временный лист удалён.' }
        } else {
            Write-Human '! Лист не выбрался или его имя не наше — не удаляем, чтобы не задеть чужой.' 'Yellow'
            Add-Finding 'bad' ('PlaceSample: временный лист id ' + $sheet.Id + ' не удалён (не удалось убедиться, что он наш): проверьте проект.')
        }
        $devEnd = @(Get-AllDevices).Count
        $compEnd = (Get-ProjectCount).Components
        $script:NamesInfo['placeSample'] = [ordered]@{ requested = @($Found).Count; placed = @($placed | Where-Object { $_.ok }).Count; devicesRemoved = $mine.Count; devicesBefore = $devStart.Count; devicesAfter = $devEnd; componentsBefore = $compStart; componentsAfter = $compEnd; exports = @($exports) }
        if ($devEnd -ne $devStart.Count) { Add-Finding 'bad' ('PlaceSample: число устройств в проекте изменилось: было ' + $devStart.Count + ', стало ' + $devEnd + '. Проверьте проект.'); Write-Human ('! Устройств было ' + $devStart.Count + ', стало ' + $devEnd) 'Yellow' }
        else { Write-Human ('Число устройств в проекте то же: ' + $devEnd) }
        if ($compStart -ge 0 -and $compEnd -gt $compStart) { Add-Finding 'note' ('PlaceSample: в списке компонентов проекта прибавилось ' + ($compEnd - $compStart) + ' (подгружено при вставке подсхем): закройте проект без сохранения.'); Write-Human ('! Компонентов в проекте было ' + $compStart + ', стало ' + $compEnd + ': закройте проект без сохранения.') 'Yellow' }
        Write-Human 'Проект НЕ сохранялся.'
        Save-NamesReport
    }
    $okCount = @($placed | Where-Object { $_.ok }).Count
    Write-Human ''
    Write-Human ('ИТОГ размещения: поставлено ' + $okCount + ' из ' + @($Found).Count + '; картинок листа: ' + $exports.Count) 'Green'
    [void]$script:NamesSummary.Add('Размещение образцов на временном листе: поставлено ' + $okCount + ' из ' + @($Found).Count + '; картинок листа: ' + $exports.Count + $(if ($exports.Count -gt 0) { ' (' + (($exports | ForEach-Object { $_.ext + ' — ' + $_.call }) -join '; ') + ')' } else { '' }))
    foreach ($item in @($Found)) {
        $p = $item['placed']
        [void]$script:NamesSummary.Add('  ' + $item.name + ': ' + $(if ($p.ok) { 'поставлено, ' + $p.call } else { 'не поставлено' }))
    }
    Add-Finding $(if ($okCount -gt 0) { 'ok' } else { 'need' }) ('PlaceSample: поставлено ' + $okCount + ' из ' + @($Found).Count + ', временный лист удалён, картинок листа ' + $exports.Count + '.')
}
