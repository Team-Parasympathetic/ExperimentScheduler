# Backplane USB Interface Report

## Scope

This is the current GUI-facing USB CDC interface for configuring, uploading, starting, stopping, and monitoring experiments on the backplane. It covers the Backplane USB protocol, schedule payloads, Timing Card GPIO actions, pump actions, delayed start behavior, and timing quirks that the GUI should model explicitly.

## Transport Frame

All USB CDC packets use the binary protocol frame:

```text
[SOF][VERSION][MSG_TYPE][SEQ_L][SEQ_H][LEN_L][LEN_H][PAYLOAD...][CRC_L][CRC_H]
```

Fields:

```text
SOF      = 0xA5
VERSION  = 0x01
SEQ      = uint16 little-endian
LEN      = uint16 little-endian payload length
CRC      = CRC-16/CCITT-FALSE over VERSION through final payload byte
CRC init = 0xFFFF
CRC poly = 0x1021
max payload = 256 bytes
```

Every valid command returns an ACK frame:

```text
MSG_ACK = 0x02
payload = ack_seq:u16le, status:u8
```

Errors return:

```text
MSG_ERROR = 0x03
payload = failed_seq:u16le, error_code:u8, detail:u8
```

Query commands return ACK first, then a second data frame with the same sequence number as the query.

## USB Commands

Current command IDs:

```text
0x01 MSG_PING
0x10 MSG_CLEAR_SCHEDULE
0x11 MSG_UPLOAD_EVENT
0x12 MSG_START_SCHEDULE
0x13 MSG_STOP_SCHEDULE
0x14 MSG_GET_STATUS
0x15 MSG_GET_CARD_INVENTORY
0x16 MSG_PREPARE_SCHEDULE
0x17 MSG_GET_PREPARE_STATUS
```

Recommended GUI flow:

```text
PING
GET_CARD_INVENTORY
CLEAR_SCHEDULE
UPLOAD_EVENT ... repeat for all events
PREPARE_SCHEDULE
poll GET_PREPARE_STATUS until ready
START_SCHEDULE
poll GET_STATUS until RUNNING
poll GET_STATUS until STOPPED or ERROR
STOP_SCHEDULE if user aborts
```

The host should keep the existing request/response discipline: send one command, wait for ACK or ERROR, then send the next command.

## Schedule Commands

`MSG_CLEAR_SCHEDULE = 0x10`

Payload: empty.

Clears the backplane's in-memory schedule, cancels any pending delayed start, and clears prepared card-local queues. This is rejected while actively running.

`MSG_UPLOAD_EVENT = 0x11`

Payload:

```text
offset  size  field
0       4     event_id:u32le
4       8     timestamp_us:u64le
12      1     action_count:u8
13      N     action records
```

Each action record:

```text
offset  size  field
0       1     module_type:u8
1       1     module_id:u8
2       1     action_type:u8
3       1     action_len:u8
4       N     action payload
```

Schedule limits:

```text
MAX_EVENTS = 48
MAX_EVENT_ACTION_BYTES = 192
minimum event spacing = 10,000 us
timestamps must be strictly increasing
zero-action events are not accepted
```

`MSG_PREPARE_SCHEDULE = 0x16`

Payload: empty.

Current behavior:

1. Validate the uploaded schedule.
2. Upload pump-card local queues.
3. Verify each required pump-card queue using count, last event index, and a lightweight queue checksum.
4. Upload Timing Card FPGA event/action queues.
5. Verify the Timing Card queues using event/action counts, last event/action values, and lightweight queue checksums.
6. Command required pump cards to begin the initial DAC preload ramp, then wait for the firmware-defined preload window. This is currently 1 second, which covers a full-scale 0-5 V ramp at 10 V/s with margin.
7. Return `ACK OK`.
8. Hold the prepared schedule in an additional 1 second safety/settling window before it may be started.

Important: `PREPARE_SCHEDULE` does not arm pump cards or the Timing Card. It prepares card-local queues, performs the initial pump DAC preload ramp, then starts the GUI-visible ready delay. The GUI should allow a longer timeout for `PREPARE_SCHEDULE` because the command may not ACK until the preload ramp window has completed.

`MSG_START_SCHEDULE = 0x12`

Payload: empty.

Current prepared-flow behavior:

1. If the schedule is already prepared and ready, write the RUN control bit to pump cards and the Timing Card.
2. Scheduler state becomes `SCHED_RUNNING`.

If `START_SCHEDULE` is sent before `PREPARE_SCHEDULE`, the firmware preserves legacy behavior:

1. Validate the uploaded schedule.
2. Upload and verify pump-card and Timing Card queues.
3. Command required pump cards to begin the initial DAC preload ramp and wait for the preload window.
4. Return `ACK OK`.
5. Wait the additional 1 second ready delay.
6. Arm pump cards and the Timing Card.
7. Scheduler state becomes `SCHED_RUNNING`.

If `START_SCHEDULE` is sent after prepare but before the 1 second ready delay has elapsed, the firmware returns `ERR_BUSY_RUNNING`.

Important: a `START_SCHEDULE` ACK only means "accepted". In the legacy path it still does not mean "already running"; the GUI must poll `GET_STATUS` and wait for `scheduler_state == 2`.

`MSG_UPLOAD_EVENT` stores the schedule in backplane memory only. Expansion-card queue offload happens during `MSG_PREPARE_SCHEDULE`, or during `MSG_START_SCHEDULE` only for the legacy no-prepare path. Upload success does not prove the expansion cards already contain the schedule.

Pump-card or Timing Card offload failures return an immediate error response:

```text
MSG_ERROR = 0x03
payload = failed_seq:u16le, error_code:u8, detail:u8
error_code = 0x07 ERR_BAD_MODULE
detail = card/field-specific diagnostic byte
```

For pump-card discovery or validation failures, `detail` may be the base pump module ID for the missing slot, currently `slot * 8`. If card offload fails, the firmware clears prepared card queues and does not enter the ready/start window.

`MSG_GET_PREPARE_STATUS = 0x17`

Payload: empty.

Response after ACK:

```text
offset  size  field
0       1     prepared:u8
1       1     ready:u8
2       1     legacy_start_pending:u8
3       1     reserved
4       4     remaining_delay_ms:u32le
```

The GUI should enable the user's Run/Start action only when `prepared != 0` and `ready != 0`.

Legacy `START_SCHEDULE` behavior before this split was:

```text
1. Validate the uploaded schedule.
2. Upload pump-card local queues.
3. Verify each required pump-card queue using count, last event index, and a lightweight queue checksum.
4. Upload Timing Card FPGA event/action queues.
5. Verify the Timing Card queues.
6. Command required pump cards to begin the initial DAC preload ramp and wait for the preload window.
7. Return `ACK OK`.
8. Wait the additional 1 second ready delay.
9. Arm pump cards and the Timing Card.
10. Scheduler state becomes `SCHED_RUNNING`.
```

`MSG_STOP_SCHEDULE = 0x13`

Payload: empty.

Cancels pending start if still inside the 1 second delay, stops pump cards, stops Timing Card outputs, and transitions the scheduler to stopped/idle depending on whether a schedule is loaded.

## Status

`MSG_GET_STATUS = 0x14`

Payload: empty.

Response after ACK:

```text
offset  size  field
0       1     scheduler_state:u8
1       1     last_error:u8
2       2     event_count:u16le
4       4     last_event_id:u32le
8       8     current_time_us:u64le
```

Scheduler states:

```text
0 SCHED_IDLE
1 SCHED_LOADED
2 SCHED_RUNNING
3 SCHED_STOPPED
4 SCHED_ERROR
```

Expected state sequence around start:

```text
PREPARE_SCHEDULE     -> ACK OK
GET_PREPARE_STATUS   -> prepared=1, ready=0 during the 1 second delay
GET_PREPARE_STATUS   -> prepared=1, ready=1 when safe to start
START_SCHEDULE       -> ACK OK
GET_STATUS     -> SCHED_RUNNING after cards are armed
GET_STATUS     -> SCHED_STOPPED when complete
```

Very short schedules can move from `RUNNING` to `STOPPED` quickly. The GUI should tolerate completion after running is observed and should treat `SCHED_ERROR` plus `last_error` as the hard failure path.

## Inventory

`MSG_GET_CARD_INVENTORY = 0x15`

Payload: empty.

Response after ACK:

```text
offset  size  field
0       1     slot_count:u8
1       7     slot 0 entry
8       7     slot 1 entry
...
```

Slot entry:

```text
offset  size  field
0       1     present:u8
1       1     card_type:u8
2       1     firmware_major:u8
3       1     firmware_minor:u8
4       2     capabilities:u16le
6       1     max_local_events:u8
```

Known card types:

```text
0x00 CARD_TYPE_NONE
0x01 CARD_TYPE_PUMP_PERISTALTIC
0x02 CARD_TYPE_FPGA_GPIO_SYNC
```

Pump Card expected values for post-response DAC preload support:

```text
card_type        = 0x01
firmware         = 1.1 or newer
capabilities     = 0x0001
max_local_events = 48
```

Timing Card expected values:

```text
card_type        = 0x02
firmware         = 1.0
capabilities     = 0x0007
max_local_events = 48
```

Timing Card capability bits:

```text
0x0001 CARD_CAP_FPGA_GPIO_3V3_16
0x0002 CARD_CAP_FPGA_GPIO_5V_16
0x0004 CARD_CAP_FPGA_SYNC_MASTER
```

With the current 8-slot backplane, inventory payload length is 57 bytes.

## Module Actions

Module types:

```text
0x01 MODULE_PUMP_PERISTALTIC
0x02 MODULE_GPIO_FPGA
```

### Pump Action

Pump module IDs are global pump IDs, currently `0..63`.

```text
action_type = 0x01 PUMP_SET_STATE
payload length = 8
```

Payload:

```text
offset  size  field
0       1     enable:u8, 0 or 1
1       1     direction:u8, 0 or 1
2       2     reserved, write 0
4       4     flow_nl_min:u32le
```

The backplane converts flow to DAC millivolts internally before writing the pump card queue.

### Timing Card GPIO Actions

GPIO module IDs are Timing Card output channels:

```text
0..15   out_5v[0..15]
16..31  out_3v3[0..15]
```

Current public GPIO action IDs:

```text
0x01 GPIO_SET_WAVEFORM
0x02 GPIO_PULSE
0x03 GPIO_STOP
0x04 GPIO_MIRROR_SYNC
```

The legacy external force-high and force-low action records are retired. Internally, the FPGA still has force-high/force-low modes, but the GUI should not emit them.

`GPIO_SET_WAVEFORM`

Payload length: 16 bytes.

```text
offset  size  field
0       1     polarity_invert:u8, 0 or 1
1       1     idle_high:u8, 0 or 1
2       2     reserved, write 0
4       4     phase_step:u32le
8       4     duty_threshold:u32le
12      4     reserved, write 0
```

`GPIO_PULSE`

Payload length: 0.

Starts a block-style high output on the selected channel. For a finite pulse/block, the GUI must also emit a later `GPIO_STOP` event at the block stop timestamp.

`GPIO_STOP`

Payload length: 0.

Stops the selected output channel and returns it to the channel's stop/idle state.

`GPIO_MIRROR_SYNC`

Payload length: 0.

Configures the selected GPIO channel to mirror the Timing Card internal `sync_state`. `sync_state` toggles on every FPGA event edge. This is the preferred hardware status output mode. The dedicated `SYNC` pin and a mirror-sync GPIO channel are driven from the same internal signal, aside from normal output path skew.

## Timing Quirks and GUI Requirements

The firmware has two pump-start timing phases after schedule upload:

1. `PREPARE_SCHEDULE` performs expansion-card queue offload/verification, commands the pump cards to start their initial DAC preload ramp, then waits silently for the preload window. This preload wait is currently 1 second. The GUI should allow `PREPARE_SCHEDULE` to take at least this long before ACK, plus normal queue upload time.
2. After `PREPARE_SCHEDULE` returns `ACK OK`, the firmware applies an additional 1 second ready delay before `START_SCHEDULE` is allowed to arm the cards. During this delay, status remains `SCHED_LOADED` or `SCHED_STOPPED`, and `GET_PREPARE_STATUS` reports the remaining delay.

The GUI should not display "running" based only on `START_SCHEDULE` ACK. It should poll `GET_STATUS` until `scheduler_state == SCHED_RUNNING`.

The Timing Card event queue defines schedule completion for GPIO-only schedules. A single `GPIO_PULSE` event without a later `GPIO_STOP` event is a one-event schedule and can complete immediately after that event. For block-based GUI elements, always emit both:

```text
block start: GPIO_PULSE
block end:   GPIO_STOP
```

For PWM blocks, emit:

```text
block start: GPIO_SET_WAVEFORM
block end:   GPIO_STOP
```

For status output, emit one `GPIO_MIRROR_SYNC` action early in the schedule and do not reuse that GPIO channel for waveform/pulse/stop actions unless the user intentionally disables status output.

The FPGA `DONE` flag means the local Timing Card event queue has been consumed. It does not mean that a GUI block had duration unless the GUI uploaded an event at the block end.

## Versioning Note

This report documents the current source interface. The GUI should reject or regenerate schedules that still contain old external `GPIO_FORCE_LOW` or `GPIO_FORCE_HIGH` action names/IDs.
