import { useEffect, useMemo, useState, type RefObject } from "react";
import { RowSidebar } from "@/components/row-sidebar";
import { TimelineRow } from "@/components/timeline-row";
import {
  ROW_HEADER_WIDTH,
  TIME_RULER_HEIGHT,
  TIMELINE_ROW_HEIGHT,
} from "@/lib/layout";
import {
  MAX_ZOOM_PX_PER_MINUTE,
  MIN_ZOOM_PX_PER_MINUTE,
  MIN_BLOCK_DURATION_MS,
  SECOND_MS,
  clampBlockStart,
  formatTimelineTime,
  getLabelEvery,
  msToPx,
  pxToMs,
  snapMs,
} from "@/lib/time";
import { getBlockById, getRowsById, getSortedRowBlocks } from "@/lib/schedule";
import { clamp } from "@/lib/utils";
import { useSchedulerStore } from "@/store/scheduler-store";
import type { Block, Row } from "@/types/scheduler";

type DragMode = "move" | "resize-start" | "resize-end";

interface DragState {
  blockId: string;
  mode: DragMode;
  originX: number;
  originY: number;
  originBlock: Block;
  originRow: Row;
  originRowIndex: number;
}

interface PanState {
  originX: number;
  originY: number;
  scrollLeft: number;
  scrollTop: number;
}

interface TimelineGridProps {
  totalDurationMs: number;
  scrollRef: RefObject<HTMLDivElement>;
  onOpenBlockContextMenu: (blockId: string, x: number, y: number) => void;
  onDismissContextMenu: () => void;
}

export function TimelineGrid({
  totalDurationMs,
  scrollRef,
  onDismissContextMenu,
  onOpenBlockContextMenu,
}: TimelineGridProps) {
  const rows = useSchedulerStore((state) => state.rows);
  const blocks = useSchedulerStore((state) => state.blocks);
  const gridSizeMs = useSchedulerStore((state) => state.gridSizeMs);
  const zoomPxPerMinute = useSchedulerStore((state) => state.zoomPxPerMinute);
  const playheadMs = useSchedulerStore((state) => state.playheadMs);
  const selectedBlockIds = useSchedulerStore((state) => state.selectedBlockIds);
  const addBlock = useSchedulerStore((state) => state.addBlock);
  const updateBlock = useSchedulerStore((state) => state.updateBlock);
  const setSelectedBlock = useSchedulerStore((state) => state.setSelectedBlock);
  const setPasteTarget = useSchedulerStore((state) => state.setPasteTarget);
  const setZoomPxPerMinute = useSchedulerStore((state) => state.setZoomPxPerMinute);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [panState, setPanState] = useState<PanState | null>(null);

  const timelineWidth = Math.max(msToPx(totalDurationMs, zoomPxPerMinute), 1200);
  const renderedGridSizeMs = Math.max(gridSizeMs, SECOND_MS);
  const labelEvery = getLabelEvery(renderedGridSizeMs, zoomPxPerMinute);
  const tickCount = Math.ceil(totalDurationMs / renderedGridSizeMs) + 1;

  const rowsById = useMemo(
    () => getRowsById(rows),
    [rows],
  );

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const originType = dragState.originRow.deviceType;
      const rawDeltaMs = pxToMs(event.clientX - dragState.originX, zoomPxPerMinute);

      if (dragState.mode === "move") {
        const nextStartMs = clampBlockStart(
          snapMs(dragState.originBlock.startMs + rawDeltaMs, gridSizeMs),
          dragState.originBlock.durationMs,
          totalDurationMs,
        );

        let nextRowId = dragState.originBlock.rowId;
        const rowDragDeltaY = event.clientY - dragState.originY;
        const rowSwitchThreshold = TIMELINE_ROW_HEIGHT * 0.72;
        const rowOffset =
          Math.abs(rowDragDeltaY) < rowSwitchThreshold
            ? 0
            : Math.sign(rowDragDeltaY) *
              Math.floor(
                (Math.abs(rowDragDeltaY) - rowSwitchThreshold) / TIMELINE_ROW_HEIGHT + 1,
              );
        const nextRowIndex = clamp(
          dragState.originRowIndex + rowOffset,
          0,
          rows.length - 1,
        );
        const hoveredRow = rows[nextRowIndex];

        if (
          hoveredRow &&
          hoveredRow.deviceType === originType &&
          !hoveredRow.isScheduleStatus
        ) {
          nextRowId = hoveredRow.id;
        }

        updateBlock(dragState.blockId, {
          rowId: nextRowId,
          startMs: nextStartMs,
        });
        setSelectedBlock(dragState.blockId);
        return;
      }

      if (dragState.mode === "resize-start") {
        const endMs = dragState.originBlock.startMs + dragState.originBlock.durationMs;
        const nextStartMs = clamp(
          snapMs(dragState.originBlock.startMs + rawDeltaMs, gridSizeMs),
          0,
          endMs - MIN_BLOCK_DURATION_MS,
        );

        updateBlock(dragState.blockId, {
          startMs: nextStartMs,
          durationMs: endMs - nextStartMs,
        });
        setSelectedBlock(dragState.blockId);
        return;
      }

      const nextEndMs = clamp(
        snapMs(
          dragState.originBlock.startMs + dragState.originBlock.durationMs + rawDeltaMs,
          gridSizeMs,
        ),
        dragState.originBlock.startMs + MIN_BLOCK_DURATION_MS,
        totalDurationMs,
      );

      updateBlock(dragState.blockId, {
        durationMs: nextEndMs - dragState.originBlock.startMs,
      });
      setSelectedBlock(dragState.blockId);
    };

    const handlePointerUp = () => {
      setDragState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [
    dragState,
    gridSizeMs,
    rows,
    rowsById,
    scrollRef,
    setSelectedBlock,
    totalDurationMs,
    updateBlock,
    zoomPxPerMinute,
  ]);

  useEffect(() => {
    if (!panState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const container = scrollRef.current;
      if (!container) {
        return;
      }

      container.scrollLeft = panState.scrollLeft - (event.clientX - panState.originX);
      container.scrollTop = panState.scrollTop - (event.clientY - panState.originY);
    };

    const handlePointerUp = () => {
      setPanState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [panState, scrollRef]);

  return (
    <div className="glass-panel min-h-0 overflow-hidden rounded-[28px] border border-border/70 shadow-panel">
      <div
        ref={scrollRef}
        className={`thin-scrollbar h-full overflow-auto ${panState ? "cursor-grabbing select-none" : ""}`}
        onWheel={(event) => {
          const target = event.target as HTMLElement | null;

          if (!target?.closest("[data-main-track='true']") || event.deltaY === 0) {
            return;
          }

          const container = scrollRef.current;
          if (!container) {
            return;
          }

          const nextZoomPxPerMinute = clamp(
            zoomPxPerMinute * Math.exp(-event.deltaY * 0.006),
            MIN_ZOOM_PX_PER_MINUTE,
            MAX_ZOOM_PX_PER_MINUTE,
          );

          event.preventDefault();

          if (nextZoomPxPerMinute === zoomPxPerMinute) {
            return;
          }

          const rect = container.getBoundingClientRect();
          const trackViewportX = Math.max(0, event.clientX - rect.left - ROW_HEADER_WIDTH);
          const timeAtPointerMs = pxToMs(
            container.scrollLeft + trackViewportX,
            zoomPxPerMinute,
          );

          setZoomPxPerMinute(nextZoomPxPerMinute);

          window.requestAnimationFrame(() => {
            container.scrollLeft = Math.max(
              0,
              msToPx(timeAtPointerMs, nextZoomPxPerMinute) - trackViewportX,
            );
          });
        }}
        onPointerDown={(event) => {
          onDismissContextMenu();

          if (event.button !== 0 || dragState) {
            return;
          }

          const target = event.target as HTMLElement | null;
          if (!target?.closest("[data-pan-track='true']")) {
            return;
          }

          if (target.closest("[data-block-root='true']")) {
            return;
          }

          const container = scrollRef.current;
          if (!container) {
            return;
          }

          event.preventDefault();
          setPanState({
            originX: event.clientX,
            originY: event.clientY,
            scrollLeft: container.scrollLeft,
            scrollTop: container.scrollTop,
          });
        }}
      >
        <div
          className="relative"
          style={{ minWidth: ROW_HEADER_WIDTH + timelineWidth }}
        >
          <div
            className="pointer-events-none absolute bottom-0 z-30 w-0"
            style={{
              left: ROW_HEADER_WIDTH + clamp(msToPx(playheadMs, zoomPxPerMinute), 0, timelineWidth),
              top: TIME_RULER_HEIGHT,
            }}
          >
            <div className="absolute bottom-0 top-0 left-0 w-px -translate-x-1/2 bg-[linear-gradient(180deg,rgba(244,63,94,0.95),rgba(244,63,94,0.38))] shadow-[0_0_12px_rgba(244,63,94,0.3)]" />
          </div>

          <div
            className="sticky top-0 z-30 grid border-b border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(246,250,252,0.92))] backdrop-blur"
            style={{
              gridTemplateColumns: `${ROW_HEADER_WIDTH}px ${timelineWidth}px`,
              height: TIME_RULER_HEIGHT,
            }}
          >
            <div className="sticky left-0 z-40 flex items-center border-r border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(246,250,252,0.96))] px-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  Device Channels
                </div>
                <div className="mt-1 text-sm font-medium text-foreground">Timeline Playlist</div>
              </div>
            </div>

            <div
              className={`relative border-l border-border/40 ${panState ? "cursor-grabbing" : "cursor-grab"}`}
              data-main-track="true"
              data-pan-track="true"
              style={{
                width: timelineWidth,
              }}
            >
              <div
                className="pointer-events-none absolute top-2 z-20 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-white bg-rose-500 shadow-[0_6px_18px_rgba(244,63,94,0.35)]"
                style={{
                  left: clamp(msToPx(playheadMs, zoomPxPerMinute), 0, timelineWidth),
                }}
              />
              {Array.from({ length: tickCount }).map((_, index) => {
                const left = msToPx(index * renderedGridSizeMs, zoomPxPerMinute);
                const isMajor = index % labelEvery === 0;
                return (
                  <div
                    key={index}
                    className="absolute inset-y-0"
                    style={{ left }}
                  >
                    <div
                      className={`absolute inset-y-0 w-px ${
                        isMajor ? "bg-slate-300" : "bg-slate-200/80"
                      }`}
                    />
                    {isMajor ? (
                      <div className="absolute left-2 top-2 font-mono text-[11px] text-muted-foreground">
                        {formatTimelineTime(index * renderedGridSizeMs)}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {rows.map((row, rowIndex) => {
            const rowBlocks = getSortedRowBlocks(blocks, row.id);
            return (
              <div
                key={row.id}
                className="grid border-b border-border/50 last:border-b-0"
                style={{
                  gridTemplateColumns: `${ROW_HEADER_WIDTH}px ${timelineWidth}px`,
                  minHeight: TIMELINE_ROW_HEIGHT,
                }}
              >
                <RowSidebar
                  row={row}
                  blockCount={rowBlocks.length}
                  onCreateBlock={() =>
                    addBlock(row.id, snapMs(rowIndex * gridSizeMs * 2, gridSizeMs))
                  }
                />
                <TimelineRow
                  blocks={rowBlocks}
                  gridSizeMs={renderedGridSizeMs}
                  isStriped={rowIndex % 2 === 1}
                  row={row}
                  selectedBlockIds={selectedBlockIds}
                  timelineWidth={timelineWidth}
                  totalDurationMs={totalDurationMs}
                  zoomPxPerMinute={zoomPxPerMinute}
                  onBlockPointerDown={(blockId, mode, event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey) {
                      return;
                    }

                    const block = getBlockById(blocks, blockId);
                    const originRow = rowsById[block?.rowId ?? ""];
                    if (!block || !originRow) {
                      return;
                    }
                    const originRowIndex = rows.findIndex((item) => item.id === originRow.id);

                    event.preventDefault();
                    event.stopPropagation();
                    setSelectedBlock(blockId);
                    setDragState({
                      blockId,
                      mode,
                      originX: event.clientX,
                      originY: event.clientY,
                      originBlock: block,
                      originRow,
                      originRowIndex: Math.max(0, originRowIndex),
                    });
                  }}
                  onCreateBlock={(timeMs) => {
                    addBlock(row.id, snapMs(timeMs, gridSizeMs));
                  }}
                  onOpenContextMenu={onOpenBlockContextMenu}
                  onSetPasteTarget={(rowId, timeMs) => {
                    setSelectedBlock(null);
                    setPasteTarget(rowId, snapMs(timeMs, gridSizeMs));
                  }}
                  onSelectBlock={setSelectedBlock}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
