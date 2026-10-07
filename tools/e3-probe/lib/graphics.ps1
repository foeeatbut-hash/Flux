# Раздел 8, B и C: графика символа, экспорт листа, остальные объекты проекта, выделение и обратная связь с E3.

$script:ExportResults = New-Object System.Collections.ArrayList

function Step-Graphics {
    Write-Section '8' 'Графика символа и экспорт листа'
    if ($null -eq $script:Kept) { Write-Human 'Нет вставленного решения — графика символа пропущена.' }
    else {
        $sym = $script:Objects['Symbol']; $gr = $script:Objects['Graph']; $tx = $script:Objects['Text']
        foreach ($sid in @($script:Kept.Symbols | Select-Object -First 2)) {
            [void](Invoke-Quiet $sym 'SetId' @($sid))
            Write-Human ('-- Символ ' + $sid + ': примитивы')
            $g = Try-Calls -Op 'graphics.symbol.graphids' -Target $sym -TL 'symbol' -Cands @((Cand 'GetGraphIds' @($null) @(0)), (Cand 'GetGraphIds' @($null, 0) @(0)), (Cand 'GetAllGraphIds' @($null) @(0)))
            $ids = @(); if ($null -ne $g.Items) { $ids = @($g.Items) }
            Write-Human ('Графических примитивов: ' + $ids.Count)
            if ($null -ne $gr) {
                $read = @()
                foreach ($n in @('GetType', 'GetGraphType', 'GetKind', 'GetText', 'GetTextString', 'GetRadius', 'GetPointCount', 'GetLineWidth', 'GetColour', 'GetColor', 'GetLayer', 'GetFilled', 'GetStartAngle', 'GetEndAngle', 'GetTextHeight', 'GetX', 'GetY', 'GetLineStyle', 'GetFillColour')) { $read += , (Cand $n) }
                $read += , (Cand 'GetStartPoint' @($null, $null) @(0, 1)); $read += , (Cand 'GetEndPoint' @($null, $null) @(0, 1)); $read += , (Cand 'GetCenter' @($null, $null) @(0, 1))
                $read += , (Cand 'GetArea' @($null, $null, $null, $null) @(0, 1, 2, 3)); $read += , (Cand 'GetCoordinates' @($null, $null, $null, $null) @(0, 1, 2, 3))
                $read += , (Cand 'GetPoints' @($null, $null) @(0, 1)); $read += , (Cand 'GetLocation' @($null, $null) @(0, 1))
                $n = 0
                foreach ($gid in $ids) {
                    if ($n -ge 5) { break }; $n++
                    [void](Invoke-Quiet $gr 'SetId' @($gid))
                    $first = ($n -eq 1)
                    [void](Try-Calls -Op 'graphics.primitive.read' -Target $gr -TL 'graph' -Cands $read -Silent:(-not $first))
                }
                # типы всех примитивов: сколько линий, дуг, текстов
                $types = @{}
                foreach ($gid in ($ids | Select-Object -First 200)) {
                    [void](Invoke-Quiet $gr 'SetId' @($gid))
                    $t = Get-QuietValue $gr 'GetType'; if ($null -eq $t) { $t = Get-QuietValue $gr 'GetGraphType' }
                    $key = Format-Value $t 30; if ($types.ContainsKey($key)) { $types[$key]++ } else { $types[$key] = 1 }
                }
                if ($types.Count -gt 0) { Write-Human ('Типы примитивов: ' + (($types.Keys | ForEach-Object { $_ + ' x' + $types[$_] }) -join ', ')) }
            }
            $t = Try-Calls -Op 'graphics.symbol.textids' -Target $sym -TL 'symbol' -Cands @((Cand 'GetTextIds' @($null) @(0)), (Cand 'GetTextIds' @($null, 0) @(0)))
            if ($null -ne $tx -and $null -ne $t.Items) {
                $n = 0
                foreach ($tid in $t.Items) {
                    if ($n -ge 3) { break }; $n++
                    [void](Invoke-Quiet $tx 'SetId' @($tid))
                    $tr = @(); foreach ($m in @('GetText', 'GetTextString', 'GetHeight', 'GetFontHeight', 'GetAngle', 'GetRotation', 'GetJustification', 'GetFont', 'GetName')) { $tr += , (Cand $m) }
                    $tr += , (Cand 'GetLocation' @($null, $null) @(0, 1)); $tr += , (Cand 'GetSchemaLocation' @($null, $null) @(0, 1)); $tr += , (Cand 'GetPosition' @($null, $null) @(0, 1))
                    [void](Try-Calls -Op 'graphics.text.read' -Target $tx -TL 'text' -Cands $tr -Silent:($n -gt 1))
                }
            }
            if ($ids.Count -gt 0) { Add-Finding 'ok' ('Графика символа читается: примитивов ' + $ids.Count + ' (' + $g.Winner + ').') }
            else { Add-Finding 'need' 'Примитивы символа (GetGraphIds) прочитать не удалось — для «Демонстрации» понадобится экспорт листа.' }
        }
    }

    # --- экспорт временного листа
    if ($null -eq $script:ProbeSheetId) { return }
    $job = $script:Job; $app = $script:App; $sh = $script:Objects['Sheet']
    [void](Use-Sheet $script:ProbeSheetId)
    [void](Try-Calls -Op 'export.activate' -Target $job -TL 'job' -Cands @((Cand 'SetActiveSheetId' @($script:ProbeSheetId)), (Cand 'ActivateSheet' @($script:ProbeSheetId))) -First -Silent)
    foreach ($label in @('Sheet', 'Job', 'Application')) {
        $m = Test-ApiMember $label 'Export|Print|Plot|Save|Image|Bitmap|Picture|Render|Snapshot'
        if ($null -ne $m) { Write-Human ('Члены ' + $label + ' про экспорт (из описи): ' + ($m -join ', ')) }
    }
    $dir = Join-Path $script:LogDir 'export'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $areaCands = $script:Env['drawingArea']
    foreach ($ext in @('emf', 'svg', 'dxf', 'pdf', 'png', 'bmp', 'jpg', 'wmf', 'dwg', 'tif')) {
        $path = Join-Path $dir ('probe.' + $ext)
        $up = $ext.ToUpper()
        $cands = New-Object System.Collections.ArrayList
        foreach ($tgt in @(@('sheet', $sh), @('job', $job), @('app', $app))) {
            if ($null -eq $tgt[1]) { continue }
            foreach ($m in @(('Export' + $up), ('Export' + $ext.Substring(0, 1).ToUpper() + $ext.Substring(1)), 'ExportImage', 'ExportBitmap', 'ExportPicture', 'ExportDrawing', 'Export', 'ExportSheet')) {
                foreach ($a in @(@($path), @($path, $ext), @($path, $up), @($script:ProbeSheetId, $path), @($path, $script:ProbeSheetId))) {
                    [void]$cands.Add(@{ L = $tgt[0]; T = $tgt[1]; M = $m; A = $a })
                }
            }
        }
        $done = $false; $tried = 0
        $seen = @{}
        foreach ($c in $cands) {
            $key = $c.L + '.' + $c.M + '(' + (($c.A | ForEach-Object { [string]$_ }) -join ',') + ')'
            if ($seen.ContainsKey($key)) { continue }; $seen[$key] = $true
            if ($c.L -eq 'sheet') { [void](Use-Sheet $script:ProbeSheetId) }
            if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
            $callArgs = $c.A.Clone()
            $action = {
                $r = Invoke-Com -Target $c.T -Name $c.M -CallArgs $callArgs -RefIdx @()
                if (-not (Test-Path $path) -or (Get-Item $path).Length -eq 0) { throw 'вызов прошёл, но файл не появился' }
                $r
            }
            $tried++
            $r = Invoke-Attempt -Op ('export.' + $ext) -Label ($c.L + '.' + $c.M) -ArgsText (Format-Args $c.A @()) -Action $action -Silent
            if ($r.Ok) {
                $size = (Get-Item $path).Length
                Write-Human ('✓ export.' + $ext + '  ' + $c.L + '.' + $c.M + '(' + (Format-Args $c.A @()) + ')  ' + $r.Record.ms + ' мс  файл ' + $size + ' байт') 'Green'
                [void]$script:ExportResults.Add(@{ Ext = $ext; Call = ($c.L + '.' + $c.M); Size = $size; Ms = $r.Record.ms })
                Add-Finding 'ok' ('Экспорт листа в ' + $ext.ToUpper() + ' работает: ' + $c.L + '.' + $c.M + ', ' + $size + ' байт, ' + $r.Record.ms + ' мс.')
                $done = $true; break
            }
        }
        if (-not $done) { Write-Human ('✕ export.' + $ext + ': перебрано вариантов ' + $tried + ', файл не получен') 'DarkGray' }
    }
    if ($script:ExportResults.Count -eq 0) { Add-Finding 'need' 'Экспорт временного листа ни в один формат не удался: нужны имена методов из api-Sheet.txt / api-Job.txt.' }
}

function Probe-Kind {
    # Читает объекты вида, создаёт и удаляет один на временном листе. Всё в таблице — без отдельного кода на вид.
    param([string]$Kind, [string[]]$ListNames, [object[]]$CreateCands, [string[]]$ReadNames)
    $obj = $script:Objects[$Kind]
    $job = $script:Job
    $listCands = @(); foreach ($n in $ListNames) { $listCands += , (Cand $n @($null) @(0)); $listCands += , (Cand $n @($null, 0) @(0)) }
    $r = Try-Calls -Op ('objects.' + $Kind.ToLower() + '.list') -Target $job -TL 'job' -Cands $listCands
    $ids = @(); if ($null -ne $r.Items) { $ids = @($r.Items) }
    if ($ids.Count -eq 0 -and $null -ne $obj) {
        $r2 = Try-Calls -Op ('objects.' + $Kind.ToLower() + '.list') -Target $obj -TL $Kind.ToLower() -Cands $listCands
        if ($null -ne $r2.Items) { $ids = @($r2.Items) }
    }
    Write-Human ($Kind + ': в проекте ' + $ids.Count + $(if ($null -eq $obj) { ' (объекта Create' + $Kind + 'Object нет)' } else { '' }))
    $script:Env['count.' + $Kind] = $ids.Count
    if ($null -ne $obj -and $ids.Count -gt 0) {
        [void](Invoke-Quiet $obj 'SetId' @($ids[0]))
        $rc = @(); foreach ($n in $ReadNames) { $rc += , (Cand $n) }
        $rc += , (Cand 'GetAttributeValue' @('Name'))
        [void](Try-Calls -Op ('objects.' + $Kind.ToLower() + '.read') -Target $obj -TL $Kind.ToLower() -Cands $rc)
    }
    if ($null -ne $obj -and $CreateCands.Count -gt 0 -and $null -ne $script:ProbeSheetId) {
        [void](Use-Sheet $script:ProbeSheetId)
        $before = $ids
        foreach ($c in $CreateCands) {
            $target = $obj
            if ($c.On -eq 'sheet') { $target = $script:Objects['Sheet']; [void](Use-Sheet $script:ProbeSheetId) }
            if ($c.On -eq 'job') { $target = $job }
            if ($null -eq $target) { continue }
            $cr = Try-Calls -Op ('objects.' + $Kind.ToLower() + '.create') -Target $target -TL $(if ($c.On) { $c.On } else { $Kind.ToLower() }) -Cands @((Cand $c.M $c.A.Clone() $c.R)) -First
            if (-not $cr.Ok) { continue }
            $newId = $null; if ($cr.Value -is [ValueType] -and [long]$cr.Value -gt 0) { $newId = $cr.Value }
            Write-Human ('  создано ' + $Kind + ': ' + (Format-Value $cr.Value 40))
            if ($null -ne $newId) {
                [void](Invoke-Quiet $obj 'SetId' @($newId))
                $d = Try-Calls -Op ('objects.' + $Kind.ToLower() + '.delete') -Target $obj -TL $Kind.ToLower() -Cands @((Cand 'Delete'), (Cand 'Delete' @(0)), (Cand 'Remove')) -First
                if (-not $d.Ok) { Write-Human ('  ! ' + $Kind + ' ' + $newId + ' удалить не удалось — уйдёт вместе с временным листом') 'Yellow' }
            }
            break
        }
    }
}

function Step-OtherObjects {
    Write-Section 'B' 'Остальные объекты проекта: кабели, цепи, тексты, графика, группы, блоки, варианты'
    $sid = $script:ProbeSheetId
    $xy = @($script:PlaceX, ($script:PlaceY + 80))
    $kinds = @(
        @{ K = 'Cable'; L = @('GetCableIds', 'GetAllCableIds'); R = @('GetName', 'GetType', 'GetCoreCount', 'GetCoreIds', 'GetWireCount'); C = @(@{ M = 'Create'; A = @(0, 'FLUXPROBECBL'); R = @() }) },
        @{ K = 'Net'; L = @('GetNetIds', 'GetAllNetIds'); R = @('GetName', 'GetNetName', 'GetSegmentIds', 'GetNetSegmentIds', 'GetPinIds'); C = @() },
        @{ K = 'Signal'; L = @('GetSignalIds', 'GetAllSignalIds'); R = @('GetName', 'GetSignalName', 'GetPinIds'); C = @() },
        @{ K = 'Terminal'; L = @('GetTerminalIds', 'GetAllTerminalIds'); R = @('GetName', 'GetDeviceId', 'GetPinIds'); C = @() },
        @{ K = 'Connector'; L = @('GetConnectorIds', 'GetAllConnectorIds'); R = @('GetName', 'GetDeviceId', 'GetPinIds'); C = @() },
        @{ K = 'Text'; L = @('GetTextIds', 'GetAllTextIds'); R = @('GetText', 'GetTextString', 'GetHeight', 'GetAngle'); C = @(
            @{ M = 'Create'; A = @($sid, 'FLUX_PROBE_TEXT', $xy[0], $xy[1]); R = @() },
            @{ M = 'Create'; A = @($sid, 'FLUX_PROBE_TEXT', $xy[0], $xy[1], 0); R = @() },
            @{ M = 'CreateText'; A = @($sid, 'FLUX_PROBE_TEXT', $xy[0], $xy[1]); R = @() },
            @{ M = 'CreateText'; A = @('FLUX_PROBE_TEXT', $xy[0], $xy[1]); R = @(); On = 'sheet' }) },
        @{ K = 'Graph'; L = @('GetGraphIds', 'GetAllGraphIds'); R = @('GetType', 'GetLineWidth', 'GetColour'); C = @(
            @{ M = 'CreateLine'; A = @($sid, $xy[0], $xy[1], ($xy[0] + 50), $xy[1]); R = @() },
            @{ M = 'CreateLine'; A = @($xy[0], $xy[1], ($xy[0] + 50), $xy[1]); R = @(); On = 'sheet' },
            @{ M = 'CreateRectangle'; A = @($sid, $xy[0], $xy[1], ($xy[0] + 50), ($xy[1] + 30)); R = @() },
            @{ M = 'CreateRectangle'; A = @($xy[0], $xy[1], ($xy[0] + 50), ($xy[1] + 30)); R = @(); On = 'sheet' },
            @{ M = 'CreateRect'; A = @($sid, $xy[0], $xy[1], ($xy[0] + 50), ($xy[1] + 30)); R = @() },
            @{ M = 'CreateCircle'; A = @($sid, $xy[0], $xy[1], 10); R = @() }) },
        @{ K = 'Group'; L = @('GetGroupIds', 'GetAllGroupIds'); R = @('GetName', 'GetDeviceIds'); C = @() },
        @{ K = 'Block'; L = @('GetBlockIds', 'GetAllBlockIds', 'GetSubCircuitIds'); R = @('GetName', 'GetDeviceIds', 'GetSheetId'); C = @() },
        @{ K = 'Variant'; L = @('GetVariantIds', 'GetAllVariantIds', 'GetVariantNames'); R = @('GetName'); C = @() },
        @{ K = 'Option'; L = @('GetOptionIds', 'GetAllOptionIds', 'GetOptionNames'); R = @('GetName'); C = @() },
        @{ K = 'Field'; L = @('GetFieldIds', 'GetAllFieldIds'); R = @('GetName', 'GetText'); C = @() },
        @{ K = 'Dimension'; L = @('GetDimensionIds', 'GetAllDimensionIds', 'GetCalloutIds'); R = @('GetText'); C = @() },
        @{ K = 'Format'; L = @('GetFormatIds', 'GetAllFormatIds'); R = @('GetName', 'GetWidth', 'GetHeight'); C = @() }
    )
    foreach ($k in $kinds) {
        Write-Human ('-- ' + $k.K)
        Probe-Kind $k.K $k.L $k.C $k.R
    }
    # атрибуты CBL_* из списка владельца на первом кабеле (чтение)
    $cbl = @($script:OwnerAttrs | Where-Object { $_ -match '^CBL_' })
    $cable = $script:Objects['Cable']
    if ($cbl.Count -gt 0 -and $null -ne $cable) {
        $ids = @(Get-Ids 'cable.ids' 'objects.cable.list.cbl' $script:Job 'job' @((Cand 'GetCableIds' @($null) @(0)), (Cand 'GetAllCableIds' @($null) @(0))))
        if ($ids.Count -gt 0) {
            [void](Invoke-Quiet $cable 'SetId' @($ids[0]))
            $shown = @()
            foreach ($a in $cbl) { $v = Read-AttrValue $cable 'cable' 'objects.cable.attr' $a -Silent; $shown += ($a + '=' + $(if ($v.Ok) { $v.Value } else { '—' })) }
            Write-Human ('Атрибуты CBL_* на первом кабеле: ' + ($shown -join '; '))
        }
    }
}

function Step-Interaction {
    Write-Section 'C' 'Выделение в E3, переход к объекту, сообщения'
    $job = $script:Job; $app = $script:App
    $names = @('GetSelectedDeviceIds', 'GetSelectedSymbolIds', 'GetSelectedSheetIds', 'GetSelectedIds', 'GetSelectedItemIds', 'GetSelectedTextIds', 'GetSelectedGraphIds', 'GetSelectedPinIds', 'GetSelectedNetIds', 'GetSelectedCableIds', 'GetSelectedBlockIds', 'GetSelectedObjects', 'GetSelection')
    $cands = @(); foreach ($n in $names) { $cands += , (Cand $n @($null) @(0)); $cands += , (Cand $n @($null, 0) @(0)) }
    $total = 0
    foreach ($tgt in @(@($job, 'job'), @($app, 'app'))) {
        $r = Try-Calls -Op ('ui.selected.' + $tgt[1]) -Target $tgt[0] -TL $tgt[1] -Cands $cands
        foreach ($w in $r.Wins) { $total += @($w.Items).Count }
    }
    if ($total -gt 0) { Add-Finding 'ok' ('Выделенное в E3 читается: найдено объектов ' + $total + '.') }
    elseif ($script:Winners.Contains('ui.selected.job') -or $script:Winners.Contains('ui.selected.app')) { Add-Finding 'ok' 'Вызовы чтения выделенного есть, но выделенного не было: выделите объект в E3 и запустите скрипт ещё раз, чтобы проверить чтение.' }
    else { Add-Finding 'need' 'Чтение выделенного в E3 (GetSelected*Ids) не сработало ни в одном варианте.' }

    if ($null -ne $script:Kept -and @($script:Kept.Devices).Count -gt 0) {
        $id = @($script:Kept.Devices)[0]
        $dev = Get-DevObj
        [void](Invoke-Quiet $dev 'SetId' @($id))
        [void](Try-Calls -Op 'ui.jump.device' -Target $dev -TL 'device' -Cands @((Cand 'Jump'), (Cand 'Highlight'), (Cand 'Highlight' @(1)), (Cand 'Show'), (Cand 'Select'), (Cand 'Find'), (Cand 'Zoom')) -First)
        $sym = $script:Objects['Symbol']
        if ($null -ne $sym -and @($script:Kept.Symbols).Count -gt 0) {
            [void](Invoke-Quiet $sym 'SetId' @(@($script:Kept.Symbols)[0]))
            [void](Try-Calls -Op 'ui.jump.symbol' -Target $sym -TL 'symbol' -Cands @((Cand 'Jump'), (Cand 'Highlight'), (Cand 'Highlight' @(1)), (Cand 'Show'), (Cand 'Select'), (Cand 'Zoom')) -First)
        }
        [void](Try-Calls -Op 'ui.jump.job' -Target $job -TL 'job' -Cands @((Cand 'Jump' @($id)), (Cand 'Highlight' @($id)), (Cand 'Highlight' @($id, 1)), (Cand 'ShowObject' @($id)), (Cand 'SelectObject' @($id)), (Cand 'ZoomTo' @($id))) -First)
        [void](Try-Calls -Op 'ui.unhighlight' -Target $job -TL 'job' -Cands @((Cand 'Highlight' @($id, 0)), (Cand 'ClearHighlight'), (Cand 'UnHighlight' @($id)), (Cand 'ResetHighlight')) -First -Silent)
    }
    $msg = 'Flux: проверка связи (можно игнорировать)'
    $ra = Try-Calls -Op 'ui.message.app' -Target $app -TL 'app' -Cands @((Cand 'PutInfo' @(0, $msg)), (Cand 'PutInfo' @($msg)), (Cand 'PutMessage' @($msg)), (Cand 'PutMessage' @(0, $msg)), (Cand 'PutWarning' @(0, $msg)), (Cand 'Print' @($msg)), (Cand 'Output' @($msg)), (Cand 'WriteMessage' @($msg))) -First
    $rj = Try-Calls -Op 'ui.message.job' -Target $job -TL 'job' -Cands @((Cand 'PutInfo' @(0, $msg)), (Cand 'PutInfo' @($msg)), (Cand 'PutMessage' @($msg)), (Cand 'PutMessage' @(0, $msg))) -First
    if ($ra.Ok -or $rj.Ok) { Add-Finding 'ok' ('Сообщение в окно вывода E3 выводится: ' + $(if ($ra.Ok) { $ra.Winner } else { $rj.Winner }) + ' — проверьте, что оно появилось.') }
    else { Add-Finding 'need' 'Сообщение в окно вывода E3 (PutInfo/PutMessage) вывести не удалось.' }
}
