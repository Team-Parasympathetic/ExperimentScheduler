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

function Stop-ExistingAppProcess {
  $processes = @(Get-Process -Name "experiment_scheduler" -ErrorAction SilentlyContinue)

  if ($processes.Count -eq 0) {
    return
  }

  Write-Host "Closing running $appName app before rebuilding..."

  foreach ($process in $processes) {
    try {
      if ($process.MainWindowHandle -ne 0) {
        [void]$process.CloseMainWindow()
      }
    } catch {
      Write-Host "Could not ask process $($process.Id) to close cleanly: $($_.Exception.Message)"
    }
  }

  Start-Sleep -Seconds 2

  $remainingProcesses = @(Get-Process -Name "experiment_scheduler" -ErrorAction SilentlyContinue)
  if ($remainingProcesses.Count -gt 0) {
    Write-Host "Forcing remaining $appName app process to close..."
    $remainingProcesses | Stop-Process -Force
    Start-Sleep -Seconds 1
  }
}

function Remove-ExistingAppExe {
  if (-not (Test-Path $exePath)) {
    return
  }

  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      Remove-Item -LiteralPath $exePath -Force
      return
    } catch {
      if ($attempt -eq 5) {
        throw "Could not replace $exePath. Close Experiment Scheduler and any antivirus scan dialogs, then run Install-Lab-App.cmd again. Original error: $($_.Exception.Message)"
      }

      Write-Host "Waiting for old app executable to unlock..."
      Start-Sleep -Seconds 1
    }
  }
}

if (-not $SkipBuild) {
  Assert-Command "npm" "Install Node.js LTS from https://nodejs.org/."
  Assert-Command "cargo" "Install Rust from https://rustup.rs/."

  Push-Location $repoRoot
  try {
    npm ci
    Stop-ExistingAppProcess
    Remove-ExistingAppExe
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
