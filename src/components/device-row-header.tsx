import { useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { FloatingWindow } from "@/components/floating-window";
import { HardwareAssignmentSelect } from "@/components/hardware-assignment-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { getDeviceTypeLabel } from "@/lib/time";
import { useSchedulerStore } from "@/store/scheduler-store";
import type { DeviceType, PumpRateMode, Row } from "@/types/scheduler";

interface RowMenuState {
  x: number;
  y: number;
}

interface DeviceRowHeaderProps {
  row: Row;
  blockCount: number;
  onCreateBlock: () => void;
}

export function DeviceRowHeader({
  row,
  blockCount,
  onCreateBlock,
}: DeviceRowHeaderProps) {
  const rows = useSchedulerStore((state) => state.rows);
  const updateRow = useSchedulerStore((state) => state.updateRow);
  const removeRow = useSchedulerStore((state) => state.removeRow);
  const moveRow = useSchedulerStore((state) => state.moveRow);
  const [menuState, setMenuState] = useState<RowMenuState | null>(null);
  const hasHardwareAssignment = row.hardwareId !== null && row.hardwareId !== undefined;
  const compactSelectClassName = "h-8 rounded-lg px-2 py-1 pr-8 text-xs";
  const rowIndex = rows.findIndex((item) => item.id === row.id);

  return (
    <div
      className="grid h-full w-full grid-cols-[26px_minmax(88px,1fr)_118px] items-center gap-2 overflow-hidden px-2 py-2"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenuState({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="flex flex-col gap-1">
        <Button
          aria-label={`Move ${row.name} up`}
          className="h-6 w-6 rounded-md px-0"
          disabled={rowIndex <= 0}
          size="sm"
          title="Move track up"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            moveRow(row.id, -1);
          }}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          aria-label={`Move ${row.name} down`}
          className="h-6 w-6 rounded-md px-0"
          disabled={rowIndex < 0 || rowIndex >= rows.length - 1}
          size="sm"
          title="Move track down"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            moveRow(row.id, 1);
          }}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-w-0">
        <div className="relative">
          <Input
            aria-label="Channel name"
            className="h-8 rounded-lg px-2 text-xs font-semibold tracking-wide"
            value={row.name}
            onChange={(event) =>
              updateRow(row.id, {
                name: event.target.value,
              })
            }
          />
        </div>
      </div>

      <HardwareAssignmentSelect
        id={`row-hardware-${row.id}`}
        row={row}
        label={row.deviceType === "trigger" ? "Output Pin" : "Pump Index"}
        showLabel={false}
        className="min-w-0 space-y-0"
        selectClassName={compactSelectClassName}
      />

      {menuState ? (
        <FloatingWindow
          title="Channel Settings"
          subtitle={`${row.name} · ${blockCount} block${blockCount === 1 ? "" : "s"}`}
          x={menuState.x}
          y={menuState.y}
          width={300}
          maxHeight={420}
          onClose={() => setMenuState(null)}
          footer={
            <div className="flex justify-between gap-2">
              <Button
                disabled={Boolean(row.isScheduleStatus)}
                size="sm"
                onClick={() => {
                  onCreateBlock();
                  setMenuState(null);
                }}
              >
                <Plus className="h-4 w-4" />
                Add Block
              </Button>
              <Button
                disabled={rows.length <= 1}
                size="sm"
                variant="destructive"
                onClick={() => {
                  removeRow(row.id);
                  setMenuState(null);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Device
              </div>
              <Select
                value={row.deviceType}
                onChange={(event) =>
                  updateRow(row.id, {
                    deviceType: event.target.value as DeviceType,
                  })
                }
              >
                <option value="peristaltic">{getDeviceTypeLabel("peristaltic")}</option>
                <option value="trigger">{getDeviceTypeLabel("trigger")}</option>
              </Select>
            </div>

            {row.deviceType === "peristaltic" ? (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Pump Type
                </div>
                <Select
                  value={row.pumpRateMode ?? "variable"}
                  onChange={(event) =>
                    updateRow(row.id, {
                      pumpRateMode: event.target.value as PumpRateMode,
                    })
                  }
                >
                  <option value="variable">Variable rate</option>
                  <option value="fixed">Fixed rate</option>
                </Select>
              </div>
            ) : null}

            {row.deviceType === "trigger" ? (
              <label
                className={`flex items-center gap-2 rounded-lg border border-violet-100 bg-violet-50/70 px-3 py-2 text-xs font-medium text-violet-800 ${
                  hasHardwareAssignment ? "" : "opacity-55"
                }`}
                title={hasHardwareAssignment ? undefined : "Select an output pin first"}
              >
                <input
                  aria-label="Use as schedule status output"
                  checked={Boolean(row.isScheduleStatus)}
                  className="h-4 w-4 rounded border-violet-300 text-violet-700 accent-violet-600"
                  disabled={!hasHardwareAssignment}
                  type="checkbox"
                  onChange={(event) =>
                    updateRow(row.id, {
                      isScheduleStatus: event.currentTarget.checked,
                    })
                  }
                />
                Schedule status output
              </label>
            ) : null}
          </div>
        </FloatingWindow>
      ) : null}
    </div>
  );
}
