# Experiment Scheduler

Desktop experiment scheduler for the lab instrumentation stack. The app is a Tauri + React GUI for building timed pump and GPIO schedules, uploading them to the Instrument Control Unit, calibrating peristaltic pumps, and monitoring pump RPM telemetry from the Encoder Monitor.

## Current Features

- Timeline editor for peristaltic pump and GPIO/timing-card tracks.
- Variable-rate and fixed-rate pump modes with matching calibration workflows.
- PWM, pulse, status-output, and synchronized GPIO waveform blocks.
- Robust schedule upload, prepare/preload, start warmup, status polling, and stop handling for the current binary firmware protocol.
- Device Manager connections for the Instrument Control Unit and Encoder Monitor.
- Live pump RPM readouts, rolling graphs, and encoder-driven 3D pump model animation.
- Schedule and calibration JSON persistence in the app data directory.

## Windows Install

Install prerequisites once:

- Git
- Node.js LTS
- Rust via `rustup` using the 64-bit MSVC toolchain
- Microsoft Edge WebView2 Runtime

Clone and install:

```powershell
git clone https://github.com/kz2504/ExperimentScheduler.git
cd ExperimentScheduler
.\Install-Lab-App.cmd
```

The installer builds the desktop app and creates fresh **Experiment Scheduler** shortcuts on the Desktop and in the Start Menu. The Start Menu shortcut cleanup removes stale shortcuts with the same app name before recreating the current one.

To update an existing lab PC checkout:

```powershell
cd C:\Users\ARN_s\ExperimentScheduler
git pull
.\Install-Lab-App.cmd
```

If PowerShell blocks `npm`, use `npm.cmd` directly for manual commands, or run the provided installer script, which uses PowerShell's bypass mode internally.

To recreate shortcuts without rebuilding:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\setup-lab-app.ps1 -SkipBuild
```

## Development

```powershell
npm ci
npm run tauri dev
```

Build the frontend only:

```powershell
npm.cmd run build
```
