$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

$ContainerDir = Join-Path $RootDir ".container"
$NodeBaseDir = Join-Path $ContainerDir "node"
$NpmCacheDir = Join-Path $ContainerDir "npm-cache"
$ElectronCacheDir = Join-Path $ContainerDir "electron-cache"
$BuilderCacheDir = Join-Path $ContainerDir "builder-cache"

New-Item -ItemType Directory -Force -Path $ContainerDir, $NodeBaseDir, $NpmCacheDir, $ElectronCacheDir, $BuilderCacheDir | Out-Null

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Lab show - Isolated Container Auto-Installer" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

# 1. Check or download portable Node.js inside .container
$NodeExe = Get-ChildItem -Path $NodeBaseDir -Filter "node.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $NodeExe) {
    Write-Host "[1/4] Downloading portable Node.js into .container..." -ForegroundColor Yellow
    $IndexJson = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
    $LtsRelease = $IndexJson | Where-Object { $_.lts -ne $false -and $_.files -contains "win-x64-zip" } | Select-Object -First 1
    if (-not $LtsRelease) {
        throw "Could not locate a Windows x64 LTS Node.js package."
    }

    $Ver = $LtsRelease.version
    $ZipUrl = "https://nodejs.org/dist/$Ver/node-$Ver-win-x64.zip"
    $ZipPath = Join-Path $ContainerDir "node.zip"

    Write-Host "      Downloading Node.js $Ver ..."
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing

    Write-Host "      Extracting into .container..."
    Expand-Archive -Path $ZipPath -DestinationPath $NodeBaseDir -Force
    Remove-Item $ZipPath -Force

    $NodeExe = Get-ChildItem -Path $NodeBaseDir -Filter "node.exe" -Recurse | Select-Object -First 1
} else {
    Write-Host "[1/4] Portable Node.js is already inside .container." -ForegroundColor Green
}

$NodeBinDir = $NodeExe.DirectoryName
$NpmCmd = Join-Path $NodeBinDir "npm.cmd"

# Isolate PATH and all caches inside .container
$env:Path = "$NodeBinDir;$env:Path"
$env:npm_config_cache = $NpmCacheDir
$env:ELECTRON_CACHE = $ElectronCacheDir
$env:ELECTRON_BUILDER_CACHE = $BuilderCacheDir
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

# 2. Install packages inside local project
Write-Host "[2/4] Downloading app packages into container..." -ForegroundColor Yellow
& $NpmCmd install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    throw "npm install failed."
}

# 3. Build standalone Windows installer (.exe)
Write-Host "[3/4] Building standalone Lab show installer (.exe)..." -ForegroundColor Yellow
& $NpmCmd run build
if ($LASTEXITCODE -ne 0) {
    throw "Build failed."
}

# 4. Create quick run.bat and launch installer
$RunBatPath = Join-Path $RootDir "run.bat"
$RunBatContent = @"
@echo off
set "PATH=$NodeBinDir;%PATH%"
cd /d "%~dp0"
start "" "$NodeBinDir\npm.cmd" start
"@
Set-Content -Path $RunBatPath -Value $RunBatContent -Encoding ASCII

$Installer = Get-ChildItem -Path (Join-Path $RootDir "dist") -Filter "*Setup*.exe" | Select-Object -First 1
if ($Installer) {
    Write-Host "[4/4] Done! Launching installer: $($Installer.Name)" -ForegroundColor Green
    Start-Process -FilePath $Installer.FullName
} else {
    Write-Host "[4/4] Build complete. Check the dist folder." -ForegroundColor Green
}