import type { Row } from "@/types/scheduler";
import { DeviceRowHeader } from "@/components/device-row-header";

interface RowSidebarProps {
  row: Row;
  blockCount: number;
  onCreateBlock: () => void;
}

export function RowSidebar({ row, blockCount, onCreateBlock }: RowSidebarProps) {
  return (
    <div className="sticky left-0 z-20 flex h-full items-stretch border-r border-border/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(246,250,252,0.96))]">
      <DeviceRowHeader row={row} blockCount={blockCount} onCreateBlock={onCreateBlock} />
    </div>
  );
}
