import { create } from "zustand";
import {
  DEFAULT_EXPERIMENT_DURATION_MS,
  DEFAULT_ZOOM_PX_PER_MINUTE,
  MIN_BLOCK_DURATION_MS,
  SECOND_MS,
  getBlockEnd,
  getScheduleDuration,
} from "@/lib/time";
import {
  getNextBlockStartMs,
  getPreviousBlockEndMs,
  getSortedRowBlocks,
} from "@/lib/schedule";
import {
  FIRMWARE_SCHEDULE_LIMITS,
  getFirmwareScheduleSummary,
} from "@/lib/firmware-constraints";
import {
  getHardwareShortLabel,
  isHardwareIdInUse,
} from "@/lib/hardware-bindings";
import {
  DEFAULT_TRIGGER_DUTY_CYCLE,
  DEFAULT_TRIGGER_FREQUENCY_HZ,
  DEFAULT_TRIGGER_MODE,
  normalizeDutyCycle,
  normalizeFrequencyHz,
} from "@/lib/trigger-output";
import { clamp, createId } from "@/lib/utils";
import type {
  Block,
  DeviceType,
  ExperimentState,
  PumpRateMode,
  Row,
  TriggerMode,
} from "@/types/scheduler";

interface SchedulerState {
  rows: Row[];
  blocks: Block[];
  availablePumpHardwareIds: number[];
  selectedBlockId: string | null;
  gridSizeMs: number;
  zoomPxPerMinute: number;
  experimentDurationMs: number;
  experimentState: ExperimentState;
  playheadMs: number;
  playheadStartOffsetMs: number;
  playheadStartTimestamp: number | null;
  setSelectedBlock: (blockId: string | null) => void;
  setGridSizeMs: (gridSizeMs: number) => void;
  setZoomPxPerMinute: (zoomPxPerMinute: number) => void;
  setExperimentDurationMs: (experimentDurationMs: number) => void;
  startExperiment: () => void;
  stopExperiment: () => void;
  resetExperiment: () => void;
  syncPlayhead: (nowMs?: number) => void;
  syncDetectedPumpHardware: (
    slots: Array<{ slot: number; present: boolean; cardType: string }>,
    options?: { assignRows?: boolean },
  ) => void;
  loadSchedule: (schedule: {
    rows: Row[];
    blocks: Block[];
    gridSizeMs: number;
    zoomPxPerMinute: number;
    experimentDurationMs: number;
  }) => void;
  addRow: (deviceType?: DeviceType) => void;
  removeRow: (rowId: string) => void;
  updateRow: (rowId: string, patch: Partial<Omit<Row, "id">>) => void;
  addBlock: (rowId: string, startMs: number, durationMs?: number) => void;
  pasteBlock: (block: Block) => void;
  updateBlock: (blockId: string, patch: Partial<Omit<Block, "id">>) => void;
  deleteBlock: (blockId: string) => void;
}

const initialRows: Row[] = [
  {
    id: "row-a",
    name: "Pump 0",
    deviceType: "peristaltic",
    hardwareId: 0,
    pumpRateMode: "variable",
  },
  { id: "row-b", name: "PWM 0", deviceType: "trigger", hardwareId: null },
];

const initialBlocks: Block[] = [
  {
    id: "blk-1",
    rowId: "row-a",
    startMs: 1_000,
    durationMs: 2 * SECOND_MS,
    direction: "forward",
    flowRate: 400,
  },
  {
    id: "blk-2",
    rowId: "row-b",
    startMs: 4_500,
    durationMs: 2_500,
    direction: "forward",
    flowRate: 400,
    triggerMode: DEFAULT_TRIGGER_MODE,
    frequencyHz: DEFAULT_TRIGGER_FREQUENCY_HZ,
    dutyCycle: DEFAULT_TRIGGER_DUTY_CYCLE,
  },
];

function getNextRowName(rows: Row[], deviceType: DeviceType) {
  const typeIndex = rows.filter((row) => row.deviceType === deviceType).length;

  if (deviceType === "trigger") {
    return `Trigger ${typeIndex}`;
  }

  return `Pump ${typeIndex}`;
}

function normalizeFlowRate(flowRate: number) {
  if (Number.isNaN(flowRate) || !Number.isFinite(flowRate)) {
    return 0;
  }

  return Math.max(0, Number(flowRate.toFixed(2)));
}

function normalizePumpRateMode(pumpRateMode: PumpRateMode | undefined): PumpRateMode {
  return pumpRateMode === "fixed" ? "fixed" : "variable";
}

function normalizeLoadedRows(rows: Row[]): Row[] {
  return rows.map((row) =>
    row.deviceType === "peristaltic"
      ? {
          ...row,
          pumpRateMode: normalizePumpRateMode(row.pumpRateMode),
          isScheduleStatus: false,
        }
      : {
          ...row,
          pumpRateMode: undefined,
        },
  );
}

function normalizeTimeValue(value: number | undefined, fallback: number, minimum: number) {
  if (value === undefined || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(minimum, Math.round(value));
}

function isWithinEditableScheduleLimits(blocks: Block[], rows: Row[]) {
  const summary = getFirmwareScheduleSummary(blocks, rows);

  return (
    summary.rowsWithinLimit &&
    summary.eventsWithinLimit &&
    summary.actionBytesWithinLimit &&
    summary.gpioActionsWithinLimit &&
    summary.scheduleStatusRowsEmpty &&
    summary.spacingWithinLimit &&
    summary.hardwareAssignmentsUnique
  );
}

function getMaxRowsForDeviceType(deviceType: DeviceType) {
  if (deviceType === "trigger") {
    return FIRMWARE_SCHEDULE_LIMITS.maxGpioOutputs;
  }

  return FIRMWARE_SCHEDULE_LIMITS.maxPumps;
}

function canAddRow(rows: Row[], deviceType: DeviceType) {
  const currentTypeCount = rows.filter((row) => row.deviceType === deviceType).length;
  return currentTypeCount < getMaxRowsForDeviceType(deviceType);
}

function normalizeHardwareId(hardwareId: number | null | undefined) {
  if (hardwareId === null || hardwareId === undefined) {
    return null;
  }

  if (!Number.isFinite(hardwareId)) {
    return null;
  }

  return Math.max(0, Math.round(hardwareId));
}

function getDetectedPumpHardwareIds(
  slots: Array<{ slot: number; present: boolean; cardType: string }>,
) {
  return slots
    .filter((slot) => slot.present && slot.cardType === "pump")
    .flatMap((slot) =>
      Array.from({ length: 8 }, (_, localPump) => slot.slot * 8 + localPump),
    )
    .filter(
      (pumpId) =>
        Number.isInteger(pumpId) &&
        pumpId >= 0 &&
        pumpId < FIRMWARE_SCHEDULE_LIMITS.maxPumps,
    )
    .sort((left, right) => left - right);
}

function getNextPumpHardwareId(
  rows: Row[],
  ignoredRowId?: string,
  availablePumpHardwareIds: number[] = [],
) {
  const usedPumpIds = new Set(
    rows
      .filter(
        (row) =>
          row.id !== ignoredRowId &&
          row.deviceType === "peristaltic" &&
          row.hardwareId !== null &&
          row.hardwareId !== undefined,
      )
      .map((row) => row.hardwareId as number),
  );

  if (availablePumpHardwareIds.length > 0) {
    return availablePumpHardwareIds.find((pumpId) => !usedPumpIds.has(pumpId)) ?? null;
  }

  const maxUsedPumpId = Math.max(-1, ...Array.from(usedPumpIds));
  const nextSequentialPumpId = maxUsedPumpId + 1;

  if (nextSequentialPumpId < FIRMWARE_SCHEDULE_LIMITS.maxPumps) {
    return nextSequentialPumpId;
  }

  for (let pumpId = 0; pumpId < FIRMWARE_SCHEDULE_LIMITS.maxPumps; pumpId++) {
    if (!usedPumpIds.has(pumpId)) {
      return pumpId;
    }
  }

  return null;
}

function assignPumpRowsByDetectedHardware(rows: Row[], availablePumpHardwareIds: number[]) {
  if (availablePumpHardwareIds.length === 0) {
    return rows.map((row) =>
      row.deviceType === "peristaltic" ? { ...row, hardwareId: null } : row,
    );
  }

  let pumpRowIndex = 0;

  return rows.map((row) => {
    if (row.deviceType !== "peristaltic") {
      return row;
    }

    const hardwareId = availablePumpHardwareIds[pumpRowIndex] ?? null;
    pumpRowIndex += 1;

    return {
      ...row,
      hardwareId,
      name:
        hardwareId !== null && !row.nameEdited
          ? getHardwareShortLabel("peristaltic", hardwareId)
          : row.name,
    };
  });
}

function normalizeTriggerMode(triggerMode: TriggerMode | undefined): TriggerMode {
  return triggerMode === "rising" ||
    triggerMode === "falling" ||
    triggerMode === "waveform"
    ? triggerMode
    : DEFAULT_TRIGGER_MODE;
}

function createDefaultBlock(row: Row, startMs: number, durationMs: number): Block {
  const block: Block = {
    id: createId("block"),
    rowId: row.id,
    startMs,
    durationMs: Math.max(MIN_BLOCK_DURATION_MS, durationMs),
    direction: "forward",
    flowRate: 400,
  };

  if (row.deviceType === "trigger") {
    return {
      ...block,
      triggerMode: DEFAULT_TRIGGER_MODE,
      frequencyHz: DEFAULT_TRIGGER_FREQUENCY_HZ,
      dutyCycle: DEFAULT_TRIGGER_DUTY_CYCLE,
    };
  }

  return block;
}

function findClosestAvailableStartMs({
  blocks,
  rowId,
  ignoredBlockId,
  desiredStartMs,
  durationMs,
  maxStartMs,
  snapThresholdMs,
}: {
  blocks: Block[];
  rowId: string;
  ignoredBlockId?: string;
  desiredStartMs: number;
  durationMs: number;
  maxStartMs: number;
  snapThresholdMs: number;
}) {
  const clampedMaxStartMs = Math.max(0, maxStartMs);
  const targetStartMs = clamp(desiredStartMs, 0, clampedMaxStartMs);
  const rowBlocks = getSortedRowBlocks(blocks, rowId, ignoredBlockId);
  const availableIntervals: Array<{ startMs: number; endMs: number }> = [];

  let cursorMs = 0;

  for (const rowBlock of rowBlocks) {
    const intervalEndMs = Math.min(clampedMaxStartMs, rowBlock.startMs - durationMs);

    if (cursorMs <= intervalEndMs) {
      availableIntervals.push({ startMs: cursorMs, endMs: intervalEndMs });
    }

    cursorMs = Math.max(cursorMs, getBlockEnd(rowBlock));

    if (cursorMs > clampedMaxStartMs) {
      break;
    }
  }

  if (cursorMs <= clampedMaxStartMs) {
    availableIntervals.push({ startMs: cursorMs, endMs: clampedMaxStartMs });
  }

  if (availableIntervals.length === 0) {
    return targetStartMs;
  }

  let bestStartMs = availableIntervals[0].startMs;
  let bestDistance = Math.abs(bestStartMs - targetStartMs);

  for (const interval of availableIntervals) {
    const candidateStartMs = clamp(targetStartMs, interval.startMs, interval.endMs);
    const snapCandidateMs =
      interval.startMs > 0 &&
      Math.abs(candidateStartMs - interval.startMs) <= snapThresholdMs
        ? interval.startMs
        : candidateStartMs;
    const candidateDistance = Math.abs(snapCandidateMs - targetStartMs);

    if (
      candidateDistance < bestDistance ||
      (candidateDistance === bestDistance && snapCandidateMs < bestStartMs)
    ) {
      bestStartMs = snapCandidateMs;
      bestDistance = candidateDistance;
    }
  }

  return bestStartMs;
}

function findAvailableStartMs({
  blocks,
  rowId,
  desiredStartMs,
  durationMs,
  maxStartMs,
}: {
  blocks: Block[];
  rowId: string;
  desiredStartMs: number;
  durationMs: number;
  maxStartMs: number;
}) {
  const clampedMaxStartMs = Math.max(0, maxStartMs);
  const targetStartMs = clamp(desiredStartMs, 0, clampedMaxStartMs);
  const rowBlocks = getSortedRowBlocks(blocks, rowId);
  const availableIntervals: Array<{ startMs: number; endMs: number }> = [];
  let cursorMs = 0;

  for (const rowBlock of rowBlocks) {
    const intervalEndMs = Math.min(clampedMaxStartMs, rowBlock.startMs - durationMs);

    if (cursorMs <= intervalEndMs) {
      availableIntervals.push({ startMs: cursorMs, endMs: intervalEndMs });
    }

    cursorMs = Math.max(cursorMs, getBlockEnd(rowBlock));

    if (cursorMs > clampedMaxStartMs) {
      break;
    }
  }

  if (cursorMs <= clampedMaxStartMs) {
    availableIntervals.push({ startMs: cursorMs, endMs: clampedMaxStartMs });
  }

  if (availableIntervals.length === 0) {
    return null;
  }

  let bestStartMs = availableIntervals[0].startMs;
  let bestDistance = Math.abs(bestStartMs - targetStartMs);

  for (const interval of availableIntervals) {
    const candidateStartMs = clamp(targetStartMs, interval.startMs, interval.endMs);
    const candidateDistance = Math.abs(candidateStartMs - targetStartMs);

    if (
      candidateDistance < bestDistance ||
      (candidateDistance === bestDistance && candidateStartMs < bestStartMs)
    ) {
      bestStartMs = candidateStartMs;
      bestDistance = candidateDistance;
    }
  }

  return bestStartMs;
}

function clampDurationWithinRow({
  blocks,
  rowId,
  ignoredBlockId,
  startMs,
  desiredDurationMs,
}: {
  blocks: Block[];
  rowId: string;
  ignoredBlockId: string;
  startMs: number;
  desiredDurationMs: number;
}) {
  const nextBlockStartMs = getNextBlockStartMs(blocks, rowId, ignoredBlockId, startMs);

  if (nextBlockStartMs === null) {
    return Math.max(MIN_BLOCK_DURATION_MS, desiredDurationMs);
  }

  const maxDurationMs = nextBlockStartMs - startMs;

  if (maxDurationMs < MIN_BLOCK_DURATION_MS) {
    return MIN_BLOCK_DURATION_MS;
  }

  return clamp(desiredDurationMs, MIN_BLOCK_DURATION_MS, maxDurationMs);
}

function getCurrentPlayheadMs(
  state: Pick<
    SchedulerState,
    "playheadMs" | "playheadStartOffsetMs" | "playheadStartTimestamp" | "experimentDurationMs"
  >,
  nowMs = Date.now(),
) {
  if (state.playheadStartTimestamp === null) {
    return clamp(state.playheadMs, 0, state.experimentDurationMs);
  }

  return clamp(
    state.playheadStartOffsetMs + (nowMs - state.playheadStartTimestamp),
    0,
    state.experimentDurationMs,
  );
}

function getPlayheadSnapshot(
  state: Pick<
    SchedulerState,
    | "experimentState"
    | "playheadMs"
    | "playheadStartOffsetMs"
    | "playheadStartTimestamp"
    | "experimentDurationMs"
  >,
  nextExperimentDurationMs = state.experimentDurationMs,
  nowMs = Date.now(),
): Pick<
  SchedulerState,
  "experimentState" | "playheadMs" | "playheadStartOffsetMs" | "playheadStartTimestamp"
> {
  const nextPlayheadMs = clamp(getCurrentPlayheadMs(state, nowMs), 0, nextExperimentDurationMs);
  const shouldKeepRunning =
    state.experimentState === "running" && nextPlayheadMs < nextExperimentDurationMs;

  return {
    experimentState: shouldKeepRunning ? "running" : "idle",
    playheadMs: nextPlayheadMs,
    playheadStartOffsetMs: nextPlayheadMs,
    playheadStartTimestamp: shouldKeepRunning ? nowMs : null,
  };
}

const initialExperimentDurationMs = getScheduleDuration(
  initialBlocks,
  DEFAULT_EXPERIMENT_DURATION_MS,
);

export const useSchedulerStore = create<SchedulerState>((set) => ({
  rows: initialRows,
  blocks: initialBlocks,
  availablePumpHardwareIds: [],
  selectedBlockId: initialBlocks[0]?.id ?? null,
  gridSizeMs: 500,
  zoomPxPerMinute: DEFAULT_ZOOM_PX_PER_MINUTE,
  experimentDurationMs: initialExperimentDurationMs,
  experimentState: "idle",
  playheadMs: 0,
  playheadStartOffsetMs: 0,
  playheadStartTimestamp: null,
  setSelectedBlock: (selectedBlockId) => set({ selectedBlockId }),
  setGridSizeMs: (gridSizeMs) =>
    set({
      gridSizeMs: Math.max(
        FIRMWARE_SCHEDULE_LIMITS.minEventSpacingMs,
        Math.round(gridSizeMs),
      ),
    }),
  setZoomPxPerMinute: (zoomPxPerMinute) => set({ zoomPxPerMinute }),
  setExperimentDurationMs: (experimentDurationMs) =>
    set((state) => {
      const nowMs = Date.now();
      const nextExperimentDurationMs = getScheduleDuration(state.blocks, experimentDurationMs);

      return {
        experimentDurationMs: nextExperimentDurationMs,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      };
    }),
  startExperiment: () =>
    set((state) => {
      if (state.experimentState === "running") {
        return state;
      }

      const nowMs = Date.now();
      const nextPlayheadMs =
        state.playheadMs >= state.experimentDurationMs
          ? 0
          : clamp(state.playheadMs, 0, state.experimentDurationMs);

      return {
        experimentState: "running",
        playheadMs: nextPlayheadMs,
        playheadStartOffsetMs: nextPlayheadMs,
        playheadStartTimestamp: nowMs,
      };
    }),
  stopExperiment: () =>
    set((state) => {
      if (state.experimentState !== "running") {
        return state;
      }

      const nextPlayheadMs = getCurrentPlayheadMs(state);
      return {
        experimentState: "idle",
        playheadMs: nextPlayheadMs,
        playheadStartOffsetMs: nextPlayheadMs,
        playheadStartTimestamp: null,
      };
    }),
  resetExperiment: () =>
    set({
      experimentState: "idle",
      playheadMs: 0,
      playheadStartOffsetMs: 0,
      playheadStartTimestamp: null,
    }),
  syncPlayhead: (nowMs = Date.now()) =>
    set((state) => {
      if (state.experimentState !== "running") {
        return state;
      }

      const nextPlayheadMs = getCurrentPlayheadMs(state, nowMs);

      if (nextPlayheadMs >= state.experimentDurationMs) {
        return {
          experimentState: "idle",
          playheadMs: state.experimentDurationMs,
          playheadStartOffsetMs: state.experimentDurationMs,
          playheadStartTimestamp: null,
        };
      }

      if (nextPlayheadMs === state.playheadMs) {
        return state;
      }

      return {
        playheadMs: nextPlayheadMs,
      };
    }),
  syncDetectedPumpHardware: (slots, options = {}) =>
    set((state) => {
      const availablePumpHardwareIds = getDetectedPumpHardwareIds(slots);

      if (!options.assignRows) {
        return { availablePumpHardwareIds };
      }

      return {
        availablePumpHardwareIds,
        rows: assignPumpRowsByDetectedHardware(state.rows, availablePumpHardwareIds),
      };
    }),
  loadSchedule: (schedule) =>
    set((state) => {
      const nextExperimentDurationMs = getScheduleDuration(
        schedule.blocks,
        schedule.experimentDurationMs,
      );

      return {
        rows: normalizeLoadedRows(schedule.rows),
        blocks: schedule.blocks,
        gridSizeMs: Math.max(
          FIRMWARE_SCHEDULE_LIMITS.minEventSpacingMs,
          Math.round(schedule.gridSizeMs),
        ),
        zoomPxPerMinute: schedule.zoomPxPerMinute,
        experimentDurationMs: nextExperimentDurationMs,
        selectedBlockId: schedule.blocks[0]?.id ?? null,
        experimentState: "idle",
        playheadMs: 0,
        playheadStartOffsetMs: 0,
        playheadStartTimestamp: null,
        availablePumpHardwareIds: state.availablePumpHardwareIds,
      };
    }),
  addRow: (deviceType = "peristaltic") =>
    set((state) => {
      if (!canAddRow(state.rows, deviceType)) {
        return state;
      }

      const hardwareId =
        deviceType === "peristaltic"
          ? getNextPumpHardwareId(
              state.rows,
              undefined,
              state.availablePumpHardwareIds,
            )
          : null;

      return {
        rows: [
          ...state.rows,
          {
            id: createId("row"),
            name:
              deviceType === "peristaltic" && hardwareId !== null
                ? getHardwareShortLabel(deviceType, hardwareId)
                : getNextRowName(state.rows, deviceType),
            deviceType,
            hardwareId,
            pumpRateMode: deviceType === "peristaltic" ? "variable" : undefined,
          },
        ],
      };
    }),
  removeRow: (rowId) =>
    set((state) => {
      const remainingRows = state.rows.filter((row) => row.id !== rowId);

      if (remainingRows.length === 0) {
        return state;
      }

      const remainingBlocks = state.blocks.filter((block) => block.rowId !== rowId);
      const nextSelected = remainingBlocks.some((block) => block.id === state.selectedBlockId)
        ? state.selectedBlockId
        : remainingBlocks[0]?.id ?? null;
      const nextExperimentDurationMs = getScheduleDuration(
        remainingBlocks,
        state.experimentDurationMs,
      );
      const nowMs = Date.now();

      return {
        rows: remainingRows,
        blocks: remainingBlocks,
        selectedBlockId: nextSelected,
        experimentDurationMs: nextExperimentDurationMs,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      };
    }),
  updateRow: (rowId, patch) =>
    set((state) => {
      const currentRow = state.rows.find((row) => row.id === rowId);
      const nextDeviceType = patch.deviceType ?? currentRow?.deviceType;
      const deviceTypeChanged =
        currentRow &&
        nextDeviceType &&
        nextDeviceType !== currentRow.deviceType;
      const requestedHardwareId =
        patch.hardwareId !== undefined
          ? normalizeHardwareId(patch.hardwareId)
          : deviceTypeChanged && nextDeviceType === "peristaltic"
          ? getNextPumpHardwareId(state.rows, rowId, state.availablePumpHardwareIds)
          : deviceTypeChanged
          ? null
          : currentRow?.hardwareId ?? null;
      const requestedScheduleStatus =
        nextDeviceType === "trigger"
          ? patch.isScheduleStatus ?? currentRow?.isScheduleStatus ?? false
          : false;
      const requestedPumpRateMode =
        nextDeviceType === "peristaltic"
          ? normalizePumpRateMode(patch.pumpRateMode ?? currentRow?.pumpRateMode)
          : undefined;

      if (
        currentRow &&
        nextDeviceType &&
        deviceTypeChanged &&
        !canAddRow(
          state.rows.filter((row) => row.id !== rowId),
          nextDeviceType,
        )
      ) {
        return state;
      }

      if (
        currentRow &&
        nextDeviceType &&
        requestedHardwareId !== null &&
        isHardwareIdInUse(state.rows, nextDeviceType, requestedHardwareId, rowId)
      ) {
        return state;
      }

      const nextRows = state.rows.map((row) => {
        if (row.id !== rowId && requestedScheduleStatus) {
          return {
            ...row,
            isScheduleStatus: false,
          };
        }

        if (row.id !== rowId) {
          return row;
        }

        const nameEdited = patch.name !== undefined ? true : row.nameEdited;
        const nextRow: Row = {
          ...row,
          ...patch,
          deviceType: nextDeviceType ?? row.deviceType,
          hardwareId: requestedHardwareId,
          pumpRateMode: requestedPumpRateMode,
          nameEdited,
          isScheduleStatus: requestedScheduleStatus,
        };

        if (deviceTypeChanged && patch.name === undefined) {
          nextRow.name =
            nextRow.deviceType === "peristaltic" && requestedHardwareId !== null
              ? getHardwareShortLabel(nextRow.deviceType, requestedHardwareId)
              : getNextRowName(
                  state.rows.filter((candidate) => candidate.id !== rowId),
                  nextRow.deviceType,
                );
          nextRow.nameEdited = false;
        }

        if (
          patch.hardwareId !== undefined &&
          requestedHardwareId !== null &&
          patch.name === undefined &&
          !row.nameEdited
        ) {
          nextRow.name = getHardwareShortLabel(nextRow.deviceType, requestedHardwareId);
        }

        return nextRow;
      });
      const nextBlocks = requestedScheduleStatus
        ? state.blocks.filter((block) => block.rowId !== rowId)
        : state.blocks;

      if (!isWithinEditableScheduleLimits(nextBlocks, nextRows)) {
        return state;
      }

      const nextSelected = nextBlocks.some((block) => block.id === state.selectedBlockId)
        ? state.selectedBlockId
        : nextBlocks[0]?.id ?? null;
      const nextExperimentDurationMs = getScheduleDuration(
        nextBlocks,
        state.experimentDurationMs,
      );
      const nowMs = Date.now();

      return {
        rows: nextRows,
        blocks: nextBlocks,
        selectedBlockId: nextSelected,
        experimentDurationMs: nextExperimentDurationMs,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      };
    }),
  addBlock: (rowId, startMs, durationMs = 2 * SECOND_MS) =>
    set((state) => {
      const row = state.rows.find((item) => item.id === rowId);

      if (!row || row.isScheduleStatus) {
        return state;
      }

      const rowBlocks = getSortedRowBlocks(state.blocks, rowId);
      const lastBlock = rowBlocks[rowBlocks.length - 1];
      const newBlock = createDefaultBlock(
        row,
        lastBlock ? getBlockEnd(lastBlock) : Math.max(0, startMs),
        durationMs,
      );
      const nextBlocks = [...state.blocks, newBlock];

      if (!isWithinEditableScheduleLimits(nextBlocks, state.rows)) {
        return state;
      }

      const nextExperimentDurationMs = getScheduleDuration(
        nextBlocks,
        state.experimentDurationMs,
      );
      const nowMs = Date.now();

      return {
        blocks: nextBlocks,
        selectedBlockId: newBlock.id,
        experimentDurationMs: nextExperimentDurationMs,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      };
    }),
  pasteBlock: (block) =>
    set((state) => {
      const row = state.rows.find((item) => item.id === block.rowId);

      if (!row || row.isScheduleStatus) {
        return state;
      }

      const durationMs = Math.max(MIN_BLOCK_DURATION_MS, Math.round(block.durationMs));
      const maxStartMs = Math.max(0, state.experimentDurationMs - durationMs);
      const startMs = findAvailableStartMs({
        blocks: state.blocks,
        rowId: block.rowId,
        desiredStartMs: getBlockEnd(block),
        durationMs,
        maxStartMs,
      });

      if (startMs === null) {
        return state;
      }

      const newBlock: Block = {
        ...block,
        id: createId("block"),
        startMs,
        durationMs,
      };
      const nextBlocks = [...state.blocks, newBlock];

      if (!isWithinEditableScheduleLimits(nextBlocks, state.rows)) {
        return state;
      }

      const nextExperimentDurationMs = getScheduleDuration(
        nextBlocks,
        state.experimentDurationMs,
      );
      const nowMs = Date.now();

      return {
        blocks: nextBlocks,
        selectedBlockId: newBlock.id,
        experimentDurationMs: nextExperimentDurationMs,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      };
    }),
  updateBlock: (blockId, patch) =>
    set((state) => {
      const nextBlocks = state.blocks.map((block) => {
        if (block.id !== blockId) {
          return block;
        }

        const patchRow =
          patch.rowId !== undefined
            ? state.rows.find((row) => row.id === patch.rowId) ?? null
            : null;
        const requestedRowId =
          patchRow && !patchRow.isScheduleStatus ? patchRow.id : block.rowId;
        const requestedRow = state.rows.find((row) => row.id === requestedRowId);
        const requestedStartMs = normalizeTimeValue(patch.startMs, block.startMs, 0);
        const requestedDurationMs = normalizeTimeValue(
          patch.durationMs,
          block.durationMs,
          MIN_BLOCK_DURATION_MS,
        );
        const rowChanged = requestedRowId !== block.rowId;
        const startChanged = patch.startMs !== undefined;
        const durationChanged = patch.durationMs !== undefined;
        const maxStartMs = Math.max(
          0,
          requestedStartMs,
          state.experimentDurationMs - requestedDurationMs,
        );

        let nextStartMs = block.startMs;
        let nextDurationMs = block.durationMs;

        if (startChanged && durationChanged && !rowChanged) {
          const blockEndMs = getBlockEnd(block);
          const previousEndMs = getPreviousBlockEndMs(
            state.blocks,
            requestedRowId,
            block.id,
            blockEndMs,
          );

          const maxStartForMinimumDurationMs = blockEndMs - MIN_BLOCK_DURATION_MS;
          const clampedStartMs =
            previousEndMs <= maxStartForMinimumDurationMs
              ? clamp(requestedStartMs, previousEndMs, maxStartForMinimumDurationMs)
              : maxStartForMinimumDurationMs;
          nextStartMs =
            Math.abs(clampedStartMs - previousEndMs) <= state.gridSizeMs / 2
              ? previousEndMs
              : clampedStartMs;
          nextDurationMs = blockEndMs - nextStartMs;
        } else if (durationChanged && !startChanged && !rowChanged) {
          nextStartMs = block.startMs;
          nextDurationMs = clampDurationWithinRow({
            blocks: state.blocks,
            rowId: requestedRowId,
            ignoredBlockId: block.id,
            startMs: nextStartMs,
            desiredDurationMs: requestedDurationMs,
          });
        } else {
          nextDurationMs = requestedDurationMs;
          nextStartMs = findClosestAvailableStartMs({
            blocks: state.blocks,
            rowId: requestedRowId,
            ignoredBlockId: block.id,
            desiredStartMs: requestedStartMs,
            durationMs: nextDurationMs,
            maxStartMs,
            snapThresholdMs: state.gridSizeMs / 2,
          });
        }

        const isTriggerBlock = requestedRow?.deviceType === "trigger";

        return {
          ...block,
          ...patch,
          rowId: requestedRowId,
          startMs: nextStartMs,
          durationMs: nextDurationMs,
          flowRate:
            patch.flowRate === undefined
              ? block.flowRate
              : normalizeFlowRate(patch.flowRate),
          triggerMode: isTriggerBlock
            ? normalizeTriggerMode(patch.triggerMode ?? block.triggerMode)
            : block.triggerMode,
          frequencyHz: isTriggerBlock
            ? normalizeFrequencyHz(
                patch.frequencyHz ?? block.frequencyHz ?? DEFAULT_TRIGGER_FREQUENCY_HZ,
              )
            : block.frequencyHz,
          dutyCycle: isTriggerBlock
            ? normalizeDutyCycle(patch.dutyCycle ?? block.dutyCycle ?? DEFAULT_TRIGGER_DUTY_CYCLE)
            : block.dutyCycle,
        };
      });
      const nextExperimentDurationMs = getScheduleDuration(
        nextBlocks,
        state.experimentDurationMs,
      );
      const nowMs = Date.now();

      if (!isWithinEditableScheduleLimits(nextBlocks, state.rows)) {
        return state;
      }

      return {
        blocks: nextBlocks,
        experimentDurationMs: nextExperimentDurationMs,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      };
    }),
  deleteBlock: (blockId) =>
    set((state) => {
      const remainingBlocks = state.blocks.filter((block) => block.id !== blockId);
      const nextExperimentDurationMs = getScheduleDuration(
        remainingBlocks,
        state.experimentDurationMs,
      );
      const nowMs = Date.now();
      return {
        blocks: remainingBlocks,
        experimentDurationMs: nextExperimentDurationMs,
        selectedBlockId:
          state.selectedBlockId === blockId ? remainingBlocks[0]?.id ?? null : state.selectedBlockId,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      };
    }),
}));
