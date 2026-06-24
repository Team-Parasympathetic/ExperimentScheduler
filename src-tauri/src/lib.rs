use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CardSlotInfo {
    slot: u8,
    present: bool,
    card_type: String,
    raw_card_type: u8,
    firmware_major: u8,
    firmware_minor: u8,
    capabilities: u16,
    max_local_events: u8,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialLogEntry {
    direction: String,
    label: String,
    seq: u16,
    msg_type: u8,
    bytes: String,
    detail: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardStatus {
    state: String,
    state_code: u8,
    last_error: u8,
    event_count: u16,
    last_event_id: u32,
    current_time_us: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareStatus {
    prepared: bool,
    ready: bool,
    legacy_start_pending: bool,
    remaining_delay_ms: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceDetectionResult {
    detected: bool,
    port_name: String,
    message: String,
    slots: Vec<CardSlotInfo>,
    log: Vec<SerialLogEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardCommandResult {
    ok: bool,
    message: String,
    status: Option<BoardStatus>,
    log: Vec<SerialLogEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncoderMonitorSample {
    port_name: String,
    seq: u8,
    raw_rpm: [i16; 8],
    rpm: [f32; 8],
    received_at_ms: u64,
    missed_frames: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncoderMonitorStatus {
    port_name: String,
    bytes_received: u64,
    frames_received: u64,
    crc_errors: u64,
    discarded_bytes: u64,
    buffered_bytes: usize,
    last_seq: Option<u8>,
    last_frame_at_ms: Option<u64>,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncoderMonitorSnapshot {
    connected: bool,
    port_name: String,
    sample: Option<EncoderMonitorSample>,
    status: Option<EncoderMonitorStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncoderMonitorResult {
    ok: bool,
    port_name: String,
    message: String,
}

struct EncoderMonitorHandle {
    port_name: String,
    stop: Arc<AtomicBool>,
    join: thread::JoinHandle<()>,
}

static ENCODER_MONITOR: OnceLock<Mutex<Option<EncoderMonitorHandle>>> = OnceLock::new();
static ENCODER_MONITOR_SNAPSHOT: OnceLock<Mutex<EncoderMonitorSnapshot>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchedulerRowInput {
    id: String,
    name: String,
    device_type: String,
    hardware_id: Option<usize>,
    is_schedule_status: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchedulerBlockInput {
    id: String,
    row_id: String,
    start_ms: f64,
    duration_ms: f64,
    direction: String,
    flow_rate: f64,
    trigger_mode: Option<String>,
    frequency_hz: Option<f64>,
    duty_cycle: Option<f64>,
    require_complete_periods: Option<bool>,
    sync_source_block_id: Option<String>,
    period_multiplier: Option<f64>,
}

#[tauri::command]
fn detect_backplane(port_name: String) -> DeviceDetectionResult {
    let trimmed_port = match require_port_name(&port_name) {
        Ok(trimmed_port) => trimmed_port,
        Err(message) => {
            return DeviceDetectionResult {
                detected: false,
                port_name: String::new(),
                message,
                slots: Vec::new(),
                log: Vec::new(),
            }
        }
    };

    let output = protocol::detect_backplane(&trimmed_port);
    match output.result {
        Ok(slots) => {
            let occupied_count = slots.iter().filter(|slot| slot.present).count();
            let pump_count = slots
                .iter()
                .filter(|slot| slot.present && slot.card_type == "pump")
                .count();
            let timing_count = slots
                .iter()
                .filter(|slot| slot.present && slot.card_type == "timing")
                .count();
            let message = if occupied_count == 0 {
                format!("Device detected on {trimmed_port}; no expansion cards reported.")
            } else {
                format!(
                    "Device detected on {trimmed_port}: {occupied_count}/{} slots occupied ({pump_count} pump, {timing_count} timing).",
                    slots.len()
                )
            };

            DeviceDetectionResult {
                detected: true,
                port_name: trimmed_port,
                message,
                slots,
                log: output.log,
            }
        }
        Err(error) => DeviceDetectionResult {
            detected: false,
            port_name: trimmed_port,
            message: error,
            slots: Vec::new(),
            log: output.log,
        },
    }
}

#[tauri::command]
fn upload_schedule(
    port_name: String,
    rows: Vec<SchedulerRowInput>,
    blocks: Vec<SchedulerBlockInput>,
) -> BoardCommandResult {
    let trimmed_port = match require_port_name(&port_name) {
        Ok(trimmed_port) => trimmed_port,
        Err(message) => return command_error(message, Vec::new()),
    };

    let output = protocol::upload_schedule(&trimmed_port, &rows, &blocks);
    match output.result {
        Ok(report) => BoardCommandResult {
            ok: true,
            message: format!(
                "Uploaded {} event(s) in {} attempt(s). Pump preload is ready to begin.",
                report.event_count, report.attempts
            ),
            status: Some(report.status),
            log: output.log,
        },
        Err(error) => command_error(error, output.log),
    }
}

#[tauri::command]
fn prepare_schedule(port_name: String) -> BoardCommandResult {
    let trimmed_port = match require_port_name(&port_name) {
        Ok(trimmed_port) => trimmed_port,
        Err(message) => return command_error(message, Vec::new()),
    };

    let output = protocol::prepare_schedule(&trimmed_port);
    match output.result {
        Ok(status) => BoardCommandResult {
            ok: true,
            message: "Preloaded pump speeds and prepared start. Start is ready.".to_string(),
            status: Some(status),
            log: output.log,
        },
        Err(error) => command_error(error, output.log),
    }
}

#[tauri::command]
fn start_schedule(port_name: String) -> BoardCommandResult {
    let trimmed_port = match require_port_name(&port_name) {
        Ok(trimmed_port) => trimmed_port,
        Err(message) => return command_error(message, Vec::new()),
    };

    let output = protocol::start_schedule(&trimmed_port);
    match output.result {
        Ok(()) => BoardCommandResult {
            ok: true,
            message: "Start command acknowledged; waiting for board status.".to_string(),
            status: None,
            log: output.log,
        },
        Err(error) => command_error(error, output.log),
    }
}

#[tauri::command]
fn get_status(port_name: String) -> BoardCommandResult {
    let trimmed_port = match require_port_name(&port_name) {
        Ok(trimmed_port) => trimmed_port,
        Err(message) => return command_error(message, Vec::new()),
    };

    let output = protocol::get_status(&trimmed_port);
    match output.result {
        Ok(status) => BoardCommandResult {
            ok: true,
            message: format!("Board status: {}.", status.state),
            status: Some(status),
            log: output.log,
        },
        Err(error) => command_error(error, output.log),
    }
}

#[tauri::command]
fn stop_schedule(port_name: String) -> BoardCommandResult {
    let trimmed_port = match require_port_name(&port_name) {
        Ok(trimmed_port) => trimmed_port,
        Err(message) => return command_error(message, Vec::new()),
    };

    let output = protocol::stop_schedule(&trimmed_port);
    match output.result {
        Ok(status) => BoardCommandResult {
            ok: true,
            message: format!("Stop command acknowledged. Board status: {}.", status.state),
            status: Some(status),
            log: output.log,
        },
        Err(error) => command_error(error, output.log),
    }
}

#[tauri::command]
fn start_encoder_monitor<R: Runtime>(app: AppHandle<R>, port_name: String) -> EncoderMonitorResult {
    let trimmed_port = match require_port_name(&port_name) {
        Ok(trimmed_port) => trimmed_port,
        Err(message) => {
            return EncoderMonitorResult {
                ok: false,
                port_name: String::new(),
                message,
            }
        }
    };

    stop_current_encoder_monitor();

    let serial = match protocol::serial::SerialConnection::open(&trimmed_port) {
        Ok(serial) => serial,
        Err(error) => {
            return EncoderMonitorResult {
                ok: false,
                port_name: trimmed_port,
                message: format!("Could not open encoder monitor: {error}"),
            }
        }
    };

    publish_encoder_snapshot(EncoderMonitorSnapshot {
        connected: true,
        port_name: trimmed_port.clone(),
        sample: None,
        status: Some(EncoderMonitorStatus {
            port_name: trimmed_port.clone(),
            bytes_received: 0,
            frames_received: 0,
            crc_errors: 0,
            discarded_bytes: 0,
            buffered_bytes: 0,
            last_seq: None,
            last_frame_at_ms: None,
            message: format!("Connected to {trimmed_port}; waiting for encoder telemetry."),
        }),
    });

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread_port = trimmed_port.clone();
    let thread_app = app.clone();

    let join = thread::spawn(move || {
        run_encoder_monitor(thread_app, thread_port, serial, thread_stop);
    });

    let mut monitor = encoder_monitor_state()
        .lock()
        .expect("encoder monitor mutex poisoned");
    *monitor = Some(EncoderMonitorHandle {
        port_name: trimmed_port.clone(),
        stop,
        join,
    });

    EncoderMonitorResult {
        ok: true,
        port_name: trimmed_port.clone(),
        message: format!("Encoder Monitor connected on {trimmed_port}."),
    }
}

#[tauri::command]
fn stop_encoder_monitor() -> EncoderMonitorResult {
    let stopped_port = stop_current_encoder_monitor();

    EncoderMonitorResult {
        ok: true,
        port_name: stopped_port.clone().unwrap_or_default(),
        message: stopped_port
            .map(|port_name| format!("Encoder Monitor disconnected from {port_name}."))
            .unwrap_or_else(|| "Encoder Monitor is not connected.".to_string()),
    }
}

#[tauri::command]
fn get_encoder_monitor_snapshot() -> EncoderMonitorSnapshot {
    encoder_monitor_snapshot_state()
        .lock()
        .expect("encoder monitor snapshot mutex poisoned")
        .clone()
}

#[tauri::command]
fn list_data_files<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<Vec<String>, String> {
    let directory = data_directory(&app, &folder)?;

    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create {}: {error}", directory.to_string_lossy()))?;

    let mut files = Vec::new();

    for entry in fs::read_dir(&directory)
        .map_err(|error| format!("Could not read {}: {error}", directory.to_string_lossy()))?
    {
        let entry = entry.map_err(|error| format!("Could not read file entry: {error}"))?;
        let path = entry.path();

        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }

        if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
            files.push(file_name.to_string());
        }
    }

    files.sort();
    Ok(files)
}

#[tauri::command]
fn save_data_file<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    file_name: String,
    content: String,
) -> Result<String, String> {
    let directory = data_directory(&app, &folder)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create {}: {error}", directory.to_string_lossy()))?;

    let normalized_file_name = normalize_json_file_name(&file_name)?;
    let path = directory.join(&normalized_file_name);

    fs::write(&path, content)
        .map_err(|error| format!("Could not write {}: {error}", path.to_string_lossy()))?;

    Ok(normalized_file_name)
}

#[tauri::command]
fn load_data_file<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    file_name: String,
) -> Result<String, String> {
    let directory = data_directory(&app, &folder)?;
    let normalized_file_name = normalize_json_file_name(&file_name)?;
    let path = directory.join(&normalized_file_name);

    fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.to_string_lossy()))
}

#[tauri::command]
fn delete_data_file<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    file_name: String,
) -> Result<String, String> {
    let directory = data_directory(&app, &folder)?;
    let normalized_file_name = normalize_json_file_name(&file_name)?;
    let path = directory.join(&normalized_file_name);

    fs::remove_file(&path)
        .map_err(|error| format!("Could not delete {}: {error}", path.to_string_lossy()))?;

    Ok(normalized_file_name)
}

fn command_error(message: impl Into<String>, log: Vec<SerialLogEntry>) -> BoardCommandResult {
    BoardCommandResult {
        ok: false,
        message: message.into(),
        status: None,
        log,
    }
}

fn encoder_monitor_state() -> &'static Mutex<Option<EncoderMonitorHandle>> {
    ENCODER_MONITOR.get_or_init(|| Mutex::new(None))
}

fn encoder_monitor_snapshot_state() -> &'static Mutex<EncoderMonitorSnapshot> {
    ENCODER_MONITOR_SNAPSHOT.get_or_init(|| {
        Mutex::new(EncoderMonitorSnapshot {
            connected: false,
            port_name: String::new(),
            sample: None,
            status: None,
        })
    })
}

fn publish_encoder_snapshot(snapshot: EncoderMonitorSnapshot) {
    let mut state = encoder_monitor_snapshot_state()
        .lock()
        .expect("encoder monitor snapshot mutex poisoned");
    *state = snapshot;
}

fn publish_encoder_status(status: EncoderMonitorStatus) {
    let mut state = encoder_monitor_snapshot_state()
        .lock()
        .expect("encoder monitor snapshot mutex poisoned");
    state.connected = true;
    state.port_name = status.port_name.clone();
    state.status = Some(status);
}

fn publish_encoder_sample(sample: EncoderMonitorSample) {
    let mut state = encoder_monitor_snapshot_state()
        .lock()
        .expect("encoder monitor snapshot mutex poisoned");
    state.connected = true;
    state.port_name = sample.port_name.clone();
    state.sample = Some(sample);
}

fn stop_current_encoder_monitor() -> Option<String> {
    let handle = {
        let mut monitor = encoder_monitor_state()
            .lock()
            .expect("encoder monitor mutex poisoned");

        monitor.take()
    }?;

    handle.stop.store(true, Ordering::Relaxed);
    let port_name = handle.port_name;
    let _ = handle.join.join();

    publish_encoder_snapshot(EncoderMonitorSnapshot {
        connected: false,
        port_name: port_name.clone(),
        sample: None,
        status: Some(EncoderMonitorStatus {
            port_name: port_name.clone(),
            bytes_received: 0,
            frames_received: 0,
            crc_errors: 0,
            discarded_bytes: 0,
            buffered_bytes: 0,
            last_seq: None,
            last_frame_at_ms: None,
            message: format!("Encoder Monitor disconnected from {port_name}."),
        }),
    });

    Some(port_name)
}

fn run_encoder_monitor<R: Runtime>(
    app: AppHandle<R>,
    port_name: String,
    mut serial: protocol::serial::SerialConnection,
    stop: Arc<AtomicBool>,
) {
    let mut read_buffer = [0u8; 128];
    let mut frame_buffer: Vec<u8> = Vec::with_capacity(256);
    let mut previous_seq: Option<u8> = None;
    let mut bytes_received = 0u64;
    let mut frames_received = 0u64;
    let mut crc_errors = 0u64;
    let mut discarded_bytes = 0u64;
    let mut last_frame_at_ms: Option<u64> = None;
    let mut last_status_emit_ms = 0u64;

    while !stop.load(Ordering::Relaxed) {
        match serial.read(&mut read_buffer) {
            Ok(0) => {
                let now_ms = now_unix_ms();
                emit_encoder_status_if_due(
                    &app,
                    &port_name,
                    bytes_received,
                    frames_received,
                    crc_errors,
                    discarded_bytes,
                    frame_buffer.len(),
                    previous_seq,
                    last_frame_at_ms,
                    &mut last_status_emit_ms,
                    now_ms,
                );
                thread::sleep(Duration::from_millis(2));
            }
            Ok(byte_count) => {
                bytes_received += byte_count as u64;
                frame_buffer.extend_from_slice(&read_buffer[..byte_count]);
                let parse_result = parse_encoder_frames(&mut frame_buffer);
                crc_errors += parse_result.crc_errors as u64;
                discarded_bytes += parse_result.discarded_bytes as u64;

                for (seq, raw_rpm) in parse_result.frames {
                    let missed_frames = previous_seq
                        .map(|previous| {
                            let expected = previous.wrapping_add(1);
                            if seq == expected {
                                0
                            } else {
                                seq.wrapping_sub(expected) as u32
                            }
                        })
                        .unwrap_or(0);
                    previous_seq = Some(seq);
                    frames_received += 1;

                    let rpm = raw_rpm.map(|value| value as f32 / 10.0);
                    let received_at_ms = now_unix_ms();
                    last_frame_at_ms = Some(received_at_ms);
                    let sample = EncoderMonitorSample {
                        port_name: port_name.clone(),
                        seq,
                        raw_rpm,
                        rpm,
                        received_at_ms,
                        missed_frames,
                    };
                    publish_encoder_sample(sample.clone());
                    let _ = app.emit(ENCODER_MONITOR_SAMPLE_EVENT, sample);
                }

                let now_ms = now_unix_ms();
                emit_encoder_status_if_due(
                    &app,
                    &port_name,
                    bytes_received,
                    frames_received,
                    crc_errors,
                    discarded_bytes,
                    frame_buffer.len(),
                    previous_seq,
                    last_frame_at_ms,
                    &mut last_status_emit_ms,
                    now_ms,
                );
            }
            Err(error) => {
                let status = EncoderMonitorStatus {
                    port_name: port_name.clone(),
                    bytes_received,
                    frames_received,
                    crc_errors,
                    discarded_bytes,
                    buffered_bytes: frame_buffer.len(),
                    last_seq: previous_seq,
                    last_frame_at_ms,
                    message: format!("Read error: {error}"),
                };
                publish_encoder_status(status.clone());
                let _ = app.emit(ENCODER_MONITOR_STATUS_EVENT, status);
                thread::sleep(Duration::from_millis(8));
            }
        }
    }
}

const ENCODER_MONITOR_SAMPLE_EVENT: &str = "encoder-monitor-sample";
const ENCODER_MONITOR_STATUS_EVENT: &str = "encoder-monitor-status";

struct EncoderParseResult {
    frames: Vec<(u8, [i16; 8])>,
    crc_errors: usize,
    discarded_bytes: usize,
}

fn emit_encoder_status_if_due<R: Runtime>(
    app: &AppHandle<R>,
    port_name: &str,
    bytes_received: u64,
    frames_received: u64,
    crc_errors: u64,
    discarded_bytes: u64,
    buffered_bytes: usize,
    last_seq: Option<u8>,
    last_frame_at_ms: Option<u64>,
    last_status_emit_ms: &mut u64,
    now_ms: u64,
) {
    if now_ms.saturating_sub(*last_status_emit_ms) < 250 {
        return;
    }

    *last_status_emit_ms = now_ms;
    let message = if frames_received > 0 {
        format!("Receiving encoder telemetry on {port_name}.")
    } else if bytes_received > 0 {
        format!("Receiving bytes on {port_name}, waiting for valid frames.")
    } else {
        format!("Connected to {port_name}; waiting for encoder telemetry.")
    };

    let status = EncoderMonitorStatus {
        port_name: port_name.to_string(),
        bytes_received,
        frames_received,
        crc_errors,
        discarded_bytes,
        buffered_bytes,
        last_seq,
        last_frame_at_ms,
        message,
    };
    publish_encoder_status(status.clone());
    let _ = app.emit(ENCODER_MONITOR_STATUS_EVENT, status);
}

fn parse_encoder_frames(buffer: &mut Vec<u8>) -> EncoderParseResult {
    const FRAME_LEN: usize = 20;
    const SYNC_A: u8 = 0xA5;
    const SYNC_B: u8 = 0xC3;

    let mut frames = Vec::new();
    let mut crc_errors = 0usize;
    let mut discarded_bytes = 0usize;

    loop {
        if buffer.len() < 2 {
            break;
        }

        let sync_position = buffer
            .windows(2)
            .position(|window| window[0] == SYNC_A && window[1] == SYNC_B);

        match sync_position {
            Some(position) if position > 0 => {
                buffer.drain(..position);
                discarded_bytes += position;
            }
            Some(_) => {}
            None => {
                let keep_last = buffer.last().copied() == Some(SYNC_A);
                let keep = usize::from(keep_last);
                let drain_len = buffer.len().saturating_sub(keep);
                buffer.drain(..drain_len);
                discarded_bytes += drain_len;
                break;
            }
        }

        if buffer.len() < FRAME_LEN {
            break;
        }

        let frame = &buffer[..FRAME_LEN];
        let expected_crc = crc8(&frame[2..19]);
        if expected_crc != frame[19] {
            buffer.drain(..1);
            crc_errors += 1;
            discarded_bytes += 1;
            continue;
        }

        let seq = frame[2];
        let mut raw_rpm = [0i16; 8];
        for channel in 0..8 {
            let offset = 3 + channel * 2;
            raw_rpm[channel] = i16::from_le_bytes([frame[offset], frame[offset + 1]]);
        }

        frames.push((seq, raw_rpm));
        buffer.drain(..FRAME_LEN);
    }

    EncoderParseResult {
        frames,
        crc_errors,
        discarded_bytes,
    }
}

fn crc8(bytes: &[u8]) -> u8 {
    let mut crc = 0u8;

    for byte in bytes {
        crc ^= *byte;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x07
            } else {
                crc << 1
            };
        }
    }

    crc
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn require_port_name(port_name: &str) -> Result<String, String> {
    let trimmed_port = port_name.trim().to_string();

    if trimmed_port.is_empty() {
        Err("Enter a COM port first.".to_string())
    } else {
        Ok(trimmed_port)
    }
}

fn data_directory<R: Runtime>(app: &AppHandle<R>, folder: &str) -> Result<PathBuf, String> {
    let folder_name = match folder {
        "calibrations" | "schedules" => folder,
        _ => return Err("Unsupported data folder.".to_string()),
    };
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate the app data directory: {error}"))?;

    Ok(app_data_dir.join(folder_name))
}

fn normalize_json_file_name(file_name: &str) -> Result<String, String> {
    let trimmed = file_name.trim();

    if trimmed.is_empty() {
        return Err("Enter a file name first.".to_string());
    }

    let base_name = trimmed
        .strip_suffix(".json")
        .unwrap_or(trimmed)
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if base_name.is_empty() {
        return Err("File name must contain letters or numbers.".to_string());
    }

    Ok(format!("{base_name}.json"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            detect_backplane,
            upload_schedule,
            prepare_schedule,
            start_schedule,
            stop_schedule,
            get_status,
            start_encoder_monitor,
            stop_encoder_monitor,
            get_encoder_monitor_snapshot,
            list_data_files,
            save_data_file,
            load_data_file,
            delete_data_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

mod protocol {
    use super::{
        BoardStatus, CardSlotInfo, PrepareStatus, SchedulerBlockInput, SchedulerRowInput,
        SerialLogEntry,
    };
    use std::collections::{BTreeMap, HashMap, HashSet};
    use std::thread;
    use std::time::{Duration, Instant};

    const SOF: u8 = 0xA5;
    const VERSION: u8 = 0x01;
    const MSG_PING: u8 = 0x01;
    const MSG_ACK: u8 = 0x02;
    const MSG_ERROR: u8 = 0x03;
    const MSG_CLEAR_SCHEDULE: u8 = 0x10;
    const MSG_UPLOAD_EVENT: u8 = 0x11;
    const MSG_START_SCHEDULE: u8 = 0x12;
    const MSG_STOP_SCHEDULE: u8 = 0x13;
    const MSG_GET_STATUS: u8 = 0x14;
    const MSG_GET_CARD_INVENTORY: u8 = 0x15;
    const MSG_PREPARE_SCHEDULE: u8 = 0x16;
    const MSG_GET_PREPARE_STATUS: u8 = 0x17;
    const ACK_OK: u8 = 0x00;
    const CARD_TYPE_NONE: u8 = 0x00;
    const CARD_TYPE_PUMP_PERISTALTIC: u8 = 0x01;
    const CARD_TYPE_FPGA_GPIO_SYNC: u8 = 0x02;
    const MODULE_PUMP_PERISTALTIC: u8 = 0x01;
    const MODULE_GPIO_FPGA: u8 = 0x02;
    const PUMP_SET_STATE: u8 = 0x01;
    const GPIO_SET_WAVEFORM: u8 = 0x01;
    const GPIO_PULSE: u8 = 0x02;
    const GPIO_STOP: u8 = 0x03;
    const GPIO_MIRROR_SYNC: u8 = 0x04;
    const CARD_INVENTORY_ENTRY_SIZE: usize = 7;
    const EVENT_HEADER_SIZE: usize = 13;
    const ACTION_HEADER_SIZE: usize = 4;
    const MAX_EVENTS: usize = 48;
    const MAX_EVENT_ACTION_BYTES: usize = 192;
    const MAX_PUMPS: usize = 64;
    const MAX_GPIO_OUTPUTS: usize = 32;
    const MAX_GPIO_ACTIONS: usize = 48;
    const MAX_PAYLOAD: usize = 256;
    const MIN_EVENT_SPACING_US: u64 = 10_000;
    const FPGA_PWM_CLOCK_HZ: u64 = 10_000_000;
    const PING_SEQ: u16 = 1;
    const INVENTORY_SEQ: u16 = 2;
    const RESPONSE_TIMEOUT: Duration = Duration::from_millis(1_000);
    const START_RESPONSE_TIMEOUT: Duration = Duration::from_millis(3_000);
    const PREPARE_RESPONSE_TIMEOUT: Duration = Duration::from_millis(6_000);
    const PREPARE_READY_TIMEOUT: Duration = Duration::from_millis(3_000);
    const PREPARE_STATUS_POLL_DELAY: Duration = Duration::from_millis(100);
    const INTER_COMMAND_DELAY: Duration = Duration::from_millis(50);
    const READ_IDLE_DELAY: Duration = Duration::from_millis(10);
    const UPLOAD_ATTEMPTS: usize = 3;
    const PREPARE_ATTEMPTS: usize = 3;
    const START_ATTEMPTS: usize = 3;
    const PWM_BOUNDARY_GUARD_US: u64 = 1;
    pub struct ProtocolResult<T> {
        pub result: Result<T, String>,
        pub log: Vec<SerialLogEntry>,
    }

    pub struct UploadReport {
        pub event_count: usize,
        pub status: BoardStatus,
        pub attempts: usize,
    }

    struct CompiledEvent {
        event_id: u32,
        timestamp_us: u64,
        payload: Vec<u8>,
    }

    #[derive(Default)]
    struct PendingEventActions {
        coalesces_nearby: bool,
        end_actions: Vec<Vec<u8>>,
        start_actions: Vec<Vec<u8>>,
    }

    pub fn detect_backplane(port_name: &str) -> ProtocolResult<Vec<CardSlotInfo>> {
        with_client(port_name, |client| {
            client.ping(PING_SEQ)?;
            thread::sleep(INTER_COMMAND_DELAY);
            client.get_card_inventory(INVENTORY_SEQ)
        })
    }

    pub fn upload_schedule(
        port_name: &str,
        rows: &[SchedulerRowInput],
        blocks: &[SchedulerBlockInput],
    ) -> ProtocolResult<UploadReport> {
        with_client(port_name, |client| {
            let mut seq = 1u16;
            client.ping(seq)?;
            seq = next_seq(seq);
            thread::sleep(INTER_COMMAND_DELAY);

            let inventory = client.get_card_inventory(seq)?;
            seq = next_seq(seq);
            thread::sleep(INTER_COMMAND_DELAY);

            let pump_slots = inventory
                .iter()
                .filter(|slot| slot.present && slot.card_type == "pump")
                .map(|slot| slot.slot)
                .collect::<Vec<_>>();
            let has_timing_card = inventory
                .iter()
                .any(|slot| slot.present && slot.card_type == "timing");
            let events = compile_schedule_events(rows, blocks, &pump_slots, has_timing_card)?;

            let mut last_error = None;

            for attempt in 1..=UPLOAD_ATTEMPTS {
                match upload_schedule_attempt(client, &events, &mut seq) {
                    Ok(status) => {
                        return Ok(UploadReport {
                            event_count: events.len(),
                            status,
                            attempts: attempt,
                        });
                    }
                    Err(error) => {
                        last_error = Some(error);

                        if attempt < UPLOAD_ATTEMPTS {
                            client.log_note(&format!(
                                "Upload attempt {attempt} failed; clearing board schedule before retry."
                            ));
                            let _ = client.clear_schedule(seq);
                            seq = next_seq(seq);
                            thread::sleep(INTER_COMMAND_DELAY);
                        }
                    }
                }
            }

            client.log_note(
                "All upload attempts failed; clearing board schedule before returning error.",
            );
            let _ = client.clear_schedule(seq);
            thread::sleep(INTER_COMMAND_DELAY);

            Err(last_error.unwrap_or_else(|| "Schedule upload failed.".to_string()))
        })
    }

    fn upload_schedule_attempt(
        client: &mut BackplaneClient,
        events: &[CompiledEvent],
        seq: &mut u16,
    ) -> Result<BoardStatus, String> {
        client.clear_schedule(*seq)?;
        *seq = next_seq(*seq);
        thread::sleep(INTER_COMMAND_DELAY);

        for event in events {
            client.upload_event(*seq, event.event_id, event.timestamp_us, &event.payload)?;
            *seq = next_seq(*seq);
            thread::sleep(INTER_COMMAND_DELAY);
        }

        let status = client.get_status(*seq)?;
        *seq = next_seq(*seq);
        thread::sleep(INTER_COMMAND_DELAY);

        if status.state_code == 4 {
            return Err(format!(
                "Board entered error state after upload. Last error: 0x{:02X}.",
                status.last_error
            ));
        }

        if status.event_count as usize != events.len() {
            return Err(format!(
                "Upload verification failed: board reports {} loaded event(s), expected {}.",
                status.event_count,
                events.len()
            ));
        }

        Ok(status)
    }

    pub fn prepare_schedule(port_name: &str) -> ProtocolResult<BoardStatus> {
        with_client(port_name, |client| {
            let mut seq = 1u16;
            client.ping(seq)?;
            seq = next_seq(seq);
            thread::sleep(INTER_COMMAND_DELAY);

            let mut last_error = None;

            for attempt in 1..=PREPARE_ATTEMPTS {
                match prepare_schedule_attempt(client, &mut seq) {
                    Ok(status) => return Ok(status),
                    Err(error) if is_pump_offload_error(&error) => {
                        last_error = Some(error);

                        if attempt < PREPARE_ATTEMPTS {
                            client.log_note(&format!(
                                "Prepare attempt {attempt} failed during card offload; retrying PREPARE_SCHEDULE."
                            ));
                            thread::sleep(INTER_COMMAND_DELAY);
                        }
                    }
                    Err(error) => return Err(error),
                }
            }

            Err(format!(
                "{} Prepare was retried {} times.",
                last_error.unwrap_or_else(|| "Card queue offload failed.".to_string()),
                PREPARE_ATTEMPTS
            ))
        })
    }

    fn prepare_schedule_attempt(
        client: &mut BackplaneClient,
        seq: &mut u16,
    ) -> Result<BoardStatus, String> {
        client.log_note("Preparing card queues and preloading pump DAC speeds.");
        client.prepare_schedule(*seq)?;
        *seq = next_seq(*seq);
        thread::sleep(INTER_COMMAND_DELAY);

        wait_for_prepare_ready(client, seq)?;

        let prepared_status = client.get_status(*seq)?;
        *seq = next_seq(*seq);
        thread::sleep(INTER_COMMAND_DELAY);

        if prepared_status.state_code == 4 {
            return Err(format!(
                "Board entered error state after prepare. Last error: 0x{:02X}.",
                prepared_status.last_error
            ));
        }

        if prepared_status.event_count == 0 {
            return Err("Prepare completed, but the board reports no loaded events.".to_string());
        }

        Ok(prepared_status)
    }

    fn wait_for_prepare_ready(
        client: &mut BackplaneClient,
        seq: &mut u16,
    ) -> Result<PrepareStatus, String> {
        let deadline = Instant::now() + PREPARE_READY_TIMEOUT;
        let mut last_status = None;

        while Instant::now() < deadline {
            let prepare_status = client.get_prepare_status(*seq)?;
            *seq = next_seq(*seq);

            if !prepare_status.prepared {
                return Err("Schedule prepare was acknowledged, but the board does not report a prepared schedule.".to_string());
            }

            if prepare_status.ready {
                thread::sleep(INTER_COMMAND_DELAY);
                return Ok(prepare_status);
            }

            last_status = Some(prepare_status);
            thread::sleep(PREPARE_STATUS_POLL_DELAY);
        }

        if let Some(status) = last_status {
            Err(format!(
                "Schedule prepare did not become ready within {:.1}s; {} ms remaining.",
                PREPARE_READY_TIMEOUT.as_secs_f32(),
                status.remaining_delay_ms
            ))
        } else {
            Err("Schedule prepare did not return a status response.".to_string())
        }
    }

    pub fn start_schedule(port_name: &str) -> ProtocolResult<()> {
        with_client(port_name, |client| {
            let mut seq = 1u16;
            client.ping(seq)?;
            seq = next_seq(seq);
            thread::sleep(INTER_COMMAND_DELAY);

            let mut last_error = None;

            for attempt in 1..=START_ATTEMPTS {
                match client.start_schedule(seq) {
                    Ok(()) => return Ok(()),
                    Err(error) if is_pump_offload_error(&error) => {
                        last_error = Some(error);

                        if attempt < START_ATTEMPTS {
                            client.log_note(&format!(
                                "Start attempt {attempt} failed during pump offload; retrying START_SCHEDULE."
                            ));
                            seq = next_seq(seq);
                            thread::sleep(INTER_COMMAND_DELAY);
                        }
                    }
                    Err(error) => return Err(error),
                }
            }

            Err(format!(
                "{} Start was retried {} times.",
                last_error.unwrap_or_else(|| "Pump offload failed.".to_string()),
                START_ATTEMPTS
            ))
        })
    }

    pub fn get_status(port_name: &str) -> ProtocolResult<BoardStatus> {
        with_client(port_name, |client| {
            let mut seq = 1u16;
            client.ping(seq)?;
            seq = next_seq(seq);
            thread::sleep(INTER_COMMAND_DELAY);

            client.get_status(seq)
        })
    }

    pub fn stop_schedule(port_name: &str) -> ProtocolResult<BoardStatus> {
        with_client(port_name, |client| {
            let mut seq = 1u16;
            client.ping(seq)?;
            seq = next_seq(seq);
            thread::sleep(INTER_COMMAND_DELAY);

            client.stop_schedule(seq)?;
            seq = next_seq(seq);
            thread::sleep(INTER_COMMAND_DELAY);

            client.get_status(seq)
        })
    }

    fn with_client<T, F>(port_name: &str, command: F) -> ProtocolResult<T>
    where
        F: FnOnce(&mut BackplaneClient) -> Result<T, String>,
    {
        match BackplaneClient::open(port_name) {
            Ok(mut client) => {
                let result = command(&mut client);
                ProtocolResult {
                    result,
                    log: client.into_log(),
                }
            }
            Err(error) => ProtocolResult {
                result: Err(error),
                log: Vec::new(),
            },
        }
    }

    fn next_seq(seq: u16) -> u16 {
        seq.wrapping_add(1).max(1)
    }

    fn compile_schedule_events(
        rows: &[SchedulerRowInput],
        blocks: &[SchedulerBlockInput],
        pump_slots: &[u8],
        has_timing_card: bool,
    ) -> Result<Vec<CompiledEvent>, String> {
        let row_indices: HashMap<&str, usize> = rows
            .iter()
            .enumerate()
            .map(|(index, row)| (row.id.as_str(), index))
            .collect();
        let blocks_by_id: HashMap<&str, &SchedulerBlockInput> = blocks
            .iter()
            .map(|block| (block.id.as_str(), block))
            .collect();
        let row_pump_ids = map_rows_to_pump_module_ids(rows, pump_slots)?;
        let row_gpio_ids = map_rows_to_gpio_module_ids(rows)?;
        let mut events_by_time_us: BTreeMap<u64, PendingEventActions> = BTreeMap::new();
        let mut gpio_action_count = 0usize;
        let schedule_status_rows = rows
            .iter()
            .filter(|row| is_schedule_status_row(row))
            .collect::<Vec<_>>();

        if schedule_status_rows.len() > 1 {
            return Err(
                "Only one trigger channel can be configured as the schedule status output."
                    .to_string(),
            );
        }

        let schedule_status_row = schedule_status_rows.first().copied();

        if let Some(row) = schedule_status_row {
            if !has_timing_card {
                return Err("A schedule status output requires a detected TimingCard.".to_string());
            }

            row_gpio_ids.get(row.id.as_str()).ok_or_else(|| {
                format!(
                    "Select an FPGA output pin for schedule status channel '{}'.",
                    row.name
                )
            })?;
        }

        for block in blocks {
            let row_index = row_indices
                .get(block.row_id.as_str())
                .copied()
                .ok_or_else(|| format!("Block {} references a missing channel.", block.id))?;
            let row = &rows[row_index];

            if is_schedule_status_row(row) {
                return Err(format!(
                    "Trigger channel '{}' is configured as the schedule status output and cannot contain blocks.",
                    row.name
                ));
            }

            let start_us = normalize_time_us(block.start_ms, "start", &block.id)?;
            let duration_us = normalize_time_us(block.duration_ms, "duration", &block.id)?;
            if duration_us == 0 {
                return Err(format!("Block {} has zero duration.", block.id));
            }

            let end_us = start_us.checked_add(duration_us).ok_or_else(|| {
                format!(
                    "Block {} ends beyond the representable time range.",
                    block.id
                )
            })?;

            match row.device_type.as_str() {
                "peristaltic" => {
                    let direction = match block.direction.as_str() {
                        "forward" => 0,
                        "reverse" => 1,
                        _ => {
                            return Err(format!(
                                "Block {} has unsupported pump direction '{}'.",
                                block.id, block.direction
                            ));
                        }
                    };
                    let flow_nl_min = flow_rate_ul_min_to_nl_min(block.flow_rate, &block.id)?;
                    let pump_id = *row_pump_ids.get(row.id.as_str()).ok_or_else(|| {
                        format!("No detected pump module is assigned to '{}'.", row.name)
                    })?;

                    events_by_time_us
                        .entry(start_us)
                        .or_default()
                        .start_actions
                        .push(build_pump_action(pump_id, true, direction, flow_nl_min));
                    events_by_time_us
                        .entry(end_us)
                        .or_default()
                        .end_actions
                        .push(build_pump_action(pump_id, false, direction, 0));
                }
                "trigger" => {
                    if !has_timing_card {
                        return Err(format!(
                            "Block {} is on a trigger output, but no TimingCard was detected.",
                            block.id
                        ));
                    }

                    let gpio_id = *row_gpio_ids
                        .get(row.id.as_str())
                        .ok_or_else(|| format!("Select an FPGA output pin for '{}'.", row.name))?;
                    let trigger_mode = block.trigger_mode.as_deref().unwrap_or("pulse");

                    match trigger_mode {
                        "pulse" | "rising" | "falling" => {
                            events_by_time_us
                                .entry(start_us)
                                .or_default()
                                .start_actions
                                .push(build_gpio_zero_payload_action(gpio_id, GPIO_PULSE));
                            events_by_time_us
                                .entry(end_us)
                                .or_default()
                                .end_actions
                                .push(build_gpio_zero_payload_action(gpio_id, GPIO_STOP));
                            gpio_action_count += 2;
                        }
                        "waveform" | "sync-division" => {
                            let waveform_phase_step = waveform_phase_step(block, &blocks_by_id)?;
                            let waveform_end_us =
                                effective_waveform_stop_us(block, start_us, waveform_phase_step)?;
                            let coalesces_nearby = trigger_mode == "sync-division"
                                || block.require_complete_periods.unwrap_or(true);
                            events_by_time_us
                                .entry(start_us)
                                .or_default()
                                .start_actions
                                .push(build_gpio_waveform_action(
                                    gpio_id,
                                    block,
                                    waveform_phase_step,
                                )?);
                            let waveform_stop_event =
                                events_by_time_us.entry(waveform_end_us).or_default();
                            waveform_stop_event.coalesces_nearby = coalesces_nearby;
                            waveform_stop_event
                                .end_actions
                                .push(build_gpio_zero_payload_action(gpio_id, GPIO_STOP));
                            gpio_action_count += 2;
                        }
                        _ => {
                            return Err(format!(
                                "Block {} has unsupported trigger block type '{}'.",
                                block.id, trigger_mode
                            ));
                        }
                    }
                }
                _ => {
                    return Err(format!(
                        "Block {} is on unsupported channel '{}' ({}).",
                        block.id, row.name, row.device_type
                    ));
                }
            }
        }

        if let Some(row) = schedule_status_row {
            let gpio_id = *row_gpio_ids.get(row.id.as_str()).ok_or_else(|| {
                format!(
                    "Select an FPGA output pin for schedule status channel '{}'.",
                    row.name
                )
            })?;
            if let Some((_time_us, pending_actions)) = events_by_time_us.iter_mut().next() {
                pending_actions
                    .start_actions
                    .push(build_gpio_zero_payload_action(gpio_id, GPIO_MIRROR_SYNC));
                gpio_action_count += 1;
            }
        }

        let events_by_time_us = coalesce_boundary_events(events_by_time_us);

        if events_by_time_us.is_empty() {
            return Err("The schedule has no events to upload.".to_string());
        }

        if gpio_action_count > MAX_GPIO_ACTIONS {
            return Err(format!(
                "Schedule has {gpio_action_count} FPGA GPIO action(s), but the TimingCard local action queue supports {MAX_GPIO_ACTIONS}."
            ));
        }

        if events_by_time_us.len() > MAX_EVENTS {
            return Err(format!(
                "Schedule has {} events, but firmware supports {MAX_EVENTS}.",
                events_by_time_us.len()
            ));
        }

        let mut compiled_events = Vec::with_capacity(events_by_time_us.len());
        let mut previous_time_us = None;

        for (index, (timestamp_us, pending_actions)) in events_by_time_us.into_iter().enumerate() {
            if let Some(previous_time_us) = previous_time_us {
                let spacing_us = timestamp_us.saturating_sub(previous_time_us);
                if spacing_us < MIN_EVENT_SPACING_US {
                    return Err(format!(
                        "Events at {:.3}s and {:.3}s are closer than the 10 ms firmware minimum.",
                        previous_time_us as f64 / 1_000_000.0,
                        timestamp_us as f64 / 1_000_000.0
                    ));
                }
            }

            let mut actions = pending_actions.end_actions;
            actions.extend(pending_actions.start_actions);
            if actions.is_empty() {
                continue;
            }

            let action_bytes_len: usize = actions.iter().map(Vec::len).sum();
            if action_bytes_len > MAX_EVENT_ACTION_BYTES {
                return Err(format!(
                    "Event at {:.3}s has {action_bytes_len} action bytes, but firmware supports {MAX_EVENT_ACTION_BYTES}.",
                    timestamp_us as f64 / 1_000_000.0
                ));
            }

            if actions.len() > u8::MAX as usize {
                return Err(format!(
                    "Event at {:.3}s has too many actions.",
                    timestamp_us as f64 / 1_000_000.0
                ));
            }

            let event_id = (index + 1) as u32;
            let mut payload = Vec::with_capacity(EVENT_HEADER_SIZE + action_bytes_len);
            payload.extend_from_slice(&event_id.to_le_bytes());
            payload.extend_from_slice(&timestamp_us.to_le_bytes());
            payload.push(actions.len() as u8);

            for action in actions {
                payload.extend_from_slice(&action);
            }

            if payload.len() > MAX_PAYLOAD {
                return Err(format!(
                    "Event at {:.3}s is {} bytes, but protocol payloads are capped at {MAX_PAYLOAD}.",
                    timestamp_us as f64 / 1_000_000.0,
                    payload.len()
                ));
            }

            compiled_events.push(CompiledEvent {
                event_id,
                timestamp_us,
                payload,
            });
            previous_time_us = Some(timestamp_us);
        }

        Ok(compiled_events)
    }

    fn coalesce_boundary_events(
        events_by_time_us: BTreeMap<u64, PendingEventActions>,
    ) -> BTreeMap<u64, PendingEventActions> {
        let mut coalesced_events: BTreeMap<u64, PendingEventActions> = BTreeMap::new();

        for (timestamp_us, mut pending_actions) in events_by_time_us {
            let target_timestamp_us =
                coalesced_events
                    .keys()
                    .next_back()
                    .copied()
                    .filter(|last_timestamp_us| {
                        let distance_us = timestamp_us.saturating_sub(*last_timestamp_us);
                        let existing_coalesces_nearby = coalesced_events
                            .get(last_timestamp_us)
                            .map(|event| event.coalesces_nearby)
                            .unwrap_or(false);

                        distance_us <= PWM_BOUNDARY_GUARD_US
                            || (distance_us < MIN_EVENT_SPACING_US
                                && (pending_actions.coalesces_nearby || existing_coalesces_nearby))
                    });

            if let Some(target_timestamp_us) = target_timestamp_us {
                if let Some(existing_actions) = coalesced_events.get_mut(&target_timestamp_us) {
                    existing_actions.coalesces_nearby |= pending_actions.coalesces_nearby;
                    existing_actions
                        .end_actions
                        .append(&mut pending_actions.end_actions);
                    existing_actions
                        .start_actions
                        .append(&mut pending_actions.start_actions);
                }
            } else {
                coalesced_events.insert(timestamp_us, pending_actions);
            }
        }

        coalesced_events
    }

    fn map_rows_to_pump_module_ids<'a>(
        rows: &'a [SchedulerRowInput],
        pump_slots: &[u8],
    ) -> Result<HashMap<&'a str, u8>, String> {
        let pump_row_count = rows
            .iter()
            .filter(|row| row.device_type == "peristaltic")
            .count();
        let pump_capacity = pump_slots.len() * 8;

        if pump_row_count > 0 && pump_slots.is_empty() {
            return Err("No peristaltic pump cards were detected for this schedule.".to_string());
        }

        if pump_row_count > pump_capacity {
            return Err(format!(
                "Schedule uses {pump_row_count} pump channel(s), but detected pump cards provide {pump_capacity}."
            ));
        }

        let pump_slot_set = pump_slots.iter().copied().collect::<HashSet<_>>();
        let available_pump_ids = pump_slots
            .iter()
            .flat_map(|slot| (0..8).map(move |local_pump| (*slot as usize) * 8 + local_pump))
            .collect::<Vec<_>>();
        let mut assigned_pump_ids = HashSet::new();
        let mut fallback_pump_index = 0usize;
        let mut row_pump_ids = HashMap::new();

        for row in rows {
            if row.device_type != "peristaltic" {
                continue;
            }

            let module_id = if let Some(requested_id) = row.hardware_id {
                validate_pump_module_id(requested_id, &pump_slot_set, &row.name)?;
                requested_id
            } else {
                while fallback_pump_index < available_pump_ids.len()
                    && assigned_pump_ids.contains(&available_pump_ids[fallback_pump_index])
                {
                    fallback_pump_index += 1;
                }

                *available_pump_ids.get(fallback_pump_index).ok_or_else(|| {
                    format!(
                        "No unassigned detected pump channel is available for '{}'.",
                        row.name
                    )
                })?
            };

            if !assigned_pump_ids.insert(module_id) {
                return Err(format!(
                    "Pump channel '{}' duplicates pump index {module_id}.",
                    row.name
                ));
            }

            if module_id >= MAX_PUMPS {
                return Err(format!(
                    "Pump channel '{}' uses pump index {module_id}, but firmware supports indices 0-{}.",
                    row.name,
                    MAX_PUMPS - 1,
                ));
            }

            row_pump_ids.insert(row.id.as_str(), module_id as u8);
        }

        Ok(row_pump_ids)
    }

    fn validate_pump_module_id(
        module_id: usize,
        pump_slot_set: &HashSet<u8>,
        row_name: &str,
    ) -> Result<(), String> {
        if module_id >= MAX_PUMPS {
            return Err(format!(
                "Pump channel '{row_name}' uses pump index {module_id}, but firmware supports indices 0-{}.",
                MAX_PUMPS - 1
            ));
        }

        let slot = (module_id / 8) as u8;
        if !pump_slot_set.contains(&slot) {
            return Err(format!(
                "Pump channel '{row_name}' is assigned to pump index {module_id}, but slot {slot} is not a detected pump card."
            ));
        }

        Ok(())
    }

    fn map_rows_to_gpio_module_ids<'a>(
        rows: &'a [SchedulerRowInput],
    ) -> Result<HashMap<&'a str, u8>, String> {
        let gpio_row_count = rows
            .iter()
            .filter(|row| row.device_type == "trigger")
            .count();

        if gpio_row_count > MAX_GPIO_OUTPUTS {
            return Err(format!(
                "Schedule uses {gpio_row_count} trigger output channel(s), but firmware supports {MAX_GPIO_OUTPUTS}."
            ));
        }

        let mut row_gpio_ids = HashMap::new();
        let mut assigned_gpio_ids = HashSet::new();

        for row in rows {
            if row.device_type != "trigger" {
                continue;
            }

            let Some(module_id) = row.hardware_id else {
                continue;
            };

            if module_id >= MAX_GPIO_OUTPUTS {
                return Err(format!(
                    "Trigger channel '{}' uses GPIO output {module_id}, but firmware supports outputs 0-{}.",
                    row.name,
                    MAX_GPIO_OUTPUTS - 1,
                ));
            }

            if !assigned_gpio_ids.insert(module_id) {
                return Err(format!(
                    "Trigger channel '{}' duplicates GPIO output {module_id}.",
                    row.name
                ));
            }

            row_gpio_ids.insert(row.id.as_str(), module_id as u8);
        }

        Ok(row_gpio_ids)
    }

    fn is_schedule_status_row(row: &SchedulerRowInput) -> bool {
        row.device_type == "trigger" && row.is_schedule_status.unwrap_or(false)
    }

    fn normalize_time_us(value_ms: f64, field_name: &str, block_id: &str) -> Result<u64, String> {
        if !value_ms.is_finite() {
            return Err(format!(
                "Block {block_id} has a non-finite {field_name} time."
            ));
        }

        if value_ms < 0.0 {
            return Err(format!(
                "Block {block_id} has a negative {field_name} time."
            ));
        }

        let value_us = (value_ms * 1_000.0).round();

        if value_us > u64::MAX as f64 {
            return Err(format!(
                "Block {block_id} has a {field_name} time beyond the firmware range."
            ));
        }

        Ok(value_us as u64)
    }

    fn flow_rate_ul_min_to_nl_min(value: f64, block_id: &str) -> Result<u32, String> {
        if !value.is_finite() {
            return Err(format!("Block {block_id} has a non-finite flow rate."));
        }

        if value < 0.0 {
            return Err(format!("Block {block_id} has a negative flow rate."));
        }

        let flow_nl_min = (value * 1_000.0).round();
        if flow_nl_min > u32::MAX as f64 {
            return Err(format!(
                "Block {block_id} flow rate is too large for firmware."
            ));
        }

        Ok(flow_nl_min as u32)
    }

    fn build_pump_action(module_id: u8, enable: bool, direction: u8, flow_nl_min: u32) -> Vec<u8> {
        let mut payload = Vec::with_capacity(8);
        payload.push(u8::from(enable));
        payload.push(direction);
        payload.extend_from_slice(&0u16.to_le_bytes());
        payload.extend_from_slice(&flow_nl_min.to_le_bytes());
        build_action(MODULE_PUMP_PERISTALTIC, module_id, PUMP_SET_STATE, &payload)
    }

    fn build_gpio_zero_payload_action(module_id: u8, action_type: u8) -> Vec<u8> {
        build_action(MODULE_GPIO_FPGA, module_id, action_type, &[])
    }

    fn build_gpio_waveform_action(
        module_id: u8,
        block: &SchedulerBlockInput,
        phase_step: u32,
    ) -> Result<Vec<u8>, String> {
        let duty_threshold =
            duty_percent_to_threshold(block.duty_cycle.unwrap_or(50.0), &block.id)?;
        let mut payload = Vec::with_capacity(16);

        payload.push(0);
        payload.push(0);
        payload.extend_from_slice(&0u16.to_le_bytes());
        payload.extend_from_slice(&phase_step.to_le_bytes());
        payload.extend_from_slice(&duty_threshold.to_le_bytes());
        payload.extend_from_slice(&0u32.to_le_bytes());

        Ok(build_action(
            MODULE_GPIO_FPGA,
            module_id,
            GPIO_SET_WAVEFORM,
            &payload,
        ))
    }

    fn effective_waveform_stop_us(
        block: &SchedulerBlockInput,
        start_us: u64,
        phase_step: u32,
    ) -> Result<u64, String> {
        let requested_duration_ms = block.duration_ms;

        if !block.require_complete_periods.unwrap_or(true) {
            let duration_us = normalize_time_us(requested_duration_ms, "duration", &block.id)?;
            return start_us.checked_add(duration_us).ok_or_else(|| {
                format!(
                    "Block {} ends beyond the representable time range.",
                    block.id
                )
            });
        }

        if !requested_duration_ms.is_finite() {
            return Err(format!("Block {} has a non-finite PWM duration.", block.id));
        }

        if requested_duration_ms <= 0.0 {
            return Err(format!("Block {} has zero duration.", block.id));
        }

        let actual_period_s =
            (u32::MAX as f64 + 1.0) / (phase_step as f64 * FPGA_PWM_CLOCK_HZ as f64);
        let requested_duration_s = requested_duration_ms / 1_000.0;
        let period_count = (requested_duration_s / actual_period_s).round().max(1.0);
        let boundary_time_s = (start_us as f64 / 1_000_000.0) + period_count * actual_period_s;
        let boundary_us = (boundary_time_s * 1_000_000.0).round();

        if boundary_us > u64::MAX as f64 {
            return Err(format!(
                "Block {} PWM stop time is too large for firmware.",
                block.id
            ));
        }

        let boundary_us = boundary_us as u64;
        let stop_us = boundary_us.saturating_sub(1).max(start_us + 1);

        if stop_us <= start_us {
            return Ok(start_us + 1);
        }

        Ok(stop_us)
    }

    fn waveform_phase_step(
        block: &SchedulerBlockInput,
        blocks_by_id: &HashMap<&str, &SchedulerBlockInput>,
    ) -> Result<u32, String> {
        match block.trigger_mode.as_deref().unwrap_or("pulse") {
            "waveform" => frequency_hz_to_phase_step(block.frequency_hz.unwrap_or(1.0), &block.id),
            "sync-division" => {
                let source_block_id = block.sync_source_block_id.as_deref().ok_or_else(|| {
                    format!(
                        "Block {} needs a source PWM block for synchronized mode.",
                        block.id
                    )
                })?;

                if source_block_id == block.id {
                    return Err(format!("Block {} cannot synchronize to itself.", block.id));
                }

                let source_block = blocks_by_id.get(source_block_id).copied().ok_or_else(|| {
                    format!(
                        "Block {} references missing source PWM block {}.",
                        block.id, source_block_id
                    )
                })?;

                if source_block.trigger_mode.as_deref() != Some("waveform") {
                    return Err(format!(
                        "Block {} synchronized source must be a PWM waveform block.",
                        block.id
                    ));
                }

                let multiplier = normalize_period_multiplier(block.period_multiplier, &block.id)?;
                let source_phase_step = frequency_hz_to_phase_step(
                    source_block.frequency_hz.unwrap_or(1.0),
                    &source_block.id,
                )?;

                if source_phase_step % multiplier != 0 {
                    return Err(format!(
                        "Block {} period multiplier {} is not exactly representable from source phase step {}.",
                        block.id, multiplier, source_phase_step
                    ));
                }

                Ok(source_phase_step / multiplier)
            }
            mode => Err(format!(
                "Block {} has unsupported waveform mode '{}'.",
                block.id, mode
            )),
        }
    }

    fn normalize_period_multiplier(value: Option<f64>, block_id: &str) -> Result<u32, String> {
        let value = value.unwrap_or(2.0);

        if !value.is_finite() || value < 1.0 {
            return Err(format!(
                "Block {block_id} synchronized multiplier must be at least 1."
            ));
        }

        if value > u32::MAX as f64 {
            return Err(format!(
                "Block {block_id} synchronized multiplier is too large."
            ));
        }

        Ok(value.round() as u32)
    }

    fn frequency_hz_to_phase_step(value: f64, block_id: &str) -> Result<u32, String> {
        if !value.is_finite() {
            return Err(format!("Block {block_id} has a non-finite PWM frequency."));
        }

        if value <= 0.0 {
            return Err(format!("Block {block_id} PWM frequency must be positive."));
        }

        let phase_step = (value * (u32::MAX as f64 + 1.0) / FPGA_PWM_CLOCK_HZ as f64).round();

        if phase_step < 1.0 {
            return Err(format!(
                "Block {block_id} PWM frequency is too low for the TimingCard phase accumulator."
            ));
        }

        if phase_step > u32::MAX as f64 {
            return Err(format!(
                "Block {block_id} PWM frequency is too high for the TimingCard phase accumulator."
            ));
        }

        Ok(phase_step as u32)
    }

    fn duty_percent_to_threshold(value: f64, block_id: &str) -> Result<u32, String> {
        if !value.is_finite() {
            return Err(format!("Block {block_id} has a non-finite PWM duty cycle."));
        }

        if !(0.0..=100.0).contains(&value) {
            return Err(format!(
                "Block {block_id} PWM duty cycle must be between 0 and 100 percent."
            ));
        }

        if value >= 100.0 {
            return Ok(u32::MAX);
        }

        let threshold = ((value / 100.0) * (u32::MAX as f64 + 1.0)).round();
        Ok(threshold.clamp(0.0, u32::MAX as f64) as u32)
    }

    fn build_action(
        module_type: u8,
        module_id: u8,
        action_type: u8,
        action_payload: &[u8],
    ) -> Vec<u8> {
        let mut action = Vec::with_capacity(ACTION_HEADER_SIZE + action_payload.len());
        action.push(module_type);
        action.push(module_id);
        action.push(action_type);
        action.push(action_payload.len() as u8);
        action.extend_from_slice(action_payload);
        action
    }

    struct BackplaneClient {
        serial: serial::SerialConnection,
        reader: FrameReader,
        log: Vec<SerialLogEntry>,
    }

    impl BackplaneClient {
        fn open(port_name: &str) -> Result<Self, String> {
            Ok(Self {
                serial: serial::SerialConnection::open(port_name)?,
                reader: FrameReader::default(),
                log: Vec::new(),
            })
        }

        fn into_log(self) -> Vec<SerialLogEntry> {
            self.log
        }

        fn ping(&mut self, seq: u16) -> Result<(), String> {
            self.request_ack("PING", MSG_PING, seq, &[], RESPONSE_TIMEOUT)
        }

        fn clear_schedule(&mut self, seq: u16) -> Result<(), String> {
            self.request_ack(
                "CLEAR_SCHEDULE",
                MSG_CLEAR_SCHEDULE,
                seq,
                &[],
                RESPONSE_TIMEOUT,
            )
        }

        fn upload_event(
            &mut self,
            seq: u16,
            event_id: u32,
            timestamp_us: u64,
            payload: &[u8],
        ) -> Result<(), String> {
            self.request_ack(
                &format!(
                    "UPLOAD_EVENT id={event_id} t={:.3}s",
                    timestamp_us as f64 / 1_000_000.0
                ),
                MSG_UPLOAD_EVENT,
                seq,
                payload,
                RESPONSE_TIMEOUT,
            )
        }

        fn prepare_schedule(&mut self, seq: u16) -> Result<(), String> {
            self.request_ack(
                "PREPARE_SCHEDULE",
                MSG_PREPARE_SCHEDULE,
                seq,
                &[],
                PREPARE_RESPONSE_TIMEOUT,
            )
        }

        fn start_schedule(&mut self, seq: u16) -> Result<(), String> {
            self.request_ack(
                "START_SCHEDULE",
                MSG_START_SCHEDULE,
                seq,
                &[],
                START_RESPONSE_TIMEOUT,
            )
        }

        fn get_prepare_status(&mut self, seq: u16) -> Result<PrepareStatus, String> {
            let frames = self.collect_until(
                "GET_PREPARE_STATUS",
                MSG_GET_PREPARE_STATUS,
                seq,
                &[],
                RESPONSE_TIMEOUT,
                |frames| {
                    frames.iter().any(|frame| frame_is_ok_ack(frame, seq))
                        && frames
                            .iter()
                            .any(|frame| frame.msg_type == MSG_GET_PREPARE_STATUS)
                },
            )?;

            if !frames.iter().any(|frame| frame_is_ok_ack(frame, seq)) {
                return Err(format_unexpected_response(
                    "Prepare status request was not acknowledged",
                    &frames,
                ));
            }

            let status_frame = frames
                .iter()
                .find(|frame| frame.msg_type == MSG_GET_PREPARE_STATUS)
                .ok_or_else(|| {
                    format_unexpected_response("Prepare status response missing", &frames)
                })?;

            parse_prepare_status_payload(&status_frame.payload)
        }

        fn stop_schedule(&mut self, seq: u16) -> Result<(), String> {
            self.request_ack(
                "STOP_SCHEDULE",
                MSG_STOP_SCHEDULE,
                seq,
                &[],
                RESPONSE_TIMEOUT,
            )
        }

        fn get_status(&mut self, seq: u16) -> Result<BoardStatus, String> {
            let frames = self.collect_until(
                "GET_STATUS",
                MSG_GET_STATUS,
                seq,
                &[],
                RESPONSE_TIMEOUT,
                |frames| {
                    frames.iter().any(|frame| frame_is_ok_ack(frame, seq))
                        && frames.iter().any(|frame| frame.msg_type == MSG_GET_STATUS)
                },
            )?;

            if !frames.iter().any(|frame| frame_is_ok_ack(frame, seq)) {
                return Err(format_unexpected_response(
                    "Status request was not acknowledged",
                    &frames,
                ));
            }

            let status_frame = frames
                .iter()
                .find(|frame| frame.msg_type == MSG_GET_STATUS)
                .ok_or_else(|| format_unexpected_response("Status response missing", &frames))?;

            parse_status_payload(&status_frame.payload)
        }

        fn get_card_inventory(&mut self, seq: u16) -> Result<Vec<CardSlotInfo>, String> {
            let frames = self.collect_until(
                "GET_CARD_INVENTORY",
                MSG_GET_CARD_INVENTORY,
                seq,
                &[],
                RESPONSE_TIMEOUT,
                |frames| {
                    frames.iter().any(|frame| frame_is_ok_ack(frame, seq))
                        && frames
                            .iter()
                            .any(|frame| frame.msg_type == MSG_GET_CARD_INVENTORY)
                },
            )?;

            if !frames.iter().any(|frame| frame_is_ok_ack(frame, seq)) {
                return Err(format_unexpected_response(
                    "Card inventory request was not acknowledged",
                    &frames,
                ));
            }

            let inventory_frame = frames
                .iter()
                .find(|frame| frame.msg_type == MSG_GET_CARD_INVENTORY)
                .ok_or_else(|| {
                    format_unexpected_response("Card inventory response missing", &frames)
                })?;

            parse_card_inventory_payload(&inventory_frame.payload)
        }

        fn request_ack(
            &mut self,
            label: &str,
            msg_type: u8,
            seq: u16,
            payload: &[u8],
            timeout: Duration,
        ) -> Result<(), String> {
            let frames = self.collect_until(label, msg_type, seq, payload, timeout, |frames| {
                frames.iter().any(|frame| frame_is_ok_ack(frame, seq))
            })?;

            if frames.iter().any(|frame| frame_is_ok_ack(frame, seq)) {
                Ok(())
            } else {
                Err(format_unexpected_response(label, &frames))
            }
        }

        fn collect_until<F>(
            &mut self,
            label: &str,
            msg_type: u8,
            seq: u16,
            payload: &[u8],
            timeout: Duration,
            is_complete: F,
        ) -> Result<Vec<Frame>, String>
        where
            F: Fn(&[Frame]) -> bool,
        {
            let frame = build_frame(msg_type, seq, payload)?;
            self.log_tx(label, msg_type, seq, &frame);
            self.serial.write_all(&frame)?;

            let deadline = Instant::now() + timeout;
            let mut frames = Vec::new();
            let mut read_buffer = [0u8; 96];

            while Instant::now() < deadline {
                let bytes_read = self.serial.read(&mut read_buffer)?;

                if bytes_read == 0 {
                    thread::sleep(READ_IDLE_DELAY);
                    continue;
                }

                for frame in self.reader.feed(&read_buffer[..bytes_read]) {
                    self.log_rx(label, &frame);

                    if frame.seq != seq {
                        continue;
                    }

                    if let Some(error) = protocol_error_for_seq(&frame, seq, label) {
                        return Err(error);
                    }

                    frames.push(frame);
                    if is_complete(&frames) {
                        return Ok(frames);
                    }
                }
            }

            if frames.is_empty() {
                Err(format!("No protocol response received for {label}."))
            } else {
                Err(format_unexpected_response(
                    &format!("Timed out waiting for {label} response"),
                    &frames,
                ))
            }
        }

        fn log_tx(&mut self, label: &str, msg_type: u8, seq: u16, bytes: &[u8]) {
            self.log.push(SerialLogEntry {
                direction: "tx".to_string(),
                label: label.to_string(),
                seq,
                msg_type,
                bytes: bytes_to_hex(bytes),
                detail: format!(
                    "{} payload={}B",
                    message_type_name(msg_type),
                    payload_len(bytes)
                ),
            });
        }

        fn log_rx(&mut self, label: &str, frame: &Frame) {
            self.log.push(SerialLogEntry {
                direction: "rx".to_string(),
                label: label.to_string(),
                seq: frame.seq,
                msg_type: frame.msg_type,
                bytes: bytes_to_hex(&frame.raw_bytes),
                detail: describe_frame(frame),
            });
        }

        fn log_note(&mut self, detail: &str) {
            self.log.push(SerialLogEntry {
                direction: "info".to_string(),
                label: "UPLOAD_RETRY".to_string(),
                seq: 0,
                msg_type: 0,
                bytes: String::new(),
                detail: detail.to_string(),
            });
        }
    }

    fn payload_len(frame_bytes: &[u8]) -> usize {
        if frame_bytes.len() < 9 {
            return 0;
        }

        u16::from_le_bytes([frame_bytes[5], frame_bytes[6]]) as usize
    }

    fn parse_status_payload(payload: &[u8]) -> Result<BoardStatus, String> {
        if payload.len() != 16 {
            return Err(format!(
                "Malformed status response: expected 16 bytes, got {}.",
                payload.len()
            ));
        }

        let state_code = payload[0];
        let last_error = payload[1];
        let event_count = u16::from_le_bytes([payload[2], payload[3]]);
        let last_event_id = u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]);
        let current_time_us = u64::from_le_bytes([
            payload[8],
            payload[9],
            payload[10],
            payload[11],
            payload[12],
            payload[13],
            payload[14],
            payload[15],
        ]);

        Ok(BoardStatus {
            state: scheduler_state_name(state_code).to_string(),
            state_code,
            last_error,
            event_count,
            last_event_id,
            current_time_us,
        })
    }

    fn parse_prepare_status_payload(payload: &[u8]) -> Result<PrepareStatus, String> {
        if payload.len() != 8 {
            return Err(format!(
                "Malformed prepare status response: expected 8 bytes, got {}.",
                payload.len()
            ));
        }

        Ok(PrepareStatus {
            prepared: payload[0] != 0,
            ready: payload[1] != 0,
            legacy_start_pending: payload[2] != 0,
            remaining_delay_ms: u32::from_le_bytes([
                payload[4], payload[5], payload[6], payload[7],
            ]),
        })
    }

    fn scheduler_state_name(state_code: u8) -> &'static str {
        match state_code {
            0 => "idle",
            1 => "loaded",
            2 => "running",
            3 => "stopped",
            4 => "error",
            _ => "unknown",
        }
    }

    fn parse_card_inventory_payload(payload: &[u8]) -> Result<Vec<CardSlotInfo>, String> {
        if payload.is_empty() {
            return Err("Malformed card inventory response: missing slot count.".to_string());
        }

        let slot_count = payload[0] as usize;
        let expected_len = 1 + (slot_count * CARD_INVENTORY_ENTRY_SIZE);
        if payload.len() != expected_len {
            return Err(format!(
                "Malformed card inventory response: expected {expected_len} bytes, got {}.",
                payload.len()
            ));
        }

        let mut slots = Vec::with_capacity(slot_count);
        let mut offset = 1usize;

        for slot in 0..slot_count {
            let present = payload[offset] != 0;
            let raw_card_type = payload[offset + 1];
            let firmware_major = payload[offset + 2];
            let firmware_minor = payload[offset + 3];
            let capabilities = u16::from_le_bytes([payload[offset + 4], payload[offset + 5]]);
            let max_local_events = payload[offset + 6];
            let card_type = decode_card_type(present, raw_card_type).to_string();

            slots.push(CardSlotInfo {
                slot: slot as u8,
                present,
                card_type,
                raw_card_type,
                firmware_major,
                firmware_minor,
                capabilities,
                max_local_events,
            });

            offset += CARD_INVENTORY_ENTRY_SIZE;
        }

        Ok(slots)
    }

    fn decode_card_type(present: bool, raw_card_type: u8) -> &'static str {
        if !present || raw_card_type == CARD_TYPE_NONE {
            return "empty";
        }

        match raw_card_type {
            CARD_TYPE_PUMP_PERISTALTIC => "pump",
            CARD_TYPE_FPGA_GPIO_SYNC => "timing",
            _ => "unknown",
        }
    }

    fn frame_is_ok_ack(frame: &Frame, seq: u16) -> bool {
        frame.msg_type == MSG_ACK
            && frame.seq == seq
            && frame.payload.len() == 3
            && u16::from_le_bytes([frame.payload[0], frame.payload[1]]) == seq
            && frame.payload[2] == ACK_OK
    }

    fn protocol_error_for_seq(frame: &Frame, seq: u16, label: &str) -> Option<String> {
        if frame.msg_type != MSG_ERROR || frame.payload.len() != 4 {
            return None;
        }

        let failed_seq = u16::from_le_bytes([frame.payload[0], frame.payload[1]]);
        if failed_seq != seq {
            return None;
        }

        let error_code = frame.payload[2];
        let detail = frame.payload[3];
        Some(format_protocol_error(label, error_code, detail))
    }

    fn is_pump_offload_error(error: &str) -> bool {
        error.contains("(ERR_BAD_MODULE 0x07)") && error.contains("offload failed")
    }

    fn format_protocol_error(label: &str, error_code: u8, detail: u8) -> String {
        if (label == "PREPARE_SCHEDULE" || label == "START_SCHEDULE") && error_code == 0x07 {
            let slot_hint = if detail % 8 == 0 {
                format!(" Possible pump slot: {}.", detail / 8)
            } else {
                String::new()
            };

            return format!(
                "Card queue offload failed during {label}; diagnostic 0x{detail:02X}.{slot_hint} (ERR_BAD_MODULE 0x07)."
            );
        }

        let error_name = protocol_error_name(error_code);
        let error_description = protocol_error_description(error_code);

        if detail == 0 {
            format!(
                "Firmware rejected {label}: {error_description} ({error_name} 0x{error_code:02X})."
            )
        } else {
            format!(
                "Firmware rejected {label}: {error_description}, detail 0x{detail:02X} ({error_name} 0x{error_code:02X})."
            )
        }
    }

    fn protocol_error_name(error_code: u8) -> &'static str {
        match error_code {
            0x01 => "ERR_BAD_CRC",
            0x02 => "ERR_BAD_VERSION",
            0x03 => "ERR_BAD_LENGTH",
            0x04 => "ERR_UNKNOWN_MSG",
            0x05 => "ERR_SCHEDULE_FULL",
            0x06 => "ERR_BAD_EVENT",
            0x07 => "ERR_BAD_MODULE",
            0x08 => "ERR_BAD_ACTION",
            0x09 => "ERR_BUSY_RUNNING",
            _ => "ERR_UNKNOWN",
        }
    }

    fn protocol_error_description(error_code: u8) -> &'static str {
        match error_code {
            0x01 => "bad CRC",
            0x02 => "unsupported protocol version",
            0x03 => "bad payload length",
            0x04 => "unknown command",
            0x05 => "schedule memory is full",
            0x06 => "bad schedule event",
            0x07 => "bad or missing module",
            0x08 => "bad module action",
            0x09 => "scheduler is busy running",
            _ => "unknown protocol error",
        }
    }

    fn format_unexpected_response(context: &str, frames: &[Frame]) -> String {
        if frames.is_empty() {
            context.to_string()
        } else {
            format!("{context}. See the serial console for firmware frame details.")
        }
    }

    fn describe_frame(frame: &Frame) -> String {
        match frame.msg_type {
            MSG_ACK if frame.payload.len() == 3 => {
                let ack_seq = u16::from_le_bytes([frame.payload[0], frame.payload[1]]);
                format!(
                    "ACK seq={} ack_seq={} status=0x{:02X}",
                    frame.seq, ack_seq, frame.payload[2]
                )
            }
            MSG_ERROR if frame.payload.len() == 4 => {
                let failed_seq = u16::from_le_bytes([frame.payload[0], frame.payload[1]]);
                format!(
                    "ERROR seq={} failed_seq={} code=0x{:02X} detail=0x{:02X}",
                    frame.seq, failed_seq, frame.payload[2], frame.payload[3]
                )
            }
            MSG_GET_STATUS if frame.payload.len() == 16 => {
                match parse_status_payload(&frame.payload) {
                    Ok(status) => format!(
                        "STATUS seq={} state={} events={} last_event={} last_error=0x{:02X}",
                        frame.seq,
                        status.state,
                        status.event_count,
                        status.last_event_id,
                        status.last_error
                    ),
                    Err(_) => format!("STATUS seq={} malformed", frame.seq),
                }
            }
            MSG_GET_PREPARE_STATUS if frame.payload.len() == 8 => {
                match parse_prepare_status_payload(&frame.payload) {
                    Ok(status) => format!(
                    "PREPARE_STATUS seq={} prepared={} ready={} legacy_pending={} remaining={}ms",
                    frame.seq,
                    status.prepared as u8,
                    status.ready as u8,
                    status.legacy_start_pending as u8,
                    status.remaining_delay_ms
                ),
                    Err(_) => format!("PREPARE_STATUS seq={} malformed", frame.seq),
                }
            }
            MSG_GET_CARD_INVENTORY => {
                format!(
                    "INVENTORY seq={} payload={}B",
                    frame.seq,
                    frame.payload.len()
                )
            }
            _ => format!(
                "{} seq={} payload={}B",
                message_type_name(frame.msg_type),
                frame.seq,
                frame.payload.len()
            ),
        }
    }

    fn message_type_name(msg_type: u8) -> &'static str {
        match msg_type {
            MSG_PING => "PING",
            MSG_ACK => "ACK",
            MSG_ERROR => "ERROR",
            MSG_CLEAR_SCHEDULE => "CLEAR_SCHEDULE",
            MSG_UPLOAD_EVENT => "UPLOAD_EVENT",
            MSG_START_SCHEDULE => "START_SCHEDULE",
            MSG_STOP_SCHEDULE => "STOP_SCHEDULE",
            MSG_GET_STATUS => "GET_STATUS",
            MSG_GET_CARD_INVENTORY => "GET_CARD_INVENTORY",
            MSG_PREPARE_SCHEDULE => "PREPARE_SCHEDULE",
            MSG_GET_PREPARE_STATUS => "GET_PREPARE_STATUS",
            _ => "FRAME",
        }
    }

    fn build_frame(msg_type: u8, seq: u16, payload: &[u8]) -> Result<Vec<u8>, String> {
        if payload.len() > MAX_PAYLOAD {
            return Err("Protocol payload is too large.".to_string());
        }

        let mut body = Vec::with_capacity(6 + payload.len());
        body.push(VERSION);
        body.push(msg_type);
        body.extend_from_slice(&seq.to_le_bytes());
        body.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        body.extend_from_slice(payload);

        let crc = crc16_ccitt_false(&body);
        let mut frame = Vec::with_capacity(1 + body.len() + 2);
        frame.push(SOF);
        frame.extend_from_slice(&body);
        frame.extend_from_slice(&crc.to_le_bytes());

        Ok(frame)
    }

    fn crc16_ccitt_false(data: &[u8]) -> u16 {
        let mut crc = 0xFFFFu16;

        for byte in data {
            crc ^= (*byte as u16) << 8;
            for _ in 0..8 {
                if (crc & 0x8000) != 0 {
                    crc = (crc << 1) ^ 0x1021;
                } else {
                    crc <<= 1;
                }
            }
        }

        crc
    }

    fn bytes_to_hex(bytes: &[u8]) -> String {
        bytes
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[derive(Clone)]
    struct Frame {
        msg_type: u8,
        seq: u16,
        payload: Vec<u8>,
        raw_bytes: Vec<u8>,
    }

    #[derive(Default)]
    struct FrameReader {
        buffer: Vec<u8>,
    }

    impl FrameReader {
        fn feed(&mut self, bytes: &[u8]) -> Vec<Frame> {
            self.buffer.extend_from_slice(bytes);
            let mut frames = Vec::new();

            loop {
                let Some(sof_index) = self.buffer.iter().position(|byte| *byte == SOF) else {
                    self.buffer.clear();
                    break;
                };

                if sof_index > 0 {
                    self.buffer.drain(..sof_index);
                }

                if self.buffer.len() < 9 {
                    break;
                }

                let version = self.buffer[1];
                let msg_type = self.buffer[2];
                let seq = u16::from_le_bytes([self.buffer[3], self.buffer[4]]);
                let payload_len = u16::from_le_bytes([self.buffer[5], self.buffer[6]]) as usize;

                if version != VERSION || payload_len > MAX_PAYLOAD {
                    self.buffer.drain(..1);
                    continue;
                }

                let frame_len = 9 + payload_len;
                if self.buffer.len() < frame_len {
                    break;
                }

                let payload_start = 7usize;
                let payload_end = payload_start + payload_len;
                let crc_rx =
                    u16::from_le_bytes([self.buffer[payload_end], self.buffer[payload_end + 1]]);
                let crc_calc = crc16_ccitt_false(&self.buffer[1..payload_end]);

                if crc_rx == crc_calc {
                    frames.push(Frame {
                        msg_type,
                        seq,
                        payload: self.buffer[payload_start..payload_end].to_vec(),
                        raw_bytes: self.buffer[..frame_len].to_vec(),
                    });
                }

                self.buffer.drain(..frame_len);
            }

            frames
        }
    }

    #[cfg(windows)]
    pub(crate) mod serial {
        use std::ffi::OsStr;
        use std::mem::{size_of, zeroed};
        use std::os::windows::ffi::OsStrExt;
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::Devices::Communication::{
            GetCommState, PurgeComm, SetCommState, SetCommTimeouts, COMMTIMEOUTS, DCB, NOPARITY,
            ONESTOPBIT, PURGE_RXCLEAR, PURGE_TXCLEAR,
        };
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ,
            FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };

        const BAUD_RATE: u32 = 115_200;

        pub struct SerialConnection {
            handle: SerialHandle,
        }

        struct SerialHandle(HANDLE);

        unsafe impl Send for SerialConnection {}

        impl Drop for SerialHandle {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }

        impl SerialConnection {
            pub fn open(port_name: &str) -> Result<Self, String> {
                let handle = open_port(port_name)?;
                configure_port(handle.0)?;

                unsafe {
                    PurgeComm(handle.0, PURGE_RXCLEAR | PURGE_TXCLEAR);
                }

                Ok(Self { handle })
            }

            pub fn write_all(&mut self, bytes: &[u8]) -> Result<(), String> {
                let mut total_written = 0usize;

                while total_written < bytes.len() {
                    let mut written = 0u32;
                    let write_ok = unsafe {
                        WriteFile(
                            self.handle.0,
                            bytes[total_written..].as_ptr(),
                            (bytes.len() - total_written) as u32,
                            &mut written,
                            null_mut(),
                        )
                    };

                    if write_ok == 0 {
                        return Err(format!(
                            "Could not write protocol frame: {}",
                            std::io::Error::last_os_error()
                        ));
                    }

                    if written == 0 {
                        return Err("Serial write stalled before the frame was sent.".to_string());
                    }

                    total_written += written as usize;
                }

                Ok(())
            }

            pub fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
                let mut bytes_read = 0u32;
                let read_ok = unsafe {
                    ReadFile(
                        self.handle.0,
                        buffer.as_mut_ptr(),
                        buffer.len() as u32,
                        &mut bytes_read,
                        null_mut(),
                    )
                };

                if read_ok == 0 {
                    return Err(format!(
                        "Could not read protocol response: {}",
                        std::io::Error::last_os_error()
                    ));
                }

                Ok(bytes_read as usize)
            }
        }

        fn open_port(port_name: &str) -> Result<SerialHandle, String> {
            let path = normalize_port_path(port_name);
            let wide_path = wide_null(&path);
            let handle = unsafe {
                CreateFileW(
                    wide_path.as_ptr(),
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    null_mut(),
                )
            };

            if handle == INVALID_HANDLE_VALUE {
                return Err(format!(
                    "Could not open {port_name}: {}",
                    std::io::Error::last_os_error()
                ));
            }

            Ok(SerialHandle(handle))
        }

        fn configure_port(handle: HANDLE) -> Result<(), String> {
            let mut dcb: DCB = unsafe { zeroed() };
            dcb.DCBlength = size_of::<DCB>() as u32;

            if unsafe { GetCommState(handle, &mut dcb) } == 0 {
                return Err(format!(
                    "Could not read serial settings: {}",
                    std::io::Error::last_os_error()
                ));
            }

            dcb.BaudRate = BAUD_RATE;
            dcb.ByteSize = 8;
            dcb.Parity = NOPARITY;
            dcb.StopBits = ONESTOPBIT;
            dcb._bitfield |= 1;
            dcb._bitfield &= !((1 << 1) | (1 << 8) | (1 << 9));

            if unsafe { SetCommState(handle, &dcb) } == 0 {
                return Err(format!(
                    "Could not apply serial settings: {}",
                    std::io::Error::last_os_error()
                ));
            }

            let timeouts = COMMTIMEOUTS {
                ReadIntervalTimeout: 20,
                ReadTotalTimeoutMultiplier: 0,
                ReadTotalTimeoutConstant: 80,
                WriteTotalTimeoutMultiplier: 0,
                WriteTotalTimeoutConstant: 250,
            };

            if unsafe { SetCommTimeouts(handle, &timeouts) } == 0 {
                return Err(format!(
                    "Could not apply serial timeouts: {}",
                    std::io::Error::last_os_error()
                ));
            }

            Ok(())
        }

        fn normalize_port_path(port_name: &str) -> String {
            let trimmed = port_name.trim();

            if trimmed.starts_with(r"\\.\") {
                trimmed.to_string()
            } else {
                format!(r"\\.\{trimmed}")
            }
        }

        fn wide_null(value: &str) -> Vec<u16> {
            OsStr::new(value).encode_wide().chain(Some(0)).collect()
        }
    }

    #[cfg(not(windows))]
    pub(crate) mod serial {
        pub struct SerialConnection;

        impl SerialConnection {
            pub fn open(_port_name: &str) -> Result<Self, String> {
                Err("Device control is currently implemented for Windows COM ports.".to_string())
            }

            pub fn write_all(&mut self, _bytes: &[u8]) -> Result<(), String> {
                Ok(())
            }

            pub fn read(&mut self, _buffer: &mut [u8]) -> Result<usize, String> {
                Ok(0)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{crc8, parse_encoder_frames};

    #[test]
    fn parses_encoder_monitor_frame_with_signed_scaled_rpm() {
        let raw_values = [123i16, -45, 0, 1, -1, 327, -327, 10];
        let mut frame = vec![0xA5, 0xC3, 0x7E];

        for value in raw_values {
            frame.extend_from_slice(&value.to_le_bytes());
        }

        let crc = crc8(&frame[2..19]);
        frame.push(crc);

        let mut buffer = frame;
        let result = parse_encoder_frames(&mut buffer);

        assert_eq!(result.crc_errors, 0);
        assert_eq!(result.discarded_bytes, 0);
        assert!(buffer.is_empty());
        assert_eq!(result.frames.len(), 1);
        assert_eq!(result.frames[0].0, 0x7E);
        assert_eq!(result.frames[0].1, raw_values);
    }

    #[test]
    fn rejects_encoder_monitor_frame_with_bad_crc() {
        let mut frame = vec![0xA5, 0xC3, 0x01];
        for _ in 0..8 {
            frame.extend_from_slice(&0i16.to_le_bytes());
        }
        frame.push(0xFF);

        let mut buffer = frame;
        let result = parse_encoder_frames(&mut buffer);

        assert_eq!(result.frames.len(), 0);
        assert_eq!(result.crc_errors, 1);
    }
}
