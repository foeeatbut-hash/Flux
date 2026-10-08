# Каталог по API (только чтение): какие данные об изделиях и символах E3 отдаёт сам API, без чтения components.mdb/symbols.mdb.
# Источники имён: выделенное инженером в базе E3 (основное приложение: GetDatabaseTree/TableSelected*, затем API редактора базы), и
# компоненты открытого проекта (Job.GetAllComponentIds). Полного списка базы в API нет. Ничего не пишется и не сохраняется;
# редактор компонента (EditComponent) не открывается, поэтому и закрывать нечего.

$script:DbeClsid = '{fc37390f-d65e-4c31-a24a-7536f40ffd93}'
$script:CatalogSymbolName = 'Вентилятор_ЗТД_К'

function Get-DbeApplication {
    # Редактор базы: только подключение к УЖЕ открытому окну инженера (Marshal.GetActiveObject). New-Object / CLSID не используются:
    # они поднимают скрытый новый экземпляр с пустым выделением, а он ничего не показывает (журнал 8 октября: оба вызова вернули 0).
    param($App)
    if ($script:Fake) { return $script:FakeDbe }
    try {
        $progs = @(Get-ChildItem 'Registry::HKEY_CLASSES_ROOT' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^CT\.' } | ForEach-Object { $_.PSChildName })
        Add-Finding 'note' ('Каталог по API: ProgID CT.* в реестре: ' + ($progs -join ', '))
    } catch { }
    $r = Invoke-Attempt -Op 'catalog.dbe.active' -Label 'Marshal.GetActiveObject' -ArgsText '"CT.DbeApplication"' -Silent -Action { [System.Runtime.InteropServices.Marshal]::GetActiveObject('CT.DbeApplication') }
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

$script:CatalogPollSec = 20
$script:SelVariants = @('ref=$null', 'ref=[object[]]@()', 'ref=[string[]]@()', '[ref] адаптер PowerShell')

function Invoke-SelCall {
    # Один вызов «выделение» (два [out] VARIANT*: имена и версии) одним из вариантов передачи out-параметров.
    # Первые три — InvokeMember с ParameterModifier (Invoke-Com), четвёртый — родной [ref] адаптера PowerShell.
    param($Target, [string]$Method, [string]$Variant)
    $res = @{ Names = @(); Vers = @(); Ret = $null; Err = '' }
    try {
        if ($Variant -eq '[ref] адаптер PowerShell') {
            if ($script:Fake) { $res.Err = 'пропущен в подставном COM'; return $res }
            Write-Trace ('COM ' + $Method + '([ref] $null, [ref] $null)')
            $r1 = $null; $r2 = $null
            $res.Ret = $Target.$Method([ref]$r1, [ref]$r2)
            $o0 = $r1; $o1 = $r2
        } else {
            [object[]]$ca = New-Object object[] 2
            if ($Variant -eq 'ref=[object[]]@()') { $ca[0] = [object[]]@(); $ca[1] = [object[]]@() }
            elseif ($Variant -eq 'ref=[string[]]@()') { $ca[0] = [string[]]@(); $ca[1] = [string[]]@() }
            $r = Invoke-Com -Target $Target -Name $Method -CallArgs $ca -RefIdx @(0, 1)
            $res.Ret = $r.Ret; $o0 = $ca[0]; $o1 = $ca[1]
        }
        $res.Names = @(@($o0) | Where-Object { $_ -is [string] -and $_ -ne '' })
        $res.Vers = @(@($o1) | ForEach-Object { [string]$_ })
    } catch {
        $inner = Get-InnerException $_.Exception
        $res.Err = ($inner.Message -replace "[\r\n]+", ' | ')
    }
    return $res
}

function Poll-DatabaseSelection {
    # Опрос без участия пользователя: раз в секунду все варианты чтения выделения во всех источниках. Фокус остаётся в E3,
    # поэтому выделение не сбрасывается уходом в консоль. Как только имена появились — конец. Возвращает пары по видам.
    param([int]$Seconds)
    $methods = @('GetDatabaseTreeSelectedComponents', 'GetDatabaseTreeSelectedSymbols', 'GetDatabaseTableSelectedComponents')
    $kind = @{ GetDatabaseTreeSelectedComponents = 'Comps'; GetDatabaseTreeSelectedSymbols = 'Syms'; GetDatabaseTableSelectedComponents = 'Table' }
    $out = @{ Comps = @(); Syms = @(); Table = @(); Hits = @(); Found = $false; Sec = 0; Errors = @{}; Sources = @() }
    $dbe = $null
    for ($sec = 1; $sec -le $Seconds; $sec++) {
        $global:CatalogPollTick = $sec
        # окно редактора базы инженер мог открыть уже во время опроса: повторная попытка подключиться раз в 5 секунд
        if ($null -eq $dbe -and ($sec -eq 1 -or $sec % 5 -eq 1)) { $dbe = Get-DbeApplication $script:App; if ($null -ne $dbe -and $out.Sources -notcontains 'dbe') { $out.Sources += 'dbe' } }
        $srcs = @(@{ Tag = 'app'; Target = $script:App }); if ($null -ne $dbe) { $srcs += @{ Tag = 'dbe'; Target = $dbe } }
        $line = @(); $hits = @()
        foreach ($src in $srcs) {
            foreach ($m in $methods) {
                $best = 0; $perVar = @(); $win = $null
                foreach ($v in $script:SelVariants) {
                    $r = Invoke-SelCall $src.Target $m $v
                    $key = $src.Tag + '.' + $m + ' [' + $v + ']'
                    if ($r.Err -ne '' -and -not $out.Errors.ContainsKey($key)) { $out.Errors[$key] = $r.Err; Write-Trace ('  вариант не прошёл: ' + $key + ' — ' + $r.Err) }
                    $n = @($r.Names).Count
                    $perVar += ($v + '=' + $n)
                    if ($n -gt $best) { $best = $n }
                    if ($n -gt 0 -and $null -eq $win) { $win = @{ Tag = $src.Tag; Method = $m; Variant = $v; Names = $r.Names; Vers = $r.Vers } }
                }
                $line += ($src.Tag + '.' + ($m -replace '^GetDatabase', '') + ' ' + $best)
                if ($null -ne $win) { $win.PerVariant = ($perVar -join '; '); $hits += , $win }
            }
        }
        $msg = 'сек ' + $sec + ': ' + ($line -join ', ')
        Write-Trace ('опрос ' + $msg); Write-Human ('  ' + $msg)
        if ($hits.Count -gt 0) {
            $out.Found = $true; $out.Sec = $sec; $out.Hits = $hits
            foreach ($h in $hits) {
                $pairs = @(); for ($i = 0; $i -lt @($h.Names).Count; $i++) { $ver = ''; if ($i -lt @($h.Vers).Count) { $ver = [string]$h.Vers[$i] }; $pairs += , @($h.Names[$i], $ver) }
                foreach ($p in $pairs) { $out[$kind[$h.Method]] += , $p }
                Write-Human ('  поймано: ' + $h.Tag + '.' + $h.Method + ', вариант [' + $h.Variant + '], имён ' + @($h.Names).Count + ' (по вариантам: ' + $h.PerVariant + ')') 'Green'
            }
            break
        }
        if ($sec -lt $Seconds) { Start-Sleep -Milliseconds 1000 }
    }
    return $out
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
    Write-Human 'Переключитесь в E3, выделите символы в дереве базы и НИЧЕГО не нажимайте — скрипт сам опрашивает 20 секунд.' 'Yellow'
    Write-Human 'Где выделять: панель «База данных» в окне проекта E3 (дерево Символы/Изделия) ИЛИ окно редактора базы E3 — скрипт проверит оба.' 'Yellow'
    $cards = New-Object System.Collections.ArrayList
    $dbe = Get-DbeApplication $script:App
    $job = Get-QuietValue $script:App 'CreateJobObject'
    $comp = $null; $sym = $null
    if ($null -ne $job) {
        $comp = Get-QuietValue $job 'CreateComponentObject'; $sym = Get-QuietValue $job 'CreateSymbolObject'
        $script:CatAttr = Get-QuietValue $job 'CreateAttributeObject'
    }
    if ($null -eq $dbe) {
        Write-Human '— окно редактора базы не открыто (Marshal.GetActiveObject "CT.DbeApplication" не нашёл); новый экземпляр не создаётся.' 'Yellow'
        Add-Finding 'note' 'Каталог по API: открытого окна редактора базы (CT.DbeApplication) нет.'
    } else {
        [void](Export-ApiObject $dbe 'DbeApplication')
    }
    $sel = Poll-DatabaseSelection $script:CatalogPollSec
    foreach ($k in @($sel.Errors.Keys)) { Add-Finding 'note' ('Каталог по API: вариант не прошёл — ' + $k + ': ' + $sel.Errors[$k]) }
    $allNames = @(@($sel.Syms) + @($sel.Comps) + @($sel.Table) | ForEach-Object { $_[0] })
    if ($sel.Found) {
        $hitText = (@($sel.Hits | ForEach-Object { $_.Tag + '.' + $_.Method + ' [' + $_.Variant + '] = ' + @($_.Names).Count }) -join '; ')
        Add-Finding 'ok' ('КАТАЛОГ ПО API: выделение поймано на ' + $sel.Sec + '-й секунде опроса. Источник и вариант: ' + $hitText + '. Имён всего ' + $allNames.Count + ', изделий ' + @($sel.Comps).Count + ', символов ' + @($sel.Syms).Count + ', таблица ' + @($sel.Table).Count + '. Первые 20: ' + (($allNames | Select-Object -First 20) -join ', '))
    } else {
        Add-Finding 'need' ('КАТАЛОГ ПО API: за ' + $script:CatalogPollSec + ' с ни один источник (приложение, редактор базы' + $(if ($sel.Sources -contains 'dbe') { '' } else { ' — не открыт' }) + ') и ни один вариант out-параметров не вернул имён.')
    }
    $seen = @{}; $selNames = @(); $selVers = @()
    foreach ($pair in (@($sel.Comps) + @($sel.Table))) { if ($null -eq $pair -or $seen.ContainsKey($pair[0])) { continue }; $seen[$pair[0]] = $true; $selNames += $pair[0]; $selVers += $pair[1] }
    $treeSyms = @($sel.Syms)
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
        Add-Finding 'note' ('КАТАЛОГ ПО API, габариты (Symbol.Load + GetArea, без размещения): ' + ((@($sizes | Select-Object -First 3) | ForEach-Object { $_.name + ' ' + $(if ($_.loaded -and $_.method -ne 'нет') { [string]$_.width + 'x' + [string]$_.height } else { 'не прочитан' }) }) -join '; '))
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
