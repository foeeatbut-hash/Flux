# Раздел D: база компонентов и символов E3 напрямую, ТОЛЬКО ЧТЕНИЕ.
# В API E3 нет ни одного списка компонентов, символов, классов или блоков (в первом прогоне все такие вызовы — «Unknown name»),
# зато app.GetComponentDatabase / GetSymbolDatabase отдают строку подключения (Access, провайдер ACE OLEDB). Читаем её тем же
# провайдером, что и сам E3: соединение открывается в режиме «только чтение», пишущих запросов нет.
# Низкоуровневые функции Open-Ado… подменяются в подставном COM (test\fake-e3.ps1).

$script:DbSearchHits = New-Object System.Collections.ArrayList     # где найдено имя решения: @{ Db; Table; Column; Name }

function Open-Ado {
    param([string]$Connection)
    try {
        $cn = New-Object -ComObject 'ADODB.Connection'
        $cn.Mode = 1            # adModeRead
        $cn.Open($Connection)
        return $cn
    } catch { Write-Human ('✕ база не открылась: ' + (Get-InnerException $_.Exception).Message) 'Yellow'; return $null }
}

function Close-Ado { param($Cn) try { if ($null -ne $Cn) { $Cn.Close() } } catch { } }

function Get-AdoRows {
    # Строки запроса как список словарей «колонка -> текст». DBNull и пустое — пустая строка.
    param($Cn, [string]$Sql, [int]$Max = 100)
    $rows = New-Object System.Collections.ArrayList
    $rs = New-Object -ComObject 'ADODB.Recordset'
    try {
        $rs.Open($Sql, $Cn, 0, 1)     # adOpenForwardOnly, adLockReadOnly
        $names = @(); for ($i = 0; $i -lt $rs.Fields.Count; $i++) { $names += [string]$rs.Fields.Item($i).Name }
        while (-not $rs.EOF -and $rows.Count -lt $Max) {
            $row = [ordered]@{}
            for ($i = 0; $i -lt $names.Count; $i++) {
                $v = $rs.Fields.Item($i).Value
                $row[$names[$i]] = $(if ($null -eq $v -or $v -is [System.DBNull]) { '' } else { [string]$v })
            }
            [void]$rows.Add($row)
            $rs.MoveNext()
        }
    } finally { try { $rs.Close() } catch { } }
    return @($rows)
}

function Get-AdoTableNames {
    param($Cn)
    $names = New-Object System.Collections.ArrayList
    $rs = $Cn.OpenSchema(20)          # adSchemaTables
    try {
        while (-not $rs.EOF) {
            $type = [string]$rs.Fields.Item('TABLE_TYPE').Value
            if ($type -eq 'TABLE' -or $type -eq 'VIEW') { [void]$names.Add([string]$rs.Fields.Item('TABLE_NAME').Value) }
            $rs.MoveNext()
        }
    } finally { try { $rs.Close() } catch { } }
    return @($names)
}

function Get-AdoColumns {
    # Колонки таблицы: @{ Name; Text } — Text истинно у строковых типов.
    param($Cn, [string]$Table)
    $cols = New-Object System.Collections.ArrayList
    $rs = New-Object -ComObject 'ADODB.Recordset'
    try {
        $rs.Open('SELECT * FROM [' + $Table + '] WHERE 1=0', $Cn, 0, 1)
        for ($i = 0; $i -lt $rs.Fields.Count; $i++) {
            $t = [int]$rs.Fields.Item($i).Type
            [void]$cols.Add(@{ Name = [string]$rs.Fields.Item($i).Name; Text = (@(8, 129, 130, 200, 201, 202, 203) -contains $t) })
        }
    } finally { try { $rs.Close() } catch { } }
    return @($cols)
}

function Get-AdoCount {
    param($Cn, [string]$Table)
    $r = @(Get-AdoRows $Cn ('SELECT COUNT(*) AS N FROM [' + $Table + ']') 1)
    if ($r.Count -eq 0) { return 0 }
    return [int]@($r[0].Values)[0]
}

function Get-AdoSample {
    param($Cn, [string]$Table, [int]$N = 2)
    return @(Get-AdoRows $Cn ('SELECT TOP ' + $N + ' * FROM [' + $Table + ']') $N)
}

function Get-AdoDistinct {
    param($Cn, [string]$Table, [string]$Column, [int]$Max = 3000)
    $rows = @(Get-AdoRows $Cn ('SELECT DISTINCT TOP ' + $Max + ' [' + $Column + '] AS V FROM [' + $Table + '] WHERE [' + $Column + '] IS NOT NULL') $Max)
    return @($rows | ForEach-Object { $_['V'] } | Where-Object { $_ -ne '' })
}

function Find-AdoValue {
    # Строки таблицы, где любая из колонок точно равна значению (без учёта регистра, как в Access).
    param($Cn, [string]$Table, [string[]]$Columns, [string]$Value)
    if ($Columns.Count -eq 0) { return @() }
    $esc = $Value -replace "'", "''"
    $where = (($Columns | ForEach-Object { '[' + $_ + "] = '" + $esc + "'" }) -join ' OR ')
    return @(Get-AdoRows $Cn ('SELECT TOP 3 * FROM [' + $Table + '] WHERE ' + $where) 3)
}

function Format-AdoRow {
    param($Row, [int]$Max = 400)
    $text = (($Row.Keys | Where-Object { $Row[$_] -ne '' } | ForEach-Object { $_ + '=' + $Row[$_] }) -join '; ')
    if ($text.Length -gt $Max) { $text = $text.Substring(0, $Max) + '…' }
    return $text
}

function Step-DatabaseRead {
    Write-Section 'D' 'База E3 напрямую: таблицы, имена, поиск решения (только чтение)'
    $dbs = @(@{ Label = 'Компоненты'; Method = 'GetComponentDatabase'; Schema = 'GetComponentDatabaseTableSchema' },
             @{ Label = 'Символы'; Method = 'GetSymbolDatabase'; Schema = 'GetSymbolDatabaseTableSchema' })
    $names = @($script:SolutionName) + @($script:FallbackSolutions | Where-Object { $_ -ne $script:SolutionName })
    $schemaText = New-Object System.Collections.ArrayList
    $namesText = New-Object System.Collections.ArrayList
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    foreach ($db in $dbs) {
        $conn = Get-QuietValue $script:App $db.Method
        $schema = Get-QuietValue $script:App $db.Schema
        if ($null -ne $schema -and "$schema" -ne '') { [void]$schemaText.Add('### ' + $db.Label + ': схема таблиц от E3 (' + $db.Schema + ")`r`n" + [string]$schema) }
        if ($null -eq $conn -or "$conn" -eq '') { Add-Finding 'need' ('База «' + $db.Label + '»: E3 не назвал строку подключения (' + $db.Method + ').'); continue }
        $cn = Open-Ado ([string]$conn)
        if ($null -eq $cn) { Add-Finding 'need' ('База «' + $db.Label + '» не открылась через ADO/OLEDB (нужен драйвер ACE OLEDB; строка в environment.json).'); continue }
        try {
            $tables = @(Get-AdoTableNames $cn)
            Write-Human ('База «' + $db.Label + '»: таблиц ' + $tables.Count)
            foreach ($t in $tables) {
                if ($sw.Elapsed.TotalSeconds -gt 120) { Write-Human '· чтение базы остановлено по времени (120 с)' 'Yellow'; break }
                try {
                    $cols = @(Get-AdoColumns $cn $t)
                    $count = Get-AdoCount $cn $t
                    $block = '### ' + $db.Label + ' / ' + $t + ' (' + $count + ' строк)' + "`r`n  колонки: " + (($cols | ForEach-Object { $_.Name + $(if ($_.Text) { '' } else { ':число' }) }) -join ', ')
                    foreach ($row in @(Get-AdoSample $cn $t 2)) { $block += "`r`n  пример: " + (Format-AdoRow $row) }
                    [void]$schemaText.Add($block)
                    $textCols = @($cols | Where-Object { $_.Text } | ForEach-Object { $_.Name })
                    # имена: колонки, похожие на имя компонента, символа, блока, формата
                    foreach ($c in $textCols) {
                        if ($c -notmatch '(?i)name|symbol|comp|part|block|format|class|code|имя|назв|наимен') { continue }
                        if ($count -eq 0 -or $namesText.Count -ge 60) { continue }
                        $vals = @(Get-AdoDistinct $cn $t $c 3000)
                        if ($vals.Count -eq 0) { continue }
                        $title = 'БД ' + $db.Label + ' / ' + $t + '.' + $c
                        Add-DbList $title $vals
                        [void]$namesText.Add('### ' + $title + ' (' + $vals.Count + ")`r`n" + ($vals -join "`r`n"))
                        foreach ($n in $names) { Find-InList $title $vals $n }
                    }
                    # точное совпадение имени решения в любой текстовой колонке таблицы
                    foreach ($n in $names) {
                        $hit = @(Find-AdoValue $cn $t $textCols $n)
                        if ($hit.Count -gt 0) {
                            Write-Human ('✓ «' + $n + '» найдено в базе «' + $db.Label + '», таблица ' + $t + ': ' + (Format-AdoRow $hit[0])) 'Green'
                            [void]$script:DbSearchHits.Add(@{ Db = $db.Label; Table = $t; Name = $n; Row = (Format-AdoRow $hit[0]) })
                            [void]$script:SolutionFound.Add('база «' + $db.Label + '», таблица ' + $t + ': ' + $n)
                        }
                    }
                } catch { Write-Human ('· таблица ' + $t + ' не прочитана: ' + (Get-InnerException $_.Exception).Message) 'DarkGray' }
            }
        } finally { Close-Ado $cn }
    }
    [System.IO.File]::WriteAllText((Join-Path $script:LogDir 'database-schema.txt'), ($schemaText -join "`r`n`r`n"), $script:Utf8Bom)
    [System.IO.File]::WriteAllText((Join-Path $script:LogDir 'database-names.txt'), ($namesText -join "`r`n`r`n"), $script:Utf8Bom)
    if ($script:DbSearchHits.Count -gt 0) { Add-Finding 'ok' ('Имя решения найдено прямо в базе E3: ' + (($script:DbSearchHits | ForEach-Object { $_.Db + '/' + $_.Table + ' «' + $_.Name + '»' }) -join '; ')) }
    elseif ($schemaText.Count -gt 0) { Add-Finding 'need' ('Ни одно из имён решения (' + ($names -join ', ') + ') не найдено в таблицах базы компонентов и символов: см. database-schema.txt и database-names.txt.') }
    Write-Human 'Файлы: database-schema.txt (таблицы, колонки, примеры), database-names.txt (списки имён).'
}
