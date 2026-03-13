param(
    [string]$AntigravityCli = "",
    [string]$PyCharmBat = "",
    [string]$CockpitLauncher = "",
    [string]$InstalledExtension = "",
    [string]$JetBrainsZip = "",
    [int]$Rounds = 3,
    [int]$StepTimeoutSec = 120,
    [int]$IdleTimeoutSec = 180,
    [int]$MaxRuntimeSec = 1800
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$watchdogLog = Join-Path $root 'tmp\gui-control-e2e\wrapper-watchdog.log'
$runner = Join-Path $PSScriptRoot 'run_with_idle_timeout.js'
$entry = Join-Path $PSScriptRoot 'gui_cross_ide_e2e.js'

$args = @(
    $runner,
    '--cwd', $root,
    '--idle-ms', ($IdleTimeoutSec * 1000),
    '--max-ms', ($MaxRuntimeSec * 1000),
    '--heartbeat-ms', 15000,
    '--log-file', $watchdogLog,
    '--',
    'node',
    $entry,
    '--rounds', $Rounds,
    '--step-timeout-ms', ($StepTimeoutSec * 1000)
)

if (-not [string]::IsNullOrWhiteSpace($AntigravityCli)) {
    $args += @('--antigravity-cli', $AntigravityCli)
}
if (-not [string]::IsNullOrWhiteSpace($PyCharmBat)) {
    $args += @('--pycharm-bat', $PyCharmBat)
}
if (-not [string]::IsNullOrWhiteSpace($CockpitLauncher)) {
    $args += @('--cockpit-launcher', $CockpitLauncher)
}
if (-not [string]::IsNullOrWhiteSpace($InstalledExtension)) {
    $args += @('--installed-extension', $InstalledExtension)
}
if (-not [string]::IsNullOrWhiteSpace($JetBrainsZip)) {
    $args += @('--jetbrains-zip', $JetBrainsZip)
}

& node @args
exit $LASTEXITCODE
