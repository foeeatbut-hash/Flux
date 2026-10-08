# Разделы 5-7 и D: вставка решения на временный лист, что появилось, обозначения, выводы и провода.

$script:Kept = $null            # @{ Devices; Symbols; Variant } — вставка, на которой идут остальные проверки
$script:WinVariantId = $null
$script:PlaceX = 100
$script:PlaceY = 100

function Get-DevObj { return $script:Objects['Device'] }

function Get-SheetSymbols {
    $sh = $script:Objects['Sheet']
    if ($null -eq $script:ProbeSheetId -or $null -eq $sh) { return @() }
    [void](Use-Sheet $script:ProbeSheetId)
    return @(Get-Ids 'sheet.symbols' 'place.sheet.symbols' $sh 'sheet' @((Cand 'GetSymbolIds' @($null) @(0)), (Cand 'GetSymbolIds' @($null, 0) @(0)), (Cand 'GetAllSymbolIds' @($null) @(0))))
}

function Get-AllDevices {
    return @(Get-Ids 'devices' 'project.devices' $script:Job 'job' (Get-DeviceIdCands))
}

function Get-DeviceDetails {
    param($Id, [string]$Title)
    $dev = Get-DevObj
    if ($null -eq $dev) { return }
    [void](Invoke-Quiet $dev 'SetId' @($Id))
    $cands = @()
    foreach ($n in @('GetName', 'GetDeviceName', 'GetAssignment', 'GetLocation', 'GetDeviceDesignation', 'GetComponentName', 'GetGateName', 'GetDeviceType', 'GetType', 'IsBlock', 'IsSubCircuit', 'GetBlockId', 'GetSheetId', 'GetPinCount', 'GetSymbolCount')) { $cands += , (Cand $n) }
    $cands += , (Cand 'GetAttributeValue' @('GLOBAL_ID_IN_PROJECT'))
    $cands += , (Cand 'GetAttributeValue' @('Device Designation'))
    $cands += , (Cand 'GetSymbolIds' @($null) @(0))
    $cands += , (Cand 'GetSymbolIds' @($null, 0) @(0))
    $cands += , (Cand 'GetPinIds' @($null) @(0))
    $cands += , (Cand 'GetAllPinIds' @($null) @(0))
    $cands += , (Cand 'GetExternalPinIds' @($null) @(0))
    Write-Human ('-- ' + $Title + ' id ' + $Id)
    return (Try-Calls -Op 'place.device.read' -Target $dev -TL 'device' -Cands $cands)
}

function Get-SymbolDetails {
    param($Id, [string]$Title)
    $sym = $script:Objects['Symbol']
    if ($null -eq $sym) { return }
    [void](Invoke-Quiet $sym 'SetId' @($Id))
    $cands = @()
    foreach ($n in @('GetName', 'GetDeviceId', 'GetSheetId', 'GetRotation', 'GetMirror', 'GetType', 'GetSymbolType', 'GetPinCount')) { $cands += , (Cand $n) }
    $cands += , (Cand 'GetSchemaLocation' @($null, $null, $null) @(0, 1, 2))
    $cands += , (Cand 'GetSchemaLocation' @($null, $null) @(0, 1))
    $cands += , (Cand 'GetLocation' @($null, $null) @(0, 1))
    $cands += , (Cand 'GetPlacement' @($null, $null) @(0, 1))
    $cands += , (Cand 'GetPinIds' @($null) @(0))
    $cands += , (Cand 'GetPinIds' @($null, 0) @(0))
    $cands += , (Cand 'GetGraphIds' @($null) @(0))
    $cands += , (Cand 'GetTextIds' @($null) @(0))
    $cands += , (Cand 'GetArea' @($null, $null, $null, $null) @(0, 1, 2, 3))
    Write-Human ('-- ' + $Title + ' id ' + $Id)
    return (Try-Calls -Op 'place.symbol.read' -Target $sym -TL 'symbol' -Cands $cands)
}

function Remove-DeviceAndSymbols {
    param($DeviceIds, $SymbolIds, [string]$Op)
    $dev = Get-DevObj; $sym = $script:Objects['Symbol']
    $ok = $true
    foreach ($id in @($DeviceIds)) {
        # Не выбрался id — Delete ударил бы по устройству, выбранному раньше, а оно может быть настоящим.
        if (-not (Select-Id $dev $id)) { $ok = $false; continue }
        $r = Try-Calls -Op $Op -Target $dev -TL 'device' -Cands @((Cand 'Delete'), (Cand 'Delete' @(0)), (Cand 'Remove')) -First
        if (-not $r.Ok) { $r = Try-Calls -Op $Op -Target $script:Job -TL 'job' -Cands @((Cand 'DeleteDevice' @($id)), (Cand 'RemoveDevice' @($id))) -First }
        if (-not $r.Ok) { $ok = $false }
    }
    if (@($DeviceIds).Count -eq 0) {
        foreach ($id in @($SymbolIds)) {
            if (-not (Select-Id $sym $id)) { $ok = $false; continue }
            $r = Try-Calls -Op $Op -Target $sym -TL 'symbol' -Cands @((Cand 'Delete'), (Cand 'Delete' @(0)), (Cand 'Remove')) -First
            if (-not $r.Ok) { $ok = $false }
        }
    }
    return $ok
}

# Решение по умолчанию есть не в каждой базе. Если заданного нет (или оно не вставилось), берём первое работающее из запасных
# и пишем в сводке, какое взято. Имена — компоненты, которые у владельца точно есть в проекте.
$script:FallbackSolutions = @('клапан_DIx2_DOx2', 'датчик_DI_условный_ДГП_2')
$script:RequestedSolution = ''
$script:SolutionNote = ''

function Step-Place {
    Write-Section '5' ('Вставка решения «' + $script:SolutionName + '» на временный лист в точку (' + $script:PlaceX + ',' + $script:PlaceY + ')')
    if ($null -eq $script:ProbeSheetId) { Write-Human 'Нет временного листа — пропущено.'; return }
    $script:RequestedSolution = $script:SolutionName
    $names = @($script:SolutionName) + @($script:FallbackSolutions | Where-Object { $_ -ne $script:SolutionName })
    # Последним — любой компонент проекта с известным символом: так проверяются сами вызовы вставки, даже если ни одного
    # из названных решений в проекте нет.
    $sample = Get-SampleComponent
    if ($null -ne $sample -and $names -notcontains $sample.Name) { $names += $sample.Name }
    foreach ($candidate in $names) {
        $script:SolutionName = $candidate
        if ($candidate -ne $script:RequestedSolution) { Write-Human ('Заданное «' + $script:RequestedSolution + '» вставить не удалось, пробую запасное «' + $candidate + '».') 'Yellow' }
        Invoke-PlaceSolution
        if ($null -ne $script:Kept) { break }
    }
    if ($null -ne $script:Kept -and $script:SolutionName -ne $script:RequestedSolution) {
        $script:SolutionNote = 'Заданное решение «' + $script:RequestedSolution + '» не нашлось или не вставилось; для проверки вставки взято запасное «' + $script:SolutionName + '».'
        Add-Finding 'note' $script:SolutionNote
        Write-Human ('→ ' + $script:SolutionNote) 'Yellow'
    }
    if ($null -eq $script:Kept) {
        Add-Finding 'bad' ('Вставить решение не удалось ни одним способом; пробовали: ' + ($names -join ', ') + '. Проверьте имена (-SolutionName) и журнал log.txt, раздел 5.')
    }
}

function Invoke-PlaceSolution {
    # Все способы вставки одного решения (имя в $script:SolutionName); удачный результат остаётся в $script:Kept.
    $variants = Get-PlaceVariants $script:SolutionName $script:PlaceX $script:PlaceY
    foreach ($v in $variants) {
        $op = 'place.' + $v.Id
        # снимок «до» — перед каждым способом: прошлый способ мог оставить своё
        $devBefore = @(Get-AllDevices); $symBefore = @(Get-SheetSymbols)
        $r = Invoke-PlaceVariant $v $op
        if (-not $r.Ok) {
            # План мог дойти до создания устройства и упасть позже: убираем только то, что появилось в этой попытке.
            $orphans = @(@(Get-AllDevices) | Where-Object { $devBefore -notcontains $_ })
            if ($orphans.Count -gt 0) {
                $gone = Remove-DeviceAndSymbols $orphans @() ($op + '.orphan')
                Write-Human ('  · неудачная попытка оставила устройств: ' + $orphans.Count + ', убраны: ' + $gone) 'DarkGray'
                $script:Failed.Remove($op + '.orphan') | Out-Null
            }
            continue
        }
        $devAfter = @(Get-AllDevices); $symAfter = @(Get-SheetSymbols)
        $newDev = @($devAfter | Where-Object { $devBefore -notcontains $_ })
        $newSym = @($symAfter | Where-Object { $symBefore -notcontains $_ })
        $ret = $r.Value.Ret
        $text = 'вернул ' + (Format-Value $ret 60) + '; новых устройств ' + $newDev.Count + ', новых символов ' + $newSym.Count
        # Вставка состоялась, только если на листе появился символ. Устройство без символа (Device.Create сам по себе) — это
        # полуфабрикат: записываем его отдельной заметкой и убираем.
        $effect = ($newSym.Count -gt 0)
        $partial = (-not $effect -and $newDev.Count -gt 0)
        if ($partial) {
            Add-Finding 'note' ('Вызов ' + $v.Label + ' создаёт устройство без символа на листе (устройств ' + $newDev.Count + '): чтобы устройство появилось на схеме, нужен ещё Symbol.Load + Symbol.Place.')
            $gone = Remove-DeviceAndSymbols $newDev @() ($op + '.partial')
            $script:Failed.Remove($op + '.partial') | Out-Null
            if (-not $gone) { Write-Human '! Устройство без символа убрать не удалось: останется в проекте до закрытия без сохранения.' 'Yellow' }
        }
        $rec = [ordered]@{ seq = 0; step = $script:Step; op = $op + '.effect'; candidate = $v.Label; args = ''; ok = $effect; type = $null; result = $text; error = $(if ($effect) { $null } elseif ($partial) { 'создано устройство без символа, на листе ничего не появилось' } else { 'вызов прошёл, но на листе ничего не появилось' }); hresult = $null; busy = $false; ms = $r.Record.ms }
        $script:Seq++; $rec.seq = $script:Seq; Add-Record $rec
        if ($effect) {
            if (-not $script:Winners.Contains($op + '.effect')) { $script:Winners[$op + '.effect'] = New-Object System.Collections.ArrayList }
            [void]$script:Winners[$op + '.effect'].Add($v.Label)
        }
        Write-Human ('{0} {1}: {2}' -f $(if ($effect) { '✓' } else { '✕' }), $op, $text) $(if ($effect) { 'Green' } else { 'DarkGray' })
        if (-not $effect) { continue }
        foreach ($d in $newDev) { [void](Get-DeviceDetails $d 'Устройство после вставки') }
        foreach ($s in $newSym) { [void](Get-SymbolDetails $s 'Символ после вставки') }
        if ($null -eq $script:Kept) {
            $script:Kept = @{ Devices = $newDev; Symbols = $newSym; Variant = $v }
            $script:WinVariantId = $v.Id
            Add-Finding 'ok' ('Вставка на лист работает: ' + $v.Label + '(' + (Format-Args $v.A @()) + '), ' + $r.Record.ms + ' мс; появилось устройств ' + $newDev.Count + ', символов ' + $newSym.Count + '.')
        } else {
            # остальные способы проверяем так же, но вставленное сразу убираем
            $removed = Remove-DeviceAndSymbols $newDev $newSym ($op + '.cleanup')
            if (-not $removed) { Write-Human '! Убрать вставленное не удалось: останется на временном листе и уйдёт вместе с ним.' 'Yellow' }
            $script:Failed.Remove($op + '.cleanup') | Out-Null
        }
    }
}

function Step-PlacedAttributes {
    # Раздел 3 (продолжение): атрибуты на устройстве, символе, пине, блоке — на вставленном временном объекте.
    Write-Section '3b' 'Атрибуты на устройстве, пине, блоке (временные объекты)'
    if ($null -eq $script:Kept) { Write-Human 'Нет вставленного устройства — пропущено.'; return }
    $dev = Get-DevObj
    if ($null -eq $dev -or @($script:Kept.Devices).Count -eq 0) { Write-Human 'Вставка не создала устройства: проверка на устройстве пропущена.'; return }
    $id = @($script:Kept.Devices)[0]
    foreach ($name in ($script:FluxAttrs + @($script:UndefinedAttr, 'Device Designation'))) {
        $res = Test-AttributeRW $dev 'device' 'attr.device' $name 'Устройство' { [void](Invoke-Quiet (Get-DevObj) 'SetId' @($id)) }
        Write-Human ('Устройство / ' + $name + ': чтение ' + $res.read + ', запись ' + $res.write + ', возврат ' + $res.restored + $(if ($res.read) { ' (было «' + $res.before + '»)' } else { '' }))
    }
    $blk = $script:Objects['Block']
    if ($null -ne $blk) {
        foreach ($name in @('FLUX_BLOCK', 'FLUX_VER', 'GLOBAL_BLOCK_ID')) {
            $res = Test-AttributeRW $blk 'block' 'attr.block' $name 'Блок' { [void](Invoke-Quiet $script:Objects['Block'] 'SetId' @($id)) }
            Write-Human ('Блок / ' + $name + ': чтение ' + $res.read + ', запись ' + $res.write + ', возврат ' + $res.restored)
        }
    } else { Write-Human '· объекта блока (CreateBlockObject) нет: блок в E3 — то же устройство; атрибуты блока проверены как атрибуты устройства.' }
    $pins = Get-PlacedPins
    if ($pins.Count -gt 0) {
        $pin = $script:Objects['Pin']
        $pid1 = $pins[0]
        foreach ($name in @('FLUX_ID', '!Pin_OpisaniePR_tip_signala', $script:UndefinedAttr)) {
            $res = Test-AttributeRW $pin 'pin' 'attr.pin' $name 'Пин' { [void](Invoke-Quiet $script:Objects['Pin'] 'SetId' @($pid1)) }
            Write-Human ('Пин / ' + $name + ': чтение ' + $res.read + ', запись ' + $res.write + ', возврат ' + $res.restored)
        }
    }
    $fluxBad = @()
    foreach ($name in @('FLUX_ID', 'FLUX_BLOCK', 'FLUX_VER')) {
        $ok = $false
        foreach ($rec in $script:Records) { if ($rec.op -eq 'attr.device.write' -and $rec.args -like ('*' + $name + '*') -and $rec.ok) { $ok = $true; break } }
        if (-not $ok) { $fluxBad += $name }
    }
    if ($fluxBad.Count -gt 0) { Add-Finding 'need' ('На устройстве не записались атрибуты: ' + ($fluxBad -join ', ') + ' — заведите их в базе E3 (носитель «Изделие», для блока — «Блок»).') }
    else { Add-Finding 'ok' 'FLUX_ID, FLUX_BLOCK, FLUX_VER на устройстве пишутся.' }
}

function Get-PlacedPins {
    if ($null -eq $script:Kept) { return @() }
    $pins = @()
    $dev = Get-DevObj; $sym = $script:Objects['Symbol']
    foreach ($id in @($script:Kept.Devices)) {
        [void](Invoke-Quiet $dev 'SetId' @($id))
        $r = Try-Calls -Op 'wires.pins.device' -Target $dev -TL 'device' -Cands @((Cand 'GetPinIds' @($null) @(0)), (Cand 'GetAllPinIds' @($null) @(0)), (Cand 'GetExternalPinIds' @($null) @(0)), (Cand 'GetPinIds' @($null, 0) @(0))) -Silent
        if ($null -ne $r.Items) { $pins += @($r.Items) }
    }
    if ($pins.Count -eq 0 -and $null -ne $sym) {
        foreach ($id in @($script:Kept.Symbols)) {
            [void](Invoke-Quiet $sym 'SetId' @($id))
            $r = Try-Calls -Op 'wires.pins.symbol' -Target $sym -TL 'symbol' -Cands @((Cand 'GetPinIds' @($null) @(0)), (Cand 'GetPinIds' @($null, 0) @(0)), (Cand 'GetAllPinIds' @($null) @(0))) -Silent
            if ($null -ne $r.Items) { $pins += @($r.Items) }
        }
    }
    return @($pins | Select-Object -Unique)
}

function Step-Designation {
    Write-Section 'D' 'Обозначения: SetName, установка, место, Device Designation'
    if ($null -eq $script:Kept -or @($script:Kept.Devices).Count -eq 0) { Write-Human 'Нет вставленного устройства — пропущено.'; return }
    $dev = Get-DevObj; $id = @($script:Kept.Devices)[0]
    [void](Invoke-Quiet $dev 'SetId' @($id))
    $readNames = @('GetName', 'GetDeviceName', 'GetDeviceDesignation', 'GetAssignment', 'GetLocation', 'GetFullName')
    $readCands = @(); foreach ($n in $readNames) { $readCands += , (Cand $n) }
    $readCands += , (Cand 'GetAttributeValue' @('Device Designation'))
    $before = Try-Calls -Op 'design.read.before' -Target $dev -TL 'device' -Cands $readCands
    $probeName = 'FLUXPROBE1'
    $set = Try-Calls -Op 'design.setname' -Target $dev -TL 'device' -Cands @((Cand 'SetName' @($probeName)), (Cand 'SetDeviceName' @($probeName)), (Cand 'SetDeviceDesignation' @($probeName)), (Cand 'SetName' @($probeName, 0))) -First
    $after = Try-Calls -Op 'design.read.after' -Target $dev -TL 'device' -Cands $readCands
    $shown = @(); foreach ($w in $after.Wins) { $shown += ($w.Label -replace '^device\.', '') + '=' + (Format-Value $w.Value 40) }
    Write-Human ('После SetName: ' + ($shown -join '; '))
    $designationLinked = $null
    foreach ($w in $after.Wins) { if ($w.Label -like '*GetAttributeValue') { $designationLinked = ([string]$w.Value -eq $probeName) } }
    if ($null -ne $designationLinked) {
        if ($designationLinked) { Add-Finding 'ok' 'Атрибут «Device Designation» следует за SetName (одно и то же значение).' } else { Add-Finding 'note' 'Атрибут «Device Designation» после SetName не равен заданному имени — это разные сущности.' }
    }
    # обратная связь: пишем атрибут и читаем имя
    [void](Try-Calls -Op 'design.attr.designation.set' -Target $dev -TL 'device' -Cands (Get-AttrWriteCands 'Device Designation' 'FLUXPROBE2') -First)
    $viaAttr = Try-Calls -Op 'design.read.afterattr' -Target $dev -TL 'device' -Cands $readCands
    $shown = @(); foreach ($w in $viaAttr.Wins) { $shown += ($w.Label -replace '^device\.', '') + '=' + (Format-Value $w.Value 40) }
    Write-Human ('После записи атрибута Device Designation: ' + ($shown -join '; '))
    # установка и место
    foreach ($pair in @(@('Assignment', @('=FLUXPROBE', 'FLUXPROBE')), @('Location', @('+FLUXPROBE', 'FLUXPROBE')))) {
        $cs = @(); foreach ($val in $pair[1]) { foreach ($m in @(('Set' + $pair[0]), ('SetDevice' + $pair[0]))) { $cs += , (Cand $m @($val)) } }
        $s = Try-Calls -Op ('design.set.' + $pair[0].ToLower()) -Target $dev -TL 'device' -Cands $cs -First
        $rb = Try-Calls -Op ('design.read.' + $pair[0].ToLower()) -Target $dev -TL 'device' -Cands @((Cand ('Get' + $pair[0]))) -First
        if ($rb.Ok) { Write-Human ($pair[0] + ': записали «' + ($pair[1][0]) + '», E3 вернул ' + (Format-Value $rb.Value 60)) }
    }
    # кириллица и совпадение с существующим
    [void](Try-Calls -Op 'design.setname.cyrillic' -Target $dev -TL 'device' -Cands @((Cand 'SetName' @('-КЛ_ПРОБА1'))) -First)
    $rb = Try-Calls -Op 'design.read.cyrillic' -Target $dev -TL 'device' -Cands @((Cand 'GetName')) -First
    if ($rb.Ok) { Write-Human ('Кириллица в обозначении: вернулось ' + (Format-Value $rb.Value 60)) }
    $others = @(Get-AllDevices | Where-Object { @($script:Kept.Devices) -notcontains $_ })
    if ($others.Count -gt 0) {
        [void](Invoke-Quiet $dev 'SetId' @($others[0]))
        $otherName = [string](Get-QuietValue $dev 'GetName')
        [void](Invoke-Quiet $dev 'SetId' @($id))
        if ($otherName -ne '') {
            $c = Try-Calls -Op 'design.setname.collision' -Target $dev -TL 'device' -Cands @((Cand 'SetName' @($otherName))) -First
            $rb = Try-Calls -Op 'design.read.collision' -Target $dev -TL 'device' -Cands @((Cand 'GetName')) -First
            Write-Human ('Совпадение с существующим «' + $otherName + '»: SetName ' + $(if ($c.Ok) { 'принят' } else { 'отклонён' }) + ', имя после: ' + (Format-Value $rb.Value 60))
            if ($c.Ok -and $rb.Ok) {
                if ([string]$rb.Value -eq $otherName) { Add-Finding 'note' 'E3 допускает два устройства с одинаковым обозначением (SetName при совпадении не отказывает и не переименовывает).' }
                else { Add-Finding 'note' ('При совпадении обозначения E3 меняет имя: «' + $otherName + '» -> «' + [string]$rb.Value + '».') }
            } elseif (-not $c.Ok) { Add-Finding 'note' 'При совпадении обозначения SetName возвращает ошибку.' }
        }
    } else { Write-Human '· других устройств в проекте нет — совпадение не проверялось.' }
    if ($set.Ok) { Add-Finding 'ok' ('Обозначение устройства пишется: ' + $set.Winner) } else { Add-Finding 'need' 'Обозначение устройства (SetName и аналоги) записать не удалось.' }
}

function Get-ConnectionCount {
    $sh = $script:Objects['Sheet']
    [void](Use-Sheet $script:ProbeSheetId)
    $a = @(Get-Ids 'conn.job' 'wires.count.connections' $script:Job 'job' @((Cand 'GetAllConnectionIds' @($null) @(0)), (Cand 'GetConnectionIds' @($null) @(0)), (Cand 'GetAllNetSegmentIds' @($null) @(0)), (Cand 'GetNetSegmentIds' @($null) @(0))))
    $b = @(Get-Ids 'conn.sheet' 'wires.count.sheetsegments' $sh 'sheet' @((Cand 'GetNetSegmentIds' @($null) @(0)), (Cand 'GetConnectionIds' @($null) @(0)), (Cand 'GetNetSegmentIds' @($null, 0) @(0))))
    return @{ Job = $a.Count; Sheet = $b.Count; JobIds = $a; SheetIds = $b }
}

function Step-Wires {
    Write-Section '7' 'Выводы, цепи и соединения'
    if ($null -eq $script:Kept) { Write-Human 'Нет вставленного решения — пропущено.'; return }
    $pin = $script:Objects['Pin']
    $pins = @(Get-PlacedPins)
    Write-Human ('Выводов у вставленного: ' + $pins.Count)
    if ($pins.Count -eq 0) { Add-Finding 'need' 'Выводы (пины) вставленного решения не прочитались: GetPinIds на устройстве и символе не сработал.'; return }
    Add-Finding 'ok' ('Выводы читаются: у вставленного решения ' + $pins.Count + '.')
    $readPin = @()
    foreach ($n in @('GetName', 'GetSignalName', 'GetNetId', 'GetNetName', 'GetDeviceId', 'GetSymbolId', 'GetPinType', 'GetType', 'GetPinName', 'GetFunction', 'GetGateName')) { $readPin += , (Cand $n) }
    $readPin += , (Cand 'GetSchemaLocation' @($null, $null, $null) @(0, 1, 2))
    $readPin += , (Cand 'GetSchemaLocation' @($null, $null) @(0, 1))
    $readPin += , (Cand 'GetConnectionIds' @($null) @(0))
    $readPin += , (Cand 'GetNetSegmentIds' @($null) @(0))
    $readPin += , (Cand 'GetConnectionId')
    $readPin += , (Cand 'GetAttributeValue' @('!Pin_OpisaniePR_tip_signala'))
    $shown = 0
    foreach ($p in $pins) {
        if ($shown -ge 4) { break }; $shown++
        [void](Invoke-Quiet $pin 'SetId' @($p))
        Write-Human ('-- Пин ' + $p)
        [void](Try-Calls -Op 'wires.pin.read' -Target $pin -TL 'pin' -Cands $readPin)
    }
    $before = Get-ConnectionCount
    Write-Human ('Соединений до: в проекте ' + $before.Job + ', на листе ' + $before.Sheet)
    $p1 = $pins[0]
    $p2 = $null
    if ($pins.Count -ge 2) { $p2 = $pins[1] }
    $second = $null
    if ($null -eq $p2 -and $null -ne $script:WinVariantId) {
        # у решения один вывод — ставим второй экземпляр рядом и соединяем выводы двух экземпляров
        $vs = Get-PlaceVariants $script:SolutionName ($script:PlaceX + 60) $script:PlaceY
        $v = @($vs | Where-Object { $_.Id -eq $script:WinVariantId })[0]
        $devB = @(Get-AllDevices); $symB = @(Get-SheetSymbols)
        $r = Invoke-PlaceVariant $v 'wires.place.second'
        if ($r.Ok) {
            $nd = @(Get-AllDevices | Where-Object { $devB -notcontains $_ }); $ns = @(Get-SheetSymbols | Where-Object { $symB -notcontains $_ })
            $second = @{ Devices = $nd; Symbols = $ns }
            $dev = Get-DevObj
            foreach ($d in $nd) { [void](Invoke-Quiet $dev 'SetId' @($d)); $rp = Try-Calls -Op 'wires.pins.second' -Target $dev -TL 'device' -Cands @((Cand 'GetPinIds' @($null) @(0))) -Silent; if ($rp.Items.Count -gt 0) { $p2 = $rp.Items[0]; break } }
        }
    }
    if ($null -eq $p2) { Add-Finding 'need' 'Соединение между двумя выводами проверить не удалось: нашёлся один вывод.'; return }
    $x1 = $script:PlaceX; $y1 = $script:PlaceY
    $connCands = New-Object System.Collections.ArrayList
    $con = $script:Objects['Connection']; $net = $script:Objects['Net']; $sh = $script:Objects['Sheet']
    $specs = @(
        @{ T = $con; L = 'connection'; C = @((Cand 'Create' @($p1, $p2)), (Cand 'Create' @($p1, $p2, 0)), (Cand 'CreateConnection' @($p1, $p2)), (Cand 'Add' @($p1, $p2))) },
        @{ T = $net; L = 'net'; C = @((Cand 'Create' @($p1, $p2)), (Cand 'Connect' @($p1, $p2)), (Cand 'CreateNet' @($p1, $p2))) },
        @{ T = $script:Job; L = 'job'; C = @((Cand 'CreateConnection' @($p1, $p2)), (Cand 'Connect' @($p1, $p2)), (Cand 'ConnectPins' @($p1, $p2)), (Cand 'CreateNet' @($p1, $p2)), (Cand 'CreateWire' @($p1, $p2))) },
        @{ T = $pin; L = 'pin'; C = @((Cand 'Connect' @($p2)), (Cand 'ConnectTo' @($p2)), (Cand 'CreateConnection' @($p2))) },
        @{ T = $sh; L = 'sheet'; C = @((Cand 'CreateConnection' @($p1, $p2)), (Cand 'CreateConnectionLine' @($x1, $y1, ($x1 + 60), $y1)), (Cand 'CreateNetSegment' @($x1, $y1, ($x1 + 60), $y1))) }
    )
    $created = $null; $winner = $null
    foreach ($s in $specs) {
        if ($null -eq $s.T) { continue }
        if ($s.L -eq 'pin') { [void](Invoke-Quiet $pin 'SetId' @($p1)) }
        if ($s.L -eq 'sheet') { [void](Use-Sheet $script:ProbeSheetId) }
        $r = Try-Calls -Op 'wires.connect' -Target $s.T -TL $s.L -Cands $s.C
        foreach ($w in $r.Wins) {
            $after = Get-ConnectionCount
            $grew = ($after.Job -gt $before.Job -or $after.Sheet -gt $before.Sheet)
            Write-Human ('  ' + $w.Label + ': вернул ' + (Format-Value $w.Value 60) + '; соединений теперь ' + $after.Job + '/' + $after.Sheet + $(if ($grew) { ' — появилось' } else { ' — не изменилось' }))
            if ($grew -and $null -eq $created) { $created = $w; $winner = $s }
        }
        if ($null -ne $created) { break }
    }
    if ($null -ne $created) { Add-Finding 'ok' ('Соединение между двумя выводами создаётся: ' + $created.Label + '.') }
    else { Add-Finding 'need' 'Соединение между двумя выводами создать не удалось ни одним вызовом (нужны имена из api-*.txt).' }

    # --- что происходит с соединением при удалении символа и повторной вставке
    $afterConn = Get-ConnectionCount
    foreach ($p in @($p1, $p2)) {
        [void](Invoke-Quiet $pin 'SetId' @($p))
        [void](Try-Calls -Op 'wires.pin.net' -Target $pin -TL 'pin' -Cands @((Cand 'GetNetId'), (Cand 'GetConnectionIds' @($null) @(0)), (Cand 'GetNetSegmentIds' @($null) @(0)), (Cand 'GetNetName')))
    }
    $pinsBeforeDelete = @($p1)
    $removed = Remove-DeviceAndSymbols $script:Kept.Devices $script:Kept.Symbols 'wires.delete.placed'
    $afterDelete = Get-ConnectionCount
    Write-Human ('После удаления вставленного: соединений в проекте ' + $afterDelete.Job + ' (было ' + $afterConn.Job + '), на листе ' + $afterDelete.Sheet + ' (было ' + $afterConn.Sheet + ')')
    if ($afterConn.Job -gt 0 -or $afterConn.Sheet -gt 0) {
        if ($afterDelete.Job -lt $afterConn.Job -or $afterDelete.Sheet -lt $afterConn.Sheet) { Add-Finding 'note' 'При удалении устройства E3 удаляет и его соединения: провода при замене блока надо запоминать и создавать заново.' }
        else { Add-Finding 'note' 'При удалении устройства соединения остаются в проекте (висят): при замене блока их можно переподключить.' }
    }
    # повторная вставка и переподключение
    $script:Kept = $null
    $devB = @(Get-AllDevices); $symB = @(Get-SheetSymbols)
    $vs = Get-PlaceVariants $script:SolutionName $script:PlaceX $script:PlaceY
    $v = @($vs | Where-Object { $_.Id -eq $script:WinVariantId })[0]
    $r = Invoke-PlaceVariant $v 'wires.place.again'
    if ($r.Ok) {
        $nd = @(Get-AllDevices | Where-Object { $devB -notcontains $_ }); $ns = @(Get-SheetSymbols | Where-Object { $symB -notcontains $_ })
        $script:Kept = @{ Devices = $nd; Symbols = $ns; Variant = $v }
        $newPins = @(Get-PlacedPins)
        Write-Human ('Повторно вставлено, выводов: ' + $newPins.Count)
        if ($newPins.Count -gt 0 -and $null -ne $winner -and $null -ne $created) {
            $np = $newPins[0]
            $cands = @()
            foreach ($c in $winner.C) { if ($c.M -eq ($created.Label -replace '^[a-z]+\.', '')) { $cands += , (Cand $c.M @($np, $p2)) } }
            if ($winner.L -eq 'pin') { [void](Invoke-Quiet $pin 'SetId' @($np)) }
            if ($cands.Count -gt 0) {
                $rc = Try-Calls -Op 'wires.reconnect' -Target $winner.T -TL $winner.L -Cands $cands -First
                if ($rc.Ok) { Add-Finding 'ok' 'Переподключение к новому символу тем же вызовом работает.' } else { Add-Finding 'note' 'Переподключение к новому символу тем же вызовом не удалось.' }
            }
        }
    }
    if ($null -ne $second) { [void](Remove-DeviceAndSymbols $second.Devices $second.Symbols 'wires.delete.second') }
    if ($null -eq $script:Kept) { $script:Kept = $null }
}
