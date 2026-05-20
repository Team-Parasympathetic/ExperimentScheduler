# Experiment Scheduler

A graphical experiment manager designed for our lab's custom instrumentation control system. 

## Lab PC setup

Use this when you want to clone the repo on a Windows lab PC and run it like a normal desktop app, without `npm run dev`.

Prerequisites for the first setup:

- Git
- Node.js LTS
- Rust
- Microsoft Edge WebView2 Runtime

From PowerShell:

```powershell
git clone <repo-url>
cd ExperimentScheduler
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-lab-app.ps1
```

Or double-click `Install-Lab-App.cmd` from the cloned folder.

The script builds the Tauri desktop app and creates shortcuts named **Experiment Scheduler** on the Desktop and in the Start Menu. After that, launch the app from the shortcut.

To update the lab PC later:

```powershell
cd ExperimentScheduler
git pull
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-lab-app.ps1
```

If the app was already built and you only need to recreate shortcuts:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-lab-app.ps1 -SkipBuild
```

## Developer mode

For development on a machine with the toolchain installed:

```bash
npm ci
npm run tauri dev
```
