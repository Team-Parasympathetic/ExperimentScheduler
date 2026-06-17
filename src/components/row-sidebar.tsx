import type { Row } from "@/types/scheduler";
import { DeviceRowHeader } from "@/components/device-row-header";

interface RowSidebarProps {
  row: Row;
  blockCount: number;
  isHighlighted?: boolean;
  onCreateBlock: () => void;
}

export function RowSidebar({
  row,
  blockCount,
  isHighlighted = false,
  onCreateBlock,
}: RowSidebarProps) {
  return (
    <div className="sticky left-0 z-40 flex h-full items-stretch border-r border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(246,250,252,0.96))]">
      <DeviceRowHeader row={row} blockCount={blockCount} onCreateBlock={onCreateBlock} />
      {isHighlighted ? (
        <div className="pointer-events-none absolute inset-y-1 left-2 right-2 rounded-xl bg-rose-100/20 opacity-95 shadow-[0_0_26px_rgba(244,63,94,0.34),inset_0_0_22px_rgba(255,255,255,0.46),inset_0_0_16px_rgba(244,63,94,0.16)]" />
      ) : null}
    </div>
  );
}
