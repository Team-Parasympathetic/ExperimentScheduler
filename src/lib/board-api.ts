import { invoke } from "@tauri-apps/api/core";
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
  return invoke<DeviceDetectionResult>("detect_backplane", { portName });
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
  return invoke<BoardCommandResult>("upload_schedule", {
    portName,
    rows,
    blocks,
  });
}

export function startBoardSchedule(portName: string) {
  return invoke<BoardCommandResult>("start_schedule", { portName });
}

export function stopBoardSchedule(portName: string) {
  return invoke<BoardCommandResult>("stop_schedule", { portName });
}

export function getBoardStatus(portName: string) {
  return invoke<BoardCommandResult>("get_status", { portName });
}
