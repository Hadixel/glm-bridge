# glm-bridge tray (Windows) — NotifyIcon with:
#   Auto-start (checked reflects `glm-bridge autostart`, click toggles)
#   Quit (`glm-bridge quit` — stops the bridge and this icon)
# Run hidden: powershell -WindowStyle Hidden -File tray.ps1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$StateDir = if ($env:GLM_BRIDGE_HOME) { $env:GLM_BRIDGE_HOME } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$PidFile = Join-Path $StateDir 'tray.pid'

# Resolve the CLI (PATH first, then sibling wrapper).
function Invoke-Glm([string]$Arg) {
    $cli = Get-Command glm-bridge -ErrorAction SilentlyContinue
    if ($cli) { return (& $cli.Source $Arg 2>$null | Out-String).Trim() }
    $shim = Join-Path $StateDir 'glm-bridge.cmd'
    if (Test-Path $shim) { return (& $shim $Arg 2>$null | Out-String).Trim() }
    return ''
}

# Single instance.
if (Test-Path $PidFile) {
    $oldPid = 0
    try { $oldPid = [int](Get-Content $PidFile -ErrorAction Stop) } catch {}
    if ($oldPid -gt 0 -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { exit 0 }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
Set-Content -Path $PidFile -Value $PID

$icon = [System.Drawing.SystemIcons]::Application
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = 'GLM Bridge'
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$autoItem = New-Object System.Windows.Forms.ToolStripMenuItem('Auto-start')
$autoItem.CheckOnClick = $false
if ((Invoke-Glm 'autostart') -eq 'on') { $autoItem.Checked = $true } else { $autoItem.Checked = $false }
$autoItem.Add_Click({
    $newState = Invoke-Glm 'autostart-toggle'
    $autoItem.Checked = ($newState -eq 'on')
}) | Out-Null

$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Quit')
$quitItem.Add_Click({
    Invoke-Glm 'quit' | Out-Null
    $ni.Visible = $false
    [System.Windows.Forms.Application]::Exit()
}) | Out-Null

$menu.Items.Add($autoItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$menu.Items.Add($quitItem) | Out-Null
$ni.ContextMenuStrip = $menu

$ni.Add_DoubleClick({
    $st = Invoke-Glm 'status'
    if ($st) { $ni.ShowBalloonTip(5000, 'GLM Bridge', $st, 'Info') }
}) | Out-Null

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $ni.Visible = $false
    $ni.Dispose()
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
