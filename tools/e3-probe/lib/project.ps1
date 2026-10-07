# Разделы 9-12, G, H: перебор устройств и скорость, возможности без вызова, устойчивость, уборка.

$script:Speed = [ordered]@{}

function Step-Search {
    Write-Section '9' 'Перебор устройств проекта и скорость (readBound)'
    $dev = Get-DevObj
    if ($null -eq $dev) { Add-Finding 'bad' 'Объект устройства не создан: перебор невозможен.'; return }
    $ids = @(Get-AllDevices)
    # устройства самой пробы в замер не входят: их скоро не будет
    if ($null -ne $script:Kept) { $ids = @($ids | Where-Object { @($script:Kept.Devices) -notcontains $_ }) }
    Write-Human ('Устройств для перебора: ' + $ids.Count)
    if ($ids.Count -eq 0) { Add-Finding 'note' 'В проекте нет устройств, кроме временных: скорость перебора не измерена. Запустите на проекте с устройствами.'; return }

    $readOne = {
        param($id, $names)
        [void](Invoke-Com -Target $dev -Name 'SetId' -CallArgs @($id) -RefIdx @())
        foreach ($n in $names) { [void](Invoke-Com -Target $dev -Name 'GetAttributeValue' -CallArgs @($n) -RefIdx @()) }
    }
    $sets = @(
        @{ Title = 'один атрибут (GLOBAL_ID_IN_PROJECT)'; Names = @('GLOBAL_ID_IN_PROJECT') },
        @{ Title = 'пять атрибутов связи'; Names = $script:FluxAttrs },
        @{ Title = 'имя и пять атрибутов'; Names = $script:FluxAttrs }
    )
    foreach ($set in $sets) {
        foreach ($limit in @(100, 1000000)) {
            $take = [math]::Min($limit, $ids.Count)
            if ($limit -gt 100 -and $ids.Count -le 100) { continue }
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $errors = 0; $done = 0; $firstError = ''
            foreach ($id in ($ids | Select-Object -First $take)) {
                try {
                    [void](Invoke-Com -Target $dev -Name 'SetId' -CallArgs @($id) -RefIdx @())
                    if ($set.Title -like 'имя*') { [void](Invoke-Com -Target $dev -Name 'GetName' -CallArgs @() -RefIdx @()) }
                    foreach ($n in $set.Names) { [void](Invoke-Com -Target $dev -Name 'GetAttributeValue' -CallArgs @($n) -RefIdx @()) }
                } catch { $errors++; if ($firstError -eq '') { $firstError = (Get-InnerException $_.Exception).Message } }
                $done++
                if ($sw.Elapsed.TotalSeconds -gt 90) { Write-Human '· прервано по времени (90 с)'; break }
            }
            $sw.Stop()
            $per = [math]::Round($sw.Elapsed.TotalMilliseconds / [math]::Max($done, 1), 2)
            $key = $set.Title + ' / ' + $(if ($limit -le 100) { '100' } else { 'все' })
            $script:Speed[$key] = @{ Devices = $done; TotalMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 0); PerDeviceMs = $per; Errors = $errors }
            Write-Human ('Скорость: ' + $key + ': устройств ' + $done + ', ' + [math]::Round($sw.Elapsed.TotalMilliseconds, 0) + ' мс всего, ' + $per + ' мс на устройство, ошибок ' + $errors + $(if ($firstError) { ' (' + $firstError + ')' } else { '' }))
            $rec = [ordered]@{ seq = 0; step = $script:Step; op = 'speed.devices'; candidate = $key; args = ''; ok = ($errors -eq 0); type = $null; result = ('устройств ' + $done + ', ' + $per + ' мс на устройство'); error = $(if ($errors) { $firstError } else { $null }); hresult = $null; busy = $false; ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1) }
            $script:Seq++; $rec.seq = $script:Seq; Add-Record $rec
        }
    }
    $all = $script:Speed.Keys | Where-Object { $_ -like 'пять*/ все' } | Select-Object -First 1
    if ($all) { Add-Finding 'ok' ('Скорость чтения пяти атрибутов связи у всех ' + $script:Speed[$all].Devices + ' устройств: ' + [math]::Round($script:Speed[$all].TotalMs / 1000, 1) + ' с (' + $script:Speed[$all].PerDeviceMs + ' мс на устройство).') }

    # --- пакетное чтение: все атрибуты объекта одним вызовом
    [void](Invoke-Quiet $dev 'SetId' @($ids[0]))
    $batch = @((Cand 'GetAttributeNames' @($null) @(0)), (Cand 'GetAttributeIds' @($null) @(0)), (Cand 'GetAttributes' @($null) @(0)), (Cand 'GetAllAttributes' @($null) @(0)), (Cand 'GetAttributeValues' @($null, $null) @(0, 1)), (Cand 'GetAttributeNamesAndValues' @($null, $null) @(0, 1)), (Cand 'GetAllAttributeValues' @($null) @(0)), (Cand 'GetAttributeCount'))
    $b = Try-Calls -Op 'speed.batch.device' -Target $dev -TL 'device' -Cands $batch
    if ($b.Ok) { Add-Finding 'ok' ('Пакетное чтение атрибутов устройства: ' + (($b.Wins | ForEach-Object { $_.Label }) -join ', ') + ' — читать все атрибуты одним вызовом можно.') }
    else { Add-Finding 'note' 'Пакетного чтения атрибутов устройства найти не удалось: читаем по одному.' }
}

function Step-Capabilities {
    # Разделы 10 и 12: только наличие методов в описи. Ничего не вызывается.
    Write-Section '10' 'Возможности без вызова: Undo, сохранение, запуск скриптов'
    foreach ($row in @(
        @{ Id = 'undo'; Name = 'Undo / отмена'; Pattern = '^(Undo|Redo|UndoLast|Rollback)'; Labels = @('Job', 'Application') },
        @{ Id = 'save'; Name = 'Сохранение проекта'; Pattern = '^(Save|SaveAs|SaveJob|SaveProject|Store)'; Labels = @('Job', 'Application') },
        @{ Id = 'script'; Name = 'Запуск скрипта E3'; Pattern = '(RunScript|ExecuteScript|Execute|^Run$|RunMacro|Macro|^Script)'; Labels = @('Job', 'Application') }
    )) {
        $found = @(); $known = $false
        foreach ($l in $row.Labels) { $m = Test-ApiMember $l $row.Pattern; if ($null -ne $m) { $known = $true; foreach ($x in $m) { $found += ($l + '.' + $x) } } }
        $line = $row.Name + ': '
        if (-not $known) { $line += 'описи API нет — наличие определить нельзя'; Add-Finding 'note' ($row.Name + ': наличие определить нельзя (нет описи API).') }
        elseif ($found.Count -gt 0) { $line += 'ЕСТЬ: ' + ($found -join ', '); Add-Finding 'ok' ($row.Name + ': в API есть ' + ($found -join ', ') + ' (не вызывалось).') }
        else { $line += 'не найдено'; Add-Finding 'note' ($row.Name + ': в API не найдено.') }
        Write-Human $line
        $rec = [ordered]@{ seq = 0; step = $script:Step; op = 'capability.' + $row.Id; candidate = 'описьAPI'; args = $row.Pattern; ok = ($found.Count -gt 0); type = $null; result = ($found -join ', '); error = $(if ($found.Count -eq 0) { 'не найдено' } else { $null }); hresult = $null; busy = $false; ms = 0 }
        $script:Seq++; $rec.seq = $script:Seq; Add-Record $rec
        $opName = $rec.op
        if ($found.Count -gt 0) { $script:Winners[$opName] = New-Object System.Collections.ArrayList; foreach ($x in $found) { [void]$script:Winners[$opName].Add($x + ' (есть в API, не вызывалось)') } }
    }
    Write-Human 'Занятость E3 (диалог открыт): специально не вызывалась; коды RPC_E_CALL_REJECTED (80010001) и RETRYLATER (8001010A) ловятся в каждом вызове и помечаются «E3 ЗАНЯТ».'
}

function Step-Resilience {
    Write-Section 'H' 'Устойчивость: повторное подключение, второй экземпляр'
    $before = [string]$script:ProjectName
    $script:App = $null; $script:Job = $null
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    $r = Invoke-Attempt -Op 'resilience.reattach' -Label 'Marshal.GetActiveObject' -ArgsText '"CT.Application"' -Action { Get-ActiveApplication }
    if ($r.Ok -and $null -ne $r.Value) {
        $script:App = $r.Value
        $job = Try-Calls -Op 'resilience.reattach.job' -Target $script:App -TL 'app' -Cands @((Cand 'CreateJobObject')) -First
        if ($job.Ok) {
            $script:Job = $job.Value
            $n = Try-Calls -Op 'resilience.reattach.name' -Target $script:Job -TL 'job' -Cands @((Cand 'GetName')) -First
            if ($n.Ok -and [string]$n.Value -eq $before) { Add-Finding 'ok' 'Повторное подключение к E3 после отпускания объектов работает: тот же проект найден.' }
            else { Add-Finding 'note' ('После повторного подключения проект: «' + (Format-Value $n.Value 80) + '».') }
        }
    } else { Add-Finding 'bad' 'Повторное подключение к E3 не удалось.' }
    $count = @($script:Env.instances).Count
    Write-Human ('Экземпляров E3 найдено при запуске: ' + $count + ' (второй экземпляр специально не запускался).')
    if ($count -lt 2) { Add-Finding 'note' 'Запущен один экземпляр E3: выбор из нескольких проверить не удалось. Для проверки откройте второй E3 и запустите скрипт ещё раз (-ProcessId выбирает процесс).' }
    Add-Finding 'note' 'Поведение закрытого проекта проверяется отдельным запуском при закрытом проекте (раздел 1d в журнале).'
}

function Step-Cleanup {
    Write-Section 'Z' 'Уборка: удаляем всё созданное'
    $leftSheet = $false
    if ($null -ne $script:Kept) {
        $ok = Remove-DeviceAndSymbols $script:Kept.Devices $script:Kept.Symbols 'cleanup.placed'
        Write-Human ('Вставленное решение удалено: ' + $ok)
        $script:Kept = $null
    }
    if ($null -ne $script:OrigSheetId) {
        [void](Try-Calls -Op 'cleanup.activate.original' -Target $script:Job -TL 'job' -Cands @((Cand 'SetActiveSheetId' @($script:OrigSheetId)), (Cand 'ActivateSheet' @($script:OrigSheetId)), (Cand 'SetActiveSheet' @($script:OrigSheetId))) -First -Silent)
    }
    if ($null -ne $script:ProbeSheetId) {
        if ($script:KeepSheet) {
            Write-Human ('Временный лист ОСТАВЛЕН (-KeepSheet): id ' + $script:ProbeSheetId + ', имя «' + $script:ProbeSheetName + '». Удалите его вручную.') 'Yellow'
            Add-Finding 'note' ('Временный лист оставлен по просьбе (-KeepSheet): удалите лист «' + $script:ProbeSheetName + '» вручную.')
        } else {
            $ok = Remove-Sheet $script:ProbeSheetId 'cleanup.sheet.delete'
            $left = @(Get-Ids 'sheets' 'sheets.list' $script:Job 'job' (Get-SheetIdCands))
            $still = ($left -contains $script:ProbeSheetId)
            if ($still) { $leftSheet = $true; Add-Finding 'bad' ('Временный лист id ' + $script:ProbeSheetId + ' («' + $script:ProbeSheetName + '») удалить не удалось: удалите его вручную.') ; Write-Human '! Временный лист не удалён.' 'Yellow' }
            else { Write-Human 'Временный лист удалён.' }
        }
    }
    $devNow = @(Get-AllDevices).Count
    $devWas = @($script:DeviceIds).Count
    if ($null -ne $script:DeviceIds -and $devNow -ne $devWas) {
        Add-Finding 'bad' ('Число устройств в проекте изменилось: было ' + $devWas + ', стало ' + $devNow + '. Проверьте проект (возможен остаток от пробы).')
        Write-Human ('! Устройств было ' + $devWas + ', стало ' + $devNow) 'Yellow'
    } else { Write-Human ('Число устройств в проекте то же: ' + $devNow) }
    if ($script:Leftovers.Count -gt 0) {
        Add-Finding 'bad' ('Не вернулись к прежнему значению атрибуты: ' + (($script:Leftovers | ForEach-Object { $_.Name + ' на «' + $_.Carrier + '» (было «' + $_.Before + '»)' }) -join '; '))
    }
    Write-Human 'Проект НЕ сохранялся.'
}
