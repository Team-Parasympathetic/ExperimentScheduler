import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  getHardwareOptions,
  getHardwareSelectPlaceholder,
  getHardwareShortLabel,
  getUsedHardwareIds,
} from "@/lib/hardware-bindings";
import { cn } from "@/lib/utils";
import { useBoardStore } from "@/store/board-store";
import { useSchedulerStore } from "@/store/scheduler-store";
import type { Row } from "@/types/scheduler";

interface HardwareAssignmentSelectProps {
  id: string;
  row: Row;
  label?: string;
  className?: string;
  labelClassName?: string;
  selectClassName?: string;
  showLabel?: boolean;
}

export function HardwareAssignmentSelect({
  className,
  id,
  label = "Hardware",
  labelClassName,
  row,
  selectClassName,
  showLabel = true,
}: HardwareAssignmentSelectProps) {
  const rows = useSchedulerStore((state) => state.rows);
  const updateRow = useSchedulerStore((state) => state.updateRow);
  const detectedSlots = useBoardStore((state) => state.detectedSlots);
  const options = getHardwareOptions(row.deviceType, detectedSlots);
  const usedHardwareIds = getUsedHardwareIds(rows, row.deviceType, row.id);
  const selectedHardwareId =
    row.hardwareId === null || row.hardwareId === undefined ? null : row.hardwareId;
  const selectedOptionExists =
    selectedHardwareId === null ||
    options.some((option) => option.value === selectedHardwareId);

  return (
    <div className={cn("space-y-2", className)}>
      <Label className={cn(showLabel ? "" : "sr-only", labelClassName)} htmlFor={id}>
        {label}
      </Label>
      <Select
        id={id}
        aria-label={showLabel ? undefined : label}
        className={selectClassName}
        value={selectedHardwareId === null ? "" : String(selectedHardwareId)}
        onChange={(event) =>
          updateRow(row.id, {
            hardwareId: event.target.value === "" ? null : Number(event.target.value),
          })
        }
      >
        <option value="">{getHardwareSelectPlaceholder(row.deviceType)}</option>
        {!selectedOptionExists && selectedHardwareId !== null ? (
          <option value={selectedHardwareId}>
            {getHardwareShortLabel(row.deviceType, selectedHardwareId)} (not detected)
          </option>
        ) : null}
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={usedHardwareIds.has(option.value)}
          >
            {option.label}
            {usedHardwareIds.has(option.value) ? " - in use" : ""}
          </option>
        ))}
      </Select>
    </div>
  );
}
