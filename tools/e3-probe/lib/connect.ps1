# Раздел 0-1: окружение, подключение к E3, выбор экземпляра, проект, опись объектов.

$script:Env = [ordered]@{}
$script:Objects = [ordered]@{}      # вид объекта (Sheet, Device…) -> обёртка COM
$script:ObjectOrigin = @{}          # вид объекта -> 'job' | 'app'

function Save-Environment {
    try { [System.IO.File]::WriteAllText((Join-Path $script:LogDir 'environment.json'), (ConvertTo-Json $script:Env -Depth 6), $script:Utf8Bom) } catch { }
}

function Get-OsText {
    try { return (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption + ' ' + [Environment]::OSVersion.Version.ToString() } catch { return [Environment]::OSVersion.VersionString }
}

function Get-E3Processes {
    $list = @()
    try {
        foreach ($p in @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -match 'E3' })) {
            $path = ''; try { $path = $p.Path } catch { }
            $version = ''; try { $version = $p.MainModule.FileVersionInfo.FileVersion } catch { }
            $list += [ordered]@{ pid = $p.Id; name = $p.ProcessName; title = $p.MainWindowTitle; path = $path; fileVersion = $version }
        }
    } catch { }
    return $list
}

function Step-Environment {
    Write-Section '0' 'Окружение'
    $script:Env['startedAt'] = (Get-Date).ToString('o')
    $script:Env['os'] = Get-OsText
    $script:Env['powershell'] = $PSVersionTable.PSVersion.ToString()
    $script:Env['powershell64bit'] = [Environment]::Is64BitProcess
    $script:Env['osIs64bit'] = [Environment]::Is64BitOperatingSystem
    $script:Env['apartment'] = [System.Threading.Thread]::CurrentThread.GetApartmentState().ToString()
    $script:Env['user'] = $env:USERNAME
    $script:Env['computer'] = $env:COMPUTERNAME
    $script:Env['culture'] = (Get-Culture).Name
    $script:Env['progIds'] = @((Get-ProgIdRegistration 'CT.Application'), (Get-ProgIdRegistration 'CT.Dispatcher'))
    $script:Env['processes'] = @(Get-E3Processes)
    Write-Human ('Windows: ' + $script:Env.os)
    Write-Human ('PowerShell: ' + $script:Env.powershell + ', 64 бита: ' + $script:Env.powershell64bit + ', поток: ' + $script:Env.apartment)
    foreach ($reg in $script:Env.progIds) {
        $line = $reg.progId + ': ' + $(if ($reg.clsid) { $reg.clsid + ' -> ' + $reg.server } else { 'не зарегистрирован (' + $reg.error + ')' })
        Write-Human $line
    }
    Write-Human ('Процессы E3: ' + @($script:Env.processes).Count)
    foreach ($p in @($script:Env.processes)) { Write-Human ('  pid ' + $p.pid + ' ' + $p.name + ' «' + $p.title + '» ' + $p.fileVersion) }
    if (-not $script:Env.powershell64bit -and $script:Env.osIs64bit) {
        Write-Human '! PowerShell 32-разрядный, а Windows 64-разрядная: 64-разрядный E3 может не найтись. run.cmd запускает 64-разрядный.' 'Yellow'
        Add-Finding 'note' 'Скрипт запущен в 32-разрядном PowerShell: запустите через run.cmd.'
    }
    Save-Environment
}

function Get-ActiveApplication {
    if ($script:Fake) { return $script:FakeApps[0] }
    return [System.Runtime.InteropServices.Marshal]::GetActiveObject('CT.Application')
}

function Get-AppIdentity {
    # Кратко про экземпляр: процесс и проект. Всё тихо — это подготовка выбора.
    param($App)
    $identity = [ordered]@{ pid = $null; version = $null; project = $null; appId = $null; fileVersion = $null }
    foreach ($name in @('GetProcessId', 'GetProcessID', 'GetPID', 'ProcessId')) {
        $v = Get-QuietValue $App $name; if ($null -ne $v) { $identity.pid = $v; break }
    }
    # В E3.series 2022 вызова с номером процесса нет, есть GetId (что он значит, выясняется по журналу — это не обязательно pid).
    $v = Get-QuietValue $App 'GetId'; if ($null -ne $v) { $identity.appId = $v }
    foreach ($name in @('GetVersion', 'GetBuild', 'Version')) {
        $v = Get-QuietValue $App $name; if ($null -ne $v -and "$v" -ne '') { $identity.version = [string]$v; break }
    }
    $job = Get-QuietValue $App 'CreateJobObject'
    if ($null -ne $job) {
        foreach ($name in @('GetName', 'GetProjectName', 'Name')) {
            $v = Get-QuietValue $job $name; if ($null -ne $v -and "$v" -ne '') { $identity.project = [string]$v; break }
        }
    }
    return $identity
}

function Step-Connect {
    Write-Section '1' 'Подключение к E3'
    $apps = New-Object System.Collections.ArrayList

    # --- активный экземпляр (запись в таблице запущенных объектов)
    $r = Invoke-Attempt -Op 'connect.application' -Label 'Marshal.GetActiveObject' -ArgsText '"CT.Application"' -Action { Get-ActiveApplication }
    if ($r.Ok -and $null -ne $r.Value) { [void]$apps.Add(@{ Source = 'GetActiveObject'; App = $r.Value }) }
    elseif (-not $script:Fake -and @($script:Env.processes).Count -gt 0) {
        # E3 запущен, но в таблице не найден: пробуем создать объект — запущенный сервер COM подхватит тот же процесс.
        $r2 = Invoke-Attempt -Op 'connect.application' -Label 'New-Object -ComObject' -ArgsText '"CT.Application"' -Action { New-Object -ComObject 'CT.Application' }
        if ($r2.Ok -and $null -ne $r2.Value) { [void]$apps.Add(@{ Source = 'New-Object'; App = $r2.Value }) }
    } else {
        Write-Human '— New-Object -ComObject пропущен: E3 не запущен, и вызов запустил бы новый экземпляр.'
    }

    # --- диспетчер: несколько запущенных E3
    $disp = $null
    $rd = Invoke-Attempt -Op 'connect.dispatcher' -Label 'New-Object -ComObject' -ArgsText '"CT.Dispatcher"' -Action { if ($script:Fake) { $script:FakeDispatcher } else { New-Object -ComObject 'CT.Dispatcher' } }
    if ($rd.Ok) { $disp = $rd.Value }
    if ($null -ne $disp) {
        [void](Export-ApiObject $disp 'Dispatcher')
        $counts = @('Count', 'GetCount', 'GetApplicationCount', 'GetE3Count', 'GetAppCount', 'GetNumberOfApplications')
        $cc = @(); foreach ($n in $counts) { $cc += , (Cand $n) }
        $countRes = Try-Calls -Op 'connect.dispatcher.count' -Target $disp -TL 'dispatcher' -Cands $cc
        $count = 0; if ($countRes.Ok -and $countRes.Value -is [ValueType]) { $count = [int]$countRes.Value }
        $getters = @('GetApplication', 'GetApplicationObject', 'Item', 'GetE3Application', 'GetApplicationByIndex', 'GetApp', 'GetE3App')
        $gc = @(); foreach ($n in $getters) { foreach ($i in @(0, 1)) { $gc += , (Cand $n @($i)) } }
        $listCands = @((Cand 'GetE3Applications' @($null) @(0)), (Cand 'GetApplications' @($null) @(0)), (Cand 'GetE3ApplicationIds' @($null) @(0)))
        $listRes = Try-Calls -Op 'connect.dispatcher.list' -Target $disp -TL 'dispatcher' -Cands $listCands
        $getRes = Try-Calls -Op 'connect.dispatcher.get' -Target $disp -TL 'dispatcher' -Cands $gc
        foreach ($w in $getRes.Wins) { if ($null -ne $w.Value -and (Test-ComObject $w.Value)) { [void]$apps.Add(@{ Source = $w.Label; App = $w.Value }) } }
        $script:Env['dispatcherCount'] = $count
    }

    # одинаковые экземпляры по процессу не дублируем
    $unique = New-Object System.Collections.ArrayList
    $seenPids = @{}
    foreach ($a in $apps) {
        $id = Get-AppIdentity $a.App
        $a.Identity = $id
        $key = if ($null -ne $id.pid) { 'pid' + $id.pid } else { 'src' + $a.Source }
        if ($seenPids.ContainsKey($key)) { continue }
        $seenPids[$key] = $true
        [void]$unique.Add($a)
    }
    # Номер процесса: если E3 сам его не назвал, а процесс на машине один, берём его (так же версия файла для сверки с GetVersion).
    $procs = @($script:Env.processes)
    foreach ($a in $unique) {
        if ($null -eq $a.Identity.pid -and $unique.Count -eq 1 -and $procs.Count -eq 1) { $a.Identity.pid = $procs[0].pid; $a.Identity.pidSource = 'единственный процесс E3' }
        foreach ($p in $procs) { if ("$($p.pid)" -eq "$($a.Identity.pid)") { $a.Identity.fileVersion = $p.fileVersion } }
    }
    $script:Env['instances'] = @($unique | ForEach-Object { [ordered]@{ source = $_.Source; pid = $_.Identity.pid; version = $_.Identity.version; project = $_.Identity.project } })
    Write-Human ('Найдено экземпляров E3 с рабочим COM: ' + $unique.Count)
    if ($unique.Count -eq 0) {
        Add-Finding 'bad' 'К E3 подключиться не удалось: откройте E3.series с проектом и запустите скрипт снова.'
        Save-Environment
        return $false
    }
    $chosen = $unique[0]
    if ($unique.Count -gt 1) {
        $i = 0
        foreach ($a in $unique) { Write-Human ('  [' + $i + '] pid ' + $a.Identity.pid + ' версия ' + $a.Identity.version + ' проект «' + $a.Identity.project + '»'); $i++ }
        Add-Finding 'note' ('Запущено несколько E3 (' + $unique.Count + '): выбор экземпляра возможен.')
        if ($script:ProcessId -gt 0) {
            $match = @($unique | Where-Object { "$($_.Identity.pid)" -eq "$($script:ProcessId)" })
            if ($match.Count -gt 0) { $chosen = $match[0] } else { Write-Human ('! Процесс ' + $script:ProcessId + ' среди найденных не обнаружен, берём [0].') 'Yellow' }
        } elseif (-not $script:NoConfirm) {
            $answer = Read-Host 'Номер экземпляра E3 для проверки (Enter — 0)'
            $n = 0; if ([int]::TryParse($answer, [ref]$n) -and $n -ge 0 -and $n -lt $unique.Count) { $chosen = $unique[$n] }
        }
    }
    $script:App = $chosen.App
    $script:Env['chosenInstance'] = $chosen.Identity
    Write-Human ('Выбран экземпляр: pid ' + $chosen.Identity.pid + ', версия по GetVersion «' + $chosen.Identity.version + '», версия файла exe «' + $chosen.Identity.fileVersion + '», GetId ' + $chosen.Identity.appId)
    return $true
}

function Get-TitleProjectFile {
    # Заголовок окна E3 с именем файла проекта (.e3s/.e3d/.e3p…) означает, что проект открыт. Возвращает заголовок или ''.
    foreach ($p in @($script:Env['processes'])) {
        if ($p.title -and ([string]$p.title) -match '(?i)\.e3[a-z]\b') { return [string]$p.title }
    }
    return ''
}

function Step-ProjectCheck {
    # Сразу после подключения, до долгой описи API: открыт ли проект. Если нет — говорим об этом громко и в самом начале,
    # а не в конце длинного журнала; дальше снимется только опись API и будет итог.
    Write-Section '1a' 'Открыт ли проект'
    $job = Get-QuietValue $script:App 'CreateJobObject'
    $name = ''
    if ($null -ne $job) {
        foreach ($n in @('GetName', 'GetProjectName', 'GetFullName')) { $v = Get-QuietValue $job $n; if ($null -ne $v -and "$v" -ne '') { $name = [string]$v; break } }
    }
    $script:ProjectNameEarly = $name
    $title = Get-TitleProjectFile
    if ($name -eq '' -and $title -ne '') {
        # Заголовок окна называет файл проекта, а проба имени не прочитала: врать «откройте проект» нельзя.
        Write-Human ('!!! ПРОТИВОРЕЧИЕ: в заголовке окна E3 есть файл проекта («' + $title + '»), а проба имя проекта прочитать не смогла.') 'Yellow'
        Write-Human '    Скорее всего, проект открыт, а ошибка в самой пробе или в ответе E3. Прогон пойдёт дальше как без проекта; пришлите журнал целиком.' 'Yellow'
        Add-Finding 'bad' ('ПРОТИВОРЕЧИЕ: заголовок окна E3 «' + $title + '» называет файл проекта, но проба не прочитала имя проекта (Job.GetName и аналоги). Это ошибка пробы или ответа E3, а не закрытый проект.')
    } elseif ($name -eq '') {
        Write-Human '!!! В E3 НЕ ОТКРЫТ ПРОЕКТ. Откройте КОПИЮ тестового проекта и запустите проверку снова.' 'Yellow'
        Write-Human '    Сейчас будет снята только опись API (она полезна и так), затем проверка завершится с итогом.' 'Yellow'
        Add-Finding 'bad' 'В E3 не был открыт проект: откройте копию тестового проекта и запустите проверку снова. Снята только опись API.'
    } else { Write-Human ('Проект открыт: «' + $name + '»') }
}

function Step-AppInfo {
    Write-Section '1b' 'Версия E3, проект'
    $names = Export-ApiObject $script:App 'Application'
    $versionNames = @('GetVersion', 'GetBuild', 'GetInstalledVersion', 'GetE3Version', 'GetProductVersion', 'GetProductName', 'GetInstallationPath', 'GetInstallPath', 'GetProgramPath', 'GetLanguage', 'GetCaption', 'GetName', 'GetProcessId', 'GetPID', 'GetUserName', 'GetDatabaseName', 'GetDatabaseType', 'GetLicenseName', 'GetLicenseType', 'IsVisible', 'GetVisible', 'Version', 'Build')
    $cands = @(); foreach ($n in $versionNames) { $cands += , (Cand $n) }
    $res = Try-Calls -Op 'app.info' -Target $script:App -TL 'app' -Cands $cands
    $info = [ordered]@{}
    foreach ($w in $res.Wins) { $info[($w.Label -replace "^app\.", "")] = Format-Plain $w.Value 200 }
    $script:Env['appInfo'] = $info
    $version = ''
    foreach ($k in @('GetVersion', 'GetBuild', 'GetE3Version', 'GetProductVersion', 'Version')) { if ($info.Contains($k)) { $version = $info[$k]; break } }
    $script:Env['e3Version'] = $version
    if ($version -ne '') { Add-Finding 'ok' ('Версия E3: ' + $version) } else { Add-Finding 'need' 'Версию E3 прочитать не удалось ни одним из вызовов GetVersion/GetBuild.' }

    # --- Create*Object: перебираем все, что нашли в описи, и все, что знаем по имени
    $known = @('Job', 'Sheet', 'Device', 'Symbol', 'Pin', 'Component', 'Attribute', 'Graph', 'Text', 'Connection', 'Net', 'NetSegment', 'Signal', 'Block', 'Group', 'Cable', 'Connector', 'Bundle', 'Format', 'Field', 'Option', 'Variant', 'Tree', 'ExternalDocument', 'Dbe', 'DbObject', 'Database', 'SubCircuit', 'Module', 'Wire', 'Assignment', 'Location', 'Table', 'Dimension', 'Rule', 'File', 'Id', 'Library', 'Report', 'Selection', 'View', 'Window', 'Terminal', 'Core', 'Part', 'Project')
    $appCreators = @($names | Where-Object { $_ -match '^Create.+Object$' })
    foreach ($n in $known) { $full = 'Create' + $n + 'Object'; if ($appCreators -notcontains $full) { $appCreators += $full } }
    $script:Env['appCreators'] = $appCreators
    Write-Human ('Create*Object у приложения: найдено в описи ' + @($names | Where-Object { $_ -match '^Create.+Object$' }).Count + ', проверяем ' + $appCreators.Count)
    foreach ($creator in $appCreators) {
        $kind = $creator -replace '^Create', '' -replace 'Object$', ''
        if ($kind -eq 'Job') { continue }
        $r = Try-Calls -Op ('app.create.' + $kind) -Target $script:App -TL 'app' -Cands @((Cand $creator)) -First -Silent
        if ($r.Ok -and $null -ne $r.Value) { $script:AppObjects[$kind] = $r.Value }
    }
    Write-Human ('Объекты, которые создаёт приложение: ' + (($script:AppObjects.Keys) -join ', '))

    # --- проект
    $jobRes = Try-Calls -Op 'app.job' -Target $script:App -TL 'app' -Cands @((Cand 'CreateJobObject'), (Cand 'CreateJob'), (Cand 'GetJob'), (Cand 'CreateProjectObject')) -First
    if (-not $jobRes.Ok) { Add-Finding 'bad' 'Объект проекта (CreateJobObject) создать не удалось.'; return $false }
    $script:Job = $jobRes.Value
    $jobNames = Export-ApiObject $script:Job 'Job'
    $infoNames = @('GetName', 'GetPath', 'GetProjectName', 'GetProjectPath', 'GetFullName', 'GetFileName', 'GetId', 'GetJobId', 'IsOpen', 'IsOpened', 'IsModified', 'GetModified', 'IsReadOnly', 'GetReadOnly', 'IsLocked', 'GetLockInfo', 'GetUser', 'GetUserName', 'GetMode', 'IsMultiUser', 'GetMultiUserMode', 'GetDatabaseName', 'GetDatabaseType', 'GetDatabasePath', 'GetComponentDatabase', 'GetUnits', 'GetUnit', 'GetMeasurementUnits', 'GetGrid', 'GetGridSize', 'GetAttributeNames', 'GetOpenedJobCount', 'GetJobCount')
    $cands = @(); foreach ($n in $infoNames) { $cands += , (Cand $n) }
    $res = Try-Calls -Op 'job.info' -Target $script:Job -TL 'job' -Cands $cands
    $jinfo = [ordered]@{}
    $jvals = @{}
    foreach ($w in $res.Wins) { $key = ($w.Label -replace '^job\.', ''); $jinfo[$key] = Format-Plain $w.Value 250; $jvals[$key] = [string]$w.Value }
    $script:Env['jobInfo'] = $jinfo
    $name = ''
    foreach ($k in @('GetName', 'GetProjectName', 'GetFullName', 'GetFileName')) { if ($jvals.ContainsKey($k) -and $jvals[$k] -ne '') { $name = $jvals[$k]; break } }
    $path = ''
    foreach ($k in @('GetPath', 'GetProjectPath', 'GetFullName')) { if ($jvals.ContainsKey($k) -and $jvals[$k] -ne '') { $path = $jvals[$k]; break } }
    $script:ProjectName = $name; $script:ProjectPath = $path
    $script:Env['project'] = [ordered]@{ name = $name; path = $path; open = ($name -ne '') }
    Save-Environment
    if ($name -eq '') {
        if ((Get-TitleProjectFile) -ne '') { Add-Finding 'bad' 'ПРОТИВОРЕЧИЕ: проба решила, что проект не открыт, но в заголовке окна E3 есть файл проекта. Проверены только подключение и опись API.' }
        else { Add-Finding 'note' 'Проект в E3 не открыт: проверены только подключение и поведение без проекта.' }
        return $false
    }
    Add-Finding 'ok' ('Проект «' + $name + '» прочитан, путь: ' + $path)
    return $true
}

function Step-CreateJobObjects {
    Write-Section '1c' 'Объекты проекта (Create*Object у Job)'
    $names = @($script:ApiNames['Job'])
    $creators = @($names | Where-Object { $_ -match '^Create.+Object$' })
    $known = @('Sheet', 'Device', 'Symbol', 'Pin', 'Component', 'Attribute', 'Graph', 'Text', 'Connection', 'Net', 'NetSegment', 'Signal', 'Block', 'Group', 'Cable', 'Connector', 'Bundle', 'Format', 'Field', 'Option', 'Variant', 'Tree', 'ExternalDocument', 'Dbe', 'DbObject', 'Database', 'SubCircuit', 'Module', 'Wire', 'Assignment', 'Location', 'Table', 'Dimension', 'Rule', 'File', 'Id', 'Library', 'Report', 'Selection', 'View', 'Window', 'Terminal', 'Core', 'Part', 'Project', 'Application')
    foreach ($n in $known) { $full = 'Create' + $n + 'Object'; if ($creators -notcontains $full) { $creators += $full } }
    $script:Env['jobCreators'] = $creators
    Write-Human ('Create*Object у проекта: найдено в описи ' + @($names | Where-Object { $_ -match '^Create.+Object$' }).Count + ', проверяем ' + $creators.Count)
    foreach ($creator in $creators) {
        $kind = $creator -replace '^Create', '' -replace 'Object$', ''
        $r = Try-Calls -Op ('job.create.' + $kind) -Target $script:Job -TL 'job' -Cands @((Cand $creator)) -First -Silent
        if ($r.Ok -and $null -ne $r.Value) { $script:Objects[$kind] = $r.Value; $script:ObjectOrigin[$kind] = 'job' }
    }
    foreach ($kind in @($script:AppObjects.Keys)) { if (-not $script:Objects.Contains($kind)) { $script:Objects[$kind] = $script:AppObjects[$kind]; $script:ObjectOrigin[$kind] = 'app' } }
    Write-Human ('Созданы обёртки: ' + (($script:Objects.Keys) -join ', '))
    $script:Env['objects'] = @($script:Objects.Keys)
    foreach ($kind in @($script:Objects.Keys)) { [void](Export-ApiObject $script:Objects[$kind] $kind) }
    Save-ApiJson
    Save-Environment
}

$script:AppObjects = [ordered]@{}

function Step-NoProject {
    # Проект не открыт: фиксируем, как E3 отвечает на вызовы проекта (H: «поведение при закрытом проекте»).
    Write-Section '1d' 'Поведение без открытого проекта'
    $calls = @((Cand 'GetSheetIds' @($null) @(0)), (Cand 'GetAllDeviceIds' @($null) @(0)), (Cand 'GetActiveSheetId'), (Cand 'GetAttributeValue' @('FLUX_PROJECT')), (Cand 'CreateSheetObject'), (Cand 'GetPath'))
    [void](Try-Calls -Op 'noproject.job' -Target $script:Job -TL 'job' -Cands $calls)
}
