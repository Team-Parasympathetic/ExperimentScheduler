import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { msToPx, pxToMs } from "@/lib/time";
import { ScheduleBlock } from "@/components/schedule-block";
import { cn } from "@/lib/utils";
import type { Block, Row } from "@/types/scheduler";

type DragMode = "move" | "resize-start" | "resize-end";

interface TimelineRowProps {
  row: Row;
  blocks: Block[];
  gridSizeMs: number;
  zoomPxPerMinute: number;
  timelineWidth: number;
  totalDurationMs: number;
  selectedBlockIds: string[];
  isStriped: boolean;
  onSelectBlock: (
    blockId: string,
    options?: { additive?: boolean; range?: boolean },
  ) => void;
  onSetPasteTarget: (rowId: string, timeMs: number) => void;
  onOpenContextMenu: (blockId: string, x: number, y: number) => void;
  onCreateBlock: (timeMs: number) => void;
  onBlockPointerDown: (
    blockId: string,
    mode: DragMode,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
}

export function TimelineRow({
  row,
  blocks,
  gridSizeMs,
  isStriped,
  onBlockPointerDown,
  onCreateBlock,
  onOpenContextMenu,
  onSelectBlock,
  onSetPasteTarget,
  selectedBlockIds,
  timelineWidth,
  totalDurationMs,
  zoomPxPerMinute,
}: TimelineRowProps) {
  const gridPixelSize = msToPx(gridSizeMs, zoomPxPerMinute);
  const isScheduleStatus = Boolean(row.isScheduleStatus);

  return (
    <div
      className="relative cursor-grab"
      data-main-track="true"
      data-pan-track="true"
      style={{
        width: timelineWidth,
      }}
      onDoubleClick={(event) => {
        if (isScheduleStatus) {
          return;
        }

        const target = event.target as HTMLElement | null;
        if (target?.closest("[data-block-root='true']")) {
          return;
        }

        const rect = event.currentTarget.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const timeMs = Math.max(0, Math.min(totalDurationMs, pxToMs(offsetX, zoomPxPerMinute)));
        onCreateBlock(timeMs);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || isScheduleStatus) {
          return;
        }

        const target = event.target as HTMLElement | null;
        if (target?.closest("[data-block-root='true']")) {
          return;
        }

        const rect = event.currentTarget.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const timeMs = Math.max(0, Math.min(totalDurationMs, pxToMs(offsetX, zoomPxPerMinute)));
        onSetPasteTarget(row.id, timeMs);
      }}
    >
      <div
        className={cn(
          "timeline-grid absolute inset-0",
          isScheduleStatus
            ? "bg-cyan-50/90"
            : isStriped
              ? "bg-scheduler-lane-alt/80"
              : "bg-scheduler-lane/80",
        )}
        style={{
          backgroundSize: `${gridPixelSize}px 100%, ${gridPixelSize}px 100%, 100% 100%`,
        }}
      />
      {isScheduleStatus ? (
        <>
          <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(14,116,144,0.11)_0,rgba(14,116,144,0.11)_8px,rgba(255,255,255,0)_8px,rgba(255,255,255,0)_16px)]" />
          <div className="pointer-events-none absolute inset-y-0 left-4 flex items-center">
            <span className="rounded-full border border-cyan-200 bg-white/80 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-800 shadow-sm">
              Schedule Status Output
            </span>
          </div>
        </>
      ) : null}
      <div className="absolute inset-y-0 left-0 w-px bg-border/70" />

      {blocks.map((block, blockIndex) => (
        <ScheduleBlock
          key={block.id}
          block={block}
          row={row}
          isSelected={selectedBlockIds.includes(block.id)}
          left={msToPx(block.startMs, zoomPxPerMinute)}
          shadeIndex={blockIndex}
          width={msToPx(block.durationMs, zoomPxPerMinute)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelectBlock(block.id);
            onOpenContextMenu(block.id, event.clientX, event.clientY);
          }}
          onPointerDownMove={(event) => onBlockPointerDown(block.id, "move", event)}
          onPointerDownResizeStart={(event) =>
            onBlockPointerDown(block.id, "resize-start", event)
          }
          onPointerDownResizeEnd={(event) =>
            onBlockPointerDown(block.id, "resize-end", event)
          }
          onSelect={(event: ReactMouseEvent<HTMLDivElement>) =>
            onSelectBlock(block.id, {
              additive: event.metaKey || event.ctrlKey,
              range: event.shiftKey,
            })
          }
        />
      ))}
    </div>
  );
}
