import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { BlockContextMenu } from "@/components/block-context-menu";
import { SchedulerLayout } from "@/components/scheduler-layout";
import { TopToolbar } from "@/components/top-toolbar";
import { Button } from "@/components/ui/button";
import { ROW_HEADER_WIDTH } from "@/lib/layout";
import { formatTimelineTime, msToPx, pxToMs } from "@/lib/time";
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
  const ref = useRef<HTMLDivElement>(null);
  const rows = useSchedulerStore((state) => state.rows);
  const row = rows.find((item) => item.id === rowId) ?? null;
  const menuLeft =
    typeof window === "undefined" ? x : Math.max(12, Math.min(x, window.innerWidth - 240));
  const menuTop =
    typeof window === "undefined" ? y : Math.max(12, Math.min(y, window.innerHeight - 150));

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  if (!row) {
    return null;
  }

  return (
    <div
      ref={ref}
      className="fixed z-50 w-[220px] rounded-xl border border-border/70 bg-white/95 p-3 shadow-[0_18px_54px_-32px_rgba(15,23,42,0.35)] backdrop-blur"
      style={{ left: menuLeft, top: menuTop }}
    >
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
        {row.name}
      </div>
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
    </div>
  );
}

export function AppShell() {
  const addBlock = useSchedulerStore((state) => state.addBlock);
  const selectedBlockIds = useSchedulerStore((state) => state.selectedBlockIds);
  const blocks = useSchedulerStore((state) => state.blocks);
  const zoomPxPerMinute = useSchedulerStore((state) => state.zoomPxPerMinute);
  const totalDurationMs = useSchedulerStore((state) => state.experimentDurationMs);
  const experimentState = useSchedulerStore((state) => state.experimentState);
  const playheadMs = useSchedulerStore((state) => state.playheadMs);
  const deleteBlocks = useSchedulerStore((state) => state.deleteBlocks);
  const pasteBlocks = useSchedulerStore((state) => state.pasteBlocks);
  const undo = useSchedulerStore((state) => state.undo);
  const redo = useSchedulerStore((state) => state.redo);
  const syncPlayhead = useSchedulerStore((state) => state.syncPlayhead);
  const setSelectedBlock = useSchedulerStore((state) => state.setSelectedBlock);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [insertMenu, setInsertMenu] = useState<InsertMenuState | null>(null);
  const [copiedBlocks, setCopiedBlocks] = useState<Block[]>([]);
  const [viewportStartMs, setViewportStartMs] = useState(0);
  const [viewportDurationMs, setViewportDurationMs] = useState(20 * 60_000);

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

      if (event.key === "Delete" && selectedBlockIds.length > 0 && !isTypingTarget) {
        event.preventDefault();
        deleteBlocks(selectedBlockIds);
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !isTypingTarget) {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y" && !isTypingTarget) {
        event.preventDefault();
        redo();
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && !isTypingTarget) {
        const selectedBlockIdSet = new Set(selectedBlockIds);
        const blocksToCopy = blocks
          .filter((item) => selectedBlockIdSet.has(item.id))
          .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));

        if (blocksToCopy.length > 0) {
          event.preventDefault();
          setCopiedBlocks(blocksToCopy.map((block) => ({ ...block })));
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && !isTypingTarget) {
        if (copiedBlocks.length > 0) {
          event.preventDefault();
          pasteBlocks(copiedBlocks);
        }
      }

      if (event.key === "Escape") {
        setContextMenu(null);
        setInsertMenu(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [blocks, copiedBlocks, deleteBlocks, pasteBlocks, redo, selectedBlockIds, undo]);

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
