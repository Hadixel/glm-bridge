# glm-bridge installer (Windows PowerShell).
#
#   irm https://raw.githubusercontent.com/Hadixel/glm-bridge/main/install.ps1 | iex
#
# Installs into %USERPROFILE%\.glm-bridge, adds a glm-bridge.cmd shim to a PATH
# directory, registers a Scheduled Task that starts at logon, and optionally
# registers the bridge as an OpenAI-compatible node in a local 9router.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest speed + no progress noise

function Run-Capture([scriptblock]$sb) {
  # Run a native command, merging stderr into stdout, and do NOT let stderr
  # text (like Node's DEP0169 warning) trip $ErrorActionPreference='Stop'
  # (PowerShell 5.1 turns stderr lines into ErrorRecords that abort the run).
  $out = & $sb 2>&1
  return ($out | ForEach-Object { "$_" }) -join "`n"
}

$RepoUrl    = 'https://github.com/Hadixel/glm-bridge.git'
$InstallDir = if ($env:GLM_BRIDGE_DIR) { $env:GLM_BRIDGE_DIR } else { Join-Path $HOME '.glm-bridge' }
$Port       = if ($env:GLM_BRIDGE_PORT) { $env:GLM_BRIDGE_PORT } else { 3010 }
$Prefix     = if ($env:GLM_BRIDGE_PREFIX) { $env:GLM_BRIDGE_PREFIX } else { 'glmz' }
$NodeName   = 'GLM Bridge (ZCode)'
$Register9R = if ($env:REGISTER_9ROUTER) { $env:REGISTER_9ROUTER } else { 'auto' }
$TaskName   = 'glm-bridge'

function Say($m) { Write-Host "[glm-bridge] $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "[glm-bridge] $m" -ForegroundColor Red; exit 1 }

# --------------------------------------------------------------- node -------
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Die 'Node.js not found in PATH. Install Node 22+ from https://nodejs.org' }
$nodeVer = (& node -p 'process.versions.node')
$major = [int]($nodeVer -split '\.')[0]
if ($major -lt 22) { Die "Node 22+ required, found $nodeVer" }
Say "using node $nodeVer ($($node.Source))"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git is required' }

# ------------------------------------------------------------- install ------
if (Test-Path (Join-Path $InstallDir '.git')) {
  Say "updating existing checkout in $InstallDir"
  git -C $InstallDir pull --ff-only
} else {
  Say "cloning into $InstallDir"
  git clone --depth 1 $RepoUrl $InstallDir
}

foreach ($f in @('glm-bridge.js', 'mint-captcha.js', 'sysblocks.json', 'zbridge.js', 'tray.ps1')) {
  if (-not (Test-Path (Join-Path $InstallDir $f))) { Die "missing $f in repo" }
}

# ---------------------------------------------------------------- shim ------
$shimDir = if ($env:GLM_BRIDGE_BIN_DIR) { $env:GLM_BRIDGE_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'glm-bridge-bin' }
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
$shim = Join-Path $shimDir 'glm-bridge.cmd'
@"
@echo off
"$($node.Source)" "$InstallDir\glm-bridge.js" %*
"@ | Set-Content -Path $shim -Encoding ASCII
Say "installed CLI -> $shim"
$zshim = Join-Path $shimDir 'zbridge.cmd'
@"
@echo off
"$($node.Source)" "$InstallDir\zbridge.js" %*
"@ | Set-Content -Path $zshim -Encoding ASCII
Say "installed TUI -> $zshim"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$shimDir*") {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $shimDir), 'User')
  Say "added $shimDir to your user PATH (new terminals only)"
}

# ------------------------------------------------- playwright dependency -----
if (-not (Test-Path (Join-Path $InstallDir 'node_modules\playwright-core'))) {
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    Say 'installing playwright-core (captcha minting dependency)'
    Push-Location $InstallDir
    try { npm install --no-audit --no-fund --loglevel=error playwright-core@1.55.0 }
    catch { Say "warn: npm install failed ($_)" }
    finally { Pop-Location }
  } else {
    Say 'warn: npm not found; set GLM_BRIDGE_CHROMIUM if captcha minting fails'
  }
}

# ------------------------------------------------------ zcode CLI bootstrap --
# The bridge drives ZCode's own CLI. If missing, offer the official build
# with size + explicit consent; install silently (no GUI opens), then offer
# the CLI's terminal OAuth login.
function Find-ZcodeCli {
  if ($env:GLM_BRIDGE_CLI -and (Test-Path $env:GLM_BRIDGE_CLI)) { return $true }
  $p = Join-Path $env:LOCALAPPDATA 'Programs\ZCode\resources\glm\zcode.cjs'
  if (Test-Path $p) { return $true }
  return (Test-Path (Join-Path $InstallDir 'squashfs-root\resources\glm\zcode.cjs'))
}
$ZcodeUrl = if ($env:GLM_BRIDGE_ZCODE_URL) { $env:GLM_BRIDGE_ZCODE_URL } else { 'https://cdn-zcode.z.ai/zcode/electron/releases/3.14.4/windows-x64/ZCode-3.14.4-win-x64.exe' }
if (-not (Find-ZcodeCli)) {
  try {
    $head = Invoke-WebRequest -Uri $ZcodeUrl -Method Head -TimeoutSec 15 -UseBasicParsing
    $zsize = [math]::Round($head.Headers['Content-Length'][0] / 1MB)
    $zhuman = "$zsize MB"
  } catch { $zhuman = 'unknown size' }
  Write-Host "[glm-bridge] ZCode not found. Download the official installer now?" -ForegroundColor Yellow
  Write-Host "  $ZcodeUrl"
  Write-Host "  Size: $zhuman (installed silently - the GUI will NOT be opened)" -ForegroundColor Yellow
  $ans = Read-Host '  Download and install? [y/N]'
  if ($ans -match '^[yY]') {
    Say "downloading ZCode ($zhuman)..."
    $tmp = Join-Path $env:TEMP 'zcode-setup.exe'
    try {
      Invoke-WebRequest -Uri $ZcodeUrl -OutFile $tmp -UseBasicParsing
      Say 'installing silently (no GUI)...'
      # NSIS installer: /S = silent, /D= must be the last parameter
      $p = Start-Process -FilePath $tmp -ArgumentList '/S' -Wait -PassThru
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      if (Find-ZcodeCli) { Say 'zcode CLI ready' } else { Say 'warn: install finished but zcode.cjs not found' }
    } catch { Say "warn: download/install failed ($_)" }
  } else {
    Say 'skipped - install ZCode manually or re-run install.ps1'
  }
}

# -------------------------------------------------------- terminal login ----
if (-not (Test-Path (Join-Path $HOME '.zcode\v2\credentials.json'))) {
  $ans = Read-Host 'No ZCode login found. Log in now, in this terminal? (prints a URL for any browser) [y/N]'
  if ($ans -match '^[yY]') {
    & $node.Source (Join-Path $InstallDir 'glm-bridge.js') login main
    if ($LASTEXITCODE -ne 0) { Say 'warn: login failed (re-run: glm-bridge login)' }
  }
}

Say "stopping any running instance"
Run-Capture { & $node.Source (Join-Path $InstallDir 'glm-bridge.js') stop } | Out-Null

$action = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$InstallDir\glm-bridge.js`" run" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Say "scheduled task '$TaskName' registered (starts at logon)"

Start-ScheduledTask -TaskName $TaskName

# ------------------------------------------------------------- ready -------
Say 'waiting for the bridge to become ready...'
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
    $ready = $true; break
  } catch { Start-Sleep -Seconds 1 }
}
if ($ready) { Say "health: $($h | ConvertTo-Json -Compress)" }
else { Say "warn: not ready yet - run: glm-bridge.cmd logs" }

$key = (Get-Content (Join-Path $InstallDir 'config.json') -Raw | ConvertFrom-Json).key

# ------------------------------------------------------------ 9router -------
function Register-9router {
  Say "registering with 9router on :20128 ..."
  $dir9 = Join-Path $HOME '.9router'
  $machineId = if (Test-Path "$dir9\machine-id") { (Get-Content "$dir9\machine-id" -Raw).Trim() } else { '' }
  $secret = if (Test-Path "$dir9\auth\cli-secret") { (Get-Content "$dir9\auth\cli-secret" -Raw).Trim() } else { '' }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($machineId + '9r-cli-auth' + $secret)
  $token = ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLower().Substring(0, 16)
  $headers = @{ 'x-9r-cli-token' = $token }

  $baseUrl = "http://127.0.0.1:$Port/v1"
  $nodes = Invoke-RestMethod 'http://127.0.0.1:20128/api/provider-nodes' -Headers $headers
  $node = $nodes.nodes | Where-Object { $_.prefix -eq $Prefix } | Select-Object -First 1
  if ($node) {
    $body = @{ prefix = $Prefix; apiType = 'chat'; baseUrl = $baseUrl; type = 'openai-compatible'; name = $NodeName } | ConvertTo-Json
    Invoke-RestMethod "http://127.0.0.1:20128/api/provider-nodes/$($node.id)" -Method Put -Headers $headers -Body $body -ContentType 'application/json' | Out-Null
    Say "node updated: $($node.id)"
    $nodeId = $node.id
  } else {
    $body = @{ prefix = $Prefix; apiType = 'chat'; baseUrl = $baseUrl; type = 'openai-compatible'; name = $NodeName } | ConvertTo-Json
    $created = Invoke-RestMethod 'http://127.0.0.1:20128/api/provider-nodes' -Method Post -Headers $headers -Body $body -ContentType 'application/json'
    $nodeId = $created.node.id
    Say "node created: $nodeId"
  }

  $cons = Invoke-RestMethod 'http://127.0.0.1:20128/api/providers' -Headers $headers
  $have = $cons.connections | Where-Object { $_.provider -eq $nodeId } | Select-Object -First 1
  if (-not $have) {
    $cbody = @{
      provider = $nodeId; authType = 'apikey'; name = "$Prefix-local"; apiKey = $key
      providerSpecificData = @{ prefix = $Prefix; apiType = 'chat'; baseUrl = $baseUrl; nodeName = $NodeName
        connectionProxyEnabled = $false; connectionProxyUrl = ''; connectionNoProxy = '' }
      isActive = $true; priority = 1
    } | ConvertTo-Json -Depth 5
    Invoke-RestMethod 'http://127.0.0.1:20128/api/providers' -Method Post -Headers $headers -Body $cbody -ContentType 'application/json' | Out-Null
    Say 'connection created'
  } else {
    Invoke-RestMethod "http://127.0.0.1:20128/api/providers/$($have.id)/test" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
    Say 'connection present and tested'
  }
  Say "use models `"$Prefix/glm-5.3-flash`" and `"$Prefix/glm-5.3`" through 9router"
}

$has9r = $false
try { $null = Invoke-RestMethod 'http://127.0.0.1:20128/api/health' -TimeoutSec 2; $has9r = $true } catch { }
if ($Register9R -ne 'no' -and $has9r) {
  try { Register-9router } catch { Say "warn: 9router registration failed ($_) - bridge still usable directly" }
} elseif ($Register9r -eq 'yes') {
  Say '9router not reachable on :20128 - skipped'
}

Say 'done'
Write-Host ''
Write-Host "  base URL : http://127.0.0.1:$Port/v1"
Write-Host "  api key  : $key"
Write-Host "  models   : glm-5.3-flash, glm-5.3"
Write-Host ''
Write-Host '  TUI      : zbridge.cmd'
Write-Host '  control  : glm-bridge.cmd start|stop|restart|status|logs'
Write-Host "  health   : curl http://127.0.0.1:$Port/health"
Write-Host ''
Write-Host 'Requires a ZCode desktop login (the bridge reuses its subscription).'
