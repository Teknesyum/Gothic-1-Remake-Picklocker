# Gothic 1 LockPicker - Kurulum betigi
#
# Kullanim (PowerShell'de calistirin):
#   irm https://raw.githubusercontent.com/Teknesyum/Gothic-1-Remake-Picklocker/master/install.ps1 | iex
#
# Bu betik repoyu klonlar (veya guncelller), bagimliliklari kurar ve
# masaustune gizli calisan bir baslatici (.bat) birakir. Uygulama zaten
# her acilista kendi guncelleme kontrolunu yapar (bkz. main.cjs), bu yuzden
# bu betigi tekrar calistirmaya normalde gerek yoktur.

$ErrorActionPreference = 'Stop'

$repoUrl = 'https://github.com/Teknesyum/Gothic-1-Remake-Picklocker.git'
$installDir = Join-Path $env:LOCALAPPDATA 'Gothic1LockPicker'

function Test-CommandExists([string] $name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not (Test-CommandExists 'git')) {
    Write-Error "Git kurulu degil. Once https://git-scm.com/downloads adresinden Git kurup tekrar deneyin."
    exit 1
}
if (-not (Test-CommandExists 'node') -or -not (Test-CommandExists 'npm')) {
    Write-Error "Node.js kurulu degil. Once https://nodejs.org adresinden Node.js (LTS) kurup tekrar deneyin."
    exit 1
}

if (Test-Path $installDir) {
    Write-Host "Mevcut kurulum bulundu, guncelleniyor: $installDir"
    Push-Location $installDir
    git fetch origin
    git reset --hard origin/master
    Pop-Location
} else {
    Write-Host "Repo klonlaniyor: $installDir"
    git clone $repoUrl $installDir
}

Write-Host "Bagimliliklar kuruluyor (npm install)..."
Push-Location $installDir
npm install
Pop-Location

$desktop = [Environment]::GetFolderPath('Desktop')
$batPath = Join-Path $desktop 'Gothic 1 LockPicker.bat'
$installDirEscaped = $installDir

$batContent = @"
@echo off
if "%~1" neq "hidden" (
    powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -ArgumentList 'hidden' -WindowStyle Hidden"
    exit
)
cd /d "$installDirEscaped"
taskkill /F /IM electron.exe 2>NUL
npm run electron:dev
"@

Set-Content -Path $batPath -Value $batContent -Encoding ASCII

Write-Host ""
Write-Host "Kurulum tamamlandi." -ForegroundColor Green
Write-Host "Masaustunde 'Gothic 1 LockPicker.bat' olusturuldu - onu calistirarak baslayabilirsiniz."
Write-Host "Uygulama her acilista otomatik guncelleme kontrolu yapar."
