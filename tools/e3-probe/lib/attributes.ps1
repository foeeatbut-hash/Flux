# Раздел 3 и E: чтение и запись атрибутов на проекте, листе, устройстве, пине, блоке; проверка списка владельца.

$script:Leftovers = New-Object System.Collections.ArrayList     # что не удалось вернуть как было
$script:ProbeValue = '__flux_probe_value__'
$script:UndefinedAttr = '__FLUX_UNDEFINED_PROBE__'
$script:FluxAttrs = @('FLUX_PROJECT', 'FLUX_BLOCK', 'FLUX_VER', 'FLUX_ID', 'GLOBAL_ID_IN_PROJECT')
$script:OwnerAttrs = @()

function Get-DeviceIdCands {
    return @((Cand 'GetAllDeviceIds' @($null) @(0)), (Cand 'GetAllDeviceIds' @($null, 0) @(0)), (Cand 'GetDeviceIds' @($null) @(0)), (Cand 'GetDeviceIds' @($null, 0) @(0)), (Cand 'GetAllDevices' @($null) @(0)), (Cand 'GetDeviceCount'))
}

function Get-AttrReadCands {
    param([string]$Name)
    return @((Cand 'GetAttributeValue' @($Name)), (Cand 'GetAttributeValue' @($Name, 0)), (Cand 'GetAttribute' @($Name)), (Cand 'GetAttributeText' @($Name)))
}
function Get-AttrWriteCands {
    param([string]$Name, [string]$Value)
    return @((Cand 'SetAttributeValue' @($Name, $Value)), (Cand 'AddAttributeValue' @($Name, $Value)), (Cand 'SetAttribute' @($Name, $Value)), (Cand 'SetAttributeValue' @($Name, 0, $Value)))
}
function Get-AttrDeleteCands {
    param([string]$Name)
    return @((Cand 'DeleteAttribute' @($Name)), (Cand 'DeleteAttributeValue' @($Name)), (Cand 'RemoveAttribute' @($Name)), (Cand 'DeleteAttribute' @($Name, 0)))
}

function Read-AttrValue {
    # Первое сработавшее чтение; $null — ни один вариант не сработал.
    param($Target, [string]$TL, [string]$Op, [string]$Name, [switch]$Silent)
    $r = Try-Calls -Op $Op -Target $Target -TL $TL -Cands (Get-AttrReadCands $Name) -First -Silent:$Silent
    if ($r.Ok) { return @{ Ok = $true; Value = [string]$r.Value; Cand = $r.WinCand } }
    return @{ Ok = $false; Value = $null; Cand = $null }
}

function Test-AttributeRW {
    # Читает, пишет, читает обратно и возвращает как было. Prepare ставит id объекта в обёртку.
    param($Target, [string]$TL, [string]$Prefix, [string]$Name, [string]$Carrier, [scriptblock]$Prepare, [switch]$Silent, [switch]$NoWrite)
    $out = [ordered]@{ name = $Name; carrier = $Carrier; read = $false; before = $null; write = $false; readback = $false; restored = $false; error = '' }
    & $Prepare
    $b = Read-AttrValue $Target $TL ($Prefix + '.read') $Name -Silent:$Silent
    $out.read = $b.Ok; $out.before = $b.Value
    # Только чтение: на настоящем проекте чужие атрибуты из списка владельца не трогаем даже «с возвратом».
    if ($NoWrite) { return $out }
    $w = Try-Calls -Op ($Prefix + '.write') -Target $Target -TL $TL -Cands (Get-AttrWriteCands $Name $script:ProbeValue) -First -Silent:$Silent
    $out.write = $w.Ok
    if ($w.Ok) {
        $rb = Read-AttrValue $Target $TL ($Prefix + '.readback') $Name -Silent:$Silent
        $out.readback = ($rb.Ok -and $rb.Value -eq $script:ProbeValue)
        # возвращаем как было
        $restored = $false
        if ($out.before -ne $null -and $out.before -ne '') {
            $rr = Try-Calls -Op ($Prefix + '.restore') -Target $Target -TL $TL -Cands (Get-AttrWriteCands $Name $out.before) -First -Silent:$Silent
            $chk = Read-AttrValue $Target $TL ($Prefix + '.restore.check') $Name -Silent
            $restored = ($chk.Ok -and $chk.Value -eq $out.before)
        } else {
            [void](Try-Calls -Op ($Prefix + '.delete') -Target $Target -TL $TL -Cands (Get-AttrDeleteCands $Name) -First -Silent:$Silent)
            $chk = Read-AttrValue $Target $TL ($Prefix + '.restore.check') $Name -Silent
            if (-not ($chk.Ok -and ($chk.Value -eq '' -or $null -eq $chk.Value))) {
                # удаление не помогло — хотя бы пустое значение
                [void](Try-Calls -Op ($Prefix + '.restore') -Target $Target -TL $TL -Cands (Get-AttrWriteCands $Name '') -First -Silent:$Silent)
                $chk = Read-AttrValue $Target $TL ($Prefix + '.restore.check') $Name -Silent
            }
            $restored = ($chk.Ok -and ($chk.Value -eq '' -or $null -eq $chk.Value))
        }
        $out.restored = $restored
        if (-not $restored) {
            [void]$script:Leftovers.Add(@{ Carrier = $Carrier; Name = $Name; Before = $out.before })
            Write-Human ('! Атрибут ' + $Name + ' на «' + $Carrier + '» не вернулся к прежнему значению «' + $out.before + '». Верните вручную.') 'Yellow'
        }
    }
    return $out
}

function Step-ProjectAttributes {
    Write-Section '3' 'Атрибуты проекта и листа'
    $job = $script:Job
    # --- весь набор атрибутов проекта (только чтение)
    $listCands = @((Cand 'GetAttributeNames' @($null) @(0)), (Cand 'GetAttributeIds' @($null) @(0)), (Cand 'GetAttributes' @($null) @(0)), (Cand 'GetAllAttributeNames' @($null) @(0)), (Cand 'GetAttributeList' @($null) @(0)), (Cand 'GetAttributeNames' @($null, 0) @(0)))
    $list = Try-Calls -Op 'project.attributes.list' -Target $job -TL 'job' -Cands $listCands
    $lines = @()
    if ($null -ne $list.Items) {
        foreach ($item in $list.Items) {
            if ($item -is [string]) {
                $v = Read-AttrValue $job 'job' 'project.attributes.read' $item -Silent
                $lines += ($item + ' = ' + $(if ($v.Ok) { $v.Value } else { '(не прочитан)' }))
            } else { $lines += [string]$item }
        }
    }
    [System.IO.File]::WriteAllText((Join-Path $script:LogDir 'project-attributes.txt'), ($lines -join "`r`n"), $script:Utf8Bom)
    Write-Human ('Атрибутов проекта прочитано: ' + $lines.Count + ' (файл project-attributes.txt)')

    # --- запись на проекте: только то, что можно вернуть как было
    foreach ($name in @('FLUX_PROJECT', $script:UndefinedAttr)) {
        $res = Test-AttributeRW $job 'job' 'attr.project' $name 'Проект' { }
        $script:ProjectAttrResults += , $res
        Write-Human ('Проект / ' + $name + ': чтение ' + $res.read + ', запись ' + $res.write + ', возврат ' + $res.restored)
    }
    # --- на временном листе: все пять атрибутов связи и неопределённый
    $sh = $script:Objects['Sheet']
    if ($null -ne $script:ProbeSheetId -and $null -ne $sh) {
        $id = $script:ProbeSheetId
        foreach ($name in ($script:FluxAttrs + @($script:UndefinedAttr, 'Sheet number'))) {
            $res = Test-AttributeRW $sh 'sheet' 'attr.sheet' $name 'Лист' { [void](Use-Sheet $id) }
            Write-Human ('Лист / ' + $name + ': чтение ' + $res.read + ', запись ' + $res.write + ', возврат ' + $res.restored)
        }
    }
    $fluxUnwritable = @($script:ProjectAttrResults | Where-Object { $_.name -eq 'FLUX_PROJECT' -and -not $_.write })
    if ($fluxUnwritable.Count -gt 0) { Add-Finding 'need' 'FLUX_PROJECT на проекте записать не удалось: заведите атрибут «FLUX_PROJECT» (носитель — проект) в базе E3.' }
    else { Add-Finding 'ok' 'FLUX_PROJECT на проекте пишется и возвращается.' }
}
$script:ProjectAttrResults = @()

function Import-OwnerAttributes {
    $path = Join-Path $script:ProbeRoot 'attributes.txt'
    if (-not (Test-Path $path)) { $script:OwnerAttrs = @(); return }
    $script:OwnerAttrs = @(Get-Content -Path $path -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

function Step-OwnerAttributes {
    # Раздел E: каждое имя из списка владельца — есть ли в базе и на каких носителях пишется.
    param($Carriers)
    Write-Section 'E2' ('Атрибуты из списка владельца (' + $script:OwnerAttrs.Count + ')')
    if ($script:OwnerAttrs.Count -eq 0) { Write-Human 'attributes.txt пуст или не найден.'; return }
    $defNames = $script:AttrDefNames
    $rows = New-Object System.Collections.ArrayList
    $missing = New-Object System.Collections.ArrayList
    foreach ($name in $script:OwnerAttrs) {
        $row = [ordered]@{ name = $name; inDefinitions = $(if ($null -eq $defNames) { 'неизвестно' } elseif ($defNames -contains $name) { 'да' } else { 'нет' }) }
        $summary = @()
        foreach ($c in $Carriers) {
            $res = Test-AttributeRW $c.Target $c.TL ('attrdef.' + $c.Id) $name $c.Label $c.Prepare -Silent -NoWrite:$c.ReadOnly
            if ($c.ReadOnly) {
                $row[$c.Id] = $(if ($res.read) { 'чтение' } else { '—' })
            } else {
                $row[$c.Id] = $(if ($res.write) { 'запись' } elseif ($res.read) { 'чтение' } else { '—' })
            }
            $summary += ($c.Id + ':' + $row[$c.Id])
        }
        $any = $false; foreach ($c in $Carriers) { if ($row[$c.Id] -ne '—') { $any = $true } }
        $row['found'] = $any
        if (-not $any) { [void]$missing.Add($name) }
        [void]$rows.Add($row)
        Write-Human ('{0} {1}  [определение: {2}]  {3}' -f $(if ($any) { '✓' } else { '✕' }), $name, $row.inDefinitions, ($summary -join ' '))
    }
    $head = @('name', 'inDefinitions') + @($Carriers | ForEach-Object { $_.Id }) + @('found')
    $csv = New-Object System.Collections.ArrayList
    [void]$csv.Add(($head -join ';'))
    foreach ($r in $rows) { [void]$csv.Add((($head | ForEach-Object { [string]$r[$_] }) -join ';')) }
    [System.IO.File]::WriteAllText((Join-Path $script:LogDir 'attribute-check.csv'), ($csv -join "`r`n"), $script:Utf8Bom)
    $script:AttrCheckRows = $rows
    $script:AttrMissing = $missing
    Write-Human ('Имён из списка: ' + $rows.Count + ', ни на одном носителе не найдено: ' + $missing.Count)
    if ($missing.Count -gt 0) { Add-Finding 'need' ('Атрибуты из списка владельца, которых в базе E3 нет (ни на одном проверенном носителе): ' + $missing.Count + ' — полный список в attribute-check.csv, столбец found=False.') }
    else { Add-Finding 'ok' ('Все ' + $rows.Count + ' атрибутов из списка владельца найдены в базе E3.') }
    $flux = @($rows | Where-Object { $_.name -match '^FLUX_' -and -not $_.found })
    $fluxAll = @($script:FluxAttrs | Where-Object { $_ -ne 'GLOBAL_ID_IN_PROJECT' })
    Add-Finding 'need' ('Завести в базе E3 (если нет): ' + ($fluxAll -join ', ') + ' — носители: проект (FLUX_PROJECT), блок (FLUX_BLOCK, FLUX_VER), изделие (FLUX_ID).')
}
$script:AttrCheckRows = @()
$script:AttrMissing = @()
$script:AttrDefNames = $null
