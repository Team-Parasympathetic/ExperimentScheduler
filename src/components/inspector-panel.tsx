import { Info, Trash2 } from "lucide-react";
import { HardwareAssignmentSelect } from "@/components/hardware-assignment-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DraftNumberInput } from "@/components/ui/draft-number-input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  MIN_BLOCK_DURATION_MS,
  formatDuration,
  formatTimelineTime,
  getDeviceTypeLabel,
} from "@/lib/time";
import { getBlockContext } from "@/lib/schedule";
import {
  DEFAULT_TRIGGER_DUTY_CYCLE,
  DEFAULT_TRIGGER_FREQUENCY_HZ,
  DEFAULT_TRIGGER_MODE,
  getDutyCycleFromHighTimeMs,
  getHighTimeMsFromDutyCycle,
  getPeriodMsFromFrequencyHz,
  getTriggerModeLabel,
  getFrequencyHzFromPeriodMs,
  normalizeDutyCycle,
  normalizeFrequencyHz,
} from "@/lib/trigger-output";
import { useSchedulerStore } from "@/store/scheduler-store";
import type { TriggerMode } from "@/types/scheduler";

export function InspectorPanel() {
  const rows = useSchedulerStore((state) => state.rows);
  const blocks = useSchedulerStore((state) => state.blocks);
  const selectedBlockId = useSchedulerStore((state) => state.selectedBlockId);
  const updateBlock = useSchedulerStore((state) => state.updateBlock);
  const deleteBlock = useSchedulerStore((state) => state.deleteBlock);
  const gridSizeMs = useSchedulerStore((state) => state.gridSizeMs);

  const blockContext = getBlockContext(rows, blocks, selectedBlockId);
  const block = blockContext?.block ?? null;
  const row = blockContext?.row ?? null;
  const compatibleRows = blockContext?.compatibleRows ?? [];
  const isTriggerBlock = row?.deviceType === "trigger";
  const triggerMode = block?.triggerMode ?? DEFAULT_TRIGGER_MODE;
  const triggerFrequencyHz = normalizeFrequencyHz(
    block?.frequencyHz ?? DEFAULT_TRIGGER_FREQUENCY_HZ,
  );
  const triggerDutyCycle = normalizeDutyCycle(
    block?.dutyCycle ?? DEFAULT_TRIGGER_DUTY_CYCLE,
  );
  const triggerPeriodMs = getPeriodMsFromFrequencyHz(triggerFrequencyHz);
  const triggerHighTimeMs = getHighTimeMsFromDutyCycle(
    triggerFrequencyHz,
    triggerDutyCycle,
  );
  const gridSizeSeconds = gridSizeMs / 1_000;
  const minBlockDurationSeconds = MIN_BLOCK_DURATION_MS / 1_000;

  return (
    <Card className="glass-panel h-full min-h-0 overflow-hidden border-border/70">
      <CardContent className="flex h-full min-h-0 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Inspector
            </div>
            <h2 className="mt-1 text-xl font-semibold text-foreground">Block Configuration</h2>
          </div>
          {row ? (
            <Badge variant={row.deviceType}>
              {row.deviceType}
            </Badge>
          ) : null}
        </div>

        {!block || !row ? (
          <div className="flex flex-1 flex-col items-center justify-center rounded-3xl border border-dashed border-border/70 bg-slate-50/70 px-6 text-center">
            <div className="rounded-2xl bg-cyan-50 p-3 text-cyan-600">
              <Info className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-lg font-semibold text-foreground">Select a block</h3>
            <p className="mt-2 max-w-xs text-sm text-muted-foreground">
              Click a command block or right-click it for quick edits. You can fine-tune timing,
              channel settings, and compatible row assignment here.
            </p>
          </div>
        ) : (
          <div className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-auto pr-1">
            <div className="rounded-2xl border border-border/60 bg-white/72 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Current Selection
              </div>
              <div className="mt-2 space-y-2">
                <div className="text-lg font-semibold text-foreground">{row.name}</div>
                <div className="text-sm text-muted-foreground">
                  {getDeviceTypeLabel(row.deviceType)} - {formatDuration(block.durationMs)} - starts at{" "}
                  {formatTimelineTime(block.startMs)}
                </div>
              </div>
            </div>

            <HardwareAssignmentSelect
              id={`inspector-hardware-${row.id}`}
              row={row}
              label={row.deviceType === "trigger" ? "Output Pin" : "Pump Index"}
            />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
              <div className="space-y-2">
                <Label htmlFor="inspector-start">Block Start (s)</Label>
                <DraftNumberInput
                  id="inspector-start"
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
                <Label htmlFor="inspector-stop">Stop Time (s)</Label>
                <DraftNumberInput
                  id="inspector-stop"
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
                <Label htmlFor="inspector-duration">Duration (s)</Label>
                <DraftNumberInput
                  id="inspector-duration"
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

            {isTriggerBlock ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="inspector-trigger-mode">Trigger Block Type</Label>
                  <Select
                    id="inspector-trigger-mode"
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
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
                    <div className="space-y-2">
                      <Label htmlFor="inspector-trigger-frequency">Frequency (Hz)</Label>
                      <DraftNumberInput
                        id="inspector-trigger-frequency"
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
                      <Label htmlFor="inspector-trigger-period">Period (s)</Label>
                      <DraftNumberInput
                        id="inspector-trigger-period"
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
                      <Label htmlFor="inspector-trigger-duty">Duty Cycle (%)</Label>
                      <DraftNumberInput
                        id="inspector-trigger-duty"
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
                      <Label htmlFor="inspector-trigger-high-time">High Time (s)</Label>
                      <DraftNumberInput
                        id="inspector-trigger-high-time"
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
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
                <div className="space-y-2">
                  <Label htmlFor="inspector-direction">Direction</Label>
                  <Select
                    id="inspector-direction"
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
                  <Label htmlFor="inspector-flow-rate">Flow Rate (uL/min)</Label>
                  <DraftNumberInput
                    id="inspector-flow-rate"
                    className="pr-3 [appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none"
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
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="inspector-row">Compatible Row Assignment</Label>
              <Select
                id="inspector-row"
                value={block.rowId}
                onChange={(event) =>
                  updateBlock(block.id, {
                    rowId: event.target.value,
                  })
                }
              >
                {compatibleRows.map((candidateRow) => (
                  <option key={candidateRow.id} value={candidateRow.id}>
                    {candidateRow.name}
                  </option>
                ))}
              </Select>
            </div>

            <Separator />

            <div className="rounded-2xl border border-border/60 bg-slate-50/80 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Interaction Notes
              </div>
              <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                <li>Double-click any empty lane region to create a new block.</li>
                <li>Drag blocks horizontally to shift start time on the grid.</li>
                <li>Use the left and right edges to resize duration precisely.</li>
                <li>Move blocks between rows only when the destination device type matches.</li>
              </ul>
            </div>
          </div>
        )}

        {block ? (
          <div className="flex gap-2 border-t border-border/70 pt-4">
            <Button className="flex-1" variant="secondary">
              Selected: {formatTimelineTime(block.startMs)}
            </Button>
            <Button variant="destructive" onClick={() => deleteBlock(block.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
