# Полная опись API: библиотека типов (ITypeInfo/ITypeLib) каждого объекта и запасной путь через Get-Member.

$script:ApiJson = [ordered]@{}        # метка объекта -> JSON (строка)
$script:ApiLibJson = [ordered]@{}     # GUID библиотеки -> JSON (строка)
$script:ApiNames = @{}                # метка объекта -> имена членов
$script:ApiSource = @{}               # метка объекта -> typeinfo | get-member | none
$script:TypeInfoLoaded = $false

function Initialize-TypeInfo {
    if ($script:TypeInfoLoaded) { return $true }
    try {
        Write-Trace 'Add-Type: компилирую lib\TypeInfoDump.cs'
        Add-Type -Path (Join-Path $script:ProbeRoot 'lib\TypeInfoDump.cs') -ReferencedAssemblies 'System.Web.Extensions' -ErrorAction Stop
        [FluxTypeInfo]::TracePath = $script:TracePath
        Write-Trace 'Add-Type: готово'
        $script:TypeInfoLoaded = $true
        return $true
    } catch {
        Write-Human ('✕ не собрался разборщик библиотек типов: ' + (Get-InnerException $_.Exception).Message) 'Yellow'
        return $false
    }
}

function Get-SafeLabel {
    param([string]$Label)
    return ($Label -replace '[^A-Za-z0-9_.-]', '_')
}

function Save-ApiText {
    param([string]$Label, [string]$Text)
    $path = Join-Path $script:LogDir ('api-' + (Get-SafeLabel $Label) + '.txt')
    [System.IO.File]::WriteAllText($path, $Text, $script:Utf8Bom)
}

function Export-ApiObject {
    # Снимает список методов и свойств объекта. Возвращает имена членов (может быть пустым).
    param($Object, [string]$Label)
    if ($null -eq $Object) { return @() }
    if ($script:ApiNames.ContainsKey($Label)) { return $script:ApiNames[$Label] }
    $names = @()
    $source = 'none'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $note = ''
    Write-Trace ('опись ' + $Label + ': начинаю')
    if (-not $script:Fake -and (Initialize-TypeInfo)) {
        try {
            $parts = [FluxTypeInfo]::OfObject($Object, $Label)
            $script:ApiJson[$Label] = $parts[0]
            Save-ApiText $Label $parts[1]
            $names = @($parts[2] -split "`n" | Where-Object { $_ -ne '' })
            $source = 'typeinfo'
            # Библиотека целиком снимается отдельным шагом в конце (Step-TypeLibrary), из файла на диске.
            Write-Trace ('опись ' + $Label + ': готово, членов ' + $names.Count)
        } catch {
            $note = ' typeinfo: ' + (Get-InnerException $_.Exception).Message
        }
    }
    if ($source -eq 'none') {
        # Запасной путь: PowerShell сам читает IDispatch и показывает члены, если библиотека типов есть.
        try {
            $members = @(Get-Member -InputObject $Object -ErrorAction Stop | Where-Object { $_.MemberType -ne 'Event' })
            if ($members.Count -gt 0) {
                $names = @($members | ForEach-Object { $_.Name })
                $text = 'Объект: ' + $Label + "  (из Get-Member: параметры и справка недоступны)`r`n" + (($members | ForEach-Object { '  ' + $_.MemberType + ' ' + $_.Definition }) -join "`r`n")
                Save-ApiText $Label $text
                $script:ApiJson[$Label] = (ConvertTo-Json @{ label = $Label; fromGetMember = @($members | ForEach-Object { @{ name = $_.Name; type = [string]$_.MemberType; definition = $_.Definition } }) } -Depth 4 -Compress)
                $source = 'get-member'
            }
        } catch { $note += ' Get-Member: ' + (Get-InnerException $_.Exception).Message }
    }
    $sw.Stop()
    $script:ApiNames[$Label] = $names
    $script:ApiSource[$Label] = $source
    $rec = [ordered]@{ seq = 0; step = $script:Step; op = 'api.dump'; candidate = $Label; args = ''; ok = ($names.Count -gt 0); type = $source; result = ('членов: ' + $names.Count + $note); error = $(if ($names.Count -gt 0) { $null } else { 'Библиотека типов недоступна' + $note }); hresult = $null; busy = $false; ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1) }
    $script:Seq++; $rec.seq = $script:Seq
    Add-Record $rec
    if ($names.Count -gt 0) {
        if (-not $script:Winners.Contains('api.dump')) { $script:Winners['api.dump'] = New-Object System.Collections.ArrayList }
        [void]$script:Winners['api.dump'].Add($Label + ' (' + $source + ')')
    } elseif (-not $script:Winners.Contains('api.dump')) { $script:Failed['api.dump'] = 1 }
    Write-Human ('{0} опись {1}: {2}, членов {3}{4}' -f $(if ($names.Count -gt 0) { '✓' } else { '✕' }), $Label, $source, $names.Count, $note)
    return $names
}

function Save-ApiLibrary {
    # Библиотека типов целиком: текст в api-typelib-<GUID>.txt, JSON — в api.json (раздел libraries).
    param([string[]]$Doc, [string]$Label)
    $guid = ''
    if ($Doc[0] -match '"guid":"(\{[0-9A-Fa-f-]+\})"') { $guid = $Matches[1] }
    if ($guid -eq '') { return '' }
    if (-not $script:ApiLibDone) { $script:ApiLibDone = @{} }
    if ($script:ApiLibDone.ContainsKey($guid)) { return $guid }
    $script:ApiLibDone[$guid] = $true
    $script:ApiLibJson[$guid] = $Doc[0]
    [System.IO.File]::WriteAllText((Join-Path $script:LogDir ('api-typelib-' + (Get-SafeLabel $guid) + '.txt')), $Doc[1], $script:Utf8Bom)
    return $guid
}

function Step-TypeLibrary {
    # Раздел T: опись всей библиотеки типов. Идёт ПОСЛЕДНИМ и читает файл .tlb с диска, а не живой объект: через ITypeInfo
    # запущенного E3 каждое обращение — вызов в другой процесс, их тысячи, и в первом реальном прогоне проба на этом встала.
    Write-Section 'T' 'Библиотека типов целиком (из файла на диске)'
    if ($script:Fake) { Write-Human '— в подставном COM библиотеки типов нет.'; return }
    if (-not (Initialize-TypeInfo)) { return }
    $path = ''
    foreach ($reg in @($script:Env['progIds'])) { if ($reg.progId -eq 'CT.Application' -and $reg.typeLibPath) { $path = [string]$reg.typeLibPath } }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        if ($path -ne '' -and (Test-Path -LiteralPath $path)) {
            Write-Trace ('библиотека: читаю файл ' + $path)
            Write-Human ('Читаю библиотеку типов из файла: ' + $path)
            $doc = [FluxTypeInfo]::LibraryFile($path, 'CT.Application')
        } elseif ($null -ne $script:App) {
            Write-Trace 'библиотека: файла нет, читаю через живой объект E3 (долго)'
            Write-Human 'Файл библиотеки типов не найден, читаю через живой E3 (может занять несколько минут).' 'Yellow'
            $doc = [FluxTypeInfo]::Library($script:App, 'Application')
        } else { Write-Human 'Библиотека типов: файл не найден и E3 недоступен.'; return }
        $guid = Save-ApiLibrary $doc 'Application'
        Write-Human ('✓ библиотека типов ' + $guid + ' записана (api-typelib-*.txt), ' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + ' с')
        Add-Finding 'ok' ('Полная опись API записана: api-typelib-' + (Get-SafeLabel $guid) + '.txt.')
    } catch {
        $inner = Get-InnerException $_.Exception
        Write-Human ('✕ библиотека типов не снята: ' + $inner.Message) 'Yellow'
        Add-Finding 'need' ('Библиотека типов целиком не снята: ' + $inner.Message)
    }
}

function Save-ApiJson {
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('{"objects":{')
    $first = $true
    foreach ($key in $script:ApiJson.Keys) {
        if (-not $first) { [void]$builder.Append(',') }; $first = $false
        [void]$builder.Append((ConvertTo-Json ([string]$key) -Compress)).Append(':').Append($script:ApiJson[$key])
    }
    [void]$builder.Append('},"libraries":{')
    $first = $true
    foreach ($key in $script:ApiLibJson.Keys) {
        if (-not $first) { [void]$builder.Append(',') }; $first = $false
        [void]$builder.Append((ConvertTo-Json ([string]$key) -Compress)).Append(':').Append($script:ApiLibJson[$key])
    }
    [void]$builder.Append('}}')
    [System.IO.File]::WriteAllText((Join-Path $script:LogDir 'api.json'), $builder.ToString(), $script:Utf8Bom)
}

function Test-ApiMember {
    # Есть ли член с таким именем (по шаблону) у объекта: возвращает найденные имена. $null — описи нет, ответить нельзя.
    param([string]$Label, [string]$Pattern)
    if (-not $script:ApiNames.ContainsKey($Label) -or $script:ApiNames[$Label].Count -eq 0) { return $null }
    return @($script:ApiNames[$Label] | Where-Object { $_ -match $Pattern })
}

function Get-ProgIdRegistration {
    # ProgID -> CLSID -> сервер и библиотека типов: куда смотреть, если опись по объекту недоступна.
    param([string]$ProgId)
    $info = [ordered]@{ progId = $ProgId; clsid = $null; server = $null; serverKind = $null; typeLib = $null; typeLibPath = $null; error = $null }
    try {
        $clsid = (Get-ItemProperty -Path ('Registry::HKEY_CLASSES_ROOT\' + $ProgId + '\CLSID') -ErrorAction Stop).'(default)'
        $info.clsid = $clsid
        $base = 'Registry::HKEY_CLASSES_ROOT\CLSID\' + $clsid
        foreach ($kind in @('LocalServer32', 'InprocServer32')) {
            $key = Get-ItemProperty -Path ($base + '\' + $kind) -ErrorAction SilentlyContinue
            if ($key) { $info.server = $key.'(default)'; $info.serverKind = $kind; break }
        }
        $lib = Get-ItemProperty -Path ($base + '\TypeLib') -ErrorAction SilentlyContinue
        if ($lib) {
            $info.typeLib = $lib.'(default)'
            $versions = @(Get-ChildItem -Path ('Registry::HKEY_CLASSES_ROOT\TypeLib\' + $info.typeLib) -ErrorAction SilentlyContinue)
            foreach ($v in $versions) {
                foreach ($arch in @('win64', 'win32')) {
                    $p = Get-ItemProperty -Path ($v.PSPath + '\0\' + $arch) -ErrorAction SilentlyContinue
                    if ($p) { $info.typeLibPath = $p.'(default)'; break }
                }
                if ($info.typeLibPath) { break }
            }
        }
    } catch { $info.error = (Get-InnerException $_.Exception).Message }
    return $info
}
