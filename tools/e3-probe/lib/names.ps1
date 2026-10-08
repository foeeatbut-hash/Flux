# Режим «по списку названий» (-NamesFile путь): для каждого названия из файла (по одному в строке, UTF-8) спрашивает E3,
# что это такое в базе: символ, компонент или подсхема/блок. ТОЛЬКО ЧТЕНИЕ, без подтверждения Y: ничего не вставляется,
# листов не создаётся, Job.LoadPart не вызывается (он подгружает деталь в проект). Размещение образцов — отдельный режим
# -PlaceSample N (lib\namesplace.ps1).
#
# Решение владельца: «Название схемы» типового решения в классификаторе = имя блока в базе E3, поэтому выделять строки в
# базе не нужно — Flux спрашивает E3 по имени. Здесь проверяется, есть ли такие имена в базе и чем они там являются.
#   1. Symbol.Load(имя, "1") (затем "") -> номер символа, 0 = нет; габарит — Symbol.GetArea / GetPlacedArea без размещения.
#   2. Component.Search(имя, "") (затем "1") -> номер компонента, 0 = нет; читаются имя, версия, тип, подтип, число выводов.
#   3. Таблицы баз компонентов и символов напрямую (ADO, режим «только чтение», как lib\dbread.ps1): где именно лежит имя.
#      Если таблица или колонка называется как блок/подсхема — вид «подсхема».
# Итог: names-report.json (по записи на имя), names-notfound.txt, сводка «символ N · компонент/подсхема M · не найдено K».

$script:NamesReport = New-Object System.Collections.ArrayList     # записи по именам, в порядке файла
$script:NamesSummary = New-Object System.Collections.ArrayList    # строки для summary.txt
$script:NamesInfo = [ordered]@{}                                  # сведения о файле, времени, проекте и размещении — в names-report.json
$script:NamesBlockPattern = '(?i)block|subcirc|module|подсх|блок|модул'
$script:NamesColumnPattern = '(?i)name|symbol|comp|block|имя|назв|наимен'

function Read-NamesFile {
    # Файл названий -> @{ Path; Names; Lines; Dups; Empty; Garbled; Error }. Кодировка — UTF-8 (BOM необязателен); короткое имя
    # файла ищется и рядом со скриптом. Повтор считается без учёта регистра: база E3 (Access) его не различает.
    param([string]$Path)
    $res = @{ Path = ''; Names = @(); Lines = 0; Dups = 0; Empty = 0; Garbled = $false; Error = '' }
    $file = $Path.Trim().Trim('"').Trim()
    foreach ($cand in @($file, (Join-Path $script:ProbeRoot $file))) {
        if ($cand -ne '' -and (Test-Path -LiteralPath $cand -PathType Leaf)) { $res.Path = [string](Resolve-Path -LiteralPath $cand).ProviderPath; break }
    }
    if ($res.Path -eq '') { $res.Error = 'файл со списком названий не найден: ' + $file + ' (ни по этому пути, ни рядом со скриптом). Скачайте его во Flux: Типовые решения -> «Скачать названия для пробы».'; return $res }
    $text = ''
    try { $text = [System.IO.File]::ReadAllText($res.Path, (New-Object System.Text.UTF8Encoding($false))) }
    catch { $res.Error = 'файл ' + $res.Path + ' не прочитан: ' + (Get-InnerException $_.Exception).Message; return $res }
    $text = $text.TrimStart([char]0xFEFF)
    if ($text.IndexOf([char]0xFFFD) -ge 0) { $res.Garbled = $true }
    $seen = @{}
    $names = New-Object System.Collections.ArrayList
    foreach ($line in [regex]::Split($text, '\r?\n')) {
        $res.Lines++
        $n = $line.Trim()
        if ($n -eq '') { $res.Empty++; continue }
        $key = $n.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { $res.Dups++; continue }
        $seen[$key] = $true
        [void]$names.Add($n)
    }
    $res.Names = @($names)
    return $res
}

function Build-DbNameIndex {
    # Имена из текстовых колонок таблиц баз компонентов и символов (только чтение): нижний регистр -> где найдено.
    # Это третья проверка после вызовов API: ловит имена, которые Symbol.Load и Component.Search не отдали, и подсказывает,
    # чем имя является (по названию таблицы). Недоступная база не ошибка: причина уходит в заметки.
    $index = @{}
    $notes = New-Object System.Collections.ArrayList
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $dbs = @(@{ Label = 'Компоненты'; Method = 'GetComponentDatabase'; Kind = 'component' }, @{ Label = 'Символы'; Method = 'GetSymbolDatabase'; Kind = 'symbol' })
    foreach ($db in $dbs) {
        $conn = Get-QuietValue $script:App $db.Method
        if ($null -eq $conn -or "$conn" -eq '') { [void]$notes.Add('база «' + $db.Label + '»: E3 не назвал строку подключения (' + $db.Method + ')'); continue }
        $cn = Open-Ado ([string]$conn)
        if ($null -eq $cn) { [void]$notes.Add('база «' + $db.Label + '» не открылась через ADO/OLEDB (нужен драйвер ACE OLEDB)'); continue }
        try {
            foreach ($t in @(Get-AdoTableNames $cn)) {
                if ($sw.Elapsed.TotalSeconds -gt 180) { [void]$notes.Add('чтение таблиц остановлено по времени (180 с)'); break }
                try {
                    foreach ($c in @(Get-AdoColumns $cn $t)) {
                        if (-not $c.Text -or $c.Name -notmatch $script:NamesColumnPattern) { continue }
                        foreach ($v in @(Get-AdoDistinct $cn $t $c.Name 200000)) {
                            $key = ([string]$v).Trim().ToLowerInvariant()
                            if ($key -eq '') { continue }
                            if (-not $index.ContainsKey($key)) { $index[$key] = New-Object System.Collections.ArrayList }
                            if ($index[$key].Count -lt 3) { [void]$index[$key].Add(@{ Db = $db.Label; Kind = $db.Kind; Table = $t; Column = $c.Name }) }
                        }
                    }
                } catch { [void]$notes.Add('таблица ' + $t + ' не прочитана: ' + (Get-InnerException $_.Exception).Message) }
            }
        } finally { Close-Ado $cn }
    }
    return @{ Index = $index; Notes = @($notes) }
}

function Get-ShortError {
    # «вернул 0 <Int32> — в E3 это неудача, ожидался номер больше нуля» -> «вернул 0»: в отчёте по сотням имён важна суть
    param([string]$Text)
    return (($Text -replace ' — в E3 это неудача.*$', '') -replace ' <\w+>', '')
}

function Find-NameInBase {
    # Одно название -> запись отчёта. Ничего не вставляет; каждый COM-вызов — в журнале (silent: по одной строке на имя в log.txt).
    param([string]$Name, $Ctx)
    $item = [ordered]@{ name = $Name; kind = 'notfound'; via = ''; width = $null; height = $null; call = ''; error = ''; ms = 0; details = $null }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $errors = New-Object System.Collections.ArrayList
    $sym = $Ctx.Sym; $comp = $Ctx.Comp

    # 1. символ: Load и габарит без размещения
    $loadVer = $null
    foreach ($ver in @('1', '')) {
        $l = Invoke-Attempt -Op 'names.symbol.load' -Label 'symbol.Load' -ArgsText ('"' + $Name + '", "' + $ver + '"') -Silent -Pos -Action { Invoke-Com -Target $sym -Name 'Load' -CallArgs @([string]$Name, [string]$ver) -RefIdx @() }
        if ($l.Ok) { $loadVer = $ver; break }
        [void]$errors.Add('Symbol.Load(«' + $ver + '»): ' + (Get-ShortError $l.Record.error))
    }
    if ($null -ne $loadVer) {
        $item.kind = 'symbol'; $item.via = 'api'
        $item.call = 'Symbol.Load("' + $Name + '", "' + $loadVer + '")'
        $ar = Try-Calls -Op 'names.symbol.area' -Target $sym -TL 'symbol' -Silent -Cands @((Cand 'GetArea' @($null, $null, $null, $null) @(0, 1, 2, 3)), (Cand 'GetPlacedArea' @($null, $null, $null, $null) @(0, 1, 2, 3)))
        foreach ($w in $ar.Wins) {
            try {
                $o = $w.Out
                $dx = [math]::Abs([double]$o[2] - [double]$o[0]); $dy = [math]::Abs([double]$o[3] - [double]$o[1])
                if ($dx -gt 0 -or $dy -gt 0) { $item.width = [math]::Round($dx, 2); $item.height = [math]::Round($dy, 2); $item.call += ' + ' + $w.Label; break }
            } catch { }
        }
        if ($null -eq $item.width) { $item.error = 'символ загружен, габарит без размещения не прочитан (GetArea, GetPlacedArea)' }
    }

    # 2. компонент: Search по базе
    if ($item.kind -eq 'notfound') {
        foreach ($ver in @('', '1')) {
            $s = Invoke-Attempt -Op 'names.component.search' -Label 'component.Search' -ArgsText ('"' + $Name + '", "' + $ver + '"') -Silent -Pos -Action { Invoke-Com -Target $comp -Name 'Search' -CallArgs @([string]$Name, [string]$ver) -RefIdx @() }
            if (-not $s.Ok) { [void]$errors.Add('Component.Search(«' + $ver + '»): ' + (Get-ShortError $s.Record.error)); continue }
            $item.kind = 'component'; $item.via = 'api'
            $item.call = 'Component.Search("' + $Name + '", "' + $ver + '")'
            $d = [ordered]@{ id = $s.Value.Ret }
            foreach ($m in @('GetName', 'GetVersion', 'GetComponentType', 'GetSubType')) {
                $v = Get-QuietValue $comp $m
                if ($null -ne $v) { $d[$m] = $(if ($m -eq 'GetVersion') { ([string]$v).Trim() } else { $v }) }
            }
            $pins = Invoke-Quiet $comp 'GetPinIds' @($null) @(0)
            if ($null -ne $pins) { $pinItems = Convert-ToItems $pins.Ret $pins.Args @(0); $d['pins'] = $pinItems.Count }
            $item.details = $d
            break
        }
    }

    # 3. таблицы базы напрямую: где лежит имя и чем оно по названию таблицы является
    if ($item.kind -eq 'notfound' -and $null -ne $Ctx.Db) {
        $key = $Name.Trim().ToLowerInvariant()
        if ($Ctx.Db.ContainsKey($key)) {
            $hit = $Ctx.Db[$key][0]
            $isBlock = ($hit.Table -match $script:NamesBlockPattern -or $hit.Column -match $script:NamesBlockPattern)
            $item.kind = $(if ($isBlock) { 'subcircuit' } elseif ($hit.Kind -eq 'symbol') { 'symbol' } else { 'component' })
            $item.via = 'db'
            $item.call = 'ADO, только чтение: база «' + $hit.Db + '», таблица ' + $hit.Table + ', колонка ' + $hit.Column
            $item.details = [ordered]@{ table = $hit.Table; column = $hit.Column; hits = $Ctx.Db[$key].Count }
            if ($hit.Kind -eq 'symbol') { $item.error = 'имя есть в таблице базы символов, но Symbol.Load его не загрузил — габарит не прочитан' }
        }
    }
    if ($item.kind -eq 'notfound') {
        if ($null -eq $Ctx.Db) { [void]$errors.Add('таблицы базы напрямую не читались') } else { [void]$errors.Add('в таблицах баз компонентов и символов имени нет') }
        $item.error = ($errors -join ' | ')
    }
    $item.ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
    return $item
}

function Get-NamesKindText {
    param($Item)
    $t = switch ($Item.kind) { 'symbol' { 'символ' } 'component' { 'компонент' } 'subcircuit' { 'подсхема' } default { 'не найдено' } }
    if ($Item.via -eq 'db') { $t += ' (по таблице базы)' }
    return $t
}

function Get-NamesCounts {
    $c = [ordered]@{ symbol = 0; component = 0; subcircuit = 0; notfound = 0; viaDb = 0 }
    foreach ($i in $script:NamesReport) {
        $c[[string]$i.kind]++
        if ($i.via -eq 'db') { $c.viaDb++ }
    }
    return $c
}

function Save-NamesReport {
    # names-report.json пишется и по ходу (каждые 25 имён), чтобы обрыв не потерял прочитанное
    $c = Get-NamesCounts
    $doc = [ordered]@{
        generated = (Get-Date).ToString('s')
        info = $script:NamesInfo
        counts = [ordered]@{ symbol = $c.symbol; component = $c.component; subcircuit = $c.subcircuit; notfound = $c.notfound; foundOnlyByDbTable = $c.viaDb }
        items = @($script:NamesReport)
    }
    try { [System.IO.File]::WriteAllText((Join-Path $script:LogDir 'names-report.json'), (ConvertTo-Json -InputObject $doc -Depth 6), $script:Utf8Bom) }
    catch { Write-Human ('! names-report.json не записан: ' + $_.Exception.Message) 'Yellow' }
}

function Get-ProjectCount {
    # Число компонентов проекта (Job.GetAllComponentIds) и устройств; -1 — прочитать не удалось. Нужно, чтобы доказать «только чтение».
    $r = Invoke-Quiet $script:Job 'GetAllComponentIds' @($null) @(0)
    $comps = -1; if ($null -ne $r) { $items = Convert-ToItems $r.Ret $r.Args @(0); $comps = $items.Count }
    $devs = -1; $r2 = Invoke-Quiet $script:Job 'GetAllDeviceIds' @($null) @(0)
    if ($null -ne $r2) { $items2 = Convert-ToItems $r2.Ret $r2.Args @(0); $devs = $items2.Count }
    return @{ Components = $comps; Devices = $devs }
}

function Step-Names {
    param([string]$File, [int]$Sample = 0)
    Write-Section 'N' 'Проверка по списку названий (только чтение)'
    $in = Read-NamesFile $File
    if ($in.Error -ne '') { Write-Human ('✕ ' + $in.Error) 'Red'; Add-Finding 'bad' ('Список названий: ' + $in.Error); return }
    Write-Human ('Файл: ' + $in.Path)
    Write-Human ('Названий: ' + $in.Names.Count + ' (строк в файле ' + $in.Lines + ', пустых ' + $in.Empty + ', повторов ' + $in.Dups + ')')
    if ($in.Garbled) { Write-Human '! В файле есть знаки U+FFFD: он сохранён не в UTF-8. Скачайте список из Flux заново (кнопка «Скачать названия для пробы»).' 'Yellow'; Add-Finding 'bad' 'Список названий сохранён не в UTF-8 (в тексте знаки U+FFFD): кириллица искажена, результаты по ней недостоверны.' }
    if ($in.Names.Count -eq 0) { Write-Human '✕ В файле нет ни одного названия.' 'Red'; Add-Finding 'bad' 'Список названий пуст.'; return }
    $first = $in.Names[0]
    Write-Human ('Первое название: «' + $first + '» (коды: ' + (($first.ToCharArray() | Select-Object -First 8 | ForEach-Object { 'U+' + ([int]$_).ToString('X4') }) -join ' ') + ')')

    $script:Job = Get-QuietValue $script:App 'CreateJobObject'
    if ($null -eq $script:Job) { Write-Human '✕ объект проекта не создан (Application.CreateJobObject).' 'Red'; Add-Finding 'bad' 'Список названий: объект проекта не создан.'; return }
    foreach ($kind in @('Sheet', 'Device', 'Symbol', 'Component')) { $script:Objects[$kind] = Get-QuietValue $script:Job ('Create' + $kind + 'Object') }
    if ($null -eq $script:Objects['Symbol'] -or $null -eq $script:Objects['Component']) { Write-Human '✕ объекты символа или компонента не созданы.' 'Red'; Add-Finding 'bad' 'Список названий: объекты Symbol/Component не созданы.'; return }

    $script:Env['e3Version'] = [string](Get-QuietValue $script:App 'GetVersion')
    $before = Get-ProjectCount
    Write-Human 'Читаю таблицы баз компонентов и символов (только чтение)…'
    $db = Build-DbNameIndex
    foreach ($n in $db.Notes) { Write-Human ('· ' + $n) 'DarkGray' }
    $dbIndex = $null; if ($db.Index.Count -gt 0) { $dbIndex = $db.Index }
    Write-Human ('Имён в таблицах баз: ' + $db.Index.Count)
    $ctx = @{ Sym = $script:Objects['Symbol']; Comp = $script:Objects['Component']; Db = $dbIndex }

    $script:NamesInfo['file'] = $in.Path
    $script:NamesInfo['names'] = $in.Names.Count
    $script:NamesInfo['duplicatesSkipped'] = $in.Dups
    $script:NamesInfo['emptyLines'] = $in.Empty
    $script:NamesInfo['dbNames'] = $db.Index.Count
    $script:NamesInfo['dbNotes'] = @($db.Notes)
    $script:NamesInfo['projectBefore'] = $before
    $total = $in.Names.Count; $i = 0
    $all = [System.Diagnostics.Stopwatch]::StartNew()
    foreach ($name in $in.Names) {
        $i++
        Write-Trace ('=== имя ' + $i + '/' + $total + ': ' + $name)
        $item = Find-NameInBase $name $ctx
        [void]$script:NamesReport.Add($item)
        $size = ''; if ($null -ne $item.width) { $size = '  габарит ' + $item.width + ' x ' + $item.height }
        Write-Human ('{0} [{1}/{2}] {3}  —  {4}{5}  ({6} мс)' -f $(if ($item.kind -eq 'notfound') { '✕' } else { '✓' }), $i, $total, $name, (Get-NamesKindText $item), $size, $item.ms) $(if ($item.kind -eq 'notfound') { 'DarkGray' } else { '' })
        if ($i % 25 -eq 0) { Save-NamesReport; Save-Json }
    }
    $all.Stop()
    $after = Get-ProjectCount
    $script:NamesInfo['projectAfter'] = $after
    $script:NamesInfo['totalSeconds'] = [math]::Round($all.Elapsed.TotalSeconds, 1)
    $c = Get-NamesCounts
    $slow = @($script:NamesReport | Sort-Object { $_.ms } -Descending | Select-Object -First 1)
    $avg = [math]::Round($all.Elapsed.TotalMilliseconds / $total, 1)
    $script:NamesInfo['avgMsPerName'] = $avg

    $line = 'символ ' + $c.symbol + ' · компонент/подсхема ' + ($c.component + $c.subcircuit) + ' · не найдено ' + $c.notfound
    Write-Human ''
    Write-Human ('ИТОГ: ' + $line) 'Green'
    Write-Human ('Время: всего ' + [math]::Round($all.Elapsed.TotalSeconds, 1) + ' с, в среднем ' + $avg + ' мс на имя; дольше всех — «' + $slow[0].name + '» (' + $slow[0].ms + ' мс)')
    if ($c.subcircuit -gt 0) { Write-Human ('  из них подсхем/блоков (по названию таблицы базы): ' + $c.subcircuit) }
    if ($c.viaDb -gt 0) { Write-Human ('  найдено только по таблице базы, без вызова API: ' + $c.viaDb) }
    $sized = @($script:NamesReport | Where-Object { $_.kind -eq 'symbol' -and $null -ne $_.width }).Count
    Write-Human ('Габарит без размещения прочитан у символов: ' + $sized + ' из ' + $c.symbol)

    $lost = @($script:NamesReport | Where-Object { $_.kind -eq 'notfound' } | ForEach-Object { $_.name })
    if ($lost.Count -gt 0) {
        Write-Human ('Не найдены (' + $lost.Count + '):') 'Yellow'
        foreach ($n in ($lost | Select-Object -First 200)) { Write-Human ('  ' + $n) }
        if ($lost.Count -gt 200) { Write-Human ('  … и ещё ' + ($lost.Count - 200) + ' — полный список в names-notfound.txt') }
    }
    try { [System.IO.File]::WriteAllText((Join-Path $script:LogDir 'names-notfound.txt'), (($lost | ForEach-Object { $_ + "`r`n" }) -join ''), $script:Utf8Bom) } catch { }

    $readOnly = ($before.Components -eq $after.Components -and $before.Devices -eq $after.Devices)
    if ($before.Components -ge 0) {
        Write-Human ('Проект до и после: компонентов ' + $before.Components + ' -> ' + $after.Components + ', устройств ' + $before.Devices + ' -> ' + $after.Devices + $(if ($readOnly) { ' (не изменился)' } else { ' (ИЗМЕНИЛСЯ)' }))
        if (-not $readOnly) { Add-Finding 'bad' ('По списку названий число компонентов или устройств проекта изменилось (' + $before.Components + ' -> ' + $after.Components + ' компонентов, ' + $before.Devices + ' -> ' + $after.Devices + ' устройств): какой-то из вызовов чтения что-то подгрузил в проект — смотрите trace.log и не сохраняйте проект.') }
    } else { Write-Human 'Число компонентов проекта прочитать не удалось (проект не открыт?): доказательство «проект не изменился» недоступно.' 'DarkGray' }

    [void]$script:NamesSummary.Add('Файл: ' + $in.Path + '; названий ' + $total + ' (повторов пропущено ' + $in.Dups + ', пустых строк ' + $in.Empty + ')')
    [void]$script:NamesSummary.Add($line)
    [void]$script:NamesSummary.Add('Время: всего ' + [math]::Round($all.Elapsed.TotalSeconds, 1) + ' с, в среднем ' + $avg + ' мс на имя; дольше всех «' + $slow[0].name + '» (' + $slow[0].ms + ' мс)')
    [void]$script:NamesSummary.Add('Габарит символа без размещения прочитан: ' + $sized + ' из ' + $c.symbol + '; найдено только по таблице базы (без API): ' + $c.viaDb + '; подсхем/блоков по названию таблицы: ' + $c.subcircuit)
    if ($before.Components -ge 0) { [void]$script:NamesSummary.Add('Проект до и после чтения: компонентов ' + $before.Components + ' -> ' + $after.Components + ', устройств ' + $before.Devices + ' -> ' + $after.Devices) }
    if ($db.Notes.Count -gt 0) { [void]$script:NamesSummary.Add('Таблицы базы: ' + ($db.Notes -join '; ')) }
    if ($lost.Count -gt 0) {
        [void]$script:NamesSummary.Add('Не найдены (' + $lost.Count + '):')
        foreach ($n in ($lost | Select-Object -First 100)) { [void]$script:NamesSummary.Add('  ' + $n) }
        if ($lost.Count -gt 100) { [void]$script:NamesSummary.Add('  … и ещё ' + ($lost.Count - 100) + ' — names-notfound.txt') }
    }
    Add-Finding $(if ($c.notfound -lt $total) { 'ok' } else { 'need' }) ('По списку названий (' + $total + '): ' + $line + '.')
    if ($lost.Count -gt 0) { Add-Finding 'need' ('Не найдены в базе E3 (' + $lost.Count + '): ' + (($lost | Select-Object -First 12) -join ', ') + $(if ($lost.Count -gt 12) { ' … (полный список в names-notfound.txt)' } else { '' })) }
    Save-NamesReport

    if ($Sample -gt 0) {
        $found = @($script:NamesReport | Where-Object { $_.kind -ne 'notfound' } | Select-Object -First $Sample)
        if ($found.Count -eq 0) { Write-Human 'Размещать нечего: ни одно название не найдено.' 'Yellow'; Add-Finding 'note' 'PlaceSample: найденных названий нет, ничего не размещалось.' }
        else { Step-NamesPlace $found }
    }
}
