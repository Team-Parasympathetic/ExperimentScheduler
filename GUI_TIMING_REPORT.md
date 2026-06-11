# GUI Timing Behavior Report

Last updated: 2026-06-09

## Scope

This report documents GUI-side timing behavior for experiment upload, start, run monitoring, and stop controls. The implementation is in `src/components/top-toolbar.tsx`.

## Upload Safety Lockout

After a successful schedule upload, the GUI disables the Start and Stop controls for 0.5 seconds.

Purpose:

- Avoid sending a start or stop command immediately after `UPLOAD_EVENT`/upload completion.
- Give the firmware and serial transaction path a short settling window before another schedule-control command.

Behavior:

- Upload remains available according to normal schedule-limit and board-busy rules.
- Start and Stop are disabled while the lockout is active.
- A regular neutral message appears in the experiment-control message stack: `Start/stop locked for 0.5s after upload.`
- The lockout is cleared if a new upload or stop command begins.

Constant:

```ts
UPLOAD_CONTROL_SAFETY_LOCKOUT_MS = 500
```

## Start Preload Delay

After `START_SCHEDULE` is acknowledged, the GUI starts a 1 second progress bar under the experiment-control message.

Purpose:

- Show the known firmware preload/arm delay before the schedule actually enters `SCHED_RUNNING`.
- Prevent the GUI playhead from starting early.

Behavior:

- The progress bar starts only after the `START_SCHEDULE` ACK.
- The GUI polls `GET_STATUS` every 100 ms while waiting for the board to report `SCHED_RUNNING`.
- During this post-ACK wait, `SCHED_STOPPED` and loaded/non-running states are treated as acceptable pending-start states.
- The GUI playhead starts only after `scheduler_state == SCHED_RUNNING`.
- The progress bar resets on stop, upload, start failure, run error, or schedule stop.

Constants:

```ts
START_PRELOAD_PROGRESS_MS = 1_000
START_STATUS_POLL_INTERVAL_MS = 100
START_STATUS_TIMEOUT_MS = 5_000
```

## Removed Completion Inference During Start

The GUI no longer treats `SCHED_STOPPED` plus populated event counters as "completed before running" during the post-start-ACK wait.

Reason:

- Firmware can keep `SCHED_STOPPED` visible during the preload delay after a restart from a stopped schedule.
- There is no explicit USB-visible `START_PENDING` state, so the GUI must keep polling until `SCHED_RUNNING`, `SCHED_ERROR`, or timeout.

## Run Monitoring

Once the board reports `SCHED_RUNNING`, the GUI:

- Starts the local playhead at 0 ms.
- Polls `GET_STATUS` every 250 ms.
- Stops/resets the GUI playhead when firmware reports `SCHED_STOPPED` or `SCHED_IDLE`.
- Shows an error and resets if firmware reports `SCHED_ERROR`.

Constant:

```ts
RUN_STATUS_POLL_INTERVAL_MS = 250
```

## Experiment-Control Message Stack

The experiment-control panel keeps a small rolling stack of recent control messages, similar to a compact console.

Behavior:

- The latest unique schedule message is appended to the stack.
- Consecutive duplicate messages are ignored.
- The stack is capped at 3 visible messages.
- Error/failure messages use the red error style.
- Normal informational messages, including the post-upload safety lockout message, use the regular neutral message style.

Constant:

```ts
CONTROL_MESSAGE_STACK_LIMIT = 3
```

## Control Availability

Upload is enabled only when:

- The schedule is within firmware limits.
- At least one event is present.
- No board command or calibration run is active.

Start is enabled only when:

- No board command or calibration run is active.
- The upload safety lockout is inactive.
- The GUI experiment state is not already running.

Stop is enabled only when:

- No board command or calibration run is active.
- The upload safety lockout is inactive.

## Current GUI-To-Firmware Start Flow

```text
GUI sends START_SCHEDULE
Firmware ACKs START_SCHEDULE
GUI starts 1 s Start warmup progress bar
GUI polls GET_STATUS every 100 ms
GUI ignores STOPPED/LOADED as pending-start states during this window
Firmware eventually reports SCHED_RUNNING
GUI starts local playhead and begins run monitoring
```
