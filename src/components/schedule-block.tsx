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
  getPumpCalibrationConfigForRow,
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
  isGuideObscured?: boolean;
  isDimmed?: boolean;
  isSyncSourceCandidate?: boolean;
  onSelect: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onPointerDownMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerDownResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerDownResizeEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

function TriggerGlyph({ mode }: { mode: TriggerMode }) {
  const path =
    mode === "pulse"
      ? "M3 13 H6 V5 H14 V13 H17"
      : mode === "sync-division"
        ? "M3 5 H7 V13 H11 V5 H17 M7 16 H17"
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
  isGuideObscured = false,
  isDimmed = false,
  isSyncSourceCandidate = false,
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
  const calibrationsByRowId = usePumpCalibrationStore((state) => state.calibrationsByRowId);
  const calibration = useMemo(
    () => getPumpCalibrationConfigForRow(calibrationsByRowId, row),
    [calibrationsByRowId, row],
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
      ? `${getTriggerFrequencyLabel(block.frequencyHz)} @ ${formatNumber(
          normalizeDutyCycle(block.dutyCycle ?? 50),
          2,
        )}%`
      : isTrigger && triggerMode === "sync-division"
      ? `x${block.periodMultiplier ?? 2} @ ${formatNumber(
          normalizeDutyCycle(block.dutyCycle ?? 50),
          2,
        )}%`
      : isTrigger
      ? "High until stop"
      : isFixedRatePump
      ? `${formatNumber(getFixedPumpVolumeForDuration(block.durationMs, fixedFit), 1)} uL @ ${getFlowRateLabel(
          getFixedPumpFlowRateForDuration(block.durationMs, fixedFit),
        )}`
      : getFlowRateLabel(block.flowRate);
  const durationLabel = formatDuration(block.durationMs);
  const deviceTypeLabel = getDeviceTypeLabel(deviceType);
  const contentWidth = Math.max(0, width - 40);
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
        132,
        getEstimatedTextWidth(secondaryLabel, 5.2) +
          getEstimatedTextWidth(durationLabel, 6) +
          28,
      );
  const showDuration = showHeader && contentWidth >= 70;
  const leftTextRightInset = isTrigger && width >= 56 ? 44 : 12;
  const badgeRightOffset = isTrigger && width >= 56 ? 40 : 12;
  const badgeMaxWidth = isTrigger && width >= 56
    ? "min(7.2rem, 44%)"
    : "min(9.5rem, 52%)";

  return (
    <div
      data-block-root="true"
      className={cn(
        "absolute top-1.5 z-20 flex h-[52px] min-w-0 touch-none select-none flex-col justify-between overflow-visible rounded-xl border text-left shadow-[0_14px_28px_-22px_rgba(15,23,42,0.28)] outline-none transition-colors focus:outline-none focus-visible:outline-none focus-visible:ring-0",
        showHeader ? "cursor-grab px-3 py-2 active:cursor-grabbing" : "cursor-grab p-0 active:cursor-grabbing",
        isTrigger
          ? isAlternateShade
            ? "border-violet-300 bg-[linear-gradient(180deg,rgba(237,233,254,0.98),rgba(196,181,253,0.92))] text-slate-800"
            : "border-violet-200 bg-[linear-gradient(180deg,rgba(245,243,255,0.98),rgba(221,214,254,0.92))] text-slate-800"
          : isAlternateShade
            ? "border-orange-300 bg-[linear-gradient(180deg,rgba(255,237,213,0.98),rgba(253,186,116,0.92))] text-slate-800"
            : "border-orange-200 bg-[linear-gradient(180deg,rgba(255,247,237,0.98),rgba(254,215,170,0.92))] text-slate-800",
        isSelected &&
          "shadow-[0_0_0_1px_rgba(14,165,233,0.42),0_0_18px_rgba(14,165,233,0.48),0_0_34px_rgba(14,165,233,0.28)]",
        isDimmed && "opacity-25 saturate-50",
        isSyncSourceCandidate &&
          "shadow-[0_0_0_1px_rgba(16,185,129,0.65),0_0_20px_rgba(16,185,129,0.45)]",
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
        className="absolute -left-1 inset-y-0 z-20 cursor-ew-resize rounded-l-xl bg-white/0 transition hover:bg-slate-900/8"
        style={{ width: resizeHandleWidth }}
        onPointerDown={(event) => {
          event.stopPropagation();
          onPointerDownResizeStart(event);
        }}
      />
      <div
        data-block-resize-handle="end"
        className="absolute -right-1 inset-y-0 z-20 cursor-ew-resize rounded-r-xl bg-white/0 transition hover:bg-slate-900/8"
        style={{ width: resizeHandleWidth }}
        onPointerDown={(event) => {
          event.stopPropagation();
          onPointerDownResizeEnd(event);
        }}
      />

      {isTrigger && width >= 56 ? <TriggerGlyph mode={triggerMode} /> : null}

      {showHeader ? (
        <>
          <div
            className={cn(
              "pointer-events-none absolute left-3 top-2 flex min-w-0 flex-col transition-[filter,opacity]",
              isGuideObscured && "blur-[1.5px] opacity-35",
            )}
            style={{ right: leftTextRightInset }}
          >
              <div className="truncate text-[9px] font-semibold uppercase leading-[1.05] tracking-[0.18em] text-slate-500">
                {getDeviceTypeLabel(deviceType)}
              </div>
              <div className="mt-1 truncate text-xs font-semibold leading-[1.05]">
                {primaryLabel}
              </div>
              {showDuration ? (
                <div className="mt-0.5 max-w-[42%] truncate font-mono text-[9px] leading-none text-slate-500">
                  {durationLabel}
                </div>
              ) : null}
          </div>

          {showFooter ? (
            <div
              className={cn(
                "pointer-events-none absolute bottom-2 flex items-center justify-end overflow-hidden text-[9px] leading-none transition-[filter,opacity]",
                isGuideObscured && "blur-[1.5px] opacity-35",
              )}
              style={{
                maxWidth: badgeMaxWidth,
                right: badgeRightOffset,
              }}
            >
              <div
                className="min-w-0 truncate rounded-full border border-white/60 bg-white/72 px-1.5 py-0.5 font-medium text-slate-700"
                style={{ maxWidth: "min(9.5rem, 100%)" }}
              >
                {secondaryLabel}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
