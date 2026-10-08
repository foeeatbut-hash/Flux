# Каталог по API (только чтение): какие данные об изделиях и символах E3 отдаёт сам API, без чтения components.mdb/symbols.mdb.
# Источники имён: выделенное инженером в базе E3 (основное приложение: GetDatabaseTree/TableSelected*, затем API редактора базы), и
# компоненты открытого проекта (Job.GetAllComponentIds). Полного списка базы в API нет. Ничего не пишется и не сохраняется;
# редактор компонента (EditComponent) не открывается, поэтому и закрывать нечего.

$script:DbeClsid = '{fc37390f-d65e-4c31-a24a-7536f40ffd93}'
$script:CatalogSymbolName = 'Вентилятор_ЗТД_К'

function Get-DbeApplication {
    # Редактор базы: через приложение (методы CreateDbe*), затем по ProgID-кандидатам, затем по CLSID coclass e3DbeApplication.
    param($App)
    if ($script:Fake) { return $script:FakeDbe }
    if (-not $script:Fake) {
        try {
            $progs = @(Get-ChildItem 'Registry::HKEY_CLASSES_ROOT' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^CT\.' } | ForEach-Object { $_.PSChildName })
            Write-Human ('ProgID семейства CT.* в реестре: ' + $(if ($progs.Count) { $progs -join ', ' } else { 'нет' }))
            Add-Finding 'note' ('Каталог по API: ProgID CT.* в реестре: ' + ($progs -join ', '))
        } catch { }
    }
    $names = @(); if ($script:ApiNames.ContainsKey('Application')) { $names = @($script:ApiNames['Application']) }
    foreach ($n in @($names | Where-Object { $_ -match '^CreateDbe|^GetDbe' })) {
        $r = Invoke-Attempt -Op 'catalog.dbe.fromapp' -Label ('application.' + $n) -ArgsText '' -Action { Invoke-Com -Target $App -Name $n -CallArgs @() -RefIdx @() }
        if ($r.Ok -and $null -ne $r.Value -and $null -ne $r.Value.Ret -and (Test-ComObject $r.Value.Ret)) { return $r.Value.Ret }
    }
    foreach ($prog in @('CT.DbeApplication', 'CT.DbeJob', 'CT.Dbe')) {
        $r = Invoke-Attempt -Op 'catalog.dbe.progid' -Label 'New-Object -ComObject' -ArgsText ('"' + $prog + '"') -Action { New-Object -ComObject $prog }
        if ($r.Ok -and $null -ne $r.Value) { return $r.Value }
    }
    $r = Invoke-Attempt -Op 'catalog.dbe.clsid' -Label 'Activator.CreateInstance' -ArgsText $script:DbeClsid -Action { [Activator]::CreateInstance([Type]::GetTypeFromCLSID([Guid]$script:DbeClsid)) }
    if ($r.Ok -and $null -ne $r.Value) { return $r.Value }
    return $null
}

function Get-RefItems {
    # Convert-ToItems отдаёт массив запятой-оболочкой; здесь он разворачивается в плоский список.
    param($Ref)
    if ($null -eq $Ref) { return @() }
    $items = Convert-ToItems $Ref.Ret $Ref.Args @(0)
    return @($items)
}

function Get-SelectedNames {
    # Выделенное в базе: два ref-массива (имена, версии). Возвращает список пар; $Target — приложение или редактор базы.
    param($Target, [string]$Method, [string]$Tag)
    $res = Try-Calls -Op ('catalog.selected.' + $Tag + '.' + $Method) -Target $Target -TL $Tag -Cands @((Cand $Method @($null, $null) @(0, 1))) -First
    $pairs = @()
    if ($res.Ok -and @($res.Out).Count -ge 2) {
        $names = @($res.Out[0]); $vers = @($res.Out[1])
        for ($i = 0; $i -lt $names.Count; $i++) {
            if ($names[$i] -isnot [string] -or $names[$i] -eq '') { continue }
            $v = ''; if ($i -lt $vers.Count) { $v = [string]$vers[$i] }
            $pairs += , @($names[$i], $v)
        }
    }
    Write-Human ('  ' + $Tag + '.' + $Method + ': имён ' + $pairs.Count)
    return , $pairs
}

function Read-SymbolSize {
    # Symbol.Load без размещения, затем кандидаты чтения области. Возвращает @(метод, ширина, высота) или $null.
    param($Sym, [string]$Name, [string]$Ver)
    $l = Invoke-Attempt -Op 'catalog.symbol.load' -Label 'symbol.Load' -ArgsText ('"' + $Name + '", "' + $Ver + '"') -Pos -Action { Invoke-Com -Target $Sym -Name 'Load' -CallArgs @([string]$Name, [string]$Ver) -RefIdx @() }
    if (-not $l.Ok -and $Ver -ne '1') { $Ver = '1'; $l = Invoke-Attempt -Op 'catalog.symbol.load' -Label 'symbol.Load' -ArgsText ('"' + $Name + '", "1"') -Pos -Action { Invoke-Com -Target $Sym -Name 'Load' -CallArgs @([string]$Name, [string]'1') -RefIdx @() } }
    if (-not $l.Ok) { return $null }
    $areaCands = @((Cand 'GetArea' @($null, $null, $null, $null) @(0, 1, 2, 3)), (Cand 'GetPlacedArea' @($null, $null, $null, $null) @(0, 1, 2, 3)))
    $ar = Try-Calls -Op 'catalog.symbol.area' -Target $Sym -TL 'symbol' -Cands $areaCands -Silent
    foreach ($w in $ar.Wins) { try { $o = $w.Out; $dx = [math]::Abs([double]$o[2] - [double]$o[0]); $dy = [math]::Abs([double]$o[3] - [double]$o[1]); if ($dx -gt 0 -or $dy -gt 0) { return @($w.Label, $dx, $dy) } } catch { } }
    return @('нет', 0, 0)
}

function Wait-CatalogKey {
    # Пауза до Enter: ReadKey, а без консоли (перенаправленный ввод) — Read-Host. В режиме без вопросов пауз нет.
    param([string]$Text)
    Write-Human ''
    Write-Human $Text 'Yellow'
    if ($script:NoConfirm) { return }
    try { while ($true) { $k = [Console]::ReadKey($true); if ($k.Key -eq [ConsoleKey]::Enter) { break } } }
    catch { [void](Read-Host 'Enter') }
}

function Read-CatalogSelection {
    # Один тест выделения: имена из дерева (изделия, символы) и таблицы основного приложения; затем таблица редактора базы.
    param([string]$Title, $Dbe)
    Write-Human ($Title + ':')
    $c = Get-SelectedNames $script:App 'GetDatabaseTreeSelectedComponents' 'app'
    $y = Get-SelectedNames $script:App 'GetDatabaseTreeSelectedSymbols' 'app'
    $t = Get-SelectedNames $script:App 'GetDatabaseTableSelectedComponents' 'app'
    if ($null -ne $Dbe) { $d = Get-SelectedNames $Dbe 'GetDatabaseTableSelectedComponents' 'dbe'; foreach ($p in $d) { $t += , $p } }
    $first = @(@($y) + @($c) + @($t) | Select-Object -First 20 | ForEach-Object { $_[0] })
    Write-Human ('  первые 20: ' + ($first -join ', '))
    return @{ Comps = @($c); Syms = @($y); Table = @($t) }
}

function Read-ComponentCard {
    # Всё, что объект-компонент отдаёт чтением: имя, версия, тип, подтип, атрибуты, выводы, виды, состояния.
    param($Comp, [string]$Tag)
    $card = [ordered]@{ source = $Tag }
    foreach ($m in @('GetName', 'GetVersion', 'GetComponentType', 'GetSubType', 'GetModelName', 'GetAttributeCount', 'GetGID')) {
        $v = Get-QuietValue $Comp $m; if ($null -ne $v) { $card[$m] = $v }
    }
    foreach ($m in @('GetPinIds', 'GetStateIds', 'GetFormboardSymbolIds', 'GetSupplyPinIds', 'GetSymbolIds', 'GetViewDefinitions')) {
        $ref = Invoke-Quiet $Comp $m @($null) @(0)
        if ($null -ne $ref) { $card[$m] = @(Get-RefItems $ref) }
    }
    $ref = Invoke-Quiet $Comp 'GetAttributeIds' @($null) @(0)
    if ($null -ne $ref) {
        $attrs = [ordered]@{}
        $aobj = $script:CatAttr
        foreach ($aid in @(Get-RefItems $ref)) {
            if ($null -ne $aobj -and (Select-Id $aobj $aid)) {
                $nm = [string](Get-QuietValue $aobj 'GetName')
                $val = Get-QuietValue $aobj 'GetFormattedValue'; if ($null -eq $val) { $val = Get-QuietValue $aobj 'GetValue' }
                if ($nm -ne '') { $attrs[$nm] = [string]$val }
            }
            if ($attrs.Count -ge 60) { break }
        }
        $card['attributes'] = $attrs
        $card['attributeIds'] = @(Get-RefItems $ref).Count
    }
    return $card
}

function Step-Catalog {
    Write-Section 'K' 'Каталог по API (только чтение)'
    Write-Human 'Панель «База данных» E3 должна быть открыта: ниже два теста с выделением (только чтение).' 'Yellow'
    $cards = New-Object System.Collections.ArrayList
    $dbe = Get-DbeApplication $script:App
    $job = Get-QuietValue $script:App 'CreateJobObject'
    $comp = $null; $sym = $null
    if ($null -ne $job) {
        $comp = Get-QuietValue $job 'CreateComponentObject'; $sym = Get-QuietValue $job 'CreateSymbolObject'
        $script:CatAttr = Get-QuietValue $job 'CreateAttributeObject'
    }
    # 1. два теста выделения. Источник — основное приложение (дерево и таблица), затем редактор базы
    $dbePairs = @()
    if ($null -eq $dbe) {
        Write-Human '— API редактора базы не подключился (ни приложение, ни ProgID, ни CLSID).' 'Yellow'
        Add-Finding 'note' 'Каталог по API: редактор базы (e3DbeApplication) не подключился.'
    } else {
        [void](Export-ApiObject $dbe 'DbeApplication')
        $ids = Invoke-Quiet $dbe 'GetComponentIds' @($null) @(0)
        if ($null -ne $ids) { $n = @(Get-RefItems $ids).Count; Write-Human ('  Dbe.GetComponentIds: идентификаторов ' + $n); Add-Finding 'note' ('Каталог по API: Dbe.GetComponentIds вернул ' + $n + ' шт. (полный список базы или только выбор — смотрите число).') }
    }
    Wait-CatalogKey 'Тест 1: выделите в дереве базы E3 одну ПАПКУ с символами и нажмите Enter'
    $t1 = Read-CatalogSelection 'Тест 1 (папка)' $dbe
    Wait-CatalogKey 'Тест 2: теперь выделите несколько СИМВОЛОВ (Ctrl/Shift) и нажмите Enter'
    $t2 = Read-CatalogSelection 'Тест 2 (несколько символов)' $dbe
    $t1Count = $t1.Comps.Count + $t1.Syms.Count
    $verdict = 'ничего не выделено'
    if ($t1Count -gt 1) { $verdict = 'папка отдаёт содержимое (имён больше одного)' } elseif ($t1Count -eq 1) { $verdict = 'вернулось одно имя — вероятно, только сама папка' }
    Add-Finding 'note' ('КАТАЛОГ ПО API, тест 1 (папка): изделий ' + $t1.Comps.Count + ', символов ' + $t1.Syms.Count + ', таблица ' + $t1.Table.Count + ' — ' + $verdict + '. Первые 20: ' + ((@($t1.Syms) + @($t1.Comps) | Select-Object -First 20 | ForEach-Object { $_[0] }) -join ', '))
    Add-Finding 'note' ('КАТАЛОГ ПО API, тест 2 (символы): символов ' + $t2.Syms.Count + ', изделий ' + $t2.Comps.Count + ', таблица ' + $t2.Table.Count + '. Первые 20: ' + ((@($t2.Syms) | Select-Object -First 20 | ForEach-Object { $_[0] }) -join ', '))
    $seen = @{}; $selNames = @(); $selVers = @()
    foreach ($pair in (@($t1.Comps) + @($t1.Table) + @($t2.Comps) + @($t2.Table))) { if ($null -eq $pair -or $seen.ContainsKey($pair[0])) { continue }; $seen[$pair[0]] = $true; $selNames += $pair[0]; $selVers += $pair[1] }
    $treeSyms = @($t2.Syms)
    Write-Human ('Для чтения карточек уникальных изделий: ' + $selNames.Count)
    # 2. по каждому выделенному имени (первые 5) — через объект-компонент проекта (Search по базе)
    $k = 0
    foreach ($nm in ($selNames | Select-Object -First 5)) {
        $ver = ''; if ($k -lt $selVers.Count) { $ver = [string]$selVers[$k] }; $k++
        if ($null -eq $comp) { break }
        $s = Invoke-Attempt -Op 'catalog.component.search' -Label 'component.Search' -ArgsText ('"' + $nm + '", "' + $ver + '"') -Action { Invoke-Com -Target $comp -Name 'Search' -CallArgs @([string]$nm, [string]$ver) -RefIdx @() }
        if ($s.Ok -and (Test-Positive $s.Value)) { [void]$cards.Add((Read-ComponentCard $comp ('component.Search ' + $nm))) }
    }
    # 3. компоненты открытого проекта (первые 5)
    if ($null -ne $job -and $null -ne $comp) {
        $pr = Try-Calls -Op 'catalog.project.components' -Target $job -TL 'job' -Cands @((Cand 'GetAllComponentIds' @($null) @(0))) -First
        $pids = @(); if ($pr.Ok) { $pids = @($pr.Items) }
        Write-Human ('Компонентов в открытом проекте: ' + $pids.Count)
        foreach ($id in ($pids | Select-Object -First 5)) { if (Select-Id $comp $id) { [void]$cards.Add((Read-ComponentCard $comp 'job.GetAllComponentIds')) } }
    }
    # 4. символы из выделения в дереве и подтверждённый символ: Load без размещения и габарит
    if ($null -ne $sym) {
        $symList = @(); foreach ($pair in (@($treeSyms) | Select-Object -First 3)) { $symList += , $pair }
        $symList += , @($script:CatalogSymbolName, '1')
        $sizes = @(); $cnt = 0
        foreach ($pair in $symList) {
            if ($cnt -ge 30) { break }; $cnt++
            $size = Read-SymbolSize $sym $pair[0] $pair[1]
            if ($null -eq $size) { Write-Human ('  символ «' + $pair[0] + '»: Load не прошёл'); $sizes += [ordered]@{ name = $pair[0]; version = $pair[1]; loaded = $false }; continue }
            Write-Human ('  символ «' + $pair[0] + '»: габарит ' + $(if ($size[0] -eq 'нет') { 'без размещения не прочитан' } else { [string]$size[1] + ' x ' + [string]$size[2] + ' (' + $size[0] + ')' }))
            $sizes += [ordered]@{ name = $pair[0]; version = $pair[1]; loaded = $true; method = $size[0]; width = $size[1]; height = $size[2] }
        }
        $okSizes = @($sizes | Where-Object { $_.loaded -and $_.method -ne 'нет' }).Count
        Add-Finding $(if ($okSizes -gt 0) { 'ok' } else { 'note' }) ('Каталог по API: символов проверено ' + @($sizes).Count + ', габарит без размещения прочитан у ' + $okSizes + '.')
        $script:CatalogSizes = $sizes
    }
    Write-Human ('Прочитано карточек изделий: ' + $cards.Count)
    foreach ($c in $cards) { Write-Human ('  ' + $c.source + ': ' + [string]$c['GetName'] + ' v' + [string]$c['GetVersion'] + '; тип ' + [string]$c['GetComponentType'] + '/' + [string]$c['GetSubType'] + '; атрибутов ' + @($c['attributes'].Keys).Count + '; выводов ' + @($c['GetPinIds']).Count) }
    Add-Finding $(if ($cards.Count -gt 0) { 'ok' } else { 'note' }) ('Каталог по API: прочитано карточек изделий ' + $cards.Count + '.')
    try {
        $file = Join-Path $script:LogDir 'catalog-api.json'
        [System.IO.File]::WriteAllText($file, (ConvertTo-Json -InputObject ([ordered]@{ cards = @($cards); symbols = @($script:CatalogSizes) }) -Depth 6), (New-Object System.Text.UTF8Encoding($true)))
        Write-Human ('Карточки: ' + $file)
    } catch { }
}
