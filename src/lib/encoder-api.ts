import {
  hasTauriRuntime,
  invokeTauri,
  TAURI_UNAVAILABLE_MESSAGE,
} from "@/lib/tauri-runtime";

export const ENCODER_SAMPLE_EVENT = "encoder-monitor-sample";
export const ENCODER_STATUS_EVENT = "encoder-monitor-status";

export interface EncoderMonitorSample {
  portName: string;
  seq: number;
  rawRpm: number[];
  rpm: number[];
  receivedAtMs: number;
  missedFrames: number;
}

export interface EncoderMonitorStatus {
  portName: string;
  bytesReceived: number;
  framesReceived: number;
  crcErrors: number;
  discardedBytes: number;
  bufferedBytes: number;
  lastSeq: number | null;
  lastFrameAtMs: number | null;
  message: string;
}

export interface EncoderMonitorResult {
  ok: boolean;
  portName: string;
  message: string;
}

export interface EncoderMonitorSnapshot {
  connected: boolean;
  portName: string;
  sample: EncoderMonitorSample | null;
  status: EncoderMonitorStatus | null;
}

export function startEncoderMonitor(portName: string) {
  if (!hasTauriRuntime()) {
    return Promise.resolve<EncoderMonitorResult>({
      ok: false,
      portName,
      message: TAURI_UNAVAILABLE_MESSAGE,
    });
  }

  return invokeTauri<EncoderMonitorResult>("start_encoder_monitor", { portName });
}

export function stopEncoderMonitor() {
  if (!hasTauriRuntime()) {
    return Promise.resolve<EncoderMonitorResult>({
      ok: false,
      portName: "",
      message: TAURI_UNAVAILABLE_MESSAGE,
    });
  }

  return invokeTauri<EncoderMonitorResult>("stop_encoder_monitor");
}

export function getEncoderMonitorSnapshot() {
  if (!hasTauriRuntime()) {
    return Promise.resolve<EncoderMonitorSnapshot>({
      connected: false,
      portName: "",
      sample: null,
      status: null,
    });
  }

  return invokeTauri<EncoderMonitorSnapshot>("get_encoder_monitor_snapshot");
}
