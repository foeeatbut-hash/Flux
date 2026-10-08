# Итог: таблица «операция — какой вариант сработал», summary.txt для владельца, log.json, архив.

function Get-OpStats {
    # Для каждой операции: сколько попыток, сколько удачных, среднее время удачных.
    $stats = [ordered]@{}
    foreach ($r in $script:Records) {
        if (-not $stats.Contains($r.op)) { $stats[$r.op] = @{ Tries = 0; Ok = 0; Ms = 0.0; Busy = 0 } }
        $s = $stats[$r.op]; $s.Tries++
        if ($r.ok) { $s.Ok++; $s.Ms += [double]$r.ms }
        if ($r.busy) { $s.Busy++ }
    }
    return $stats
}

function Build-SummaryTable {
    $stats = Get-OpStats
    $rows = New-Object System.Collections.ArrayList
    foreach ($op in $stats.Keys) {
        if ($op -match '^(attrdef\.|attr\.|speed\.devices|cleanup\.|api\.dump)') { continue }
        $s = $stats[$op]
        # создателей объектов, которых в E3 нет, десятки: в таблице они только мешают, полный список — в log.txt
        if ($op -match '^(app|job)\.create\.' -and $s.Ok -eq 0) { continue }
        $variant = '—  не сработало (попыток ' + $s.Tries + ')'
        $ms = ''
        if ($script:Winners.Contains($op)) {
            $uniq = @($script:Winners[$op] | Select-Object -Unique)
            $variant = ($uniq | Select-Object -First 4) -join ' | '
            if ($uniq.Count -gt 4) { $variant += ' | … (+' + ($uniq.Count - 4) + ')' }
            $ms = [math]::Round($s.Ms / [math]::Max($s.Ok, 1), 1)
        }
        [void]$rows.Add(@{ Op = $op; Variant = $variant; Ms = $ms; Tries = $s.Tries; Ok = $s.Ok })
    }
    return $rows
}

function Write-SummaryTable {
    $rows = Build-SummaryTable
    Write-Human ''
    Write-Human '=== ИТОГ: операция — какой вариант сработал ===' 'Cyan'
    foreach ($r in $rows) {
        $mark = if ($r.Ok -gt 0) { '✓' } else { '✕' }
        Write-Human ('{0} {1,-34} {2}   {3}' -f $mark, $r.Op, $r.Variant, $(if ($r.Ms -ne '') { [string]$r.Ms + ' мс' } else { '' }))
    }
    return $rows
}

function Write-SummaryFile {
    param($Rows)
    $lines = New-Object System.Collections.ArrayList
    function Add-Line { param([string]$Text) [void]$lines.Add($Text) }
    Add-Line 'ПРОВЕРКА API E3.series ДЛЯ FLUX — СВОДКА'
    Add-Line ('Дата: ' + (Get-Date).ToString('dd.MM.yyyy HH:mm'))
    Add-Line ('Версия E3: ' + $script:Env['e3Version'] + '   Проект: ' + $script:ProjectName)
    Add-Line ('Windows: ' + $script:Env['os'] + '   PowerShell: ' + $script:Env['powershell'] + ' (64 бита: ' + $script:Env['powershell64bit'] + ')')
    Add-Line ('Решение для проверки вставки: ' + $script:SolutionName)
    if ($script:SolutionNote) { Add-Line ('  ' + $script:SolutionNote) }
    Add-Line ''
    $ok = @($script:Findings | Where-Object { $_.Kind -eq 'ok' })
    $bad = @($script:Findings | Where-Object { $_.Kind -eq 'bad' })
    $need = @($script:Findings | Where-Object { $_.Kind -eq 'need' })
    $note = @($script:Findings | Where-Object { $_.Kind -eq 'note' })
    Add-Line ('ЧТО РАБОТАЕТ (' + $ok.Count + ')')
    foreach ($f in $ok) { Add-Line ('  + ' + $f.Text) }
    Add-Line ''
    Add-Line ('ЧТО НЕ РАБОТАЕТ ИЛИ ТРЕБУЕТ ВНИМАНИЯ (' + ($bad.Count + $need.Count) + ')')
    foreach ($f in $bad) { Add-Line ('  ! ' + $f.Text) }
    foreach ($f in $need) { Add-Line ('  - ' + $f.Text) }
    Add-Line ''
    Add-Line 'ЧТО НАДО ЗАВЕСТИ В БАЗЕ E3'
    Add-Line '  Атрибуты связи (если их нет): FLUX_PROJECT (проект), FLUX_BLOCK и FLUX_VER (блок), FLUX_ID (изделие).'
    if ($script:AttrMissing.Count -gt 0) {
        Add-Line ('  Атрибуты из списка владельца, не найденные ни на одном носителе (' + $script:AttrMissing.Count + '):')
        foreach ($n in ($script:AttrMissing | Select-Object -First 80)) { Add-Line ('    ' + $n) }
        if ($script:AttrMissing.Count -gt 80) { Add-Line ('    … и ещё ' + ($script:AttrMissing.Count - 80) + ' — см. attribute-check.csv') }
    } elseif ($script:AttrCheckRows.Count -gt 0) { Add-Line '  Все атрибуты из списка владельца нашлись.' }
    Add-Line ''
    Add-Line 'ГДЕ НАЙДЕНО ТИПОВОЕ РЕШЕНИЕ'
    if ($script:SolutionFound.Count -gt 0) { foreach ($s in $script:SolutionFound) { Add-Line ('  ' + $s) } } else { Add-Line '  нигде не найдено' }
    Add-Line ''
    Add-Line 'СКОРОСТЬ'
    if ($script:Speed.Count -gt 0) { foreach ($k in $script:Speed.Keys) { $v = $script:Speed[$k]; Add-Line ('  ' + $k + ': ' + $v.Devices + ' устройств, ' + $v.TotalMs + ' мс всего, ' + $v.PerDeviceMs + ' мс на устройство') } } else { Add-Line '  не измерялась' }
    Add-Line ''
    Add-Line 'ЭКСПОРТ ЛИСТА'
    if ($script:ExportResults.Count -gt 0) { foreach ($e in $script:ExportResults) { Add-Line ('  ' + $e.Ext + ': ' + $e.Call + ', ' + $e.Size + ' байт, ' + $e.Ms + ' мс (файл в папке export)') } } else { Add-Line '  ни один формат не получен' }
    Add-Line ''
    Add-Line 'ЗАМЕТКИ'
    foreach ($f in $note) { Add-Line ('  * ' + $f.Text) }
    if ($script:Leftovers.Count -gt 0) {
        Add-Line ''
        Add-Line 'ВЕРНИТЕ ВРУЧНУЮ (скрипт не смог вернуть как было)'
        foreach ($l in $script:Leftovers) { Add-Line ('  ' + $l.Name + ' на «' + $l.Carrier + '», было «' + $l.Before + '»') }
    }
    Add-Line ''
    Add-Line 'ИТОГОВАЯ ТАБЛИЦА: ОПЕРАЦИЯ — ВАРИАНТ, КОТОРЫЙ СРАБОТАЛ'
    foreach ($r in $Rows) { Add-Line ('  {0} {1,-34} {2}  {3}' -f $(if ($r.Ok -gt 0) { '+' } else { '-' }), $r.Op, $r.Variant, $(if ($r.Ms -ne '') { [string]$r.Ms + ' мс' } else { '' })) }
    Add-Line ''
    Add-Line 'ФАЙЛЫ ЖУРНАЛА: log.txt (подробно), log.json / log.ndjson (машинный), environment.json, api.json и api-*.txt (полная опись вызовов E3), attribute-check.csv, database-lists.txt, export\'
    Add-Line 'Пришлите архив e3-probe-….zip целиком.'
    [System.IO.File]::WriteAllText((Join-Path $script:LogDir 'summary.txt'), ($lines -join "`r`n"), $script:Utf8Bom)
}

function Step-Report {
    Write-Section 'R' 'Итоги'
    $rows = Write-SummaryTable
    Write-SummaryFile $rows
    Save-Environment
    Save-ApiJson
    try {
        $doc = [ordered]@{
            summary = @($rows | ForEach-Object { [ordered]@{ op = $_.Op; variant = $_.Variant; avgMs = $_.Ms; tries = $_.Tries; ok = $_.Ok } })
            findings = @($script:Findings | ForEach-Object { [ordered]@{ kind = $_.Kind; text = $_.Text } })
            leftovers = @($script:Leftovers)
            speed = $script:Speed
            solutionFound = @($script:SolutionFound)
            attempts = @($script:Records.ToArray())
        }
        [System.IO.File]::WriteAllText($script:JsonPath, (ConvertTo-Json $doc -Depth 7), $script:Utf8Bom)
        $script:FinalJsonWritten = $true
    } catch { Write-Human ('! log.json: ' + $_.Exception.Message) 'Yellow' }
    Write-Human ''
    Write-Human ('Сводка: ' + (Join-Path $script:LogDir 'summary.txt')) 'Green'
    # Архив рядом с папкой: владельцу проще прислать один файл.
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
        $zip = $script:LogDir.TrimEnd('\', '/') + '.zip'
        if (Test-Path $zip) { Remove-Item $zip -Force }
        [System.IO.Compression.ZipFile]::CreateFromDirectory($script:LogDir, $zip)
        Write-Human ('Архив для отправки: ' + $zip) 'Green'
    } catch { Write-Human ('! Архив не создан (' + $_.Exception.Message + '). Отправьте папку целиком.') 'Yellow' }
}
