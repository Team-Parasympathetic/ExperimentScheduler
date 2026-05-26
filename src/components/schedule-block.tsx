import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useMemo } from "react";
import type { Block, Row, TriggerMode } from "@/types/scheduler";
import {
  getFixedPumpCalibrationFit,
  getFixedPumpFlowRateForDuration,
  getFixedPumpVolumeForDuration,
  normalizePumpCalibrationConfig,
} from "@/lib/pump-calibration";
import {
  DEFAULT_TRIGGER_MODE,
  getTriggerFrequencyLabel,
  getTriggerModeLabel,
  normalizeDutyCycle,
} from "@/lib/trigger-output";
import { formatDuration, getDeviceTypeLabel, getFlowRateLabel } from "@/lib/time";
import { usePumpCalibrationStore } from "@/store/pump-calibration-store";
import { cn } from "@/lib/utils";

interface ScheduleBlockProps {
  block: Block;
  row: Row;
  left: number;
  width: number;
  shadeIndex: number;
  isSelected: boolean;
  onSelect: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onPointerDownMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerDownResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerDownResizeEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

function TriggerGlyph({ mode }: { mode: TriggerMode }) {
  const path =
    mode === "rising"
      ? "M3 13 H7 V5 H15"
      : mode === "falling"
      ? "M3 5 H9 V13 H15"
      : "M3 13 H6 V5 H10 V13 H14 V5 H17";

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute right-3 top-3 z-10 flex h-5 w-5 items-center justify-center rounded-md border border-white/70 bg-white/72 text-violet-700 shadow-sm"
    >
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      >
        <path d={path} />
      </svg>
    </div>
  );
}

function formatNumber(value: number, digits = 1) {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: value % 1 === 0 ? 0 : Math.min(1, digits),
  });
}

function getEstimatedTextWidth(text: string, averageCharacterWidth = 7) {
  return text.length * averageCharacterWidth;
}

export function ScheduleBlock({
  block,
  row,
  isSelected,
  left,
  onContextMenu,
  onPointerDownMove,
  onPointerDownResizeEnd,
  onPointerDownResizeStart,
  onSelect,
  shadeIndex,
  width,
}: ScheduleBlockProps) {
  const storedCalibration = usePumpCalibrationStore(
    (state) => state.calibrationsByRowId[block.rowId],
  );
  const calibration = useMemo(
    () => normalizePumpCalibrationConfig(storedCalibration),
    [storedCalibration],
  );
  const fixedFit = getFixedPumpCalibrationFit(calibration.fixed);
  const deviceType = row.deviceType;
  const isTrigger = deviceType === "trigger";
  const isFixedRatePump = deviceType === "peristaltic" && row.pumpRateMode === "fixed";
  const isAlternateShade = shadeIndex % 2 === 1;
  const triggerMode = block.triggerMode ?? DEFAULT_TRIGGER_MODE;
  const primaryLabel = isTrigger
    ? getTriggerModeLabel(triggerMode)
    : block.direction === "forward"
    ? "Forward"
    : "Reverse";
  const secondaryLabel =
    isTrigger && triggerMode === "waveform"
      ? `${getTriggerFrequencyLabel(block.frequencyHz)} @ ${normalizeDutyCycle(
          block.dutyCycle ?? 50,
        )}%`
      : isTrigger
      ? triggerMode === "rising"
        ? "High at start"
        : "Low at start"
      : isFixedRatePump
      ? `${formatNumber(getFixedPumpVolumeForDuration(block.durationMs, fixedFit), 1)} uL @ ${getFlowRateLabel(
          getFixedPumpFlowRateForDuration(block.durationMs, fixedFit),
        )}`
      : getFlowRateLabel(block.flowRate);
  const durationLabel = formatDuration(block.durationMs);
  const deviceTypeLabel = getDeviceTypeLabel(deviceType);
  const contentWidth = Math.max(0, width - 34);
  const resizeHandleWidth = Math.round(
    width < 24 ? Math.min(7, Math.max(4, width * 0.28)) : Math.min(18, Math.max(14, width * 0.28)),
  );
  const showHeader =
    contentWidth >=
    Math.max(128, getEstimatedTextWidth(deviceTypeLabel, 5.8), getEstimatedTextWidth(primaryLabel, 8) + 22);
  const showFooter =
    showHeader &&
    contentWidth >=
      Math.max(
        164,
        getEstimatedTextWidth(secondaryLabel, 6.7) +
          getEstimatedTextWidth(durationLabel, 7) +
          34,
      );

  return (
    <div
      data-block-root="true"
      className={cn(
        "absolute top-2 flex h-[76px] min-w-0 touch-none select-none flex-col justify-between overflow-visible rounded-2xl border text-left shadow-[0_16px_32px_-22px_rgba(15,23,42,0.28)] transition-colors",
        showHeader ? "cursor-grab px-4 py-3 active:cursor-grabbing" : "cursor-grab p-0 active:cursor-grabbing",
        isTrigger
          ? isAlternateShade
            ? "border-violet-300 bg-[linear-gradient(180deg,rgba(237,233,254,0.98),rgba(196,181,253,0.92))] text-slate-800"
            : "border-violet-200 bg-[linear-gradient(180deg,rgba(245,243,255,0.98),rgba(221,214,254,0.92))] text-slate-800"
          : isAlternateShade
            ? "border-orange-300 bg-[linear-gradient(180deg,rgba(255,237,213,0.98),rgba(253,186,116,0.92))] text-slate-800"
            : "border-orange-200 bg-[linear-gradient(180deg,rgba(255,247,237,0.98),rgba(254,215,170,0.92))] text-slate-800",
        isSelected && "ring-2 ring-primary/55",
      )}
      style={{
        left,
        width,
        minWidth: 0,
      }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(event);
      }}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDownMove}
      role="button"
      tabIndex={0}
      aria-label={`${deviceTypeLabel} ${primaryLabel} ${secondaryLabel} ${durationLabel}`}
    >
      <div
        data-block-resize-handle="start"
        className="absolute -left-1 inset-y-0 z-20 cursor-ew-resize rounded-l-2xl bg-white/0 transition hover:bg-slate-900/8"
        style={{ width: resizeHandleWidth }}
        onPointerDown={(event) => {
          event.stopPropagation();
          onPointerDownResizeStart(event);
        }}
      />
      <div
        data-block-resize-handle="end"
        className="absolute -right-1 inset-y-0 z-20 cursor-ew-resize rounded-r-2xl bg-white/0 transition hover:bg-slate-900/8"
        style={{ width: resizeHandleWidth }}
        onPointerDown={(event) => {
          event.stopPropagation();
          onPointerDownResizeEnd(event);
        }}
      />

      {isTrigger && width >= 56 ? <TriggerGlyph mode={triggerMode} /> : null}

      {showHeader ? (
        <>
          <div className="pointer-events-none flex items-start justify-between gap-3 pr-6">
            <div className="min-w-0">
              <div className="truncate text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                {getDeviceTypeLabel(deviceType)}
              </div>
              <div className="mt-1 truncate text-sm font-semibold">
                {primaryLabel}
              </div>
            </div>
          </div>

          {showFooter ? (
            <div className="pointer-events-none flex items-center justify-between gap-3 text-xs">
              <div className="truncate rounded-full border border-white/60 bg-white/72 px-2.5 py-1 font-medium text-slate-700">
                {secondaryLabel}
              </div>
              <div className="truncate font-mono text-slate-500">
                {durationLabel}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
