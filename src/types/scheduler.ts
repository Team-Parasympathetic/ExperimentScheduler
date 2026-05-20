export type DeviceType = "peristaltic" | "trigger";
export type Direction = "forward" | "reverse";
export type ExperimentState = "idle" | "running";
export type PumpRateMode = "variable" | "fixed";
export type TriggerMode = "rising" | "falling" | "waveform";

export interface Row {
  id: string;
  name: string;
  deviceType: DeviceType;
  hardwareId?: number | null;
  pumpRateMode?: PumpRateMode;
  nameEdited?: boolean;
  isScheduleStatus?: boolean;
}

export interface Block {
  id: string;
  rowId: string;
  startMs: number;
  durationMs: number;
  direction: Direction;
  flowRate: number;
  triggerMode?: TriggerMode;
  frequencyHz?: number;
  dutyCycle?: number;
}
