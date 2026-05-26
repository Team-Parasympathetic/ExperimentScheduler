import { create } from "zustand";
import {
  DEFAULT_EXPERIMENT_DURATION_MS,
  DEFAULT_ZOOM_PX_PER_MINUTE,
  MAX_ZOOM_PX_PER_MINUTE,
  MIN_BLOCK_DURATION_MS,
  MIN_ZOOM_PX_PER_MINUTE,
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

interface SchedulerHistorySnapshot {
  rows: Row[];
  blocks: Block[];
  selectedBlockId: string | null;
  selectedBlockIds: string[];
  selectionAnchorBlockId: string | null;
  selectedRowId: string | null;
  pasteTargetStartMs: number | null;
  gridSizeMs: number;
  zoomPxPerMinute: number;
  experimentDurationMs: number;
}

interface MutationOptions {
  recordHistory?: boolean;
}

interface BlockMoveUpdate {
  blockId: string;
  rowId: string;
  startMs: number;
}

interface SchedulerState {
  rows: Row[];
  blocks: Block[];
  availablePumpHardwareIds: number[];
  past: SchedulerHistorySnapshot[];
  future: SchedulerHistorySnapshot[];
  pendingHistorySnapshot: SchedulerHistorySnapshot | null;
  selectedBlockId: string | null;
  selectedBlockIds: string[];
  selectionAnchorBlockId: string | null;
  selectedRowId: string | null;
  pasteTargetStartMs: number | null;
  gridSizeMs: number;
  zoomPxPerMinute: number;
  experimentDurationMs: number;
  experimentState: ExperimentState;
  playheadMs: number;
  playheadStartOffsetMs: number;
  playheadStartTimestamp: number | null;
  setSelectedBlock: (
    blockId: string | null,
    options?: { additive?: boolean; range?: boolean },
  ) => void;
  setPasteTarget: (rowId: string, startMs?: number | null) => void;
  setGridSizeMs: (gridSizeMs: number) => void;
  setZoomPxPerMinute: (zoomPxPerMinute: number) => void;
  setExperimentDurationMs: (experimentDurationMs: number) => void;
  startExperiment: () => void;
  stopExperiment: () => void;
  resetExperiment: () => void;
  undo: () => void;
  redo: () => void;
  beginHistoryEntry: () => void;
  commitHistoryEntry: () => void;
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
  pasteBlocks: (blocks: Block[]) => void;
  updateBlock: (
    blockId: string,
    patch: Partial<Omit<Block, "id">>,
    options?: MutationOptions,
  ) => void;
  moveBlocks: (updates: BlockMoveUpdate[], options?: MutationOptions) => void;
  deleteBlock: (blockId: string) => void;
  deleteBlocks: (blockIds: string[]) => void;
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

function blocksDoNotOverlapByRow(blocks: Block[]) {
  const blocksByRowId = new Map<string, Block[]>();

  for (const block of blocks) {
    const rowBlocks = blocksByRowId.get(block.rowId) ?? [];
    rowBlocks.push(block);
    blocksByRowId.set(block.rowId, rowBlocks);
  }

  for (const rowBlocks of blocksByRowId.values()) {
    const sortedBlocks = [...rowBlocks].sort(
      (left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id),
    );

    for (let index = 1; index < sortedBlocks.length; index += 1) {
      if (sortedBlocks[index].startMs < getBlockEnd(sortedBlocks[index - 1])) {
        return false;
      }
    }
  }

  return true;
}

function isWithinEditableScheduleLimits(blocks: Block[], rows: Row[]) {
  const summary = getFirmwareScheduleSummary(blocks, rows);

  return (
    blocksDoNotOverlapByRow(blocks) &&
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
  const usedPumpIds = new Set(
    rows
      .filter(
        (row) =>
          row.deviceType === "peristaltic" &&
          row.hardwareId !== null &&
          row.hardwareId !== undefined,
      )
      .map((row) => row.hardwareId as number),
  );
  let nextAvailableIndex = 0;

  return rows.map((row) => {
    if (row.deviceType !== "peristaltic") {
      return row;
    }

    // Detection can be retried/remounted often; preserve explicit channel choices.
    if (row.hardwareId !== null && row.hardwareId !== undefined) {
      return row;
    }

    while (
      nextAvailableIndex < availablePumpHardwareIds.length &&
      usedPumpIds.has(availablePumpHardwareIds[nextAvailableIndex])
    ) {
      nextAvailableIndex += 1;
    }

    const hardwareId = availablePumpHardwareIds[nextAvailableIndex] ?? null;

    if (hardwareId === null) {
      return row;
    }

    usedPumpIds.add(hardwareId);
    nextAvailableIndex += 1;

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

function getBlockSelectionSnapshot(blocks: Block[], blockId: string | null) {
  const block = blockId ? blocks.find((item) => item.id === blockId) ?? null : null;

  return {
    selectedBlockId: block?.id ?? null,
    selectedBlockIds: block ? [block.id] : [],
    selectionAnchorBlockId: block?.id ?? null,
    selectedRowId: block?.rowId ?? null,
    pasteTargetStartMs: block ? getBlockEnd(block) : null,
  };
}

function getSortedSelectedBlockIds(blocks: Block[], blockIds: string[]) {
  const blockIdSet = new Set(blockIds);
  return blocks
    .filter((block) => blockIdSet.has(block.id))
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
    .map((block) => block.id);
}

function getSelectionForBlock({
  additive = false,
  anchorBlockId,
  blockId,
  blocks,
  currentBlockIds,
  range = false,
}: {
  additive?: boolean;
  anchorBlockId: string | null;
  blockId: string;
  blocks: Block[];
  currentBlockIds: string[];
  range?: boolean;
}) {
  const block = blocks.find((item) => item.id === blockId);

  if (!block) {
    return getBlockSelectionSnapshot(blocks, null);
  }

  if (range && anchorBlockId) {
    const anchorBlock = blocks.find((item) => item.id === anchorBlockId);

    if (anchorBlock?.rowId === block.rowId) {
      const rowBlocks = getSortedRowBlocks(blocks, block.rowId);
      const anchorIndex = rowBlocks.findIndex((item) => item.id === anchorBlock.id);
      const blockIndex = rowBlocks.findIndex((item) => item.id === block.id);

      if (anchorIndex >= 0 && blockIndex >= 0) {
        const startIndex = Math.min(anchorIndex, blockIndex);
        const endIndex = Math.max(anchorIndex, blockIndex);
        const selectedBlockIds = rowBlocks
          .slice(startIndex, endIndex + 1)
          .map((item) => item.id);

        return {
          selectedBlockId: block.id,
          selectedBlockIds,
          selectionAnchorBlockId: anchorBlock.id,
          selectedRowId: block.rowId,
          pasteTargetStartMs: getBlockEnd(block),
        };
      }
    }
  }

  if (additive) {
    const currentBlocks = blocks.filter((item) => currentBlockIds.includes(item.id));
    const canAddToCurrentSelection =
      currentBlocks.length === 0 || currentBlocks.every((item) => item.rowId === block.rowId);

    if (canAddToCurrentSelection) {
      const currentBlockIdSet = new Set(currentBlocks.map((item) => item.id));
      if (currentBlockIdSet.has(block.id)) {
        currentBlockIdSet.delete(block.id);
      } else {
        currentBlockIdSet.add(block.id);
      }

      const selectedBlockIds = getSortedSelectedBlockIds(blocks, Array.from(currentBlockIdSet));
      const selectedBlockId = selectedBlockIds.includes(block.id)
        ? block.id
        : selectedBlockIds[selectedBlockIds.length - 1] ?? null;

      return {
        selectedBlockId,
        selectedBlockIds,
        selectionAnchorBlockId: anchorBlockId ?? block.id,
        selectedRowId: block.rowId,
        pasteTargetStartMs: getBlockEnd(block),
      };
    }
  }

  return getBlockSelectionSnapshot(blocks, block.id);
}

function getNextSelectionAfterRemoving(blocks: Block[], blockIdsToRemove: string[]) {
  const removedBlockIdSet = new Set(blockIdsToRemove);
  const remainingBlocks = blocks.filter((block) => !removedBlockIdSet.has(block.id));
  const selectedBlock = remainingBlocks[0] ?? null;

  return {
    selectedBlockId: selectedBlock?.id ?? null,
    selectedBlockIds: selectedBlock ? [selectedBlock.id] : [],
    selectionAnchorBlockId: selectedBlock?.id ?? null,
    selectedRowId: selectedBlock?.rowId ?? null,
    pasteTargetStartMs: selectedBlock ? getBlockEnd(selectedBlock) : null,
  };
}

function pasteBlocksIntoState(state: SchedulerState, blocksToPaste: Block[]) {
  const sortedBlocksToPaste = [...blocksToPaste].sort(
    (left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id),
  );
  const firstBlock = sortedBlocksToPaste[0];
  const sourceRow = firstBlock
    ? state.rows.find((row) => row.id === firstBlock.rowId) ?? null
    : null;

  if (!firstBlock || !sourceRow) {
    return state;
  }

  const sourceRowId = firstBlock.rowId;
  const allBlocksShareSourceRow = sortedBlocksToPaste.every(
    (block) => block.rowId === sourceRowId,
  );

  if (!allBlocksShareSourceRow) {
    return state;
  }

  const targetRow =
    (state.selectedRowId
      ? state.rows.find((row) => row.id === state.selectedRowId) ?? null
      : null) ?? sourceRow;

  if (
    !targetRow ||
    targetRow.isScheduleStatus ||
    targetRow.deviceType !== sourceRow.deviceType
  ) {
    return state;
  }

  const groupStartMs = Math.min(...sortedBlocksToPaste.map((block) => block.startMs));
  const groupEndMs = Math.max(...sortedBlocksToPaste.map((block) => getBlockEnd(block)));
  const groupDurationMs = Math.max(MIN_BLOCK_DURATION_MS, groupEndMs - groupStartMs);
  const copiedSelectionIsStillActive =
    targetRow.id === sourceRow.id &&
    sortedBlocksToPaste.every((block) => state.selectedBlockIds.includes(block.id));
  const desiredStartMs = copiedSelectionIsStillActive
    ? groupEndMs
    : state.pasteTargetStartMs ?? groupEndMs;
  const maxStartMs = Math.max(0, state.experimentDurationMs - groupDurationMs);
  const startMs = findAvailableStartMs({
    blocks: state.blocks,
    rowId: targetRow.id,
    desiredStartMs,
    durationMs: groupDurationMs,
    maxStartMs,
  });

  if (startMs === null) {
    return state;
  }

  const newBlocks: Block[] = sortedBlocksToPaste.map((block) => ({
    ...block,
    id: createId("block"),
    rowId: targetRow.id,
    startMs: startMs + (block.startMs - groupStartMs),
    durationMs: Math.max(MIN_BLOCK_DURATION_MS, Math.round(block.durationMs)),
  }));
  const nextBlocks = [...state.blocks, ...newBlocks];

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
    selectedBlockId: newBlocks[0]?.id ?? null,
    selectedBlockIds: newBlocks.map((block) => block.id),
    selectionAnchorBlockId: newBlocks[0]?.id ?? null,
    selectedRowId: targetRow.id,
    pasteTargetStartMs: Math.max(...newBlocks.map((block) => getBlockEnd(block))),
    experimentDurationMs: nextExperimentDurationMs,
    ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
  };
}

function findClosestAvailableStartMs({
  blocks,
  rowId,
  ignoredBlockId,
  ignoredBlockIds,
  desiredStartMs,
  durationMs,
  maxStartMs,
  snapThresholdMs,
}: {
  blocks: Block[];
  rowId: string;
  ignoredBlockId?: string;
  ignoredBlockIds?: Set<string>;
  desiredStartMs: number;
  durationMs: number;
  maxStartMs: number;
  snapThresholdMs: number;
}) {
  const clampedMaxStartMs = Math.max(0, maxStartMs);
  const targetStartMs = clamp(desiredStartMs, 0, clampedMaxStartMs);
  const ignoredIds = new Set(ignoredBlockIds);

  if (ignoredBlockId) {
    ignoredIds.add(ignoredBlockId);
  }

  const rowBlocks = blocks
    .filter((block) => block.rowId === rowId && !ignoredIds.has(block.id))
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
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
  ignoredBlockIds,
  desiredStartMs,
  durationMs,
  maxStartMs,
}: {
  blocks: Block[];
  rowId: string;
  ignoredBlockIds?: Set<string>;
  desiredStartMs: number;
  durationMs: number;
  maxStartMs: number;
}) {
  const clampedMaxStartMs = Math.max(0, maxStartMs);
  const targetStartMs = clamp(desiredStartMs, 0, clampedMaxStartMs);
  const ignoredIds = ignoredBlockIds ?? new Set<string>();
  const rowBlocks = blocks
    .filter((block) => block.rowId === rowId && !ignoredIds.has(block.id))
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));
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

const HISTORY_LIMIT = 80;

function getHistorySnapshot(state: SchedulerState): SchedulerHistorySnapshot {
  return {
    rows: state.rows.map((row) => ({ ...row })),
    blocks: state.blocks.map((block) => ({ ...block })),
    selectedBlockId: state.selectedBlockId,
    selectedBlockIds: [...state.selectedBlockIds],
    selectionAnchorBlockId: state.selectionAnchorBlockId,
    selectedRowId: state.selectedRowId,
    pasteTargetStartMs: state.pasteTargetStartMs,
    gridSizeMs: state.gridSizeMs,
    zoomPxPerMinute: state.zoomPxPerMinute,
    experimentDurationMs: state.experimentDurationMs,
  };
}

function restoreHistorySnapshot(
  snapshot: SchedulerHistorySnapshot,
): Pick<
  SchedulerState,
  | "rows"
  | "blocks"
  | "selectedBlockId"
  | "selectedBlockIds"
  | "selectionAnchorBlockId"
  | "selectedRowId"
  | "pasteTargetStartMs"
  | "gridSizeMs"
  | "zoomPxPerMinute"
  | "experimentDurationMs"
> {
  return {
    rows: snapshot.rows.map((row) => ({ ...row })),
    blocks: snapshot.blocks.map((block) => ({ ...block })),
    selectedBlockId: snapshot.selectedBlockId,
    selectedBlockIds: [...snapshot.selectedBlockIds],
    selectionAnchorBlockId: snapshot.selectionAnchorBlockId,
    selectedRowId: snapshot.selectedRowId,
    pasteTargetStartMs: snapshot.pasteTargetStartMs,
    gridSizeMs: snapshot.gridSizeMs,
    zoomPxPerMinute: snapshot.zoomPxPerMinute,
    experimentDurationMs: snapshot.experimentDurationMs,
  };
}

function areHistorySnapshotsEqual(
  left: SchedulerHistorySnapshot,
  right: SchedulerHistorySnapshot,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withHistory<T extends Partial<SchedulerState>>(
  state: SchedulerState,
  patch: T,
  options: MutationOptions = {},
): T | (T & Pick<SchedulerState, "past" | "future" | "pendingHistorySnapshot">) {
  if (options.recordHistory === false) {
    return patch;
  }

  return {
    ...patch,
    past: [...state.past, getHistorySnapshot(state)].slice(-HISTORY_LIMIT),
    future: [],
    pendingHistorySnapshot: null,
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
  past: [],
  future: [],
  pendingHistorySnapshot: null,
  selectedBlockId: initialBlocks[0]?.id ?? null,
  selectedBlockIds: initialBlocks[0] ? [initialBlocks[0].id] : [],
  selectionAnchorBlockId: initialBlocks[0]?.id ?? null,
  selectedRowId: initialBlocks[0]?.rowId ?? initialRows[0]?.id ?? null,
  pasteTargetStartMs: initialBlocks[0] ? getBlockEnd(initialBlocks[0]) : null,
  gridSizeMs: 500,
  zoomPxPerMinute: DEFAULT_ZOOM_PX_PER_MINUTE,
  experimentDurationMs: initialExperimentDurationMs,
  experimentState: "idle",
  playheadMs: 0,
  playheadStartOffsetMs: 0,
  playheadStartTimestamp: null,
  setSelectedBlock: (blockId, options = {}) =>
    set((state) =>
      blockId
        ? getSelectionForBlock({
            additive: options.additive,
            anchorBlockId: state.selectionAnchorBlockId,
            blockId,
            blocks: state.blocks,
            currentBlockIds: state.selectedBlockIds,
            range: options.range,
          })
        : {
            selectedBlockId: null,
            selectedBlockIds: [],
            selectionAnchorBlockId: null,
          },
    ),
  setPasteTarget: (selectedRowId, startMs = null) =>
    set({
      selectedRowId,
      pasteTargetStartMs: startMs,
    }),
  setGridSizeMs: (gridSizeMs) =>
    set((state) =>
      withHistory(state, {
        gridSizeMs: Math.max(
          FIRMWARE_SCHEDULE_LIMITS.minEventSpacingMs,
          Math.round(gridSizeMs),
        ),
      }),
    ),
  setZoomPxPerMinute: (zoomPxPerMinute) =>
    set({
      zoomPxPerMinute: clamp(
        zoomPxPerMinute,
        MIN_ZOOM_PX_PER_MINUTE,
        MAX_ZOOM_PX_PER_MINUTE,
      ),
    }),
  setExperimentDurationMs: (experimentDurationMs) =>
    set((state) => {
      const nowMs = Date.now();
      const nextExperimentDurationMs = getScheduleDuration(state.blocks, experimentDurationMs);

      return withHistory(state, {
        experimentDurationMs: nextExperimentDurationMs,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      });
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
  undo: () =>
    set((state) => {
      const previousSnapshot = state.past[state.past.length - 1];

      if (!previousSnapshot) {
        return state;
      }

      const currentSnapshot = getHistorySnapshot(state);
      const nextExperimentDurationMs = previousSnapshot.experimentDurationMs;
      const nowMs = Date.now();

      return {
        ...restoreHistorySnapshot(previousSnapshot),
        past: state.past.slice(0, -1),
        future: [currentSnapshot, ...state.future].slice(0, HISTORY_LIMIT),
        pendingHistorySnapshot: null,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      };
    }),
  redo: () =>
    set((state) => {
      const nextSnapshot = state.future[0];

      if (!nextSnapshot) {
        return state;
      }

      const currentSnapshot = getHistorySnapshot(state);
      const nextExperimentDurationMs = nextSnapshot.experimentDurationMs;
      const nowMs = Date.now();

      return {
        ...restoreHistorySnapshot(nextSnapshot),
        past: [...state.past, currentSnapshot].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        pendingHistorySnapshot: null,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      };
    }),
  beginHistoryEntry: () =>
    set((state) =>
      state.pendingHistorySnapshot
        ? state
        : { pendingHistorySnapshot: getHistorySnapshot(state) },
    ),
  commitHistoryEntry: () =>
    set((state) => {
      if (!state.pendingHistorySnapshot) {
        return state;
      }

      if (areHistorySnapshotsEqual(state.pendingHistorySnapshot, getHistorySnapshot(state))) {
        return { pendingHistorySnapshot: null };
      }

      return {
        past: [...state.past, state.pendingHistorySnapshot].slice(-HISTORY_LIMIT),
        future: [],
        pendingHistorySnapshot: null,
      };
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

      const selectedBlock = schedule.blocks[0] ?? null;

      return withHistory(state, {
        rows: normalizeLoadedRows(schedule.rows),
        blocks: schedule.blocks,
        gridSizeMs: Math.max(
          FIRMWARE_SCHEDULE_LIMITS.minEventSpacingMs,
          Math.round(schedule.gridSizeMs),
        ),
        zoomPxPerMinute: clamp(
          schedule.zoomPxPerMinute,
          MIN_ZOOM_PX_PER_MINUTE,
          MAX_ZOOM_PX_PER_MINUTE,
        ),
        experimentDurationMs: nextExperimentDurationMs,
        selectedBlockId: selectedBlock?.id ?? null,
        selectedBlockIds: selectedBlock ? [selectedBlock.id] : [],
        selectionAnchorBlockId: selectedBlock?.id ?? null,
        selectedRowId: selectedBlock?.rowId ?? schedule.rows[0]?.id ?? null,
        pasteTargetStartMs: selectedBlock ? getBlockEnd(selectedBlock) : null,
        experimentState: "idle",
        playheadMs: 0,
        playheadStartOffsetMs: 0,
        playheadStartTimestamp: null,
        availablePumpHardwareIds: state.availablePumpHardwareIds,
      });
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

      return withHistory(state, {
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
      });
    }),
  removeRow: (rowId) =>
    set((state) => {
      const remainingRows = state.rows.filter((row) => row.id !== rowId);

      if (remainingRows.length === 0) {
        return state;
      }

      const remainingBlocks = state.blocks.filter((block) => block.rowId !== rowId);
      const remainingBlockIds = new Set(remainingBlocks.map((block) => block.id));
      const selectedBlockIds = getSortedSelectedBlockIds(
        remainingBlocks,
        state.selectedBlockIds.filter((blockId) => remainingBlockIds.has(blockId)),
      );
      const firstSelectedBlock =
        remainingBlocks.find((block) => block.id === selectedBlockIds[0]) ?? null;
      const fallbackSelection =
        selectedBlockIds.length > 0
          ? {
              selectedBlockId: selectedBlockIds.includes(state.selectedBlockId ?? "")
                ? state.selectedBlockId
                : selectedBlockIds[0],
              selectedBlockIds,
              selectionAnchorBlockId: selectedBlockIds.includes(state.selectionAnchorBlockId ?? "")
                ? state.selectionAnchorBlockId
                : selectedBlockIds[0],
              selectedRowId: firstSelectedBlock?.rowId ?? null,
              pasteTargetStartMs: firstSelectedBlock ? getBlockEnd(firstSelectedBlock) : null,
            }
          : getBlockSelectionSnapshot(remainingBlocks, remainingBlocks[0]?.id ?? null);
      const nextExperimentDurationMs = getScheduleDuration(
        remainingBlocks,
        state.experimentDurationMs,
      );
      const nowMs = Date.now();

      return withHistory(state, {
        rows: remainingRows,
        blocks: remainingBlocks,
        ...fallbackSelection,
        experimentDurationMs: nextExperimentDurationMs,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      });
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

      const nextBlockIds = new Set(nextBlocks.map((block) => block.id));
      const selectedBlockIds = getSortedSelectedBlockIds(
        nextBlocks,
        state.selectedBlockIds.filter((blockId) => nextBlockIds.has(blockId)),
      );
      const selectedBlock = nextBlocks.find((block) =>
        selectedBlockIds.includes(block.id),
      ) ?? nextBlocks[0] ?? null;
      const nextExperimentDurationMs = getScheduleDuration(
        nextBlocks,
        state.experimentDurationMs,
      );
      const nowMs = Date.now();

      return withHistory(state, {
        rows: nextRows,
        blocks: nextBlocks,
        selectedBlockId: selectedBlock?.id ?? null,
        selectedBlockIds:
          selectedBlockIds.length > 0
            ? selectedBlockIds
            : selectedBlock
              ? [selectedBlock.id]
              : [],
        selectionAnchorBlockId:
          selectedBlockIds.includes(state.selectionAnchorBlockId ?? "")
            ? state.selectionAnchorBlockId
            : selectedBlock?.id ?? null,
        selectedRowId: selectedBlock?.rowId ?? state.selectedRowId,
        pasteTargetStartMs: selectedBlock ? getBlockEnd(selectedBlock) : state.pasteTargetStartMs,
        experimentDurationMs: nextExperimentDurationMs,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      });
    }),
  addBlock: (rowId, startMs, durationMs = 2 * SECOND_MS) =>
    set((state) => {
      const row = state.rows.find((item) => item.id === rowId);

      if (!row || row.isScheduleStatus) {
        return state;
      }

      const normalizedDurationMs = Math.max(MIN_BLOCK_DURATION_MS, Math.round(durationMs));
      const maxStartMs = Math.max(0, state.experimentDurationMs - normalizedDurationMs);
      const nextStartMs = findAvailableStartMs({
        blocks: state.blocks,
        rowId,
        desiredStartMs: Math.max(0, startMs),
        durationMs: normalizedDurationMs,
        maxStartMs,
      });

      if (nextStartMs === null) {
        return state;
      }

      const newBlock = createDefaultBlock(
        row,
        nextStartMs,
        normalizedDurationMs,
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

      return withHistory(state, {
        blocks: nextBlocks,
        selectedBlockId: newBlock.id,
        selectedBlockIds: [newBlock.id],
        selectionAnchorBlockId: newBlock.id,
        selectedRowId: newBlock.rowId,
        pasteTargetStartMs: getBlockEnd(newBlock),
        experimentDurationMs: nextExperimentDurationMs,
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      });
    }),
  pasteBlock: (block) =>
    set((state) => {
      const patch = pasteBlocksIntoState(state, [block]);
      return patch === state ? state : withHistory(state, patch);
    }),
  pasteBlocks: (blocksToPaste) =>
    set((state) => {
      const patch = pasteBlocksIntoState(state, blocksToPaste);
      return patch === state ? state : withHistory(state, patch);
    }),
  updateBlock: (blockId, patch, options = {}) =>
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
          }) ?? block.startMs;
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

      return withHistory(
        state,
        {
          blocks: nextBlocks,
          experimentDurationMs: nextExperimentDurationMs,
          ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
        },
        options,
      );
    }),
  moveBlocks: (updates, options = {}) =>
    set((state) => {
      if (updates.length === 0) {
        return state;
      }

      const updatesByBlockId = new Map(updates.map((update) => [update.blockId, update]));
      const movingBlockIds = new Set(updatesByBlockId.keys());
      const moveGroups = new Map<
        string,
        Array<{ block: Block; requestedStartMs: number }>
      >();
      const unchangedMovingBlockIds = new Set<string>();

      for (const block of state.blocks) {
        const update = updatesByBlockId.get(block.id);

        if (!update) {
          continue;
        }

        const currentRow = state.rows.find((row) => row.id === block.rowId);
        const requestedRow = state.rows.find((row) => row.id === update.rowId);

        if (
          !currentRow ||
          !requestedRow ||
          requestedRow.isScheduleStatus ||
          requestedRow.deviceType !== currentRow.deviceType
        ) {
          unchangedMovingBlockIds.add(block.id);
          continue;
        }

        const group = moveGroups.get(requestedRow.id) ?? [];
        group.push({
          block,
          requestedStartMs: normalizeTimeValue(update.startMs, block.startMs, 0),
        });
        moveGroups.set(requestedRow.id, group);
      }

      const resolvedMoves = new Map<string, { rowId: string; startMs: number }>();

      for (const [rowId, group] of moveGroups) {
        const groupStartMs = Math.min(...group.map((item) => item.block.startMs));
        const groupEndMs = Math.max(...group.map((item) => getBlockEnd(item.block)));
        const groupDurationMs = Math.max(MIN_BLOCK_DURATION_MS, groupEndMs - groupStartMs);
        const desiredGroupStartMs = Math.min(...group.map((item) => item.requestedStartMs));
        const maxStartMs = Math.max(0, state.experimentDurationMs - groupDurationMs);
        const nextGroupStartMs = findClosestAvailableStartMs({
          blocks: state.blocks,
          rowId,
          ignoredBlockIds: movingBlockIds,
          desiredStartMs: desiredGroupStartMs,
          durationMs: groupDurationMs,
          maxStartMs,
          snapThresholdMs: state.gridSizeMs / 2,
        });

        if (nextGroupStartMs === null) {
          group.forEach((item) => unchangedMovingBlockIds.add(item.block.id));
          continue;
        }

        for (const item of group) {
          resolvedMoves.set(item.block.id, {
            rowId,
            startMs: nextGroupStartMs + (item.block.startMs - groupStartMs),
          });
        }
      }

      const nextBlocks = state.blocks.map((block) => {
        const resolvedMove = resolvedMoves.get(block.id);

        if (!resolvedMove || unchangedMovingBlockIds.has(block.id)) {
          return block;
        }

        return {
          ...block,
          rowId: resolvedMove.rowId,
          startMs: resolvedMove.startMs,
        };
      });

      if (!isWithinEditableScheduleLimits(nextBlocks, state.rows)) {
        return state;
      }

      const movedBlocks = nextBlocks.filter((block) => updatesByBlockId.has(block.id));
      const selectedBlockIds = getSortedSelectedBlockIds(
        nextBlocks,
        state.selectedBlockIds.filter((blockId) => updatesByBlockId.has(blockId)),
      );
      const nextExperimentDurationMs = getScheduleDuration(
        nextBlocks,
        state.experimentDurationMs,
      );
      const nowMs = Date.now();
      const nextPasteTargetStartMs =
        movedBlocks.length > 0
          ? Math.max(...movedBlocks.map((block) => getBlockEnd(block)))
          : state.pasteTargetStartMs;

      return withHistory(
        state,
        {
          blocks: nextBlocks,
          selectedBlockIds:
            selectedBlockIds.length > 0 ? selectedBlockIds : state.selectedBlockIds,
          selectedRowId: movedBlocks[0]?.rowId ?? state.selectedRowId,
          pasteTargetStartMs: nextPasteTargetStartMs,
          experimentDurationMs: nextExperimentDurationMs,
          ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
        },
        options,
      );
    }),
  deleteBlock: (blockId) =>
    set((state) => {
      const blockIdsToDelete = state.selectedBlockIds.includes(blockId)
        ? state.selectedBlockIds
        : [blockId];
      const blockIdSet = new Set(blockIdsToDelete);
      const remainingBlocks = state.blocks.filter((block) => !blockIdSet.has(block.id));
      const nextExperimentDurationMs = getScheduleDuration(
        remainingBlocks,
        state.experimentDurationMs,
      );
      const nowMs = Date.now();
      return withHistory(state, {
        blocks: remainingBlocks,
        experimentDurationMs: nextExperimentDurationMs,
        ...getNextSelectionAfterRemoving(state.blocks, blockIdsToDelete),
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      });
    }),
  deleteBlocks: (blockIds) =>
    set((state) => {
      const blockIdSet = new Set(blockIds);
      if (blockIdSet.size === 0) {
        return state;
      }

      const remainingBlocks = state.blocks.filter((block) => !blockIdSet.has(block.id));
      if (remainingBlocks.length === state.blocks.length) {
        return state;
      }

      const nextExperimentDurationMs = getScheduleDuration(
        remainingBlocks,
        state.experimentDurationMs,
      );
      const nowMs = Date.now();
      return withHistory(state, {
        blocks: remainingBlocks,
        experimentDurationMs: nextExperimentDurationMs,
        ...getNextSelectionAfterRemoving(state.blocks, blockIds),
        ...getPlayheadSnapshot(state, nextExperimentDurationMs, nowMs),
      });
    }),
}));
