import {
  hasTauriRuntime,
  invokeTauri,
  TAURI_UNAVAILABLE_MESSAGE,
} from "@/lib/tauri-runtime";
import type {
  BoardCommandResult,
  DeviceSlotInfo,
  SerialLogEntry,
} from "@/store/board-store";
import type { Block, Row } from "@/types/scheduler";

export interface DeviceDetectionResult {
  detected: boolean;
  message: string;
  portName: string;
  slots: DeviceSlotInfo[];
  log: SerialLogEntry[];
}

export function detectBackplane(portName: string) {
  if (!hasTauriRuntime()) {
    return Promise.resolve<DeviceDetectionResult>({
      detected: false,
      message: TAURI_UNAVAILABLE_MESSAGE,
      portName,
      slots: [],
      log: [],
    });
  }

  return invokeTauri<DeviceDetectionResult>("detect_backplane", { portName });
}

export function uploadBoardSchedule({
  blocks,
  portName,
  rows,
}: {
  blocks: Block[];
  portName: string;
  rows: Row[];
}) {
  return invokeTauri<BoardCommandResult>("upload_schedule", {
    portName,
    rows,
    blocks,
  });
}

export function startBoardSchedule(portName: string) {
  return invokeTauri<BoardCommandResult>("start_schedule", { portName });
}

export function prepareBoardSchedule(portName: string) {
  return invokeTauri<BoardCommandResult>("prepare_schedule", { portName });
}

export function stopBoardSchedule(portName: string) {
  return invokeTauri<BoardCommandResult>("stop_schedule", { portName });
}

export function getBoardStatus(portName: string) {
  return invokeTauri<BoardCommandResult>("get_status", { portName });
}
