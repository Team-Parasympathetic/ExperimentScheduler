import type { Block, DeviceType } from "@/types/scheduler";
import { clamp } from "@/lib/utils";

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const MIN_BLOCK_DURATION_MS = 1_000;
export const EXPERIMENT_PADDING_MS = 15 * MINUTE_MS;
export const DEFAULT_EXPERIMENT_DURATION_MS = 5 * MINUTE_MS;
export const MIN_AUTO_SCHEDULE_DURATION_MS = DEFAULT_EXPERIMENT_DURATION_MS;
export const MIN_MANUAL_SCHEDULE_DURATION_MS = MINUTE_MS;

export const GRID_OPTIONS = [
  { label: "0.1 sec", value: 100 },
  { label: "0.5 sec", value: 500 },
  { label: "1 sec", value: 1_000 },
  { label: "5 sec", value: 5_000 },
  { label: "10 sec", value: 10_000 },
  { label: "30 sec", value: 30_000 },
  { label: "1 min", value: 60_000 },
];

export const MIN_ZOOM_PX_PER_MINUTE = 300;
export const MAX_ZOOM_PX_PER_MINUTE = 96_000;
export const ZOOM_LEVELS = [
  MIN_ZOOM_PX_PER_MINUTE,
  450,
  600,
  900,
  1_200,
  1_800,
  3_000,
  6_000,
  9_000,
  12_000,
  18_000,
  24_000,
  36_000,
  48_000,
  72_000,
  MAX_ZOOM_PX_PER_MINUTE,
] as const;
export const DEFAULT_ZOOM_PX_PER_MINUTE = 6_000;

const GRID_DIVISION_OPTIONS_MS = [
  100,
  250,
  500,
  1_000,
  2_000,
  5_000,
  10_000,
  15_000,
  30_000,
  MINUTE_MS,
  2 * MINUTE_MS,
  5 * MINUTE_MS,
  10 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  60 * MINUTE_MS,
] as const;

function trimTrailingZeros(value: string) {
  return value.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

export function snapMs(value: number, gridSizeMs: number) {
  return Math.round(value / gridSizeMs) * gridSizeMs;
}

export function pxToMs(px: number, zoomPxPerMinute: number) {
  return (px / zoomPxPerMinute) * MINUTE_MS;
}

export function msToPx(ms: number, zoomPxPerMinute: number) {
  return (ms / MINUTE_MS) * zoomPxPerMinute;
}

export function formatTimelineTime(ms: number) {
  const normalizedMs = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(normalizedMs / SECOND_MS);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const remainingMs = normalizedMs % SECOND_MS;

  if (hours > 0) {
    const baseLabel = `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
    return remainingMs > 0 ? `${baseLabel}.${Math.floor(remainingMs / 100)}` : baseLabel;
  }

  const baseLabel = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  return remainingMs > 0 ? `${baseLabel}.${Math.floor(remainingMs / 100)}` : baseLabel;
}

export function formatDuration(ms: number) {
  const normalizedMs = Math.max(0, Math.round(ms));

  if (normalizedMs < MINUTE_MS) {
    if (normalizedMs % SECOND_MS === 0) {
      return `${normalizedMs / SECOND_MS}s`;
    }

    const fractionDigits = normalizedMs % 100 === 0 ? 1 : 2;
    return `${trimTrailingZeros((normalizedMs / SECOND_MS).toFixed(fractionDigits))}s`;
  }

  const totalSeconds = Math.round(normalizedMs / SECOND_MS);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0 && seconds > 0) {
    return `${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return `${seconds}s`;
}

export function getBlockEnd(block: Block) {
  return block.startMs + block.durationMs;
}

export function getRequiredScheduleDuration(blocks: Block[]) {
  const maxEnd = blocks.reduce((max, block) => Math.max(max, getBlockEnd(block)), 0);
  return maxEnd;
}

export function getScheduleDuration(blocks: Block[], requestedDurationMs?: number) {
  const requiredDurationMs = getRequiredScheduleDuration(blocks);

  if (requestedDurationMs === undefined) {
    return Math.max(
      requiredDurationMs + EXPERIMENT_PADDING_MS,
      MIN_AUTO_SCHEDULE_DURATION_MS,
    );
  }

  return Math.max(
    requiredDurationMs,
    requestedDurationMs,
    MIN_MANUAL_SCHEDULE_DURATION_MS,
  );
}

export function getLabelEvery(gridSizeMs: number, zoomPxPerMinute: number) {
  const gridWidth = msToPx(gridSizeMs, zoomPxPerMinute);
  return Math.max(1, Math.ceil(90 / Math.max(gridWidth, 1)));
}

export function getVisibleGridSizeMs(gridSizeMs: number, zoomPxPerMinute: number) {
  const minGridWidthPx = 26;
  const minimumDivisionMs = Math.max(100, gridSizeMs);
  const visibleDivisionMs = GRID_DIVISION_OPTIONS_MS.find(
    (divisionMs) =>
      divisionMs >= minimumDivisionMs &&
      msToPx(divisionMs, zoomPxPerMinute) >= minGridWidthPx,
  );

  if (visibleDivisionMs) {
    return visibleDivisionMs;
  }

  const minDivisionMs = pxToMs(minGridWidthPx, zoomPxPerMinute);
  return Math.ceil(minDivisionMs / MINUTE_MS) * MINUTE_MS;
}

export function formatSecondsPerDivision(ms: number) {
  const seconds = ms / SECOND_MS;

  return `${trimTrailingZeros(seconds.toFixed(seconds < 10 && seconds % 1 !== 0 ? 1 : 0))} s/div`;
}

export function clampBlockStart(startMs: number, durationMs: number, totalDurationMs: number) {
  return clamp(startMs, 0, Math.max(0, totalDurationMs - durationMs));
}

export function getDeviceTypeLabel(deviceType: DeviceType) {
  if (deviceType === "trigger") {
    return "Trigger output";
  }

  return "Peristaltic pump";
}

export function getFlowRateLabel(flowRate: number) {
  return `${flowRate.toFixed(flowRate % 1 === 0 ? 0 : 1)} uL/min`;
}
