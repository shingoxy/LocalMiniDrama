param(
  [ValidateSet('Start', 'Stop', 'Backup')][string]$Action = 'Start',
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$stateDir = Join-Path $root '.local'
$stateFile = Join-Path $stateDir 'processes.json'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

function Read-State {
  if (Test-Path -LiteralPath $stateFile) {
    return Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  }
}
function Is-Owned($record) {
  $proc = Get-Process -Id $record.Id -ErrorAction SilentlyContinue
  if (!$proc -or $proc.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.StartTicks) { return $false }
  $info = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.Id)"
  return $info.CommandLine -and $info.CommandLine.Contains($root)
}
function Stop-Tree([int]$processId) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $processId"
  foreach ($child in $children) { Stop-Tree $child.ProcessId }
  Stop-Process -Id $processId -ErrorAction SilentlyContinue
}
function Stop-Local {
  $state = Read-State
  if ($state -and $state.Root -eq $root) {
    foreach ($record in $state.Processes) {
      if (Is-Owned $record) { Stop-Tree $record.Id }
    }
    Remove-Item -LiteralPath $stateFile -Force
  }
  Write-Host 'LocalMiniDrama tracked processes stopped.'
}
function Port-InUse([int]$port) {
  return @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue).Count -gt 0
}
function Wait-Url([string]$url) {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1
      if ($r.StatusCode -eq 200) { return }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  throw "Service did not become ready: $url. See .local/*.log"
}

try {
  if ($Action -eq 'Stop') { Stop-Local; exit 0 }
  $node = (Get-Command node.exe).Source
  $version = (& $node -p 'process.versions.node').Split('.')
  if ([int]$version[0] -lt 24 -or ([int]$version[0] -eq 24 -and [int]$version[1] -lt 5)) {
    throw 'Local launcher needs Node >=24.5 for native HTTP/fetch environment proxy support.'
  }
  if ($Action -eq 'Backup') {
    Stop-Local
    foreach ($port in 5679,3013) {
      if (Port-InUse $port) { throw "Port $port is still used. Close manual LocalMiniDrama instances before backup." }
    }
    $destination = Join-Path $root ('backup\' + (Get-Date -Format 'yyyy-MM-dd_HHmm'))
    if (Test-Path -LiteralPath $destination) { throw "Backup already exists: $destination" }
    New-Item -ItemType Directory -Path $destination | Out-Null
    $source = Join-Path $root 'backend-node'
    foreach ($folder in 'data','configs') {
      $from = Join-Path $source $folder
      if (Test-Path -LiteralPath $from) {
        & robocopy.exe $from (Join-Path $destination "backend-node\$folder") /E /XJ /XD cache temp tmp /XF *.tmp *.log /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "Backup copy failed: $folder ($LASTEXITCODE)" }
      }
    }
    & $node (Join-Path $root 'verify_backup.cjs') $destination
    if ($LASTEXITCODE) { throw 'Backup integrity check failed.' }
    Get-ChildItem -LiteralPath $destination -Recurse -File | Get-FileHash -Algorithm SHA256 |
      Select-Object @{Name='Path';Expression={$_.Path.Substring($destination.Length+1)}},Hash |
      ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'manifest.json') -Encoding UTF8
    Write-Host "Backup saved: $destination (contains private API credentials). Services remain stopped."
    exit 0
  }
  if (!(Test-Path -LiteralPath (Join-Path $root 'backend-node\node_modules\better-sqlite3'))) { throw 'Run npm install in backend-node first.' }
  if (!(Test-Path -LiteralPath (Join-Path $root 'frontweb\node_modules\vite\bin\vite.js'))) { throw 'Run npm install in frontweb first.' }
  $config = Join-Path $root 'backend-node\configs\config.yaml'
  if (!(Test-Path -LiteralPath $config)) {
    Copy-Item -LiteralPath (Join-Path $root 'backend-node\configs\config.example.yaml') -Destination $config
  }
  $state = Read-State
  if ($state -and $state.Root -eq $root -and @($state.Processes | Where-Object { Is-Owned $_ }).Count -eq 2) {
    Wait-Url 'http://127.0.0.1:5679/health'
    Wait-Url 'http://127.0.0.1:3013'
    Write-Host 'LocalMiniDrama is already running.'
    if (!$NoBrowser) { Start-Process 'http://127.0.0.1:3013' }
    exit 0
  }
  Stop-Local
  foreach ($port in 5679,3013) {
    if (Port-InUse $port) { throw "Port $port is occupied. No unrelated process was stopped." }
  }
  $proxyFile = Join-Path $stateDir 'proxy.ps1'
  if (Test-Path -LiteralPath $proxyFile) { . $proxyFile }
  $env:NODE_USE_ENV_PROXY = '1'
  $env:NODE_TLS_REJECT_UNAUTHORIZED = '1'
  if (!$env:NO_PROXY) { $env:NO_PROXY = 'localhost,127.0.0.1,::1,.aliyuncs.com,.volces.com,.volcengineapi.com,.klingai.com,.vidu.cn' }
  $records = @()
  foreach ($service in @(
    @{Name='backend';Dir='backend-node';Entry='backend-node\src\server.js';Args='--watch'},
    @{Name='frontend';Dir='frontweb';Entry='frontweb\node_modules\vite\bin\vite.js';Args='--host 127.0.0.1 --port 3013 --strictPort'}
  )) {
    $entry = Join-Path $root $service.Entry
    $args = if ($service.Name -eq 'backend') { "$($service.Args) `"$entry`"" } else { "`"$entry`" $($service.Args)" }
    $proc = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory (Join-Path $root $service.Dir) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stateDir "$($service.Name).stdout.log") -RedirectStandardError (Join-Path $stateDir "$($service.Name).stderr.log")
    $records += @{ Id=$proc.Id; StartTicks=$proc.StartTime.ToUniversalTime().Ticks.ToString(); Name=$service.Name }
    @{Root=$root;Processes=$records} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stateFile -Encoding UTF8
  }
  Wait-Url 'http://127.0.0.1:5679/health'
  Wait-Url 'http://127.0.0.1:3013'
  Write-Host 'Frontend: http://127.0.0.1:3013'
  Write-Host 'Backend:  http://127.0.0.1:5679'
  if (!$NoBrowser) { Start-Process 'http://127.0.0.1:3013' }
} catch {
  if ($Action -eq 'Start') { Stop-Local }
  Write-Error $_
  exit 1
}
