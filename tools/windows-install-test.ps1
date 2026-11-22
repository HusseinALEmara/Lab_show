# Installs the freshly built Setup on a real Windows machine (GitHub's server), runs the
# app, and checks: the back end runs in its own process and answers, everything the app
# writes is inside its own folder, an update keeps that data, and uninstalling leaves
# nothing behind. Any failure stops the release.
$ErrorActionPreference = 'Stop'
$setup = (Get-ChildItem dist\Lab-show-Setup-*.exe | Select-Object -First 1).FullName
$inst = Join-Path $env:LOCALAPPDATA 'Programs\Lab show'
$exe = Join-Path $inst 'Lab show.exe'
$roaming = Join-Path $env:APPDATA 'Lab show'
$port = 47800
function Fail($message) { Write-Host "FAIL: $message"; exit 1 }
function Pass($message) { Write-Host "PASS: $message" }

function Wait-Health {
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
      if ($r.ok) { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Stop-App {
  Start-Process -FilePath $exe -ArgumentList '--quit-for-update' -Wait
  for ($i = 0; $i -lt 20 -and (Get-Process 'Lab show' -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
  if (Get-Process 'Lab show' -ErrorAction SilentlyContinue) { Fail 'the app did not close' }
}

if (Test-Path $roaming) { Remove-Item $roaming -Recurse -Force }

# 1. Install (the same installer as the window, run silently here)
Start-Process -FilePath $setup -ArgumentList '/S' -Wait
if (-not (Test-Path $exe)) { Fail "not installed at $inst" }
if (-not (Test-Path (Join-Path $inst 'resources\cloudflared.exe'))) { Fail 'cloudflared.exe missing' }
Pass "installed for this user at $inst, with cloudflared"

# 2. Run: the back end answers, from a separate process
$env:LABSHOW_PORT = "$port"
$env:LABSHOW_TUNNEL = 'off'
Start-Process -FilePath $exe
if (-not (Wait-Health)) { Fail 'the back end did not answer' }
$page = Invoke-WebRequest -Uri "http://127.0.0.1:$port/j?c=ABCDEFGHJKLM" -UseBasicParsing
if ($page.Content -notmatch 'ABCDEFGHJKLM') { Fail 'the link page did not answer' }
Pass 'the back end answers on its port, and the link page works'
$procs = Get-CimInstance Win32_Process -Filter "Name='Lab show.exe'"
$utility = $procs | Where-Object { $_.CommandLine -match '--type=utility' -and $_.CommandLine -match 'node.mojom.NodeService' }
if (-not $utility) { Fail ('no separate back-end process; processes: ' + (($procs | ForEach-Object { $_.CommandLine }) -join ' || ')) }
Pass ("the back end runs in its own process (pid $($utility[0].ProcessId)), apart from the windows")

# Kill the back end: the app must start it again by itself.
Stop-Process -Id $utility[0].ProcessId -Force
Start-Sleep -Seconds 3
if (-not (Wait-Health)) { Fail 'the back end was not restarted' }
Pass 'a stopped back end is started again automatically'

# 3. Everything it writes stays in its own folder
$data = Join-Path $inst 'data'
foreach ($sub in 'session', 'logs', 'tmp', 'work') {
  if (-not (Test-Path (Join-Path $data $sub))) { Fail "data\$sub missing" }
}
if (Test-Path $roaming) {
  $found = Get-ChildItem $roaming -Recurse -Force | ForEach-Object { $_.FullName.Substring($roaming.Length) + ' (' + $_.Length + ')' }
  Fail ("the app wrote to $roaming : " + ($found -join ' | '))
}
Pass "everything stays in $data; nothing in $roaming"

# 4. Update over it: the data folder is kept
Set-Content -Path (Join-Path $data 'settings.json') -Value '{"blockNotifications":true}'
Stop-App
Start-Process -FilePath $setup -ArgumentList '/S' -Wait
if (-not (Test-Path $exe)) { Fail 'the update removed the app' }
if ((Get-Content (Join-Path $data 'settings.json') -Raw) -notmatch 'true') { Fail 'the update lost the settings' }
Pass 'an update keeps the settings in the data folder'
Start-Process -FilePath $exe
if (-not (Wait-Health)) { Fail 'the updated app did not start' }
Stop-App
Pass 'the updated app starts and closes cleanly'

# 5. Uninstall: nothing stays
$uninstaller = Join-Path $inst 'Uninstall Lab show.exe'
Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait
for ($i = 0; $i -lt 30 -and (Test-Path $inst); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path $inst) { Fail ('left behind: ' + ((Get-ChildItem $inst -Recurse | Select-Object -First 10 | ForEach-Object { $_.FullName }) -join ', ')) }
if (Test-Path $roaming) { Fail "left behind: $roaming" }
Pass 'uninstalling removes the whole folder; nothing is left on the system'
Write-Host 'Windows install test passed'
