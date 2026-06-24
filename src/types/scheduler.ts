export type DeviceType = "peristaltic" | "trigger";
export type Direction = "forward" | "reverse";
export type ExperimentState = "idle" | "running";
export type PumpRateMode = "variable" | "fixed";
export type TriggerMode = "pulse" | "waveform" | "sync-division";

export interface Row {
  id: string;
  name: string;
  deviceType: DeviceType;
  hardwareId?: number | null;
  pumpRateMode?: PumpRateMode;
  nameEdited?: boolean;
  isScheduleStatus?: boolean;
}

export interface PumpModelSlot {
  id: string;
  rowId: string;
  encoderChannel: number;
  x: number;
  y: number;
  z: number;
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
  requireCompletePeriods?: boolean;
  completePeriodTargetDurationMs?: number;
  syncSourceBlockId?: string | null;
  periodMultiplier?: number;
}
