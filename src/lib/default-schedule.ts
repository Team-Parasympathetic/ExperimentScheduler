import type { Block, Row } from "@/types/scheduler";

export const DEFAULT_SCHEDULE_FILE_NAME = "Default.json";

export const DEFAULT_SCHEDULE_ROWS: Row[] = [
  {
    id: "row-a",
    name: "KVO",
    deviceType: "peristaltic",
    hardwareId: 34,
    pumpRateMode: "variable",
    nameEdited: true,
    isScheduleStatus: false,
  },
  {
    id: "row-md981w",
    name: "PBG",
    deviceType: "peristaltic",
    hardwareId: 33,
    pumpRateMode: "fixed",
    nameEdited: true,
    isScheduleStatus: false,
  },
  {
    id: "row-0s02pq",
    name: "Capsaicin",
    deviceType: "peristaltic",
    hardwareId: 32,
    pumpRateMode: "fixed",
    nameEdited: true,
    isScheduleStatus: false,
  },
  {
    id: "row-ip5mf5",
    name: "Volume",
    deviceType: "peristaltic",
    hardwareId: 35,
    pumpRateMode: "variable",
    nameEdited: true,
    isScheduleStatus: false,
  },
  {
    id: "row-nfnlp7",
    name: "Camera",
    deviceType: "trigger",
    hardwareId: 16,
    nameEdited: true,
    isScheduleStatus: false,
  },
  {
    id: "row-ehq5j9",
    name: "Stimulator",
    deviceType: "trigger",
    hardwareId: 1,
    nameEdited: true,
    isScheduleStatus: false,
  },
  {
    id: "row-qghgc9",
    name: "LED",
    deviceType: "trigger",
    hardwareId: 2,
    nameEdited: true,
    isScheduleStatus: false,
  },
  {
    id: "row-hyl5oj",
    name: "Status",
    deviceType: "trigger",
    hardwareId: 0,
    nameEdited: true,
    isScheduleStatus: true,
  },
];

export const DEFAULT_SCHEDULE_BLOCKS: Block[] = [];

export const DEFAULT_SCHEDULE_FILE = {
  kind: "experimentSchedule" as const,
  schemaVersion: 1 as const,
  savedAt: "2026-06-10T15:44:45.069Z",
  rows: DEFAULT_SCHEDULE_ROWS,
  blocks: DEFAULT_SCHEDULE_BLOCKS,
  gridSizeMs: 500,
  zoomPxPerMinute: 1200,
  experimentDurationMs: 960_000,
  lastCalibrationFileName: "Test_Calibration.json",
};
