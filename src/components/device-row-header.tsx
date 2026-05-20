import { Plus, Trash2 } from "lucide-react";
import { HardwareAssignmentSelect } from "@/components/hardware-assignment-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { getDeviceTypeLabel } from "@/lib/time";
import { useSchedulerStore } from "@/store/scheduler-store";
import type { DeviceType, PumpRateMode, Row } from "@/types/scheduler";

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
  const hasHardwareAssignment = row.hardwareId !== null && row.hardwareId !== undefined;

  return (
    <div className="flex w-full flex-col justify-between px-4 py-3">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Input
              aria-label="Channel name"
              className="h-8 px-2 text-sm font-semibold tracking-wide"
              value={row.name}
              onChange={(event) =>
                updateRow(row.id, {
                  name: event.target.value,
                })
              }
            />
            <div className="mt-1 text-xs uppercase tracking-[0.22em] text-muted-foreground">
              {blockCount} command{blockCount === 1 ? "" : "s"}
            </div>
          </div>
          <div
            className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${
              row.deviceType === "trigger"
                ? "border-violet-200 bg-violet-50 text-violet-700"
                : "border-orange-200 bg-orange-50 text-orange-700"
            }`}
          >
            {row.deviceType}
          </div>
        </div>

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

        <HardwareAssignmentSelect
          id={`row-hardware-${row.id}`}
          row={row}
          label={row.deviceType === "trigger" ? "Output Pin" : "Pump Index"}
        />

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

      <div className="mt-4 flex gap-2">
        <Button
          disabled={Boolean(row.isScheduleStatus)}
          size="sm"
          className="flex-1"
          onClick={onCreateBlock}
        >
          <Plus className="h-4 w-4" />
          Add Block
        </Button>
        <Button
          disabled={rows.length <= 1}
          size="sm"
          variant="outline"
          onClick={() => removeRow(row.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
