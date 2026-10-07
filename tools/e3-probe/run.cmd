@echo off
rem Zapusk proverki API E3 dvoynym shchelchkom. Nichego ustanavlivat ne nado: PowerShell 5.1 vhodit v Windows.
rem Nuzhen 64-razryadnyj PowerShell: 32-razryadnyj process ne vidit COM 64-razryadnogo E3.
setlocal
chcp 65001 >nul
set "PS=%SystemRoot%\sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0e3-probe.ps1" %*
echo.
echo Exit code: %ERRORLEVEL%
pause
