import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import { Box, ChevronDown, ChevronUp } from "lucide-react";
import { PumpSetupViewport } from "@/components/pump-setup-viewport";
import { SchedulerSidebar } from "@/components/scheduler-sidebar";
import { TimelineGrid } from "@/components/timeline-grid";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SchedulerLayoutProps {
  totalDurationMs: number;
  scrollRef: RefObject<HTMLDivElement>;
  onOpenBlockContextMenu: (blockId: string, x: number, y: number) => void;
  onOpenInsertContextMenu: (rowId: string, timeMs: number, x: number, y: number) => void;
  onDismissContextMenu: () => void;
}

const COLLAPSED_SIDEBAR_WIDTH = 72;
const DEFAULT_SIDEBAR_WIDTH = 520;
const MIN_SIDEBAR_WIDTH = 380;
const SIDEBAR_MAX_FRACTION = 1 / 3;
const SIDEBAR_WIDTH_STORAGE_KEY = "experiment-scheduler:sidebar-width";
const PUMP_PANEL_HEIGHT_STORAGE_KEY = "experiment-scheduler:pump-panel-open";

function getWindowWidth() {
  return typeof window === "undefined" ? 1680 : window.innerWidth;
}

function getMaxSidebarWidth(windowWidth = getWindowWidth()) {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.floor(windowWidth * SIDEBAR_MAX_FRACTION));
}

function clampSidebarWidth(width: number, windowWidth = getWindowWidth()) {
  return Math.min(getMaxSidebarWidth(windowWidth), Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function getStoredSidebarWidth() {
  if (typeof window === "undefined") {
    return DEFAULT_SIDEBAR_WIDTH;
  }

  try {
    const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    return storedWidth ? Number(storedWidth) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

export function SchedulerLayout({
  scrollRef,
  totalDurationMs,
  onOpenBlockContextMenu,
  onOpenInsertContextMenu,
  onDismissContextMenu,
}: SchedulerLayoutProps) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampSidebarWidth(getStoredSidebarWidth()),
  );
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isPumpPanelCollapsed, setIsPumpPanelCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    try {
      return window.localStorage.getItem(PUMP_PANEL_HEIGHT_STORAGE_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const gridTemplateColumns = useMemo(
    () =>
      isSidebarCollapsed
        ? `minmax(0,1fr) ${COLLAPSED_SIDEBAR_WIDTH}px`
        : `minmax(0,1fr) ${sidebarWidth}px`,
    [isSidebarCollapsed, sidebarWidth],
  );

  useEffect(() => {
    const handleResize = () => {
      setSidebarWidth((current) => clampSidebarWidth(current));
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const updateSidebarWidth = useCallback((nextWidth: number) => {
    const clampedWidth = clampSidebarWidth(nextWidth);
    setSidebarWidth(clampedWidth);

    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampedWidth));
    } catch {
      // Resizing still works if local storage is unavailable.
    }
  }, []);

  const togglePumpPanel = useCallback(() => {
    setIsPumpPanelCollapsed((current) => {
      const nextCollapsed = !current;

      try {
        window.localStorage.setItem(
          PUMP_PANEL_HEIGHT_STORAGE_KEY,
          nextCollapsed ? "collapsed" : "open",
        );
      } catch {
        // Collapsing still works if local storage is unavailable.
      }

      return nextCollapsed;
    });
  }, []);

  const handleResizePointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (isSidebarCollapsed) {
        return;
      }

      const layoutNode = layoutRef.current;
      if (!layoutNode) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsResizingSidebar(true);

      const layoutRight = layoutNode.getBoundingClientRect().right;

      const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
        updateSidebarWidth(layoutRight - moveEvent.clientX);
      };

      const handlePointerUp = () => {
        setIsResizingSidebar(false);
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [isSidebarCollapsed, updateSidebarWidth],
  );

  return (
    <div
      ref={layoutRef}
      className={cn(
        "adaptive-layout grid min-h-0 flex-1 gap-4",
        isResizingSidebar && "select-none",
      )}
      style={{ gridTemplateColumns }}
    >
      <div
        className="grid min-h-0 min-w-0 gap-3"
        style={{
          gridTemplateRows: isPumpPanelCollapsed
            ? "minmax(0, 1fr) auto"
            : "minmax(0, 2fr) minmax(220px, 1fr)",
        }}
      >
        <TimelineGrid
          scrollRef={scrollRef}
          totalDurationMs={totalDurationMs}
          onDismissContextMenu={onDismissContextMenu}
          onOpenBlockContextMenu={onOpenBlockContextMenu}
          onOpenInsertContextMenu={onOpenInsertContextMenu}
        />

        <section className="glass-panel flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 shadow-[0_18px_50px_-34px_rgba(15,23,42,0.28)]">
          <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Box className="h-4 w-4 shrink-0 text-sky-600" />
              <div className="min-w-0">
                <div className="truncate text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  3D Setup
                </div>
                <div className="truncate text-sm font-semibold text-foreground">
                  Physical Pump View
                </div>
              </div>
            </div>
            <Button
              aria-label={isPumpPanelCollapsed ? "Expand 3D setup panel" : "Collapse 3D setup panel"}
              className="h-8 w-8 shrink-0 rounded-lg px-0"
              size="sm"
              title={isPumpPanelCollapsed ? "Expand 3D setup panel" : "Collapse 3D setup panel"}
              variant="ghost"
              onClick={togglePumpPanel}
            >
              {isPumpPanelCollapsed ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </div>

          {isPumpPanelCollapsed ? null : (
            <PumpSetupViewport className="min-h-0 flex-1 rounded-none border-0 bg-transparent" />
          )}
        </section>
      </div>
      <div className="relative min-h-0 min-w-0 overflow-hidden">
        <button
          aria-label="Resize sidebar"
          className={cn(
            "absolute -left-3 top-0 z-20 h-full w-5 cursor-col-resize rounded-full transition hover:bg-sky-200/35",
            isSidebarCollapsed ? "hidden" : "hidden lg:block",
            isResizingSidebar && "bg-sky-200/50",
          )}
          onPointerDown={handleResizePointerDown}
          title="Resize sidebar"
          type="button"
        >
          <span className="mx-auto block h-full w-px bg-border/80" />
        </button>
        <SchedulerSidebar
          collapsed={isSidebarCollapsed}
          onToggleCollapsed={() => setIsSidebarCollapsed((current) => !current)}
        />
      </div>
    </div>
  );
}
