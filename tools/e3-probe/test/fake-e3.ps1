# Подставной COM для проверки e3-probe.ps1 без E3: объекты на ScriptMethod, состояние в $global:F.
# Подключается параметром -FakeCom. Имена и порядок аргументов — как в догадках пробы; часть вызовов намеренно отсутствует
# или падает с HRESULT, чтобы проверить разбор ошибок.

$global:F = @{
    Next = 1000
    Sheets = @{ 101 = @{ Name = 'Лист 1'; Format = 'A3'; Attrs = @{} } }
    Devices = @{ 501 = @{ Name = '-M1'; Attrs = @{ 'GLOBAL_ID_IN_PROJECT' = 'ID-1' }; Sym = @() } }
    Symbols = @{}
    Pins = @{}
    Conns = @()
    ProjectAttrs = @{ 'Sheet number' = '1' }
    Defined = @('GLOBAL_ID_IN_PROJECT', 'FLUX_ID', 'FLUX_BLOCK', 'FLUX_VER', 'Sheet number', 'Device Designation', 'GLOBAL_BLOCK_ID', 'GLOBAL_BLOCK_NAME', 'dip_Fnumber', '!Pin_OpisaniePR_tip_signala')
    Components = @('Клапан_К24_КП2', 'Двигатель_М1')
    Active = 101
    Log = @()
}

function New-FakeObject {
    param([hashtable]$Methods)
    $o = New-Object PSObject
    Add-Member -InputObject $o -MemberType NoteProperty -Name Id -Value 0
    foreach ($name in $Methods.Keys) { Add-Member -InputObject $o -MemberType ScriptMethod -Name $name -Value $Methods[$name] }
    return $o
}

function Throw-FakeCom {
    param([string]$Message, [int]$Hr = -2147352567)
    throw (New-Object System.Runtime.InteropServices.COMException($Message, $Hr))
}

$global:FakeAttrGet = {
    param($store, $a)
    if ($global:F.Defined -notcontains [string]$a[0]) { Throw-FakeCom ('Атрибут ' + $a[0] + ' не определён') }
    if ($store.ContainsKey([string]$a[0])) { return [string]$store[[string]$a[0]] }
    return ''
}
$global:FakeAttrSet = {
    param($store, $a)
    if ($global:F.Defined -notcontains [string]$a[0]) { Throw-FakeCom ('Атрибут ' + $a[0] + ' не определён в базе') }
    $store[[string]$a[0]] = [string]$a[1]
    return 1
}

function New-FakeDevice {
    return (New-FakeObject @{
        SetId = { param($a) $this.Id = $a[0]; return 1 }
        GetName = { param($a) return $global:F.Devices[[int]$this.Id].Name }
        SetName = { param($a) $global:F.Devices[[int]$this.Id].Name = [string]$a[0]; return 1 }
        GetAttributeValue = { param($a) & $global:FakeAttrGet $global:F.Devices[[int]$this.Id].Attrs $a }
        SetAttributeValue = { param($a) & $global:FakeAttrSet $global:F.Devices[[int]$this.Id].Attrs $a }
        GetSymbolIds = { param($a) $ids = @($global:F.Devices[[int]$this.Id].Sym); $a[0] = [object[]]$ids; return $ids.Count }
        GetPinIds = {
            param($a)
            $pins = @(); foreach ($s in $global:F.Devices[[int]$this.Id].Sym) { $pins += @($global:F.Symbols[[int]$s].Pins) }
            $a[0] = [object[]]$pins; return $pins.Count
        }
        Delete = {
            param($a)
            $id = [int]$this.Id
            foreach ($s in @($global:F.Devices[$id].Sym)) { foreach ($p in @($global:F.Symbols[[int]$s].Pins)) { $global:F.Pins.Remove([int]$p) }; $global:F.Symbols.Remove([int]$s) }
            $global:F.Devices.Remove($id); return 1
        }
    })
}

function New-FakeSheet {
    return (New-FakeObject @{
        SetId = { param($a) $this.Id = $a[0]; return 1 }
        GetName = { param($a) return $global:F.Sheets[[int]$this.Id].Name }
        GetFormat = { param($a) return $global:F.Sheets[[int]$this.Id].Format }
        GetDrawingArea = { param($a) $a[0] = 10.0; $a[1] = 10.0; $a[2] = 410.0; $a[3] = 287.0; return 1 }
        Create = {
            param($a)
            $global:F.Next++; $id = $global:F.Next
            $global:F.Sheets[$id] = @{ Name = [string]$a[1]; Format = $(if ($a.Length -gt 2) { [string]$a[2] } else { '' }); Attrs = @{} }
            $this.Id = $id; return $id
        }
        Delete = { param($a) $global:F.Sheets.Remove([int]$this.Id); return 1 }
        GetAttributeValue = { param($a) & $global:FakeAttrGet $global:F.Sheets[[int]$this.Id].Attrs $a }
        SetAttributeValue = { param($a) & $global:FakeAttrSet $global:F.Sheets[[int]$this.Id].Attrs $a }
        GetSymbolIds = {
            param($a)
            $ids = @($global:F.Symbols.Keys | Where-Object { $global:F.Symbols[$_].Sheet -eq [int]$this.Id })
            $a[0] = [object[]]$ids; return $ids.Count
        }
        PlacePart = {
            param($a)
            if ([string]$a[0] -notin $global:F.Components) { Throw-FakeCom 'Компонент не найден' }
            $global:F.Next++; $dev = $global:F.Next; $global:F.Next++; $sym = $global:F.Next; $global:F.Next++; $p1 = $global:F.Next; $global:F.Next++; $p2 = $global:F.Next
            $global:F.Pins[$p1] = @{ Name = '1' }; $global:F.Pins[$p2] = @{ Name = '2' }
            $global:F.Symbols[$sym] = @{ Sheet = [int]$this.Id; X = $a[2]; Y = $a[3]; Pins = @($p1, $p2); Dev = $dev }
            $global:F.Devices[$dev] = @{ Name = '-V1'; Attrs = @{}; Sym = @($sym) }
            return $dev
        }
        ExportDXF = { param($a) Set-Content -Path ([string]$a[0]) -Value '0 SECTION' -Encoding ASCII; return 1 }
        ExportPNG = { param($a) Throw-FakeCom 'Не поддерживается в этой версии' }
    })
}

function New-FakeSymbol {
    return (New-FakeObject @{
        SetId = { param($a) $this.Id = $a[0]; return 1 }
        GetSchemaLocation = { param($a) $s = $global:F.Symbols[[int]$this.Id]; $a[0] = $s.X; $a[1] = $s.Y; if ($a.Length -gt 2) { $a[2] = 5 }; return $s.Sheet }
        GetPinIds = { param($a) $ids = @($global:F.Symbols[[int]$this.Id].Pins); $a[0] = [object[]]$ids; return $ids.Count }
        GetGraphIds = { param($a) $a[0] = [object[]]@(9001, 9002); return 2 }
        GetTextIds = { param($a) $a[0] = [object[]]@(); return 0 }
    })
}

function New-FakeJob {
    $sheet = New-FakeSheet
    return (New-FakeObject @{
        GetName = { param($a) if ($env:E3_FAKE_NOPROJECT) { return '' }; return 'Тестовый проект' }
        GetPath = { param($a) return 'C:\Fake\test.e3s' }
        GetSheetIds = { param($a) if ($env:E3_FAKE_NOPROJECT) { Throw-FakeCom 'Нет открытого проекта' -2147220992 }; $ids = @($global:F.Sheets.Keys); $a[0] = [object[]]$ids; return $ids.Count }
        GetActiveSheetId = { param($a) return $global:F.Active }
        SetActiveSheetId = { param($a) $global:F.Active = [int]$a[0]; return 1 }
        GetAllDeviceIds = { param($a) $ids = @($global:F.Devices.Keys); $a[0] = [object[]]$ids; return $ids.Count }
        GetAllConnectionIds = { param($a) $a[0] = [object[]]@($global:F.Conns); return @($global:F.Conns).Count }
        CreateConnection = { param($a) $global:F.Next++; $global:F.Conns += $global:F.Next; return $global:F.Next }
        GetAttributeValue = { param($a) & $global:FakeAttrGet $global:F.ProjectAttrs $a }
        SetAttributeValue = { param($a) & $global:FakeAttrSet $global:F.ProjectAttrs $a }
        GetAttributeNames = { param($a) $a[0] = [object[]]@($global:F.Defined); return $global:F.Defined.Count }
        CreateSheetObject = { param($a) return (New-FakeSheet) }
        CreateDeviceObject = { param($a) return (New-FakeDevice) }
        CreateSymbolObject = { param($a) return (New-FakeSymbol) }
        CreatePinObject = { param($a) return (New-FakeObject @{ SetId = { param($a) $this.Id = $a[0]; return 1 }; GetName = { param($a) return $global:F.Pins[[int]$this.Id].Name } }) }
        CreateComponentObject = { param($a) return (New-FakeObject @{ SetId = { param($a) return 1 }; GetNames = { param($a) $a[0] = [object[]]$global:F.Components; return $global:F.Components.Count }; Search = { param($a) return $(if ([string]$a[0] -in $global:F.Components) { 1 } else { 0 }) } }) }
        CreateGraphObject = { param($a) return (New-FakeObject @{ SetId = { param($a) $this.Id = $a[0]; return 1 }; GetType = { param($a) return 'Line' } }) }
        Undo = { param($a) return 1 }
        Save = { param($a) throw 'Save не должен вызываться пробой' }
    })
}

function New-FakeApp {
    return (New-FakeObject @{
        GetVersion = { param($a) return '2099.0 (fake)' }
        GetProcessId = { param($a) return 4242 }
        CreateJobObject = { param($a) return (New-FakeJob) }
        PutInfo = { param($a) return 1 }
    })
}

$script:FakeApps = @((New-FakeApp)); $global:FakeApps = $script:FakeApps
$script:FakeDispatcher = New-FakeObject @{ GetCount = { param($a) return 1 }; GetApplication = { param($a) return $global:FakeApps[0] } }
