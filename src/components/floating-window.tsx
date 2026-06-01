import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const WINDOW_MARGIN = 12;

interface FloatingWindowProps {
  title: string;
  subtitle?: ReactNode;
  x: number;
  y: number;
  width?: number;
  maxHeight?: number;
  className?: string;
  contentClassName?: string;
  footer?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}

interface WindowPosition {
  left: number;
  top: number;
}

interface WindowDragState {
  pointerId: number;
  originX: number;
  originY: number;
  originLeft: number;
  originTop: number;
}

function getWindowBounds(width: number, height: number) {
  if (typeof window === "undefined") {
    return {
      maxLeft: Number.POSITIVE_INFINITY,
      maxTop: Number.POSITIVE_INFINITY,
    };
  }

  return {
    maxLeft: Math.max(WINDOW_MARGIN, window.innerWidth - width - WINDOW_MARGIN),
    maxTop: Math.max(WINDOW_MARGIN, window.innerHeight - height - WINDOW_MARGIN),
  };
}

function clampWindowPosition(position: WindowPosition, width: number, height: number) {
  const bounds = getWindowBounds(width, height);

  return {
    left: Math.max(WINDOW_MARGIN, Math.min(position.left, bounds.maxLeft)),
    top: Math.max(WINDOW_MARGIN, Math.min(position.top, bounds.maxTop)),
  };
}

export function FloatingWindow({
  children,
  className,
  contentClassName,
  footer,
  maxHeight,
  onClose,
  subtitle,
  title,
  width = 290,
  x,
  y,
}: FloatingWindowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<WindowDragState | null>(null);
  const resolvedMaxHeight =
    typeof window === "undefined"
      ? maxHeight
      : maxHeight
        ? Math.min(maxHeight, window.innerHeight - WINDOW_MARGIN * 2)
        : `calc(100vh - ${WINDOW_MARGIN * 2}px)`;
  const [position, setPosition] = useState<WindowPosition>(() =>
    clampWindowPosition({ left: x, top: y }, width, maxHeight ?? 360),
  );

  useLayoutEffect(() => {
    const measuredHeight = ref.current?.offsetHeight ?? maxHeight ?? 360;
    setPosition(clampWindowPosition({ left: x, top: y }, width, measuredHeight));
  }, [maxHeight, width, x, y]);

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

    const handleResize = () => {
      const measuredHeight = ref.current?.offsetHeight ?? maxHeight ?? 360;
      setPosition((currentPosition) =>
        clampWindowPosition(currentPosition, width, measuredHeight),
      );
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleResize);
    };
  }, [maxHeight, onClose, width]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;

      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      const measuredHeight = ref.current?.offsetHeight ?? maxHeight ?? 360;
      setPosition(
        clampWindowPosition(
          {
            left: dragState.originLeft + event.clientX - dragState.originX,
            top: dragState.originTop + event.clientY - dragState.originY,
          },
          width,
          measuredHeight,
        ),
      );
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (dragStateRef.current?.pointerId === event.pointerId) {
        dragStateRef.current = null;
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [maxHeight, width]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      originLeft: position.left,
      originTop: position.top,
    };
  };

  const floatingWindow = (
    <div
      ref={ref}
      className={cn(
        "fixed z-[80] flex rounded-2xl border border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(247,250,252,0.98))] shadow-[0_24px_70px_-38px_rgba(15,23,42,0.28)] backdrop-blur",
        className,
      )}
      style={{
        left: position.left,
        maxHeight: resolvedMaxHeight,
        top: position.top,
        width,
      }}
    >
      <div className="flex min-h-0 w-full flex-col">
        <div
          className="flex cursor-grab touch-none select-none items-start justify-between gap-3 rounded-t-2xl border-b border-border/60 px-4 py-3 active:cursor-grabbing"
          onPointerDown={startDrag}
        >
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              {title}
            </div>
            {subtitle ? (
              <div className="mt-1 truncate text-sm font-semibold text-foreground">
                {subtitle}
              </div>
            ) : null}
          </div>
          <Button
            aria-label={`Close ${title}`}
            className="h-7 w-7 shrink-0 rounded-lg px-0"
            size="sm"
            variant="ghost"
            onClick={onClose}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className={cn("min-h-0 overflow-auto p-4", contentClassName)}>
          {children}
        </div>

        {footer ? (
          <div className="border-t border-border/60 px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (typeof document === "undefined") {
    return floatingWindow;
  }

  return createPortal(floatingWindow, document.body);
}
