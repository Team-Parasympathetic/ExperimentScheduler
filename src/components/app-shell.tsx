import { useEffect, useRef, useState } from "react";
import { BlockContextMenu } from "@/components/block-context-menu";
import { SchedulerLayout } from "@/components/scheduler-layout";
import { TopToolbar } from "@/components/top-toolbar";
import { ROW_HEADER_WIDTH } from "@/lib/layout";
import { pxToMs } from "@/lib/time";
import { useSchedulerStore } from "@/store/scheduler-store";
import type { Block } from "@/types/scheduler";

interface ContextMenuState {
  blockId: string;
  x: number;
  y: number;
}

export function AppShell() {
  const selectedBlockIds = useSchedulerStore((state) => state.selectedBlockIds);
  const blocks = useSchedulerStore((state) => state.blocks);
  const zoomPxPerMinute = useSchedulerStore((state) => state.zoomPxPerMinute);
  const totalDurationMs = useSchedulerStore((state) => state.experimentDurationMs);
  const experimentState = useSchedulerStore((state) => state.experimentState);
  const deleteBlocks = useSchedulerStore((state) => state.deleteBlocks);
  const pasteBlocks = useSchedulerStore((state) => state.pasteBlocks);
  const undo = useSchedulerStore((state) => state.undo);
  const redo = useSchedulerStore((state) => state.redo);
  const syncPlayhead = useSchedulerStore((state) => state.syncPlayhead);
  const setSelectedBlock = useSchedulerStore((state) => state.setSelectedBlock);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
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
          setContextMenu({ blockId, x, y });
        }}
        onDismissContextMenu={() => setContextMenu(null)}
      />

      {contextMenu ? (
        <BlockContextMenu
          blockId={contextMenu.blockId}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}
