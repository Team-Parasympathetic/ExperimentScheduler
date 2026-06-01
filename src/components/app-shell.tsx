import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { BlockContextMenu } from "@/components/block-context-menu";
import { FloatingWindow } from "@/components/floating-window";
import { SchedulerLayout } from "@/components/scheduler-layout";
import { TopToolbar } from "@/components/top-toolbar";
import { Button } from "@/components/ui/button";
import { ROW_HEADER_WIDTH } from "@/lib/layout";
import { stopBoardSchedule } from "@/lib/board-api";
import { formatTimelineTime, getRequiredScheduleDuration, msToPx, pxToMs } from "@/lib/time";
import { useBoardStore } from "@/store/board-store";
import { useSchedulerStore } from "@/store/scheduler-store";
import type { Block } from "@/types/scheduler";

interface ContextMenuState {
  blockId: string;
  x: number;
  y: number;
}

interface InsertMenuState {
  rowId: string;
  timeMs: number;
  x: number;
  y: number;
}

interface InsertBlockContextMenuProps extends InsertMenuState {
  onClose: () => void;
  onInsert: () => void;
}

function InsertBlockContextMenu({
  rowId,
  timeMs,
  x,
  y,
  onClose,
  onInsert,
}: InsertBlockContextMenuProps) {
  const rows = useSchedulerStore((state) => state.rows);
  const row = rows.find((item) => item.id === rowId) ?? null;

  if (!row) {
    return null;
  }

  return (
    <FloatingWindow
      title="Insert Block"
      subtitle={row.name}
      x={x}
      y={y}
      width={240}
      maxHeight={180}
      onClose={onClose}
      contentClassName="p-3"
    >
      <Button
        className="w-full justify-start"
        size="sm"
        variant="ghost"
        onClick={() => {
          onInsert();
          onClose();
        }}
      >
        <Plus className="h-4 w-4" />
        Insert Block at {formatTimelineTime(timeMs)}
      </Button>
    </FloatingWindow>
  );
}

export function AppShell() {
  const comPort = useBoardStore((state) => state.comPort);
  const appendSerialLog = useBoardStore((state) => state.appendSerialLog);
  const setScheduleCommandState = useBoardStore((state) => state.setScheduleCommandState);
  const setScheduleMessage = useBoardStore((state) => state.setScheduleMessage);
  const addBlock = useSchedulerStore((state) => state.addBlock);
  const selectedBlockIds = useSchedulerStore((state) => state.selectedBlockIds);
  const blocks = useSchedulerStore((state) => state.blocks);
  const zoomPxPerMinute = useSchedulerStore((state) => state.zoomPxPerMinute);
  const totalDurationMs = useSchedulerStore((state) => state.experimentDurationMs);
  const experimentState = useSchedulerStore((state) => state.experimentState);
  const playheadMs = useSchedulerStore((state) => state.playheadMs);
  const deleteBlocks = useSchedulerStore((state) => state.deleteBlocks);
  const pasteBlocks = useSchedulerStore((state) => state.pasteBlocks);
  const resetExperiment = useSchedulerStore((state) => state.resetExperiment);
  const undo = useSchedulerStore((state) => state.undo);
  const redo = useSchedulerStore((state) => state.redo);
  const syncPlayhead = useSchedulerStore((state) => state.syncPlayhead);
  const setSelectedBlock = useSchedulerStore((state) => state.setSelectedBlock);

  const scrollRef = useRef<HTMLDivElement>(null);
  const autoStopRequestedRef = useRef(false);
  const shortcutsRef = useRef({
    blocks,
    copiedBlocks: [] as Block[],
    selectedBlockIds,
  });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [insertMenu, setInsertMenu] = useState<InsertMenuState | null>(null);
  const [copiedBlocks, setCopiedBlocks] = useState<Block[]>([]);
  const [viewportStartMs, setViewportStartMs] = useState(0);
  const [viewportDurationMs, setViewportDurationMs] = useState(20 * 60_000);

  useEffect(() => {
    shortcutsRef.current = {
      blocks,
      copiedBlocks,
      selectedBlockIds,
    };
  }, [blocks, copiedBlocks, selectedBlockIds]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }

    const updateViewport = () => {
      setViewportStartMs(pxToMs(node.scrollLeft, zoomPxPerMinute));
      setViewportDurationMs(
        pxToMs(Math.max(0, node.clientWidth - ROW_HEADER_WIDTH), zoomPxPerMinute),
      );
    };

    updateViewport();
    node.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);

    return () => {
      node.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
    };
  }, [zoomPxPerMinute]);

  useEffect(() => {
    if (experimentState !== "running") {
      autoStopRequestedRef.current = false;
      return;
    }

    let animationFrameId = 0;

    const tick = () => {
      syncPlayhead();
      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [experimentState, syncPlayhead]);

  useEffect(() => {
    if (experimentState !== "running") {
      autoStopRequestedRef.current = false;
      return;
    }

    const finalBlockEndMs = getRequiredScheduleDuration(blocks);

    if (playheadMs < finalBlockEndMs || autoStopRequestedRef.current) {
      return;
    }

    autoStopRequestedRef.current = true;
    resetExperiment();

    const trimmedComPort = comPort.trim();
    setScheduleCommandState("stop");
    setScheduleMessage(`Auto-stop in progress on ${trimmedComPort || "COM port"}...`);

    void stopBoardSchedule(trimmedComPort)
      .then((result) => {
        appendSerialLog(result.log, `# Auto-stop ${trimmedComPort || "COM port"}`);
        setScheduleMessage(
          result.ok ? `Schedule complete. ${result.message}` : `Auto-stop failed: ${result.message}`,
        );
      })
      .catch((error) => {
        setScheduleMessage(
          `Auto-stop failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        setScheduleCommandState(null);
      });
  }, [
    appendSerialLog,
    blocks,
    comPort,
    experimentState,
    playheadMs,
    resetExperiment,
    setScheduleCommandState,
    setScheduleMessage,
  ]);

  useEffect(() => {
    if (experimentState !== "running") {
      return;
    }

    const node = scrollRef.current;
    if (!node) {
      return;
    }

    const visibleTrackWidth = Math.max(0, node.clientWidth - ROW_HEADER_WIDTH);
    if (visibleTrackWidth <= 0) {
      return;
    }

    const playheadX = msToPx(playheadMs, zoomPxPerMinute);
    const viewportStartPx = node.scrollLeft;
    const followEdgePx = viewportStartPx + visibleTrackWidth * 0.82;
    const resetEdgePx = visibleTrackWidth * 0.04;

    if (playheadX > followEdgePx) {
      node.scrollLeft = Math.max(0, playheadX - visibleTrackWidth * 0.78);
    } else if (playheadX < viewportStartPx + resetEdgePx) {
      node.scrollLeft = Math.max(0, playheadX - visibleTrackWidth * 0.12);
    }
  }, [experimentState, playheadMs, zoomPxPerMinute]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable;
      const shortcutState = shortcutsRef.current;

      if (event.key === "Delete" && shortcutState.selectedBlockIds.length > 0 && !isTypingTarget) {
        event.preventDefault();
        event.stopPropagation();
        deleteBlocks(shortcutState.selectedBlockIds);
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !isTypingTarget) {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y" && !isTypingTarget) {
        event.preventDefault();
        event.stopPropagation();
        redo();
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && !isTypingTarget) {
        const selectedBlockIdSet = new Set(shortcutState.selectedBlockIds);
        const blocksToCopy = shortcutState.blocks
          .filter((item) => selectedBlockIdSet.has(item.id))
          .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));

        if (blocksToCopy.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          const nextCopiedBlocks = blocksToCopy.map((block) => ({ ...block }));
          shortcutsRef.current.copiedBlocks = nextCopiedBlocks;
          setCopiedBlocks(nextCopiedBlocks);
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && !isTypingTarget) {
        if (shortcutState.copiedBlocks.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          pasteBlocks(shortcutState.copiedBlocks);
        }
      }

      if (event.key === "Escape") {
        setContextMenu(null);
        setInsertMenu(null);
      }
    };

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [deleteBlocks, pasteBlocks, redo, undo]);

  return (
    <div className="adaptive-shell relative flex h-full flex-col overflow-hidden px-5 pb-5 pt-4 text-foreground">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_14%_0%,rgba(34,211,238,0.16),transparent_24%),radial-gradient(circle_at_94%_2%,rgba(249,115,22,0.16),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0),rgba(255,255,255,0.68))]" />

      <TopToolbar
        totalDurationMs={totalDurationMs}
        viewportDurationMs={viewportDurationMs}
        viewportStartMs={viewportStartMs}
        onJumpToTime={(timeMs, behavior = "smooth") => {
          const node = scrollRef.current;
          if (!node) {
            return;
          }

          node.scrollTo({
            left: Math.max(0, (timeMs / 60_000) * zoomPxPerMinute),
            behavior,
          });
        }}
      />

      <SchedulerLayout
        scrollRef={scrollRef}
        totalDurationMs={totalDurationMs}
        onOpenBlockContextMenu={(blockId, x, y) => {
          if (!selectedBlockIds.includes(blockId)) {
            setSelectedBlock(blockId);
          }
          setInsertMenu(null);
          setContextMenu({ blockId, x, y });
        }}
        onOpenInsertContextMenu={(rowId, timeMs, x, y) => {
          setContextMenu(null);
          setSelectedBlock(null);
          setInsertMenu({ rowId, timeMs, x, y });
        }}
        onDismissContextMenu={() => {
          setContextMenu(null);
          setInsertMenu(null);
        }}
      />

      {contextMenu ? (
        <BlockContextMenu
          blockId={contextMenu.blockId}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      {insertMenu ? (
        <InsertBlockContextMenu
          {...insertMenu}
          onClose={() => setInsertMenu(null)}
          onInsert={() => addBlock(insertMenu.rowId, insertMenu.timeMs)}
        />
      ) : null}
    </div>
  );
}
