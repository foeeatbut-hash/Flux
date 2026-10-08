# Раздел 4 и E: база E3 — путь и режим, определения атрибутов, классы, компоненты, символы, блоки, поиск типового решения.

$script:SolutionFound = New-Object System.Collections.ArrayList
$script:DbLists = [ordered]@{}      # название списка -> имена (для файла database-lists.txt)

function Add-DbList {
    param([string]$Title, $Items)
    if ($null -eq $Items) { return }
    $script:DbLists[$Title] = @($Items | ForEach-Object { [string]$_ })
}

function Find-InList {
    # Совпадение с именем решения в списке: точное, по вхождению и по частям имени.
    param([string]$Title, $Items, [string]$Name)
    if ($null -eq $Items -or @($Items).Count -eq 0) { return }
    $strings = @($Items | ForEach-Object { [string]$_ })
    $exact = @($strings | Where-Object { $_ -eq $Name })
    $part = @($strings | Where-Object { $_ -like ('*' + $Name + '*') })
    if ($exact.Count -gt 0) { [void]$script:SolutionFound.Add('точно: ' + $Title); Write-Human ('✓ «' + $Name + '» найдено ТОЧНО в списке: ' + $Title) 'Green' }
    elseif ($part.Count -gt 0) { [void]$script:SolutionFound.Add('по вхождению (' + $part.Count + '): ' + $Title + ' — ' + (($part | Select-Object -First 3) -join ' | ')); Write-Human ('~ «' + $Name + '» по вхождению в списке ' + $Title + ': ' + (($part | Select-Object -First 5) -join ' | ')) }
    else {
        $tokens = @($Name -split '_' | Where-Object { $_.Length -ge 2 })
        $near = @(); foreach ($t in $tokens) { $near += @($strings | Where-Object { $_ -like ('*' + $t + '*') } | Select-Object -First 3) }
        if ($near.Count -gt 0) { Write-Human ('· похожие имена в списке ' + $Title + ': ' + (($near | Select-Object -Unique -First 6) -join ' | ')) }
    }
}

function Step-Database {
    Write-Section '4' 'База E3: настройки, определения, компоненты, символы, блоки'
    $job = $script:Job; $app = $script:App
    $name = $script:SolutionName

    # --- путь, тип, режим базы
    $infoNames = @('GetDatabasePath', 'GetDatabaseName', 'GetDatabaseType', 'GetDatabaseMode', 'GetComponentDatabase', 'GetComponentDatabasePath', 'GetSymbolDatabase', 'GetSymbolDatabasePath', 'GetDatabase', 'GetDBPath', 'GetDBName', 'GetDBType', 'IsSqlDatabase', 'IsSQL', 'GetServerName', 'GetDatabaseServer', 'GetLibraryPath', 'GetLibraryName', 'GetDatabaseVersion', 'GetCurrentDatabase')
    $cands = @(); foreach ($n in $infoNames) { $cands += , (Cand $n) }
    $dbJob = Try-Calls -Op 'db.info.job' -Target $job -TL 'job' -Cands $cands
    $dbApp = Try-Calls -Op 'db.info.app' -Target $app -TL 'app' -Cands $cands
    $dbInfo = [ordered]@{}
    foreach ($w in $dbJob.Wins) { $dbInfo[$w.Label] = Format-Plain $w.Value 250 }
    foreach ($w in $dbApp.Wins) { $dbInfo[$w.Label] = Format-Plain $w.Value 250 }
    $script:Env['database'] = $dbInfo
    if ($dbInfo.Count -gt 0) { Add-Finding 'ok' ('База E3: ' + (($dbInfo.Keys | ForEach-Object { $_ + '=' + $dbInfo[$_] }) -join '; ')) } else { Add-Finding 'need' 'Путь и тип базы E3 (локальная или SQL) прочитать не удалось.' }

    # --- определения атрибутов
    $attrObj = $script:Objects['Attribute']
    $defCands = @((Cand 'GetAttributeNames' @($null) @(0)), (Cand 'GetAllAttributeNames' @($null) @(0)), (Cand 'GetAttributeDefinitions' @($null) @(0)), (Cand 'GetAttributeList' @($null) @(0)), (Cand 'GetAttributeIds' @($null) @(0)), (Cand 'GetDefinedAttributeNames' @($null) @(0)), (Cand 'GetAttributeNames' @($null, 0) @(0)), (Cand 'GetAttributeNames' @($null, 1) @(0)))
    $defNames = $null
    $defSources = @(@{ T = $job; L = 'job'; Op = 'db.attrdefs.job' }, @{ T = $app; L = 'app'; Op = 'db.attrdefs.app' })
    if ($null -ne $attrObj) {
        $defSources += @{ T = $attrObj; L = 'attribute'; Op = 'db.attrdefs.attribute' }
    }
    $idCands = @((Cand 'GetIds' @($null) @(0)), (Cand 'GetNames' @($null) @(0)), (Cand 'GetAllIds' @($null) @(0)), (Cand 'GetAttributeIds' @($null) @(0)), (Cand 'GetAll' @($null) @(0)), (Cand 'GetCount'))
    foreach ($s in $defSources) {
        $c = $defCands; if ($s.L -eq 'attribute') { $c = $idCands + $defCands }
        $r = Try-Calls -Op $s.Op -Target $s.T -TL $s.L -Cands $c
        if ($null -ne $r.Items -and $r.Items.Count -gt 0 -and $null -eq $defNames) {
            $first = $r.Items[0]
            if ($first -is [string]) { $defNames = @($r.Items | ForEach-Object { [string]$_ }); $script:DefSource = $r.Winner }
            elseif ($null -ne $attrObj) {
                # идентификаторы -> имена и сведения (на чём, тип)
                $detail = @(); $names = @(); $n = 0
                foreach ($id in $r.Items) {
                    if ($n -ge 3000) { break }; $n++
                    [void](Invoke-Quiet $attrObj 'SetId' @($id))
                    $nm = Get-QuietValue $attrObj 'GetName'
                    if ($null -eq $nm) { $nm = Get-QuietValue $attrObj 'GetAttributeName' }
                    if ($null -eq $nm) { continue }
                    $names += [string]$nm
                    $ty = Get-QuietValue $attrObj 'GetType'; if ($null -eq $ty) { $ty = Get-QuietValue $attrObj 'GetValueType' }
                    $ow = Get-QuietValue $attrObj 'GetOwner'; if ($null -eq $ow) { $ow = Get-QuietValue $attrObj 'GetObjectType' }; if ($null -eq $ow) { $ow = Get-QuietValue $attrObj 'GetCarrier' }
                    $detail += ([string]$nm + ';' + (Format-Value $ty 40) + ';' + (Format-Value $ow 40))
                }
                if ($names.Count -gt 0) { $defNames = $names; $script:DefSource = $r.Winner + ' + attribute.GetName'; Add-DbList 'Определения атрибутов (имя;тип;носитель)' $detail }
            }
        }
    }
    $script:AttrDefNames = $defNames
    if ($null -ne $defNames) {
        Write-Human ('Определений атрибутов в базе: ' + $defNames.Count)
        Add-DbList 'Определения атрибутов' $defNames
        [System.IO.File]::WriteAllText((Join-Path $script:LogDir 'attribute-definitions.txt'), ($defNames -join "`r`n"), $script:Utf8Bom)
        Add-Finding 'ok' ('Список определений атрибутов читается (' + $defNames.Count + '), вызов: ' + $script:DefSource)
    } else { Add-Finding 'need' 'Список определений атрибутов через API получить не удалось: наличие атрибутов проверено по записи на временных объектах (attribute-check.csv).' }

    # --- классы, компоненты, символы, блоки
    $comp = $script:Objects['Component']; $sym = $script:Objects['Symbol']; $blk = $script:Objects['Block']
    $lists = @(
        @{ Title = 'Классы компонентов'; Op = 'db.classes'; Pairs = @(@($comp, 'component'), @($job, 'job'), @($app, 'app')); Names = @('GetClassNames', 'GetClassIds', 'GetClasses', 'GetComponentClasses', 'GetClassList') },
        @{ Title = 'Компоненты'; Op = 'db.components'; Pairs = @(@($comp, 'component'), @($job, 'job'), @($app, 'app')); Names = @('GetComponentNames', 'GetComponentIds', 'GetNames', 'GetIds', 'GetAllComponentNames', 'GetComponents', 'GetAllNames', 'GetPartNames') },
        @{ Title = 'Символы'; Op = 'db.symbols'; Pairs = @(@($sym, 'symbol'), @($job, 'job'), @($app, 'app')); Names = @('GetSymbolNames', 'GetSymbolList', 'GetAllSymbolNames', 'GetNames', 'GetSymbols', 'GetLibrarySymbolNames', 'GetAllNames') },
        @{ Title = 'Блоки и подсхемы'; Op = 'db.blocks'; Pairs = @(@($blk, 'block'), @($job, 'job'), @($app, 'app')); Names = @('GetBlockNames', 'GetBlockList', 'GetSubCircuitNames', 'GetModuleNames', 'GetNames', 'GetBlocks', 'GetAllBlockNames', 'GetSubCircuits') }
    )
    foreach ($l in $lists) {
        $got = $null
        foreach ($pair in $l.Pairs) {
            if ($null -eq $pair[0]) { continue }
            $cs = @(); foreach ($n in $l.Names) { $cs += , (Cand $n @($null) @(0)); $cs += , (Cand $n @($null, 0) @(0)) }
            $r = Try-Calls -Op ($l.Op + '.' + $pair[1]) -Target $pair[0] -TL $pair[1] -Cands $cs
            if ($null -ne $r.Items -and $r.Items.Count -gt 0) { $got = $r.Items; Write-Human ('«' + $l.Title + '»: ' + $r.Items.Count + ' (' + $r.Winner + ')'); break }
        }
        if ($null -ne $got) {
            Add-DbList $l.Title $got
            Find-InList $l.Title $got $name
            Add-Finding 'ok' ($l.Title + ' читаются: ' + @($got).Count + '.')
        } else { Add-Finding 'need' ($l.Title + ': список через API получить не удалось.') }
    }
    [System.IO.File]::WriteAllText((Join-Path $script:LogDir 'database-lists.txt'), (($script:DbLists.Keys | ForEach-Object { '### ' + $_ + ' (' + $script:DbLists[$_].Count + ')' + "`r`n" + (($script:DbLists[$_] | Select-Object -First 5000) -join "`r`n") }) -join "`r`n`r`n"), $script:Utf8Bom)

    # --- поиск решения по имени через объекты базы (без вставки на лист)
    Write-Human ('-- Поиск «' + $name + '» вызовами базы')
    if ($null -ne $comp) {
        $s1 = Try-Calls -Op 'db.find.component' -Target $comp -TL 'component' -Cands @((Cand 'Search' @($name, '') -Pos), (Cand 'Search' @($name, '1') -Pos)) -Silent
        foreach ($w in $s1.Wins) { [void]$script:SolutionFound.Add('компонент: ' + $w.Label + ' -> ' + (Format-Value $w.Value 80)) }
        if ($s1.Ok) {
            Write-Human ('✓ компонент: ' + $s1.Winner + ' -> ' + (Format-Value $s1.Value 120)) 'Green'
            # чтение свойств без вставки
            $props = @(); foreach ($n in @('GetName', 'GetClass', 'GetClassName', 'GetDescription', 'GetVersion', 'GetSymbolIds', 'GetPinCount', 'GetGateCount', 'GetPinIds', 'GetType', 'GetAttributeValue')) { $props += , (Cand $n) }
            $props += , (Cand 'GetAttributeValue' @('GLOBAL_BLOCK_ID'))
            $props += , (Cand 'GetSymbolIds' @($null) @(0))
            $props += , (Cand 'GetPinIds' @($null) @(0))
            [void](Try-Calls -Op 'db.component.props' -Target $comp -TL 'component' -Cands $props)
        }
    }
    if ($null -ne $sym) {
        $s2 = Try-Calls -Op 'db.find.symbol' -Target $sym -TL 'symbol' -Cands @((Cand 'Load' @($name, '') -Pos), (Cand 'Load' @($name, '1') -Pos)) -Silent
        foreach ($w in $s2.Wins) { [void]$script:SolutionFound.Add('символ: ' + $w.Label + ' -> ' + (Format-Value $w.Value 80)) }
        if ($s2.Ok) { Write-Human ('✓ символ: ' + $s2.Winner + ' -> ' + (Format-Value $s2.Value 120)) 'Green' }
    }
    if ($null -ne $blk) {
        $s3 = Try-Calls -Op 'db.find.block' -Target $blk -TL 'block' -Cands @((Cand 'Load' @($name, '') -Pos)) -Silent
        foreach ($w in $s3.Wins) { [void]$script:SolutionFound.Add('блок: ' + $w.Label + ' -> ' + (Format-Value $w.Value 80)) }
        if ($s3.Ok) { Write-Human ('✓ блок: ' + $s3.Winner + ' -> ' + (Format-Value $s3.Value 120)) 'Green' }
    }
    foreach ($tgt in @(@($job, 'job'), @($app, 'app'))) {
        $s4 = Try-Calls -Op ('db.find.' + $tgt[1]) -Target $tgt[0] -TL $tgt[1] -Cands @((Cand 'GetSymbolIds' @($null, $name) @(0))) -Silent
        foreach ($w in $s4.Wins) { if (@($w.Items).Count -gt 0) { [void]$script:SolutionFound.Add($tgt[1] + ': ' + $w.Label + ' -> ' + @($w.Items).Count + ' символов в проекте') } }
    }

    # --- файлы на диске (.e3p, .e3d и любые с таким именем)
    $roots = @()
    foreach ($r in @($script:Env.progIds)) { if ($r.server) { $dir = Split-Path -Parent ([string]$r.server -replace '"', ''); if ($dir) { $roots += $dir } } }
    if ($script:ProjectPath) { try { $roots += (Split-Path -Parent $script:ProjectPath) } catch { } }
    $docs = @(); if ($env:PUBLIC) { $docs += (Join-Path $env:PUBLIC 'Documents') }; if ($env:USERPROFILE) { $docs += (Join-Path $env:USERPROFILE 'Documents') }
    foreach ($p in (@($env:ProgramData) + $docs)) { if ($p) { $roots += $p } }
    $roots = @($roots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $files = @()
    foreach ($root in $roots) {
        if ($sw.Elapsed.TotalSeconds -gt 40) { Write-Human '· поиск файлов остановлен по времени (40 с)'; break }
        try { $files += @(Get-ChildItem -Path $root -Filter ('*' + $name + '*') -Recurse -Depth 3 -File -ErrorAction SilentlyContinue | Select-Object -First 10 | ForEach-Object { $_.FullName }) } catch { }
    }
    $script:SolutionFiles = @($files | Select-Object -Unique)
    foreach ($f in $script:SolutionFiles) { [void]$script:SolutionFound.Add('файл: ' + $f); Write-Human ('✓ файл: ' + $f) 'Green' }
    Write-Human ('Каталоги поиска: ' + ($roots -join '; '))
    $rec = [ordered]@{ seq = 0; step = $script:Step; op = 'db.find.files'; candidate = 'Get-ChildItem'; args = $name; ok = ($script:SolutionFiles.Count -gt 0); type = 'String[]'; result = (($script:SolutionFiles) -join ' | '); error = $(if ($script:SolutionFiles.Count -gt 0) { $null } else { 'файлов не найдено' }); hresult = $null; busy = $false; ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1) }
    $script:Seq++; $rec.seq = $script:Seq; Add-Record $rec

    if ($script:SolutionFound.Count -gt 0) { Add-Finding 'ok' ('Типовое решение «' + $name + '» найдено: ' + (($script:SolutionFound | Select-Object -First 6) -join '; ')) }
    else { Add-Finding 'need' ('Типовое решение «' + $name + '» не найдено ни среди компонентов, символов, блоков, ни среди файлов. Укажите имя существующего решения: -SolutionName <имя>.') }
    $script:Env['solutionFound'] = @($script:SolutionFound)
    Save-Environment
}
$script:SolutionFiles = @()
$script:DefSource = ''
