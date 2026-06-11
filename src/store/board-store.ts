import { create } from "zustand";

export type ScheduleCommand = "upload" | "start" | "stop";
export type SlotCardType = "empty" | "pump" | "timing" | "unknown";

export interface DeviceSlotInfo {
  slot: number;
  present: boolean;
  cardType: SlotCardType;
  rawCardType: number;
  firmwareMajor: number;
  firmwareMinor: number;
  capabilities: number;
  maxLocalEvents: number;
}

export interface SerialLogEntry {
  direction: "tx" | "rx" | "info";
  label: string;
  seq: number;
  msgType: number;
  bytes: string;
  detail: string;
}

export interface BoardStatus {
  state: string;
  stateCode: number;
  lastError: number;
  eventCount: number;
  lastEventId: number;
  currentTimeUs: number;
}

export interface BoardCommandResult {
  ok: boolean;
  message: string;
  status: BoardStatus | null;
  log: SerialLogEntry[];
}

interface BoardState {
  comPort: string;
  detectedSlots: DeviceSlotInfo[];
  scheduleCommandState: ScheduleCommand | null;
  isCalibrationRunning: boolean;
  scheduleMessage: string;
  serialLog: string[];
  appendSerialLog: (entries: SerialLogEntry[], header?: string) => void;
  clearSerialLog: () => void;
  setComPort: (comPort: string) => void;
  setDetectedSlots: (slots: DeviceSlotInfo[]) => void;
  setScheduleCommandState: (commandState: ScheduleCommand | null) => void;
  setCalibrationRunning: (isCalibrationRunning: boolean) => void;
  setScheduleMessage: (message: string) => void;
}

const COM_PORT_STORAGE_KEY = "experiment-scheduler:last-com-port";
const DEFAULT_COM_PORT = "COM7";

function getStoredComPort() {
  if (typeof window === "undefined") {
    return DEFAULT_COM_PORT;
  }

  try {
    return window.localStorage.getItem(COM_PORT_STORAGE_KEY) || DEFAULT_COM_PORT;
  } catch {
    return DEFAULT_COM_PORT;
  }
}

function storeComPort(comPort: string) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(COM_PORT_STORAGE_KEY, comPort);
  } catch {
    // Ignore storage failures; the in-memory value still updates.
  }
}

function formatHex(value: number, width: number) {
  return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}

export function formatSerialLogEntry(entry: SerialLogEntry) {
  if (entry.direction === "info") {
    return `INFO ${entry.label} ${entry.detail}`;
  }

  const direction = entry.direction.toUpperCase();
  return `${direction} ${entry.label} seq=${entry.seq} type=${formatHex(entry.msgType, 2)} ${entry.detail} :: ${entry.bytes}`;
}

export const useBoardStore = create<BoardState>((set) => ({
  comPort: getStoredComPort(),
  detectedSlots: [],
  scheduleCommandState: null,
  isCalibrationRunning: false,
  scheduleMessage: "",
  serialLog: [],
  appendSerialLog: (entries, header) =>
    set((state) => {
      const formattedEntries = entries.map(formatSerialLogEntry);
      const nextEntries = header
        ? [...state.serialLog, header, ...formattedEntries]
        : [...state.serialLog, ...formattedEntries];

      return {
        serialLog: nextEntries.slice(-180),
      };
    }),
  clearSerialLog: () => set({ serialLog: [] }),
  setComPort: (comPort) => {
    storeComPort(comPort);
    set({ comPort });
  },
  setDetectedSlots: (detectedSlots) => set({ detectedSlots }),
  setScheduleCommandState: (scheduleCommandState) => set({ scheduleCommandState }),
  setCalibrationRunning: (isCalibrationRunning) => set({ isCalibrationRunning }),
  setScheduleMessage: (scheduleMessage) => set({ scheduleMessage }),
}));
