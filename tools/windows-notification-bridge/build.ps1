param([string]$OutputDirectory = "$PSScriptRoot\out")
$ErrorActionPreference = 'Stop'
$taskStage = Join-Path $OutputDirectory 'stage'
$taskPackage = Join-Path $OutputDirectory 'Flux.NotificationBridge.msix'
if (Test-Path $taskStage) { Remove-Item -LiteralPath $taskStage -Recurse -Force }
New-Item -ItemType Directory -Path $taskStage -Force | Out-Null
dotnet publish "$PSScriptRoot\Flux.NotificationBridge.csproj" -c Release -r win-x64 --self-contained true -o $taskStage
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }
Copy-Item -LiteralPath "$PSScriptRoot\Package.appxmanifest" -Destination (Join-Path $taskStage 'AppxManifest.xml')
$taskAssets = Join-Path $taskStage 'Assets'
New-Item -ItemType Directory -Path $taskAssets -Force | Out-Null
Add-Type -AssemblyName System.Drawing
$taskIcon = [System.Drawing.Image]::FromFile((Resolve-Path "$PSScriptRoot\..\..\build\icon.png"))
try {
  foreach ($taskSpec in @(@('StoreLogo.png',50),@('Square44x44Logo.png',44),@('Square150x150Logo.png',150))) {
    $taskBitmap = New-Object System.Drawing.Bitmap($taskSpec[1],$taskSpec[1])
    $taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
    try { $taskGraphics.DrawImage($taskIcon,0,0,$taskSpec[1],$taskSpec[1]); $taskBitmap.Save((Join-Path $taskAssets $taskSpec[0]),[System.Drawing.Imaging.ImageFormat]::Png) }
    finally { $taskGraphics.Dispose(); $taskBitmap.Dispose() }
  }
} finally { $taskIcon.Dispose() }
$taskSdk = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory | Sort-Object Name -Descending |
  Where-Object { Test-Path (Join-Path $_.FullName 'x64\makeappx.exe') } | Select-Object -First 1
if (!$taskSdk) { throw 'Windows SDK MakeAppx.exe is required' }
& (Join-Path $taskSdk.FullName 'x64\makeappx.exe') pack /d $taskStage /p $taskPackage /o
if ($LASTEXITCODE -ne 0) { throw 'MakeAppx validation failed' }
Write-Output "Unsigned package: $taskPackage"
Write-Output 'Sign with a certificate whose Subject matches CN=Flux before installing. See README.md.'
