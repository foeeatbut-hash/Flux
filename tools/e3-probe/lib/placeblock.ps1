# Режим «только разместить», блок из файла (.e3p/.e3s): Job.ImportDrawing на АКТИВНЫЙ лист. Подсхема из базы идёт прежним
# порядком (Sheet.PlacePart в lib\placeonly.ps1). Ничего не удаляется и не сохраняется; успех — рост числа устройств,
# блоков или символов на листе, а не только ненулевой ответ.

function Resolve-BlockFile {
    # Введённая строка -> полный путь к существующему файлу блока или ''. Кавычки (при перетаскивании файла в окно) снимаются;
    # имя без пути ищется рядом со скриптом. Файлом считается строка с расширением .e3p/.e3s, даже если файла нет (тогда $script:BlockMissing).
    param([string]$Text)
    $script:BlockMissing = $false
    $t = $Text.Trim().Trim('"').Trim("'").Trim()
    if ($t -notmatch '\.(e3p|e3s)$') { return '' }
    foreach ($cand in @($t, (Join-Path $script:ProbeRoot $t))) {
        if (Test-Path -LiteralPath $cand -PathType Leaf) { return [string](Resolve-Path -LiteralPath $cand).ProviderPath }
    }
    $script:BlockMissing = $true
    return ''
}

function Get-BlockIdList {
    return @(Get-Ids 'blocks' 'place.job.blocks' $script:Job 'job' @((Cand 'GetBlockIds' @($null) @(0)), (Cand 'GetBlockIds' @($null, 0) @(0))))
}

function Write-BlockSuccess {
    param([string]$File, $v, $newDev, $newSym, $newBlk, $sheetName, $sid, $point)
    $dev = $script:Objects['Device']; $sym = $script:Objects['Symbol']
    Write-Human ''
    Write-Human 'ГОТОВО: вставлен блок из файла.' 'Green'
    Write-Human ('  Файл: ' + $File)
    Write-Human ('  Добавилось: устройств ' + @($newDev).Count + ', блоков ' + @($newBlk).Count + ', символов на листе ' + @($newSym).Count)
    foreach ($d in @($newDev)) { $n = ''; if (Select-Id $dev $d) { $n = [string](Get-QuietValue $dev 'GetName') }; Write-Human ('  Устройство: id ' + $d + ', имя «' + $n + '»') }
    foreach ($s in @($newSym)) {
        $shId = ''; if (Select-Id $sym $s) { $shId = [string](Get-QuietValue $sym 'GetSheetId') }
        Write-Human ('  Символ: id ' + $s + $(if ($shId -ne '') { ', лист ' + $shId } else { '' }))
    }
    if (@($newBlk).Count -gt 0) { Write-Human ('  Блоки: id ' + (@($newBlk) -join ', ')) }
    Write-Human ('  Лист «' + $sheetName + '» (id ' + $sid + '); точка (' + $point[0] + ', ' + $point[1] + ')')
    Write-Human ('  Вызов: ' + $v.Label + ' — ' + (($v.Steps | ForEach-Object { $_.T + '.' + $_.M + '(' + (Format-Args $_.A @()) + ')' }) -join ' → '))
    Write-Human '  Отменить: Ctrl+Z или выделить блок в E3 и нажать Delete. Проект не сохранялся.' 'Yellow'
    Add-Finding 'ok' ('Вставлен блок из файла ' + $File + ' на лист «' + $sheetName + '» (id ' + $sid + '): устройств ' + @($newDev).Count + ' (id ' + (@($newDev) -join ', ') + '), символов на листе ' + @($newSym).Count + ' (id ' + (@($newSym) -join ', ') + '), блоков ' + @($newBlk).Count + ', вызов ' + $v.Label + '.')
}

function Step-PlaceBlockFile {
    param([string]$File, $Sid, $Point, $SheetName)
    $plans = @(
        @{ Id = 'job.ImportDrawing'; Label = 'job.ImportDrawing'; Steps = @((New-PlanStep job ImportDrawing @([string]$File, [int]1, [double]$Point[0], [double]$Point[1]) -Pos)) },
        @{ Id = 'job.ImportDrawingEx'; Label = 'job.ImportDrawingEx (flags 0)'; Steps = @((New-PlanStep job ImportDrawingEx @([string]$File, [int]1, [int]0, [double]$Point[0], [double]$Point[1]) -Pos)) })
    foreach ($v in $plans) {
        $v.SheetId = $Sid; $v.A = @($v.Steps)[-1].A
        $devBefore = @(Get-AllDevices); $symBefore = @(Get-SheetSymbols); $blkBefore = @(Get-BlockIdList)
        $r = Invoke-PlaceVariant $v ('place.only.block.' + $v.Id)
        if (-not $r.Ok) { continue }
        $newDev = @(@(Get-AllDevices) | Where-Object { $devBefore -notcontains $_ })
        $newSym = @(@(Get-SheetSymbols) | Where-Object { $symBefore -notcontains $_ })
        $newBlk = @(@(Get-BlockIdList) | Where-Object { $blkBefore -notcontains $_ })
        if ($newDev.Count -gt 0 -or $newSym.Count -gt 0 -or $newBlk.Count -gt 0) {
            Write-BlockSuccess $File $v $newDev $newSym $newBlk $SheetName $Sid $Point
            if ($newSym.Count -eq 0) { Write-Human '! На активном листе новых символов нет: блок лёг на другой лист или без символов. Смотрите id устройств выше.' 'Yellow' }
            return $true
        }
        Write-Human ('! ' + $v.Label + ' вернул успех, но устройств, блоков и символов не прибавилось. Пробую следующий вызов.') 'Yellow'
        Add-Finding 'note' ($v.Label + ' вернул успех без роста числа устройств, блоков и символов.')
    }
    Write-Human ''
    Write-Human ('✕ блок из файла ' + $File + ' вставить не удалось (ImportDrawing, ImportDrawingEx). Подробности — в trace.log и log.txt.') 'Red'
    Add-Finding 'bad' ('Блок из файла ' + $File + ' не вставлен ни ImportDrawing, ни ImportDrawingEx.')
    return $false
}
