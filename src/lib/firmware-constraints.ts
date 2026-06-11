import {
  DEFAULT_TRIGGER_MODE,
  getCompletePeriodDurationMs,
  getDerivedFrequencyHz,
  normalizeFrequencyHz,
  normalizeRequireCompletePeriods,
} from "@/lib/trigger-output";
import type { Block, Row } from "@/types/scheduler";

export const FIRMWARE_SCHEDULE_LIMITS = {
  maxEvents: 48,
  maxEventActionBytes: 192,
  minEventSpacingMs: 10,
  maxPumps: 64,
  maxGpioOutputs: 32,
  maxGpioActions: 48,
  maxProtocolPayloadBytes: 256,
  eventHeaderBytes: 13,
  pumpActionRecordBytes: 12,
  gpioZeroPayloadActionRecordBytes: 4,
  gpioWaveformActionRecordBytes: 20,
} as const;

const PWM_BOUNDARY_GUARD_US = 1;
const MIN_EVENT_SPACING_US = FIRMWARE_SCHEDULE_LIMITS.minEventSpacingMs * 1_000;

export interface FirmwareEventSummary {
  timeMs: number;
  actionCount: number;
  actionBytes: number;
  pumpActionCount: number;
  gpioActionCount: number;
  coalescesNearby?: boolean;
}

export interface FirmwareScheduleSummary {
  events: FirmwareEventSummary[];
  eventCount: number;
  transitionActionCount: number;
  gpioActionCount: number;
  scheduleStatusRowCount: number;
  pumpRowCount: number;
  gpioRowCount: number;
  maxActionBytesAtEvent: number;
  maxPumpActionsAtEvent: number;
  closestEventSpacingMs: number | null;
  maxEventPayloadBytes: number;
  rowsWithinLimit: boolean;
  pumpRowsWithinLimit: boolean;
  gpioRowsWithinLimit: boolean;
  eventsWithinLimit: boolean;
  actionBytesWithinLimit: boolean;
  gpioActionsWithinLimit: boolean;
  scheduleStatusRowsWithinLimit: boolean;
  scheduleStatusRowsEmpty: boolean;
  spacingWithinLimit: boolean;
  hardwareAssignmentsComplete: boolean;
  hardwareAssignmentsUnique: boolean;
  isWithinLimits: boolean;
}

function addTransition(
  eventsByTime: Map<number, FirmwareEventSummary>,
  timeMs: number,
  actionBytes: number,
  actionKind: "pump" | "gpio",
  options: { coalescesNearby?: boolean } = {},
) {
  const normalizedTimeUs = Math.max(0, Math.round(timeMs * 1_000));
  const coalescedTimeUs =
    Array.from(eventsByTime.keys()).reduce<number | null>(
      (bestTimeUs, existingTimeUs) => {
        const existingEvent = eventsByTime.get(existingTimeUs);
        const distanceUs = Math.abs(existingTimeUs - normalizedTimeUs);
        const canCoalesce =
          distanceUs <= PWM_BOUNDARY_GUARD_US ||
          (distanceUs < MIN_EVENT_SPACING_US &&
            (options.coalescesNearby || existingEvent?.coalescesNearby));

        if (!canCoalesce) {
          return bestTimeUs;
        }

        if (bestTimeUs === null) {
          return existingTimeUs;
        }

        const bestDistanceUs = Math.abs(bestTimeUs - normalizedTimeUs);
        return distanceUs < bestDistanceUs ? existingTimeUs : bestTimeUs;
      },
      null,
    ) ?? normalizedTimeUs;
  const eventTimeUs = Math.min(coalescedTimeUs, normalizedTimeUs);

  if (eventTimeUs !== coalescedTimeUs) {
    const existingEvent = eventsByTime.get(coalescedTimeUs);
    if (existingEvent) {
      eventsByTime.delete(coalescedTimeUs);
      existingEvent.timeMs = eventTimeUs / 1_000;
      existingEvent.coalescesNearby =
        existingEvent.coalescesNearby || options.coalescesNearby;
      eventsByTime.set(eventTimeUs, existingEvent);
    }
  }

  const normalizedTimeMs = eventTimeUs / 1_000;
  const existingEvent = eventsByTime.get(eventTimeUs);

  if (existingEvent) {
    existingEvent.actionCount += 1;
    existingEvent.actionBytes += actionBytes;

    if (actionKind === "gpio") {
      existingEvent.gpioActionCount += 1;
    } else {
      existingEvent.pumpActionCount += 1;
    }

    existingEvent.coalescesNearby =
      existingEvent.coalescesNearby || options.coalescesNearby;

    return;
  }

  eventsByTime.set(eventTimeUs, {
    timeMs: normalizedTimeMs,
    actionCount: 1,
    actionBytes,
    pumpActionCount: actionKind === "pump" ? 1 : 0,
    gpioActionCount: actionKind === "gpio" ? 1 : 0,
    coalescesNearby: options.coalescesNearby,
  });
}

export function getFirmwareScheduleSummary(
  blocks: Block[],
  rows: Row[] = [],
): FirmwareScheduleSummary {
  const eventsByTime = new Map<number, FirmwareEventSummary>();
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const scheduleStatusRows = rows.filter(
    (row) => row.deviceType === "trigger" && row.isScheduleStatus,
  );
  const scheduleStatusRowIds = new Set(scheduleStatusRows.map((row) => row.id));

  for (const block of blocks) {
    const row = rowsById.get(block.rowId);

    if (row && scheduleStatusRowIds.has(row.id)) {
      continue;
    }

    if (row?.deviceType === "trigger") {
      const triggerMode = block.triggerMode ?? DEFAULT_TRIGGER_MODE;
      if (triggerMode === "waveform" || triggerMode === "sync-division") {
        const sourceBlock =
          triggerMode === "sync-division" && block.syncSourceBlockId
            ? blocks.find((item) => item.id === block.syncSourceBlockId) ?? null
            : null;
        const derivedFrequencyHz =
          sourceBlock?.triggerMode === "waveform"
            ? getDerivedFrequencyHz(
                normalizeFrequencyHz(sourceBlock.frequencyHz ?? 1),
                block.periodMultiplier,
              )
            : null;
        const waveformFrequencyHz =
          triggerMode === "sync-division"
            ? derivedFrequencyHz
            : normalizeFrequencyHz(block.frequencyHz ?? 1);
        const usesCompletePeriodStop =
          waveformFrequencyHz !== null &&
          (triggerMode === "sync-division" ||
            normalizeRequireCompletePeriods(block.requireCompletePeriods));
        const durationMs = usesCompletePeriodStop
          ? getCompletePeriodDurationMs(
              block.durationMs,
              waveformFrequencyHz,
              block.startMs,
            )
          : block.durationMs;
        addTransition(
          eventsByTime,
          block.startMs,
          FIRMWARE_SCHEDULE_LIMITS.gpioWaveformActionRecordBytes,
          "gpio",
        );
        addTransition(
          eventsByTime,
          block.startMs + durationMs,
          FIRMWARE_SCHEDULE_LIMITS.gpioZeroPayloadActionRecordBytes,
          "gpio",
          { coalescesNearby: usesCompletePeriodStop },
        );
      } else {
        addTransition(
          eventsByTime,
          block.startMs,
          FIRMWARE_SCHEDULE_LIMITS.gpioZeroPayloadActionRecordBytes,
          "gpio",
        );
        addTransition(
          eventsByTime,
          block.startMs + block.durationMs,
          FIRMWARE_SCHEDULE_LIMITS.gpioZeroPayloadActionRecordBytes,
          "gpio",
        );
      }

      continue;
    }

    addTransition(
      eventsByTime,
      block.startMs,
      FIRMWARE_SCHEDULE_LIMITS.pumpActionRecordBytes,
      "pump",
    );
    addTransition(
      eventsByTime,
      block.startMs + block.durationMs,
      FIRMWARE_SCHEDULE_LIMITS.pumpActionRecordBytes,
      "pump",
    );
  }

  if (scheduleStatusRows.length === 1 && eventsByTime.size > 0) {
    const firstEventTime = Math.min(...Array.from(eventsByTime.keys()));
    addTransition(
      eventsByTime,
      firstEventTime / 1_000,
      FIRMWARE_SCHEDULE_LIMITS.gpioZeroPayloadActionRecordBytes,
      "gpio",
    );
  }

  const events = Array.from(eventsByTime.values()).sort((left, right) => left.timeMs - right.timeMs);
  let closestEventSpacingMs: number | null = null;

  for (let index = 1; index < events.length; index++) {
    const spacingMs = events[index].timeMs - events[index - 1].timeMs;

    closestEventSpacingMs =
      closestEventSpacingMs === null ? spacingMs : Math.min(closestEventSpacingMs, spacingMs);
  }

  const maxActionBytesAtEvent = events.reduce(
    (maxBytes, event) => Math.max(maxBytes, event.actionBytes),
    0,
  );
  const maxPumpActionsAtEvent = Math.floor(
    FIRMWARE_SCHEDULE_LIMITS.maxEventActionBytes /
      FIRMWARE_SCHEDULE_LIMITS.pumpActionRecordBytes,
  );
  const maxEventPayloadBytes =
    FIRMWARE_SCHEDULE_LIMITS.eventHeaderBytes + FIRMWARE_SCHEDULE_LIMITS.maxEventActionBytes;
  const transitionActionCount = events.reduce((sum, event) => sum + event.actionCount, 0);
  const gpioActionCount = events.reduce((sum, event) => sum + event.gpioActionCount, 0);
  const scheduleStatusRowCount = scheduleStatusRows.length;
  const pumpRowCount = rows.filter((row) => row.deviceType === "peristaltic").length;
  const gpioRowCount = rows.filter((row) => row.deviceType === "trigger").length;
  const usedHardwareIdsByType = new Map<string, Set<number>>();
  let hardwareAssignmentsUnique = true;

  for (const row of rows) {
    if (row.hardwareId === null || row.hardwareId === undefined) {
      continue;
    }

    const usedHardwareIds = usedHardwareIdsByType.get(row.deviceType) ?? new Set<number>();

    if (usedHardwareIds.has(row.hardwareId)) {
      hardwareAssignmentsUnique = false;
      break;
    }

    usedHardwareIds.add(row.hardwareId);
    usedHardwareIdsByType.set(row.deviceType, usedHardwareIds);
  }

  const hardwareAssignmentsComplete =
    blocks.every((block) => {
      const row = rowsById.get(block.rowId);
      return row?.hardwareId !== null && row?.hardwareId !== undefined;
    }) &&
    scheduleStatusRows.every(
      (row) => row.hardwareId !== null && row.hardwareId !== undefined,
    );
  const scheduleStatusRowsEmpty = blocks.every(
    (block) => !scheduleStatusRowIds.has(block.rowId),
  );
  const scheduleStatusRowsWithinLimit = scheduleStatusRows.length <= 1;
  const pumpRowsWithinLimit = pumpRowCount <= FIRMWARE_SCHEDULE_LIMITS.maxPumps;
  const gpioRowsWithinLimit = gpioRowCount <= FIRMWARE_SCHEDULE_LIMITS.maxGpioOutputs;
  const rowsWithinLimit =
    pumpRowsWithinLimit && gpioRowsWithinLimit && scheduleStatusRowsWithinLimit;
  const eventsWithinLimit = events.length <= FIRMWARE_SCHEDULE_LIMITS.maxEvents;
  const actionBytesWithinLimit =
    maxActionBytesAtEvent <= FIRMWARE_SCHEDULE_LIMITS.maxEventActionBytes;
  const gpioActionsWithinLimit = gpioActionCount <= FIRMWARE_SCHEDULE_LIMITS.maxGpioActions;
  const spacingWithinLimit =
    closestEventSpacingMs === null ||
    closestEventSpacingMs >= FIRMWARE_SCHEDULE_LIMITS.minEventSpacingMs;

  return {
    events,
    eventCount: events.length,
    transitionActionCount,
    gpioActionCount,
    scheduleStatusRowCount,
    pumpRowCount,
    gpioRowCount,
    maxActionBytesAtEvent,
    maxPumpActionsAtEvent,
    closestEventSpacingMs,
    maxEventPayloadBytes,
    rowsWithinLimit,
    pumpRowsWithinLimit,
    gpioRowsWithinLimit,
    eventsWithinLimit,
    actionBytesWithinLimit,
    gpioActionsWithinLimit,
    scheduleStatusRowsWithinLimit,
    scheduleStatusRowsEmpty,
    spacingWithinLimit,
    hardwareAssignmentsComplete,
    hardwareAssignmentsUnique,
    isWithinLimits:
      rowsWithinLimit &&
      eventsWithinLimit &&
      actionBytesWithinLimit &&
      gpioActionsWithinLimit &&
      scheduleStatusRowsEmpty &&
      spacingWithinLimit &&
      hardwareAssignmentsComplete &&
      hardwareAssignmentsUnique,
  };
}
