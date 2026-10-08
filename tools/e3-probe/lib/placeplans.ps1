# Планы вставки изделия на лист по настоящим сигнатурам из библиотеки типов E3 (api-*.txt):
#   Device.Create(name, assignment, location, comp, vers, after) -> номер устройства, 0 = неудача
#   Symbol.Load(name, version) -> номер символа, 0 = неудача
#   Symbol.Place(shti, x, y [, rot, scale, maintaintextsize]) -> номер, 0 = неудача (shti — номер ЛИСТА)
#   Job.LoadPart(name, version, unique) и Sheet.PlacePart(name, version, x, y, rot)
#   Device.LoadAndCreate(comp, vers, type), Device.CreateBlock(name, assignment, location, cmpname, version, filename)
#   Job.ImportDrawing(name, unique, posx, posy)
# Общий код для полной проверки (временный лист) и для режима «только разместить» (активный лист).

$script:ProjectComponents = $null       # список @{ Id; Name; Version }: компоненты проекта (Job.GetComponentIds -> Component.GetName)
$script:CompSamples = $null             # ключ — имя компонента в нижнем регистре -> @{ Name; Version; Symbols = @(@{Name; Version}) }
$script:PlanCtx = @{}                   # что создал последний план: Created — номера устройств, StepsDone — сколько шагов прошло

function Get-PlanTarget {
    param([string]$Kind)
    if ($Kind -eq 'job') { return $script:Job }
    return $script:Objects[(Get-Culture).TextInfo.ToTitleCase($Kind)]
}

function Get-ProjectComponents {
    # Компоненты проекта с именами: список в API отдаёт только номера, имя читается через Component.SetId + GetName.
    if ($null -ne $script:ProjectComponents) { return $script:ProjectComponents }
    $list = New-Object System.Collections.ArrayList
    $comp = $script:Objects['Component']
    if ($null -ne $comp -and $null -ne $script:Job) {
        $ids = @(Get-Ids 'components' 'db.components.job' $script:Job 'job' @((Cand 'GetComponentIds' @($null) @(0)), (Cand 'GetAllComponentIds' @($null) @(0))))
        foreach ($id in $ids) {
            if (-not (Select-Id $comp $id)) { continue }
            $name = Get-QuietValue $comp 'GetName'
            if ($null -eq $name -or "$name" -eq '') { continue }
            $ver = Get-QuietValue $comp 'GetVersion'
            [void]$list.Add(@{ Id = $id; Name = [string]$name; Version = $(if ($null -eq $ver) { '' } else { ([string]$ver).Trim() }); VersionRaw = $(if ($null -eq $ver) { '' } else { [string]$ver }) })
        }
    }
    $script:ProjectComponents = @($list)
    return $script:ProjectComponents
}

function Get-DeviceSamples {
    # По существующим устройствам проекта: какие символы (имя и версия) у какого компонента. Это единственный способ узнать
    # имя символа компонента через API: списка символов в базе в API нет.
    if ($null -ne $script:CompSamples) { return $script:CompSamples }
    $samples = @{}
    $dev = $script:Objects['Device']; $sym = $script:Objects['Symbol']
    if ($null -ne $dev -and $null -ne $sym) {
        $scanned = 0
        foreach ($id in @(Get-AllDevices)) {
            if ($scanned -ge 400) { break }; $scanned++
            if (-not (Select-Id $dev $id)) { continue }
            $cn = Get-QuietValue $dev 'GetComponentName'
            if ($null -eq $cn -or "$cn" -eq '') { continue }
            $key = ([string]$cn).ToLower()
            if ($samples.ContainsKey($key) -and @($samples[$key].Symbols).Count -ge 2) { continue }
            $cv = Get-QuietValue $dev 'GetComponentVersion'
            if (-not $samples.ContainsKey($key)) { $samples[$key] = @{ Name = [string]$cn; Version = $(if ($null -eq $cv) { '' } else { ([string]$cv).Trim() }); VersionRaw = $(if ($null -eq $cv) { '' } else { [string]$cv }); Symbols = @() } }
            $r = Invoke-Quiet $dev 'GetSymbolIds' @($null) @(0)
            if ($null -eq $r) { continue }
            $symIds = Convert-ToItems $r.Ret $r.Args @(0)   # без @(): функция возвращает массив одним объектом
            foreach ($sid in $symIds) {
                if (@($samples[$key].Symbols).Count -ge 2) { break }
                if (-not (Select-Id $sym $sid)) { continue }
                $sn = Get-QuietValue $sym 'GetName'
                if ($null -eq $sn -or "$sn" -eq '') { continue }
                $sv = Get-QuietValue $sym 'GetVersion'
                $samples[$key].Symbols += , @{ Name = [string]$sn; Version = $(if ($null -eq $sv) { '' } else { [string]$sv }) }
            }
        }
    }
    $script:CompSamples = $samples
    return $samples
}

function Resolve-Component {
    # Имя -> сведения о компоненте проекта (без учёта регистра) или $null, если такого компонента в проекте нет.
    param([string]$Name)
    $key = $Name.ToLower()
    $samples = Get-DeviceSamples
    if ($samples.ContainsKey($key)) { return $samples[$key] }
    foreach ($c in @(Get-ProjectComponents)) {
        if ($c.Name.ToLower() -eq $key) {
            # Ни одно устройство проекта этот компонент не использует: имена символов пробуем взять из видов компонента
            # (Component.GetViewDefinitions); что именно вернётся, в описи не сказано — значение пишется в журнал.
            $symbols = @()
            $comp = $script:Objects['Component']
            if ($null -ne $comp -and (Select-Id $comp $c.Id)) {
                $r = Invoke-Quiet $comp 'GetViewDefinitions' @($null) @(0)
                if ($null -ne $r) {
                    $items = Convert-ToItems $r.Ret $r.Args @(0)
                    Write-Trace ('GetViewDefinitions(' + $c.Name + '): ' + (Format-Value $items 300))
                    foreach ($it in $items) { if ($it -is [string] -and $it -ne '' -and $symbols.Count -lt 3) { $symbols += , @{ Name = $it; Version = '' } } }
                }
            }
            return @{ Name = $c.Name; Version = $c.Version; VersionRaw = $c.VersionRaw; Symbols = $symbols }
        }
    }
    return $null
}

function Get-SampleComponent {
    # Любой компонент проекта, у которого известен символ: чтобы проверить сами вызовы вставки, когда заданного решения нет.
    $samples = Get-DeviceSamples
    foreach ($k in @($samples.Keys | Sort-Object)) { if (@($samples[$k].Symbols).Count -gt 0) { return $samples[$k] } }
    return $null
}

function New-PlanStep {
    param([string]$T, [string]$M, [object[]]$A = @(), [switch]$Pos, [switch]$Soft, [string]$Save = '')
    return @{ T = $T; M = $M; A = $A; Pos = [bool]$Pos; Soft = [bool]$Soft; Save = $Save }
}

function Get-PlaceVariants {
    # Все способы вставить изделие по компоненту $Name в точку (X, Y) листа $SheetId, самые вероятные — первыми.
    param([string]$Name, $X, $Y, $SheetId = $script:ProbeSheetId, [switch]$PlaceOnly)
    $info = Resolve-Component $Name
    $comp = [string]$Name; $ver = ''; $verRaw = ''
    if ($null -ne $info) { $comp = [string]$info.Name; $ver = [string]$info.Version; $verRaw = [string]$info.VersionRaw }
    $v = New-Object System.Collections.ArrayList
    $add = {
        param([string]$Id, [string]$Label, $Steps)
        [void]$v.Add(@{ Id = $Id; Label = $Label; Steps = @($Steps); SheetId = $SheetId; A = @($Steps)[-1].A })
    }
    $k = 0
    if ($null -ne $info) {
        foreach ($s in @($info.Symbols)) {
            $k++
            foreach ($devName in @('', '-FLUXPLACE')) {
                & $add ('device.Create+Load+Place.s' + $k + '.n' + $devName.Length) 'device.Create+symbol.Load+Place' @(
                    (New-PlanStep device Create @([string]$devName, '', '', $comp, $ver, [int]0) -Pos -Save dev),
                    (New-PlanStep symbol Load @([string]$s.Name, [string]$s.Version) -Pos),
                    (New-PlanStep symbol Place @([int]$SheetId, [double]$X, [double]$Y) -Pos))
            }
        }
    }
    foreach ($devName in @('', '-FLUXPLACE')) {
        & $add ('device.Create.n' + $devName.Length) 'device.Create' @((New-PlanStep device Create @([string]$devName, '', '', $comp, $ver, [int]0) -Pos -Save dev))
    }
    & $add 'device.LoadAndCreate' 'device.LoadAndCreate' @((New-PlanStep device LoadAndCreate @($comp, $ver, 0) -Pos -Save dev))
    # Версии без Select-Object: он оборачивает строки в PSObject. Последней идёт версия с пробельным хвостом, как в базе.
    $versions = @(); foreach ($cand in @($ver, '', '1', $verRaw)) { if ($versions -notcontains [string]$cand) { $versions += [string]$cand } }
    foreach ($pv in $versions) {
        & $add ('sheet.PlacePart.v' + $pv) 'job.LoadPart+sheet.PlacePart' @(
            (New-PlanStep sheet Display -Soft),
            (New-PlanStep job LoadPart @($comp, [string]$pv, [int]0) -Soft),
            (New-PlanStep sheet PlacePart @($comp, [string]$pv, [double]$X, [double]$Y, [double]0)))
        & $add ('sheet.PlacePartEx.v' + $pv) 'sheet.PlacePartEx' @(
            (New-PlanStep sheet Display -Soft),
            (New-PlanStep sheet PlacePartEx @($comp, [string]$pv, [int]0, [double]$X, [double]$Y, [double]0)))
    }
    & $add 'device.CreateBlock' 'device.CreateBlock' @((New-PlanStep device CreateBlock @('', '', '', $comp, '', '') -Pos -Save dev))
    & $add 'symbol.Load+Place.name' 'symbol.Load+Place' @(
        (New-PlanStep symbol Load @($comp, '') -Pos),
        (New-PlanStep symbol Place @([int]$SheetId, [double]$X, [double]$Y) -Pos))
    foreach ($f in @($script:SolutionFiles)) {
        if ($f -match '\.(e3p|e3d|e3s|e3t)$') {
            & $add 'job.ImportDrawing' 'job.ImportDrawing' @((New-PlanStep sheet Display -Soft), (New-PlanStep job ImportDrawing @($f, 1, $X, $Y) -Pos))
            break
        }
    }
    if ($PlaceOnly) {
        # Режим «только разместить»: ничего лишнего. Остаются планы, которые кончаются символом на листе; устройство без
        # символа, блок, голый символ и смена вида листа (Display) не нужны.
        $keep = @($v | Where-Object { $_.Id -like 'device.Create+Load+Place*' -or $_.Id -like 'sheet.PlacePart*' -or $_.Id -eq 'job.ImportDrawing' })
        foreach ($p in $keep) { $p.Steps = @($p.Steps | Where-Object { -not ($_.T -eq 'sheet' -and $_.M -eq 'Display') }) }
        return $keep
    }
    return @($v)
}

function Invoke-PlaceVariant {
    param($Variant, [string]$Op)
    $script:PlanCtx = @{ Created = @(); StepsDone = 0 }
    $argText = (($Variant.Steps | ForEach-Object { $_.T + '.' + $_.M + '(' + (Format-Args $_.A @()) + ')' }) -join ' → ')
    $action = {
        $last = $null; $i = 0
        foreach ($st in $Variant.Steps) {
            $i++
            try {
                $target = Get-PlanTarget $st.T
                if ($null -eq $target) { throw ('Объект «' + $st.T + '» не создан') }
                if ($st.T -eq 'sheet') { [void](Use-Sheet $Variant.SheetId) }
                $r = Invoke-Com -Target $target -Name $st.M -CallArgs $st.A.Clone() -RefIdx @()
                if ($st.Pos -and -not (Test-Positive $r)) { throw ('шаг ' + $st.T + '.' + $st.M + ' вернул ' + (Format-Value $r.Ret 30) + ' (0 в E3 — неудача)') }
            } catch {
                if ($st.Soft) { continue }
                throw
            }
            $script:PlanCtx.StepsDone = $i
            if ($st.Save -ne '') { $script:PlanCtx[$st.Save] = $r.Ret; $script:PlanCtx.Created = @($script:PlanCtx.Created) + @($r.Ret) }
            $last = $r
        }
        if ($null -eq $last) { throw 'ни один шаг плана не выполнен' }
        $last
    }
    return (Invoke-Attempt -Op $Op -Label $Variant.Label -ArgsText $argText -Action $action)
}
