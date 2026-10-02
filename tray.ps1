# glm-bridge tray (Windows) — NotifyIcon with:
#   Auto-start (checked reflects `glm-bridge autostart`, click toggles)
#   Quit (`glm-bridge quit` — stops the bridge and this icon)
# Run hidden: powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File tray.ps1

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$StateDir = if ($env:GLM_BRIDGE_HOME) { $env:GLM_BRIDGE_HOME } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$PidFile = Join-Path $StateDir 'tray.pid'

# Resolve node and bridge script for fast, direct invocation (no cmd.exe wrapper delays)
$script:NodeExe = (Get-Command node -ErrorAction SilentlyContinue)
$script:BridgeJs = Join-Path $StateDir 'glm-bridge.js'
$script:ShimCmd = Join-Path $StateDir 'glm-bridge.cmd'

function Invoke-Glm([string]$Arg) {
    try {
        if ($script:NodeExe -and (Test-Path $script:BridgeJs)) {
            $p = Start-Process -FilePath $script:NodeExe.Source -ArgumentList "`"$($script:BridgeJs)`"", $Arg -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $env:TEMP "glm-out.tmp") -RedirectStandardError (Join-Path $env:TEMP "glm-err.tmp")
            $res = if (Test-Path (Join-Path $env:TEMP "glm-out.tmp")) { (Get-Content (Join-Path $env:TEMP "glm-out.tmp") -Raw).Trim() } else { '' }
            Remove-Item (Join-Path $env:TEMP "glm-*.tmp") -Force -ErrorAction SilentlyContinue
            return $res
        }
        $cli = Get-Command glm-bridge -ErrorAction SilentlyContinue
        if ($cli) { return (& $cli.Source $Arg 2>$null | Out-String).Trim() }
        if (Test-Path $script:ShimCmd) { return (& $script:ShimCmd $Arg 2>$null | Out-String).Trim() }
    } catch {}
    return ''
}

# Single instance guard
if (Test-Path $PidFile) {
    $oldPid = 0
    try { $oldPid = [int](Get-Content $PidFile -ErrorAction Stop) } catch {}
    if ($oldPid -gt 0 -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        exit 0
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
Set-Content -Path $PidFile -Value $PID

$script:icon = [System.Drawing.SystemIcons]::Application
$script:ni = New-Object System.Windows.Forms.NotifyIcon
$script:ni.Icon = $script:icon
$script:ni.Text = 'GLM Bridge'
$script:ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

# 1. Header / Status
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem('GLM Bridge')
$statusItem.Enabled = $false
$menu.Items.Add($statusItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# 2. Auto-start toggle
$script:autoItem = New-Object System.Windows.Forms.ToolStripMenuItem('Auto-start with Windows')
$script:autoItem.CheckOnClick = $false
$isAuto = (Invoke-Glm 'autostart') -eq 'on'
$script:autoItem.Checked = $isAuto

$script:autoItem.Add_Click({
    $newState = Invoke-Glm 'autostart-toggle'
    $this.Checked = ($newState -eq 'on')
}) | Out-Null
$menu.Items.Add($script:autoItem) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# 3. Quit
$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Quit GLM Bridge (Terminate)')
$quitItem.Add_Click({
    # Immediately remove icon from Windows notification tray area (prevent ghost icons)
    $script:ni.Visible = $false
    $script:ni.Dispose()
    # Remove PID file so killTray in bridge.js doesn't forcefully abort this script mid-stop
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    # Terminate the bridge service
    Invoke-Glm 'quit' | Out-Null
    [System.Windows.Forms.Application]::Exit()
}) | Out-Null
$menu.Items.Add($quitItem) | Out-Null

$script:ni.ContextMenuStrip = $menu

$script:ni.Add_DoubleClick({
    $st = Invoke-Glm 'status'
    if ($st) { $script:ni.ShowBalloonTip(4000, 'GLM Bridge Status', $st, [System.Windows.Forms.ToolTipIcon]::Info) }
}) | Out-Null

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $script:ni.Visible = $false
    $script:ni.Dispose()
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
