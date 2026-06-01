import { Trash2 } from "lucide-react";
import { FloatingWindow } from "@/components/floating-window";
import { HardwareAssignmentSelect } from "@/components/hardware-assignment-select";
import { Button } from "@/components/ui/button";
import { DraftNumberInput } from "@/components/ui/draft-number-input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { getBlockContext } from "@/lib/schedule";
import { MIN_BLOCK_DURATION_MS, getDeviceTypeLabel, getFlowRateLabel } from "@/lib/time";
import {
  getFixedPumpCalibrationFit,
  getFixedPumpFlowRateForDuration,
  getFixedPumpVolumeForDuration,
  getPumpCalibrationConfigForRow,
} from "@/lib/pump-calibration";
import {
  DEFAULT_TRIGGER_DUTY_CYCLE,
  DEFAULT_TRIGGER_FREQUENCY_HZ,
  DEFAULT_TRIGGER_MODE,
  getDutyCycleFromHighTimeMs,
  getFrequencyHzFromPeriodMs,
  getHighTimeMsFromDutyCycle,
  getPeriodMsFromFrequencyHz,
  getTriggerModeLabel,
  normalizeDutyCycle,
  normalizeFrequencyHz,
} from "@/lib/trigger-output";
import { useSchedulerStore } from "@/store/scheduler-store";
import { usePumpCalibrationStore } from "@/store/pump-calibration-store";
import type { TriggerMode } from "@/types/scheduler";

interface BlockContextMenuProps {
  blockId: string;
  x: number;
  y: number;
  onClose: () => void;
}

export function BlockContextMenu({ blockId, x, y, onClose }: BlockContextMenuProps) {
  const blocks = useSchedulerStore((state) => state.blocks);
  const rows = useSchedulerStore((state) => state.rows);
  const gridSizeMs = useSchedulerStore((state) => state.gridSizeMs);
  const updateBlock = useSchedulerStore((state) => state.updateBlock);
  const deleteBlock = useSchedulerStore((state) => state.deleteBlock);
  const calibrationsByRowId = usePumpCalibrationStore((state) => state.calibrationsByRowId);

  const blockContext = getBlockContext(rows, blocks, blockId);
  const block = blockContext?.block ?? null;
  const row = blockContext?.row ?? null;

  if (!block || !row) {
    return null;
  }

  const isTriggerBlock = row.deviceType === "trigger";
  const isFixedRatePump = row.deviceType === "peristaltic" && row.pumpRateMode === "fixed";
  const fixedCalibration = getPumpCalibrationConfigForRow(calibrationsByRowId, row).fixed;
  const fixedFit = getFixedPumpCalibrationFit(fixedCalibration);
  const triggerMode = block.triggerMode ?? DEFAULT_TRIGGER_MODE;
  const triggerFrequencyHz = normalizeFrequencyHz(
    block.frequencyHz ?? DEFAULT_TRIGGER_FREQUENCY_HZ,
  );
  const triggerDutyCycle = normalizeDutyCycle(
    block.dutyCycle ?? DEFAULT_TRIGGER_DUTY_CYCLE,
  );
  const triggerPeriodMs = getPeriodMsFromFrequencyHz(triggerFrequencyHz);
  const triggerHighTimeMs = getHighTimeMsFromDutyCycle(
    triggerFrequencyHz,
    triggerDutyCycle,
  );
  const gridSizeSeconds = gridSizeMs / 1_000;
  const minBlockDurationSeconds = MIN_BLOCK_DURATION_MS / 1_000;

  return (
    <FloatingWindow
      title="Quick Edit"
      subtitle={`${row.name} - ${getDeviceTypeLabel(row.deviceType)}`}
      x={x}
      y={y}
      width={310}
      maxHeight={620}
      onClose={onClose}
      footer={
        <div className="flex justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              deleteBlock(block.id);
              onClose();
            }}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <HardwareAssignmentSelect
          id={`menu-hardware-${row.id}`}
          row={row}
          label={row.deviceType === "trigger" ? "Output Pin" : "Pump Index"}
        />

        {isTriggerBlock ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="menu-trigger-mode">Trigger Block Type</Label>
              <Select
                id="menu-trigger-mode"
                value={triggerMode}
                onChange={(event) =>
                  updateBlock(block.id, {
                    triggerMode: event.target.value as TriggerMode,
                  })
                }
              >
                <option value="rising">{getTriggerModeLabel("rising")}</option>
                <option value="falling">{getTriggerModeLabel("falling")}</option>
                <option value="waveform">{getTriggerModeLabel("waveform")}</option>
              </Select>
            </div>

            {triggerMode === "waveform" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="menu-trigger-frequency">Freq (Hz)</Label>
                  <DraftNumberInput
                    id="menu-trigger-frequency"
                    min="0.000001"
                    minValue={Number.EPSILON}
                    step="any"
                    type="number"
                    value={triggerFrequencyHz}
                    onCommit={(value) =>
                      updateBlock(block.id, {
                        frequencyHz: normalizeFrequencyHz(value),
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="menu-trigger-duty">Duty (%)</Label>
                  <DraftNumberInput
                    id="menu-trigger-duty"
                    min="0"
                    minValue={0}
                    max="100"
                    maxValue={100}
                    step="1"
                    type="number"
                    value={triggerDutyCycle}
                    onCommit={(value) =>
                      updateBlock(block.id, {
                        dutyCycle: normalizeDutyCycle(value),
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="menu-trigger-period">Period (s)</Label>
                  <DraftNumberInput
                    id="menu-trigger-period"
                    min="0.0000001"
                    minValue={Number.EPSILON}
                    step="any"
                    type="number"
                    value={triggerPeriodMs / 1_000}
                    onCommit={(value) =>
                      updateBlock(block.id, {
                        frequencyHz: getFrequencyHzFromPeriodMs(value * 1_000),
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="menu-trigger-high-time">High Time (s)</Label>
                  <DraftNumberInput
                    id="menu-trigger-high-time"
                    min="0"
                    minValue={0}
                    step="any"
                    type="number"
                    value={triggerHighTimeMs / 1_000}
                    onCommit={(value) =>
                      updateBlock(block.id, {
                        dutyCycle: getDutyCycleFromHighTimeMs(
                          triggerFrequencyHz,
                          value * 1_000,
                        ),
                      })
                    }
                  />
                </div>
              </div>
            ) : null}
          </>
        ) : isFixedRatePump ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="menu-direction">Direction</Label>
              <Select
                id="menu-direction"
                value={block.direction}
                onChange={(event) =>
                  updateBlock(block.id, {
                    direction: event.target.value as "forward" | "reverse",
                  })
                }
              >
                <option value="forward">Forward</option>
                <option value="reverse">Reverse</option>
              </Select>
            </div>

            <div className="rounded-lg border border-orange-100 bg-orange-50/70 px-3 py-2 text-xs text-orange-900">
              <div className="flex items-center justify-between gap-3">
                <span className="text-orange-700">Total flow</span>
                <span className="font-mono">
                  {`${getFixedPumpVolumeForDuration(block.durationMs, fixedFit).toFixed(1)} uL`}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <span className="text-orange-700">Flow rate</span>
                <span className="font-mono">
                  {getFlowRateLabel(getFixedPumpFlowRateForDuration(block.durationMs, fixedFit))}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr),minmax(0,1.2fr)]">
            <div className="space-y-2">
              <Label htmlFor="menu-direction">Direction</Label>
              <Select
                id="menu-direction"
                value={block.direction}
                onChange={(event) =>
                  updateBlock(block.id, {
                    direction: event.target.value as "forward" | "reverse",
                  })
                }
              >
                <option value="forward">Forward</option>
                <option value="reverse">Reverse</option>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="menu-flow-rate">Flow Rate</Label>
              <div className="relative">
                <DraftNumberInput
                  id="menu-flow-rate"
                  className="pr-20 [&::-webkit-inner-spin-button]:mr-10 [&::-webkit-outer-spin-button]:mr-10"
                  min={0}
                  minValue={0}
                  step="10"
                  type="number"
                  value={block.flowRate}
                  onCommit={(value) =>
                    updateBlock(block.id, {
                      flowRate: value,
                    })
                  }
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  uL/min
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="menu-start">Start (s)</Label>
            <DraftNumberInput
              id="menu-start"
              min={0}
              minValue={0}
              step={gridSizeSeconds}
              type="number"
              value={block.startMs / 1_000}
              onCommit={(value) =>
                updateBlock(block.id, {
                  startMs: value * 1_000,
                })
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="menu-stop">Stop (s)</Label>
            <DraftNumberInput
              id="menu-stop"
              min={block.startMs / 1_000 + minBlockDurationSeconds}
              minValue={block.startMs / 1_000 + minBlockDurationSeconds}
              step={gridSizeSeconds}
              type="number"
              value={(block.startMs + block.durationMs) / 1_000}
              onCommit={(value) =>
                updateBlock(block.id, {
                  durationMs: value * 1_000 - block.startMs,
                })
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="menu-duration">Duration (s)</Label>
            <DraftNumberInput
              id="menu-duration"
              min={minBlockDurationSeconds}
              minValue={minBlockDurationSeconds}
              step={gridSizeSeconds}
              type="number"
              value={block.durationMs / 1_000}
              onCommit={(value) =>
                updateBlock(block.id, {
                  durationMs: value * 1_000,
                })
              }
            />
          </div>
        </div>
      </div>
    </FloatingWindow>
  );
}
