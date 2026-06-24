import { useState } from "react";
import { getSortedRowBlocks } from "@/lib/schedule";
import { cn } from "@/lib/utils";
import { useSchedulerStore } from "@/store/scheduler-store";
import type { Block, Row } from "@/types/scheduler";

interface OverviewMinimapProps {
  rows: Row[];
  blocks: Block[];
  totalDurationMs: number;
  viewportStartMs: number;
  viewportDurationMs: number;
  onJumpToTime: (timeMs: number, behavior?: ScrollBehavior) => void;
}

export function OverviewMinimap({
  rows,
  blocks,
  totalDurationMs,
  viewportDurationMs,
  viewportStartMs,
  onJumpToTime,
}: OverviewMinimapProps) {
  const playheadMs = useSchedulerStore((state) => state.playheadMs);
  const [isDragging, setIsDragging] = useState(false);
  const trackAreaHeight = 148;
  const rowGap = rows.length > 1 ? 4 : 0;
  const rowHeight = rows.length > 0
    ? Math.max(
        5,
        Math.min(16, (trackAreaHeight - rowGap * (rows.length - 1)) / rows.length),
      )
    : 16;
  const viewportWidthPercent = Math.min(
    100,
    Math.max(8, (viewportDurationMs / totalDurationMs) * 100),
  );
  const viewportLeftPercent = Math.max(0, Math.min(
    100 - viewportWidthPercent,
    (viewportStartMs / totalDurationMs) * 100,
  ));
  const scrollToPointer = (element: HTMLElement, clientX: number) => {
    const rect = element.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onJumpToTime(totalDurationMs * ratio - viewportDurationMs / 2, "auto");
  };

  return (
    <div className="space-y-2">
      <div
        className={`relative block w-full overflow-hidden rounded-2xl border border-border/60 bg-slate-50/90 p-2 text-left ${
          isDragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        role="slider"
        aria-label="Schedule overview"
        aria-valuemax={totalDurationMs}
        aria-valuemin={0}
        aria-valuenow={viewportStartMs}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setIsDragging(true);
          scrollToPointer(event.currentTarget, event.clientX);
        }}
        onPointerMove={(event) => {
          if (!isDragging) {
            return;
          }

          scrollToPointer(event.currentTarget, event.clientX);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setIsDragging(false);
        }}
        onPointerCancel={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setIsDragging(false);
        }}
        onWheel={(event) => {
          event.preventDefault();

          const rect = event.currentTarget.getBoundingClientRect();
          const scrollDeltaPx = event.deltaX !== 0 ? event.deltaX : event.deltaY;
          const durationPerPixel = totalDurationMs / Math.max(rect.width, 1);
          onJumpToTime(viewportStartMs + scrollDeltaPx * durationPerPixel * 8, "auto");
        }}
      >
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(148,163,184,0.06),transparent_25%,transparent_75%,rgba(148,163,184,0.06))]" />
        <div className="relative" style={{ height: trackAreaHeight }}>
          {rows.map((row, rowIndex) => (
            <div
              key={row.id}
              className={cn(
                "absolute left-0 right-0 overflow-hidden rounded-md",
                row.isScheduleStatus
                  ? "bg-cyan-50/90 shadow-[inset_0_0_0_1px_rgba(14,116,144,0.12)]"
                  : "bg-white/80",
              )}
              style={{
                height: rowHeight,
                top: rowIndex * (rowHeight + rowGap),
              }}
            >
              {row.isScheduleStatus ? (
                <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(14,116,144,0.16)_0,rgba(14,116,144,0.16)_4px,rgba(255,255,255,0)_4px,rgba(255,255,255,0)_8px)]" />
              ) : null}
              {getSortedRowBlocks(blocks, row.id).map((block, blockIndex) => {
                const left = (block.startMs / totalDurationMs) * 100;
                const width = (block.durationMs / totalDurationMs) * 100;
                const isAlternateShade = blockIndex % 2 === 1;
                return (
                  <div
                    key={block.id}
                    className={cn(
                      "absolute top-1/2 -translate-y-1/2 rounded-full",
                      row.deviceType === "trigger"
                        ? isAlternateShade
                          ? "bg-violet-500 shadow-[0_0_20px_rgba(139,92,246,0.2)]"
                          : "bg-violet-300 shadow-[0_0_20px_rgba(139,92,246,0.18)]"
                        : isAlternateShade
                          ? "bg-orange-500 shadow-[0_0_20px_rgba(251,146,60,0.2)]"
                          : "bg-orange-300 shadow-[0_0_20px_rgba(251,146,60,0.18)]",
                    )}
                    style={{
                      height: Math.max(3, Math.min(10, rowHeight * 0.68)),
                      left: `${left}%`,
                      width: `${width}%`,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>

        <div
          className="pointer-events-none absolute inset-y-2 rounded-xl border border-cyan-400/60 bg-cyan-400/12 shadow-[0_0_0_1px_rgba(34,211,238,0.14)]"
          style={{
            left: `${viewportLeftPercent}%`,
            width: `${viewportWidthPercent}%`,
          }}
        />
        <div
          className="pointer-events-none absolute inset-y-2 w-px bg-rose-500/85 shadow-[0_0_10px_rgba(244,63,94,0.32)]"
          style={{
            left: `${Math.min(100, (playheadMs / totalDurationMs) * 100)}%`,
          }}
        />
      </div>

      <div className="flex items-center justify-between px-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        <span>0:00</span>
        <span>{Math.round(totalDurationMs / 60_000)} min</span>
      </div>
    </div>
  );
}
