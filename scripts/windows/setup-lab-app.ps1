param(
  [switch]$SkipBuild,
  [switch]$DesktopOnly,
  [switch]$StartMenuOnly
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$appName = "Experiment Scheduler"
$exePath = Join-Path $repoRoot "src-tauri\target\release\experiment_scheduler.exe"

function Assert-Command {
  param(
    [string]$Name,
    [string]$InstallHint
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $InstallHint"
  }
}

function New-AppShortcut {
  param(
    [string]$ShortcutPath
  )

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $exePath
  $shortcut.WorkingDirectory = Split-Path $exePath -Parent
  $shortcut.IconLocation = "$exePath,0"
  $shortcut.Description = "Launch $appName"
  $shortcut.Save()
}

if (-not $SkipBuild) {
  Assert-Command "npm" "Install Node.js LTS from https://nodejs.org/."
  Assert-Command "cargo" "Install Rust from https://rustup.rs/."

  Push-Location $repoRoot
  try {
    npm ci
    npm run tauri build
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $exePath)) {
  throw "Could not find $exePath. Run this script without -SkipBuild first."
}

$createDesktop = -not $StartMenuOnly
$createStartMenu = -not $DesktopOnly

if ($createDesktop) {
  $desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "$appName.lnk"
  New-AppShortcut $desktopShortcut
  Write-Host "Created desktop shortcut: $desktopShortcut"
}

if ($createStartMenu) {
  $startMenuDir = Join-Path ([Environment]::GetFolderPath("Programs")) $appName
  New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
  $startMenuShortcut = Join-Path $startMenuDir "$appName.lnk"
  New-AppShortcut $startMenuShortcut
  Write-Host "Created Start Menu shortcut: $startMenuShortcut"
}

Write-Host ""
Write-Host "$appName is ready. Use the shortcut to launch the desktop app; no npm dev server is needed."
