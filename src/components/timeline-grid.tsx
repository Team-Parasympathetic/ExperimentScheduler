import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
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
  formatDuration,
  formatSecondsPerDivision,
  formatTimelineTime,
  getBlockEnd,
  getLabelEvery,
  getVisibleGridSizeMs,
  msToPx,
  pxToMs,
  snapMs,
} from "@/lib/time";
import { getBlockById, getRowsById, getSortedRowBlocks } from "@/lib/schedule";
import { BLOCK_CREATION_GUIDE_EVENT } from "@/lib/smart-guides";
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
  originBlocks: Block[];
  originRow: Row;
  originRowIndex: number;
}

interface PanState {
  originX: number;
  originY: number;
  scrollLeft: number;
  scrollTop: number;
}

interface DistanceGuide {
  distanceMs: number;
  sourceRowIndex: number;
  targetRowIndex: number;
  startMs: number;
  endMs: number;
}

interface ActiveGuideEdge {
  timeMs: number;
  rowIndex: number;
}

interface CandidateGuideEdge {
  timeMs: number;
  rowIndex: number;
  priority: number;
}

const CREATION_GUIDE_DURATION_MS = 1_200;
const BLOCK_TOP_OFFSET_PX = 6;
const BLOCK_HEIGHT_PX = 52;
const GUIDE_LABEL_HALF_WIDTH_PX = 52;
const GUIDE_LABEL_TOP_OFFSET_PX = 38;
const GUIDE_LABEL_BOTTOM_OFFSET_PX = 4;

function pointInRect(
  containerLeft: number,
  containerRight: number,
  containerTop: number,
  containerBottom: number,
  pointX: number,
  pointY: number,
) {
  return (
    pointX >= containerLeft &&
    pointX <= containerRight &&
    pointY >= containerTop &&
    pointY <= containerBottom
  );
}

interface TimelineGridProps {
  totalDurationMs: number;
  scrollRef: RefObject<HTMLDivElement>;
  onOpenBlockContextMenu: (blockId: string, x: number, y: number) => void;
  onOpenInsertContextMenu: (rowId: string, timeMs: number, x: number, y: number) => void;
  onDismissContextMenu: () => void;
}

export function TimelineGrid({
  totalDurationMs,
  scrollRef,
  onDismissContextMenu,
  onOpenBlockContextMenu,
  onOpenInsertContextMenu,
}: TimelineGridProps) {
  const rows = useSchedulerStore((state) => state.rows);
  const blocks = useSchedulerStore((state) => state.blocks);
  const gridSizeMs = useSchedulerStore((state) => state.gridSizeMs);
  const zoomPxPerMinute = useSchedulerStore((state) => state.zoomPxPerMinute);
  const playheadMs = useSchedulerStore((state) => state.playheadMs);
  const selectedRowId = useSchedulerStore((state) => state.selectedRowId);
  const selectedBlockIds = useSchedulerStore((state) => state.selectedBlockIds);
  const syncSourcePickTargetBlockId = useSchedulerStore(
    (state) => state.syncSourcePickTargetBlockId,
  );
  const addBlock = useSchedulerStore((state) => state.addBlock);
  const updateBlock = useSchedulerStore((state) => state.updateBlock);
  const moveBlocks = useSchedulerStore((state) => state.moveBlocks);
  const beginHistoryEntry = useSchedulerStore((state) => state.beginHistoryEntry);
  const commitHistoryEntry = useSchedulerStore((state) => state.commitHistoryEntry);
  const setSelectedBlock = useSchedulerStore((state) => state.setSelectedBlock);
  const setSyncSourcePickTargetBlock = useSchedulerStore(
    (state) => state.setSyncSourcePickTargetBlock,
  );
  const setPasteTarget = useSchedulerStore((state) => state.setPasteTarget);
  const setZoomPxPerMinute = useSchedulerStore((state) => state.setZoomPxPerMinute);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [panState, setPanState] = useState<PanState | null>(null);
  const zoomPxPerMinuteRef = useRef(zoomPxPerMinute);
  const pendingZoomPxPerMinuteRef = useRef<number | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const zoomAnchorRef = useRef<{
    timeAtPointerMs: number;
    trackViewportX: number;
  } | null>(null);
  const creationGuideTimeoutRef = useRef<number | null>(null);
  const [creationGuideBlockIds, setCreationGuideBlockIds] = useState<string[]>([]);

  const timelineWidth = Math.max(msToPx(totalDurationMs, zoomPxPerMinute), 1200);
  const playheadLeftPx = clamp(msToPx(playheadMs, zoomPxPerMinute), 0, timelineWidth);
  const renderedGridSizeMs = getVisibleGridSizeMs(gridSizeMs, zoomPxPerMinute);
  const labelEvery = getLabelEvery(renderedGridSizeMs, zoomPxPerMinute);
  const tickCount = Math.ceil(totalDurationMs / renderedGridSizeMs) + 1;
  const gridTicks = useMemo(
    () =>
      Array.from({ length: tickCount }, (_, index) => ({
        timeMs: index * renderedGridSizeMs,
        left: msToPx(index * renderedGridSizeMs, zoomPxPerMinute),
        isMajor: index % labelEvery === 0,
      })),
    [labelEvery, renderedGridSizeMs, tickCount, zoomPxPerMinute],
  );
  const secondsPerDivisionLabel = formatSecondsPerDivision(renderedGridSizeMs);
  const rowsById = useMemo(
    () => getRowsById(rows),
    [rows],
  );
  const showCreationGuideForBlockIds = useCallback((blockIds: string[]) => {
    if (blockIds.length === 0) {
      return;
    }

    setCreationGuideBlockIds(blockIds);

    if (creationGuideTimeoutRef.current !== null) {
      window.clearTimeout(creationGuideTimeoutRef.current);
    }

    creationGuideTimeoutRef.current = window.setTimeout(() => {
      creationGuideTimeoutRef.current = null;
      setCreationGuideBlockIds([]);
    }, CREATION_GUIDE_DURATION_MS);
  }, []);
  const addBlockWithCreationGuide = useCallback(
    (rowId: string, startMs: number) => {
      const previousBlockIds = new Set(
        useSchedulerStore.getState().blocks.map((block) => block.id),
      );

      addBlock(rowId, startMs);

      const newBlockIds = useSchedulerStore
        .getState()
        .blocks.filter((block) => !previousBlockIds.has(block.id))
        .map((block) => block.id);

      showCreationGuideForBlockIds(newBlockIds);
    },
    [addBlock, showCreationGuideForBlockIds],
  );
  const distanceGuide = useMemo<DistanceGuide | null>(() => {
    if (blocks.length < 2) {
      return null;
    }

    const movingBlockIds = new Set(
      dragState
        ? (dragState.originBlocks.length > 0
            ? dragState.originBlocks
            : [dragState.originBlock]
          ).map((block) => block.id)
        : [],
    );
    const creationBlockIdSet = new Set(creationGuideBlockIds);
    const excludedBlockIds = dragState ? movingBlockIds : creationBlockIdSet;
    const activeEdges: ActiveGuideEdge[] = [];

    if (dragState) {
      const activeBlocks = blocks.filter((block) => movingBlockIds.has(block.id));

      if (activeBlocks.length === 0) {
        return null;
      }

      if (dragState.mode === "move") {
        const groupStartMs = Math.min(...activeBlocks.map((block) => block.startMs));
        const groupEndMs = Math.max(...activeBlocks.map((block) => getBlockEnd(block)));
        const sourceRowIndex = rows.findIndex((row) => row.id === activeBlocks[0]?.rowId);

        if (sourceRowIndex < 0) {
          return null;
        }

        activeEdges.push(
          { timeMs: groupStartMs, rowIndex: sourceRowIndex },
          { timeMs: groupEndMs, rowIndex: sourceRowIndex },
        );
      } else {
        const activeBlock = activeBlocks.find((block) => block.id === dragState.blockId);
        const sourceRowIndex = rows.findIndex((row) => row.id === activeBlock?.rowId);

        if (!activeBlock || sourceRowIndex < 0) {
          return null;
        }

        activeEdges.push({
          timeMs:
            dragState.mode === "resize-start"
              ? activeBlock.startMs
              : getBlockEnd(activeBlock),
          rowIndex: sourceRowIndex,
        });
      }
    } else if (creationGuideBlockIds.length > 0) {
      const createdBlocks = blocks.filter((block) => creationBlockIdSet.has(block.id));

      if (createdBlocks.length > 0) {
        const groupStartMs = Math.min(...createdBlocks.map((block) => block.startMs));
        const groupEndMs = Math.max(...createdBlocks.map((block) => getBlockEnd(block)));
        const sourceRowIndex = rows.findIndex((row) => row.id === createdBlocks[0]?.rowId);

        if (sourceRowIndex >= 0) {
          activeEdges.push(
            { timeMs: groupStartMs, rowIndex: sourceRowIndex },
            { timeMs: groupEndMs, rowIndex: sourceRowIndex },
          );
        }
      }
    }

    if (activeEdges.length === 0) {
      return null;
    }

    const candidateEdges: CandidateGuideEdge[] = [];

    for (const candidateBlock of blocks) {
      if (excludedBlockIds.has(candidateBlock.id)) {
        continue;
      }

      const candidateRowIndex = rows.findIndex((row) => row.id === candidateBlock.rowId);
      if (candidateRowIndex < 0) {
        continue;
      }

      candidateEdges.push(
        { timeMs: candidateBlock.startMs, rowIndex: candidateRowIndex, priority: 0 },
        { timeMs: getBlockEnd(candidateBlock), rowIndex: candidateRowIndex, priority: 0 },
      );
    }

    if (candidateEdges.length === 0) {
      const sourceRowIndex = activeEdges[0].rowIndex;
      candidateEdges.push(
        ...gridTicks.map((tick) => ({
          timeMs: tick.timeMs,
          rowIndex: sourceRowIndex,
          priority: 1,
        })),
      );
    }

    let closestGuide: DistanceGuide | null = null;
    let closestPriority = Number.POSITIVE_INFINITY;

    for (const activeEdge of activeEdges) {
      for (const candidateEdge of candidateEdges) {
        const distanceMs = Math.abs(activeEdge.timeMs - candidateEdge.timeMs);
        const rowDistance = Math.abs(candidateEdge.rowIndex - activeEdge.rowIndex);
        const closestRowDistance = closestGuide
          ? Math.abs(closestGuide.targetRowIndex - closestGuide.sourceRowIndex)
          : Number.POSITIVE_INFINITY;
        const effectivePriority =
          candidateEdge.priority + (candidateEdge.rowIndex === activeEdge.rowIndex ? 0 : 10);

        if (
          !closestGuide ||
          distanceMs < closestGuide.distanceMs ||
          (distanceMs === closestGuide.distanceMs && rowDistance < closestRowDistance) ||
          (distanceMs === closestGuide.distanceMs &&
            rowDistance === closestRowDistance &&
            effectivePriority < closestPriority)
        ) {
          closestGuide = {
            distanceMs,
            sourceRowIndex: activeEdge.rowIndex,
            targetRowIndex: candidateEdge.rowIndex,
            startMs: Math.min(candidateEdge.timeMs, activeEdge.timeMs),
            endMs: Math.max(candidateEdge.timeMs, activeEdge.timeMs),
          };
          closestPriority = effectivePriority;
        }
      }
    }

    return closestGuide;
  }, [blocks, creationGuideBlockIds, dragState, gridTicks, rows]);
  const guideObscuredBlockIds = useMemo(() => {
    if (!distanceGuide || distanceGuide.distanceMs === 0) {
      return new Set<string>();
    }

    const guideStartPx = msToPx(distanceGuide.startMs, zoomPxPerMinute);
    const guideEndPx = msToPx(distanceGuide.endMs, zoomPxPerMinute);
    const guideLeftPx = Math.min(guideStartPx, guideEndPx);
    const guideWidthPx = Math.abs(guideEndPx - guideStartPx);
    const sourceCenterY =
      distanceGuide.sourceRowIndex * TIMELINE_ROW_HEIGHT + TIMELINE_ROW_HEIGHT / 2;
    const targetCenterY =
      distanceGuide.targetRowIndex * TIMELINE_ROW_HEIGHT + TIMELINE_ROW_HEIGHT / 2;
    const labelLeftPx = clamp(
      guideLeftPx + guideWidthPx / 2,
      36,
      Math.max(36, timelineWidth - 36),
    );
    const labelCenterX = labelLeftPx;
    const labelCenterY =
      sourceCenterY - (GUIDE_LABEL_TOP_OFFSET_PX + GUIDE_LABEL_BOTTOM_OFFSET_PX) / 2;
    const obscuredBlockIds = new Set<string>();

    for (const block of blocks) {
      const rowIndex = rows.findIndex((row) => row.id === block.rowId);

      if (rowIndex < 0) {
        continue;
      }

      const blockLeftPx = msToPx(block.startMs, zoomPxPerMinute);
      const blockRightPx = msToPx(getBlockEnd(block), zoomPxPerMinute);
      const blockTopPx = rowIndex * TIMELINE_ROW_HEIGHT + BLOCK_TOP_OFFSET_PX;
      const blockBottomPx = blockTopPx + BLOCK_HEIGHT_PX;

      if (
        pointInRect(
          blockLeftPx,
          blockRightPx,
          blockTopPx,
          blockBottomPx,
          labelCenterX,
          labelCenterY,
        )
      ) {
        obscuredBlockIds.add(block.id);
      }
    }

    return obscuredBlockIds;
  }, [blocks, distanceGuide, rows, timelineWidth, zoomPxPerMinute]);

  useEffect(() => {
    zoomPxPerMinuteRef.current = zoomPxPerMinute;
  }, [zoomPxPerMinute]);

  useEffect(
    () => () => {
      if (zoomFrameRef.current !== null) {
        window.cancelAnimationFrame(zoomFrameRef.current);
      }

      if (creationGuideTimeoutRef.current !== null) {
        window.clearTimeout(creationGuideTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const handleBlockCreationGuide = (event: Event) => {
      const blockIds = (event as CustomEvent<{ blockIds?: string[] }>).detail?.blockIds ?? [];
      showCreationGuideForBlockIds(blockIds);
    };

    window.addEventListener(BLOCK_CREATION_GUIDE_EVENT, handleBlockCreationGuide);

    return () => {
      window.removeEventListener(BLOCK_CREATION_GUIDE_EVENT, handleBlockCreationGuide);
    };
  }, [showCreationGuideForBlockIds]);

  useEffect(() => {
    const container = scrollRef.current;

    if (!container) {
      return;
    }

    const handleWheelCapture = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;

      if (target?.closest("[data-main-track='true']")) {
        event.preventDefault();
      }
    };

    container.addEventListener("wheel", handleWheelCapture, {
      capture: true,
      passive: false,
    });

    return () => {
      container.removeEventListener("wheel", handleWheelCapture, {
        capture: true,
      });
    };
  }, [scrollRef]);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const originType = dragState.originRow.deviceType;
      const rawDeltaMs = pxToMs(event.clientX - dragState.originX, zoomPxPerMinute);

      if (dragState.mode === "move") {
        const originBlocks =
          dragState.originBlocks.length > 0
            ? dragState.originBlocks
            : [dragState.originBlock];
        const groupStartMs = Math.min(...originBlocks.map((block) => block.startMs));
        const groupEndMs = Math.max(
          ...originBlocks.map((block) => block.startMs + block.durationMs),
        );
        const snappedDraggedStartMs = snapMs(
          dragState.originBlock.startMs + rawDeltaMs,
          gridSizeMs,
        );
        const nextDeltaMs = clamp(
          snappedDraggedStartMs - dragState.originBlock.startMs,
          -groupStartMs,
          totalDurationMs - groupEndMs,
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

        moveBlocks(
          originBlocks.map((block) => ({
            blockId: block.id,
            rowId: nextRowId,
            startMs: block.startMs + nextDeltaMs,
          })),
          { recordHistory: false },
        );
        return;
      }

      if (dragState.mode === "resize-start") {
        const endMs = dragState.originBlock.startMs + dragState.originBlock.durationMs;
        const nextStartMs = clamp(
          snapMs(dragState.originBlock.startMs + rawDeltaMs, gridSizeMs),
          0,
          endMs - MIN_BLOCK_DURATION_MS,
        );

        updateBlock(
          dragState.blockId,
          {
            startMs: nextStartMs,
            durationMs: endMs - nextStartMs,
          },
          { recordHistory: false },
        );
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

      updateBlock(
        dragState.blockId,
        {
          durationMs: nextEndMs - dragState.originBlock.startMs,
        },
        { recordHistory: false },
      );
      setSelectedBlock(dragState.blockId);
    };

    const handlePointerUp = () => {
      commitHistoryEntry();
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
    commitHistoryEntry,
    gridSizeMs,
    moveBlocks,
    rows,
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
    <div className="glass-panel h-full min-h-0 overflow-hidden rounded-[28px] border border-border/70 shadow-panel">
      <div
        ref={scrollRef}
        className={`thin-scrollbar h-full overflow-auto ${panState ? "cursor-grabbing select-none" : ""}`}
        onWheel={(event) => {
          const target = event.target as HTMLElement | null;
          const isOverTimeline = Boolean(target?.closest("[data-main-track='true']"));

          if (!isOverTimeline) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();

          if (event.deltaY === 0) {
            return;
          }

          const container = scrollRef.current;
          if (!container) {
            return;
          }

          const rect = container.getBoundingClientRect();
          const trackViewportX = Math.max(0, event.clientX - rect.left - ROW_HEADER_WIDTH);
          const currentZoomPxPerMinute = zoomPxPerMinuteRef.current;
          const timeAtPointerMs = pxToMs(
            container.scrollLeft + trackViewportX,
            currentZoomPxPerMinute,
          );
          const baseZoomPxPerMinute =
            pendingZoomPxPerMinuteRef.current ?? currentZoomPxPerMinute;
          const nextZoomPxPerMinute = clamp(
            baseZoomPxPerMinute * Math.exp(-event.deltaY * 0.0036),
            MIN_ZOOM_PX_PER_MINUTE,
            MAX_ZOOM_PX_PER_MINUTE,
          );

          if (nextZoomPxPerMinute === baseZoomPxPerMinute) {
            return;
          }

          pendingZoomPxPerMinuteRef.current = nextZoomPxPerMinute;
          zoomAnchorRef.current = {
            timeAtPointerMs,
            trackViewportX,
          };

          if (zoomFrameRef.current !== null) {
            return;
          }

          zoomFrameRef.current = window.requestAnimationFrame(() => {
            zoomFrameRef.current = null;
            const committedZoomPxPerMinute = pendingZoomPxPerMinuteRef.current;
            const zoomAnchor = zoomAnchorRef.current;
            pendingZoomPxPerMinuteRef.current = null;
            zoomAnchorRef.current = null;

            if (
              committedZoomPxPerMinute === null ||
              committedZoomPxPerMinute === zoomPxPerMinuteRef.current
            ) {
              return;
            }

            zoomPxPerMinuteRef.current = committedZoomPxPerMinute;
            flushSync(() => {
              setZoomPxPerMinute(committedZoomPxPerMinute);
            });

            if (!zoomAnchor) {
              return;
            }

            container.scrollLeft = Math.max(
              0,
              msToPx(zoomAnchor.timeAtPointerMs, committedZoomPxPerMinute) -
                zoomAnchor.trackViewportX,
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
          {distanceGuide ? (
            <div
              className="pointer-events-none absolute z-40"
              style={{
                left: ROW_HEADER_WIDTH,
                top: TIME_RULER_HEIGHT,
                width: timelineWidth,
                height: rows.length * TIMELINE_ROW_HEIGHT,
              }}
            >
              {(() => {
                const guideStartPx = msToPx(distanceGuide.startMs, zoomPxPerMinute);
                const guideEndPx = msToPx(distanceGuide.endMs, zoomPxPerMinute);
                const guideLeftPx = Math.min(guideStartPx, guideEndPx);
                const guideWidthPx = Math.abs(guideEndPx - guideStartPx);
                const draggedCenterY =
                  distanceGuide.sourceRowIndex * TIMELINE_ROW_HEIGHT +
                  TIMELINE_ROW_HEIGHT / 2;
                const targetCenterY =
                  distanceGuide.targetRowIndex * TIMELINE_ROW_HEIGHT +
                  TIMELINE_ROW_HEIGHT / 2;
                const connectorTop = Math.min(draggedCenterY, targetCenterY);
                const connectorHeight = Math.abs(targetCenterY - draggedCenterY);
                const labelLeftPx = clamp(
                  guideLeftPx + guideWidthPx / 2,
                  36,
                  Math.max(36, timelineWidth - 36),
                );

                return (
                  <>
                    <div
                      className="absolute w-px border-l border-dashed border-sky-400/70"
                      style={{
                        left: guideStartPx,
                        top: connectorTop,
                        height: connectorHeight || TIMELINE_ROW_HEIGHT * 0.42,
                        transform:
                          connectorHeight === 0 ? "translateY(-50%)" : undefined,
                      }}
                    />
                    <div
                      className="absolute w-px border-l border-dashed border-sky-400/70"
                      style={{
                        left: guideEndPx,
                        top: connectorTop,
                        height: connectorHeight || TIMELINE_ROW_HEIGHT * 0.42,
                        transform:
                          connectorHeight === 0 ? "translateY(-50%)" : undefined,
                      }}
                    />
                    <div
                      className="absolute h-px bg-sky-500/85 shadow-[0_0_10px_rgba(14,165,233,0.45)]"
                      style={{
                        left: guideLeftPx,
                        top: draggedCenterY,
                        width: Math.max(guideWidthPx, 1),
                      }}
                    />
                    <div
                      className="absolute h-3 w-px -translate-y-1/2 bg-sky-500"
                      style={{ left: guideStartPx, top: draggedCenterY }}
                    />
                    <div
                      className="absolute h-3 w-px -translate-y-1/2 bg-sky-500"
                      style={{ left: guideEndPx, top: draggedCenterY }}
                    />
                    <div
                      className="absolute -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded-full border border-sky-200 bg-white/95 px-2 py-0.5 font-mono text-[10px] font-semibold text-sky-700 shadow-[0_8px_20px_-12px_rgba(14,165,233,0.55)]"
                      style={{ left: labelLeftPx, top: draggedCenterY }}
                    >
                      {formatDuration(distanceGuide.distanceMs)}
                    </div>
                  </>
                );
              })()}
            </div>
          ) : null}

          <div
            className="pointer-events-none absolute z-30 w-px bg-[linear-gradient(180deg,rgba(244,63,94,0.95),rgba(244,63,94,0.38))] shadow-[0_0_12px_rgba(244,63,94,0.3)]"
            style={{
              left: 0,
              top: TIME_RULER_HEIGHT,
              height: rows.length * TIMELINE_ROW_HEIGHT,
              transform: `translate3d(${ROW_HEADER_WIDTH + playheadLeftPx}px, 0, 0) translateX(-50%)`,
              willChange: "transform",
            }}
          />

          <div
            className="pointer-events-none absolute z-10"
            style={{
              left: ROW_HEADER_WIDTH,
              top: TIME_RULER_HEIGHT,
              width: timelineWidth,
              height: rows.length * TIMELINE_ROW_HEIGHT,
            }}
          >
            {gridTicks.map((tick, index) => (
              <div
                key={index}
                className={`absolute inset-y-0 w-px ${
                  tick.isMajor ? "bg-slate-300/70" : "bg-slate-200/70"
                }`}
                style={{ left: tick.left }}
              />
            ))}
          </div>

          <div
            className="sticky top-0 z-50 grid border-b border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(246,250,252,0.92))] backdrop-blur"
            style={{
              gridTemplateColumns: `${ROW_HEADER_WIDTH}px ${timelineWidth}px`,
              height: TIME_RULER_HEIGHT,
            }}
          >
            <div className="sticky left-0 z-[60] flex items-center border-r border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(246,250,252,0.96))] px-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  Device Channels
                </div>
                <div className="mt-1 text-sm font-medium text-foreground">Timeline Playlist</div>
              </div>
            </div>

            <div
              className={`relative ${panState ? "cursor-grabbing" : "cursor-grab"}`}
              data-main-track="true"
              data-pan-track="true"
              style={{
                width: timelineWidth,
              }}
            >
              <div className="pointer-events-none sticky left-3 top-2 z-30 inline-flex rounded-full border border-border/70 bg-white/85 px-2 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground shadow-sm backdrop-blur">
                {secondsPerDivisionLabel}
              </div>
              <div
                className="pointer-events-none absolute left-0 top-2 z-20 h-3 w-3 rounded-full border-2 border-white bg-rose-500 shadow-[0_6px_18px_rgba(244,63,94,0.35)]"
                style={{
                  transform: `translate3d(${playheadLeftPx}px, 0, 0) translateX(-50%)`,
                  willChange: "transform",
                }}
              />
              {gridTicks.map((tick, index) => {
                return (
                  <div
                    key={index}
                    className="absolute inset-y-0"
                    style={{ left: tick.left }}
                  >
                    <div
                      className={`absolute inset-y-0 w-px ${
                        tick.isMajor ? "bg-slate-300" : "bg-slate-200/80"
                      }`}
                    />
                    {tick.isMajor ? (
                      <div className="absolute left-2 top-2 font-mono text-[11px] text-muted-foreground">
                        {formatTimelineTime(tick.timeMs)}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {rows.map((row, rowIndex) => {
            const rowBlocks = getSortedRowBlocks(blocks, row.id);
            const isHighlightedRow = row.id === selectedRowId;
            return (
              <div
                key={row.id}
                className="grid border-b border-border/50 last:border-b-0"
                style={{
                  gridTemplateColumns: `${ROW_HEADER_WIDTH}px ${timelineWidth}px`,
                  height: TIMELINE_ROW_HEIGHT,
                }}
              >
                <RowSidebar
                  row={row}
                  blockCount={rowBlocks.length}
                  isHighlighted={isHighlightedRow}
                  onCreateBlock={() =>
                    addBlockWithCreationGuide(
                      row.id,
                      snapMs(rowIndex * gridSizeMs * 2, gridSizeMs),
                    )
                  }
                />
                <TimelineRow
                  blocks={rowBlocks}
                  isHighlighted={isHighlightedRow}
                  isStriped={rowIndex % 2 === 1}
                  row={row}
                  guideObscuredBlockIds={guideObscuredBlockIds}
                  selectedBlockIds={selectedBlockIds}
                  syncSourcePickTargetBlockId={syncSourcePickTargetBlockId}
                  timelineWidth={timelineWidth}
                  totalDurationMs={totalDurationMs}
                  zoomPxPerMinute={zoomPxPerMinute}
                  onBlockPointerDown={(blockId, mode, event) => {
                    if (syncSourcePickTargetBlockId) {
                      event.preventDefault();
                      event.stopPropagation();
                      return;
                    }

                    if (event.metaKey || event.ctrlKey || event.shiftKey) {
                      return;
                    }

                    const block = getBlockById(blocks, blockId);
                    const originRow = rowsById[block?.rowId ?? ""];
                    if (!block || !originRow) {
                      return;
                    }
                    const originRowIndex = rows.findIndex((item) => item.id === originRow.id);
                    const shouldDragSelectedBatch =
                      mode === "move" && selectedBlockIds.includes(block.id);
                    const selectedBlockIdSet = new Set(selectedBlockIds);
                    const originBlocks = shouldDragSelectedBatch
                      ? blocks
                          .filter((item) => selectedBlockIdSet.has(item.id))
                          .sort(
                            (left, right) =>
                              left.startMs - right.startMs || left.id.localeCompare(right.id),
                          )
                      : [block];

                    event.preventDefault();
                    event.stopPropagation();
                    beginHistoryEntry();
                    if (!shouldDragSelectedBatch) {
                      setSelectedBlock(blockId);
                    }
                    setDragState({
                      blockId,
                      mode,
                      originX: event.clientX,
                      originY: event.clientY,
                      originBlock: block,
                      originBlocks,
                      originRow,
                      originRowIndex: Math.max(0, originRowIndex),
                    });
                  }}
                  onCreateBlock={(timeMs) => {
                    addBlockWithCreationGuide(row.id, snapMs(timeMs, gridSizeMs));
                  }}
                  onOpenContextMenu={onOpenBlockContextMenu}
                  onPickSyncSourceBlock={(sourceBlockId) => {
                    if (!syncSourcePickTargetBlockId) {
                      return;
                    }

                    const sourceBlock = getBlockById(blocks, sourceBlockId);
                    if (!sourceBlock || sourceBlock.triggerMode !== "waveform") {
                      return;
                    }

                    updateBlock(syncSourcePickTargetBlockId, {
                      syncSourceBlockId: sourceBlockId,
                    });
                    window.dispatchEvent(
                      new CustomEvent<{ targetBlockId: string }>("scheduler:sync-source-picked", {
                        detail: { targetBlockId: syncSourcePickTargetBlockId },
                      }),
                    );
                    setSyncSourcePickTargetBlock(null);
                  }}
                  onOpenInsertMenu={(rowId, timeMs, x, y) => {
                    onOpenInsertContextMenu(rowId, snapMs(timeMs, gridSizeMs), x, y);
                  }}
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
