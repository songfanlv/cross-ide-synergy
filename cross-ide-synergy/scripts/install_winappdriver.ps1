Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$downloadDir = Join-Path $root 'tmp\winappdriver'
$installerPath = Join-Path $downloadDir 'WindowsApplicationDriver_1.2.1.msi'
$extractRoot = Join-Path $downloadDir 'bin'
$downloadUrl = 'https://github.com/microsoft/WinAppDriver/releases/download/v1.2.1/WindowsApplicationDriver_1.2.1.msi'
$candidates = @(
    'D:\Program Files\winappdriver\WinAppDriver.exe',
    'C:\Program Files (x86)\Windows Application Driver\WinAppDriver.exe',
    'C:\Program Files\Windows Application Driver\WinAppDriver.exe'
)

foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
        Write-Host "WinAppDriver already installed: $candidate"
        exit 0
    }
}

if (Test-Path $extractRoot) {
    $localExe = Get-ChildItem -Path $extractRoot -Filter 'WinAppDriver.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
    if ($localExe) {
        Write-Host "WinAppDriver already extracted: $localExe"
        exit 0
    }
}

New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
Write-Host 'Downloading WinAppDriver installer...'
Invoke-WebRequest -Uri $downloadUrl -OutFile $installerPath

Write-Host 'Installing WinAppDriver silently...'
$process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $installerPath, '/qn', '/norestart') -PassThru -Wait
if ($process.ExitCode -eq 0) {
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            Write-Host "WinAppDriver installed: $candidate"
            exit 0
        }
    }
}

Write-Host "System install did not yield a usable WinAppDriver.exe. ExitCode=$($process.ExitCode). Falling back to admin extraction..."
if (Test-Path $extractRoot) {
    Remove-Item -Path $extractRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

$extractProcess = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/a', $installerPath, '/qn', "TARGETDIR=$extractRoot") -PassThru -Wait
if ($extractProcess.ExitCode -ne 0) {
    throw "WinAppDriver extraction failed with exit code $($extractProcess.ExitCode)"
}

$extractedExe = Get-ChildItem -Path $extractRoot -Filter 'WinAppDriver.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if ($extractedExe) {
    Write-Host "WinAppDriver extracted locally: $extractedExe"
    exit 0
}

throw 'WinAppDriver installation finished, but WinAppDriver.exe was still not found.'
