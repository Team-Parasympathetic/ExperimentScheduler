import { useCallback, useEffect, useState } from "react";
import { Cpu, ListChecks, PanelsTopLeft, Terminal } from "lucide-react";
import backplaneImage from "@/assets/backplane.png";
import pumpCardImage from "@/assets/pump-control-card.png";
import timingCardImage from "@/assets/timing-card.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  FIRMWARE_SCHEDULE_LIMITS,
  getFirmwareScheduleSummary,
} from "@/lib/firmware-constraints";
import { detectBackplane } from "@/lib/board-api";
import { cn } from "@/lib/utils";
import {
  useBoardStore,
  type DeviceSlotInfo,
  type SlotCardType,
} from "@/store/board-store";
import { useSchedulerStore } from "@/store/scheduler-store";

interface SlotDetection extends DeviceSlotInfo {
  detail: string;
}

type DetectionState = "idle" | "detecting" | "detected" | "not-detected";

interface DetectDeviceOptions {
  logHeader?: string;
  shouldApplyResult?: () => boolean;
  assignRows?: boolean;
}

const BACKPLANE_SLOT_COUNT = 8;
const BACKPLANE_IMAGE_WIDTH_PX = 1570;
const FIRST_SLOT_CENTER_X_PX = 402;
const SLOT_CENTER_SPACING_X_PX = 150;
const STARTUP_DETECTION_ATTEMPTS = 3;
const STARTUP_DETECTION_RETRY_DELAY_MS = 800;

function getSlotLeftPercent(slot: number) {
  const slotCenterX = FIRST_SLOT_CENTER_X_PX + SLOT_CENTER_SPACING_X_PX * slot;
  return (slotCenterX / BACKPLANE_IMAGE_WIDTH_PX) * 100;
}

function getEmptySlot(slot: number): SlotDetection {
  return {
    slot,
    present: false,
    cardType: "empty",
    rawCardType: 0,
    firmwareMajor: 0,
    firmwareMinor: 0,
    capabilities: 0,
    maxLocalEvents: 0,
    detail: "Empty",
  };
}

function getEmptySlotDetection() {
  return Array.from({ length: BACKPLANE_SLOT_COUNT }, (_, slot) => getEmptySlot(slot));
}

function formatHex(value: number, width: number) {
  return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}

function getSlotDetail(slot: DeviceSlotInfo): string {
  if (!slot.present || slot.cardType === "empty") {
    return "Empty";
  }

  const firmwareText = `fw ${slot.firmwareMajor}.${slot.firmwareMinor}`;

  if (slot.cardType === "pump") {
    return `Pump card, ${firmwareText}`;
  }

  if (slot.cardType === "timing") {
    return `Timing card, ${firmwareText}`;
  }

  return `Unknown ${formatHex(slot.rawCardType, 2)}, ${firmwareText}`;
}

function normalizeSlotCardType(cardType: SlotCardType, present: boolean): SlotCardType {
  if (!present) {
    return "empty";
  }

  return cardType === "pump" || cardType === "timing" || cardType === "unknown"
    ? cardType
    : "unknown";
}

function normalizeSlotDetection(deviceSlots: DeviceSlotInfo[]): SlotDetection[] {
  const slots = getEmptySlotDetection();

  for (const deviceSlot of deviceSlots) {
    if (!Number.isInteger(deviceSlot.slot)) {
      continue;
    }

    if (deviceSlot.slot < 0 || deviceSlot.slot >= BACKPLANE_SLOT_COUNT) {
      continue;
    }

    const normalizedSlot: DeviceSlotInfo = {
      slot: deviceSlot.slot,
      present: Boolean(deviceSlot.present),
      cardType: normalizeSlotCardType(deviceSlot.cardType, Boolean(deviceSlot.present)),
      rawCardType: deviceSlot.rawCardType ?? 0,
      firmwareMajor: deviceSlot.firmwareMajor ?? 0,
      firmwareMinor: deviceSlot.firmwareMinor ?? 0,
      capabilities: deviceSlot.capabilities ?? 0,
      maxLocalEvents: deviceSlot.maxLocalEvents ?? 0,
    };

    slots[deviceSlot.slot] = {
      ...normalizedSlot,
      detail: getSlotDetail(normalizedSlot),
    };
  }

  return slots;
}

function Metric({
  label,
  value,
  isOk = true,
}: {
  label: string;
  value: string;
  isOk?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-white/72 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className={isOk ? "mt-1 text-sm font-semibold text-foreground" : "mt-1 text-sm font-semibold text-rose-600"}>
        {value}
      </div>
    </div>
  );
}

function DeviceDetectionControls({
  comPort,
  detectionMessage,
  detectionState,
  isBoardLocked,
  lockReason,
  onComPortChange,
  onDetect,
}: {
  comPort: string;
  detectionMessage: string;
  detectionState: DetectionState;
  isBoardLocked: boolean;
  lockReason: string;
  onComPortChange: (comPort: string) => void;
  onDetect: () => void;
}) {
  const isDetected = detectionState === "detected";
  const isDetecting = detectionState === "detecting";
  const isDetectionDisabled = isDetecting || isBoardLocked;

  return (
    <section className="rounded-lg border border-border/60 bg-white/72 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Device Link
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">
            USB CDC
          </div>
        </div>
        <Badge
          className={
            isDetected
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-slate-200 bg-slate-50 text-slate-600"
          }
        >
          {isDetected ? "Device Detected" : "No Device"}
        </Badge>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr),auto]">
        <div className="space-y-1.5">
          <Label htmlFor="device-com-port">COM Port</Label>
          <Input
            id="device-com-port"
            value={comPort}
            placeholder="COM7"
            onChange={(event) => onComPortChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !isDetectionDisabled) {
                onDetect();
              }
            }}
          />
        </div>
        <Button
          className="self-end"
          disabled={isDetectionDisabled}
          title={isBoardLocked ? `Detection is paused while ${lockReason}.` : undefined}
          onClick={onDetect}
        >
          {isBoardLocked ? "Locked" : isDetecting ? "Detecting" : "Detect"}
        </Button>
      </div>

      {detectionMessage ? (
        <div
          className={cn(
            "mt-3 rounded-lg border px-3 py-2 text-xs",
            isDetected
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-slate-200 bg-slate-50 text-slate-600",
          )}
        >
          {detectionMessage}
        </div>
      ) : null}
    </section>
  );
}

function SlotDetectionWindow({
  isDeviceDetected,
  slots,
}: {
  isDeviceDetected: boolean;
  slots: SlotDetection[];
}) {
  const occupiedSlotCount = slots.filter((slot) => slot.present).length;

  return (
    <section className="rounded-lg border border-border/60 bg-white/72 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          <PanelsTopLeft className="h-4 w-4 text-cyan-600" />
          Slot Detection
        </div>
        <Badge variant="default">
          {occupiedSlotCount}/{slots.length} occupied
        </Badge>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-border/60 bg-slate-50/85 p-1">
        <div className="relative">
          <img
            src={backplaneImage}
            alt="Backplane"
            className={cn(
              "relative z-0 w-full select-none transition",
              isDeviceDetected ? "opacity-100" : "opacity-[0.35] grayscale",
            )}
            draggable={false}
          />
          <div className="absolute inset-0 z-10">
            {isDeviceDetected ? slots.map((slot) => {
              if (!slot.present || (slot.cardType !== "pump" && slot.cardType !== "timing")) {
                return null;
              }

              return (
                <img
                  key={`slot-card-${slot.slot}`}
                  src={slot.cardType === "pump" ? pumpCardImage : timingCardImage}
                  alt={slot.cardType === "pump" ? "Pump control card" : "Timing card"}
                  className="absolute top-0 h-full max-w-none -translate-x-1/2 select-none object-contain drop-shadow-[0_8px_18px_rgba(15,23,42,0.22)]"
                  draggable={false}
                  style={{
                    left: `${getSlotLeftPercent(slot.slot)}%`,
                  }}
                />
              );
            }) : null}

            {slots.map((slot) => (
              <div
                key={`slot-label-${slot.slot}`}
                className={cn(
                  "absolute bottom-1 z-20 -translate-x-1/2 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] shadow-sm",
                  slot.cardType === "pump" &&
                    "border-cyan-200 bg-cyan-50/95 text-cyan-700",
                  slot.cardType === "timing" &&
                    "border-orange-200 bg-orange-50/95 text-orange-700",
                  slot.cardType === "unknown" &&
                    "border-violet-200 bg-violet-50/95 text-violet-700",
                  slot.cardType === "empty" &&
                    "border-slate-200 bg-white/85 text-slate-500",
                )}
                style={{ left: `${getSlotLeftPercent(slot.slot)}%` }}
              >
                S{slot.slot}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {slots.map((slot) => (
          <div
            key={slot.slot}
            className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-slate-50/70 px-3 py-2 text-xs"
          >
            <span className="font-semibold text-foreground">Slot {slot.slot}</span>
            <span
              className={cn(
                "truncate text-right",
                slot.cardType === "pump" && "text-cyan-700",
                slot.cardType === "timing" && "text-orange-700",
                slot.cardType === "unknown" && "text-violet-700",
                slot.cardType === "empty" && "text-muted-foreground",
              )}
            >
              {slot.detail}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SerialConsole({
  entries,
  onClear,
}: {
  entries: string[];
  onClear: () => void;
}) {
  return (
    <section className="rounded-lg border border-border/60 bg-slate-950 p-3 text-slate-100">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-300">
          <Terminal className="h-4 w-4 text-cyan-300" />
          Serial Console
        </div>
        <Button
          className="h-7 border-slate-700 bg-slate-900 px-2 text-[10px] text-slate-200 hover:bg-slate-800"
          size="sm"
          variant="outline"
          onClick={onClear}
        >
          Clear
        </Button>
      </div>
      <div className="thin-scrollbar mt-3 max-h-44 overflow-auto rounded-md border border-slate-800 bg-black/45 p-2 font-mono text-[10px] leading-relaxed text-slate-200">
        {entries.length > 0 ? (
          entries.map((entry, index) => (
            <div key={`${index}-${entry}`} className="break-all">
              {entry}
            </div>
          ))
        ) : (
          <div className="text-slate-500">No serial transactions yet.</div>
        )}
      </div>
    </section>
  );
}

export function DeviceOverviewPanel() {
  const rows = useSchedulerStore((state) => state.rows);
  const blocks = useSchedulerStore((state) => state.blocks);
  const experimentState = useSchedulerStore((state) => state.experimentState);
  const syncDetectedPumpHardware = useSchedulerStore(
    (state) => state.syncDetectedPumpHardware,
  );
  const comPort = useBoardStore((state) => state.comPort);
  const serialLog = useBoardStore((state) => state.serialLog);
  const appendSerialLog = useBoardStore((state) => state.appendSerialLog);
  const clearSerialLog = useBoardStore((state) => state.clearSerialLog);
  const setComPort = useBoardStore((state) => state.setComPort);
  const setDetectedSlots = useBoardStore((state) => state.setDetectedSlots);
  const isCalibrationRunning = useBoardStore((state) => state.isCalibrationRunning);
  const [detectionState, setDetectionState] = useState<DetectionState>("idle");
  const [detectionMessage, setDetectionMessage] = useState("");
  const [slots, setSlots] = useState<SlotDetection[]>(() => getEmptySlotDetection());
  const summary = getFirmwareScheduleSummary(blocks, rows);
  const isDeviceDetected = detectionState === "detected";
  const isMainScheduleRunning = experimentState === "running";
  const boardLockReason = isMainScheduleRunning
    ? "the main schedule is running"
    : isCalibrationRunning
    ? "calibration is running"
    : "";
  const isBoardLocked = boardLockReason !== "";

  const detectDevice = useCallback(async (options: DetectDeviceOptions = {}) => {
    const logHeader = options.logHeader ?? "# Detect";
    const shouldApplyResult = options.shouldApplyResult ?? (() => true);
    const shouldAssignRows = options.assignRows ?? false;
    const trimmedComPort = comPort.trim();

    if (isBoardLocked) {
      if (shouldApplyResult()) {
        setDetectionMessage(`Detection paused while ${boardLockReason}.`);
      }

      return false;
    }

    if (shouldApplyResult()) {
      setDetectionState("detecting");
      setSlots(getEmptySlotDetection());
      setDetectionMessage(`Reading inventory from ${trimmedComPort || "COM port"}...`);
    }

    try {
      const result = await detectBackplane(trimmedComPort);

      if (shouldApplyResult()) {
        setDetectionState(result.detected ? "detected" : "not-detected");
        setDetectionMessage(result.message);
        setSlots(result.detected ? normalizeSlotDetection(result.slots) : getEmptySlotDetection());
        setDetectedSlots(result.detected ? result.slots : []);
        syncDetectedPumpHardware(result.detected ? result.slots : [], {
          assignRows: shouldAssignRows && result.detected,
        });
        appendSerialLog(result.log, `${logHeader} ${trimmedComPort || "COM port"}`);
      }

      return result.detected;
    } catch (error) {
      if (shouldApplyResult()) {
        setDetectionState("not-detected");
        setDetectionMessage(error instanceof Error ? error.message : String(error));
        setSlots(getEmptySlotDetection());
        setDetectedSlots([]);
        syncDetectedPumpHardware([]);
      }

      return false;
    }
  }, [
    appendSerialLog,
    boardLockReason,
    comPort,
    isBoardLocked,
    setDetectedSlots,
    syncDetectedPumpHardware,
  ]);

  useEffect(() => {
    let isCancelled = false;

    async function runStartupDetection() {
      for (let attempt = 1; attempt <= STARTUP_DETECTION_ATTEMPTS; attempt += 1) {
        if (isCancelled) {
          return;
        }

        const isDetected = await detectDevice({
          assignRows: true,
          logHeader: `# Startup detect ${attempt}/${STARTUP_DETECTION_ATTEMPTS}`,
          shouldApplyResult: () => !isCancelled,
        });

        if (isDetected || isCancelled) {
          return;
        }

        if (attempt < STARTUP_DETECTION_ATTEMPTS) {
          await new Promise((resolve) => {
            window.setTimeout(resolve, STARTUP_DETECTION_RETRY_DELAY_MS);
          });
        }
      }
    }

    const startupTimer = window.setTimeout(() => {
      void runStartupDetection();
    }, 0);

    return () => {
      isCancelled = true;
      window.clearTimeout(startupTimer);
    };
  }, []);

  return (
    <Card className="glass-panel h-full min-h-0 overflow-hidden border-border/70">
      <CardContent className="flex h-full min-h-0 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Devices
            </div>
            <h2 className="mt-1 text-xl font-semibold text-foreground">Device Overview</h2>
          </div>
          <Badge
            className={
              summary.isWithinLimits
                ? undefined
                : "border-rose-200 bg-rose-50 text-rose-700"
            }
          >
            {summary.isWithinLimits ? "Within Limits" : "Limit Hit"}
          </Badge>
        </div>

        <div className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-auto pr-1">
          <DeviceDetectionControls
            comPort={comPort}
            detectionMessage={detectionMessage}
            detectionState={detectionState}
            isBoardLocked={isBoardLocked}
            lockReason={boardLockReason}
            onComPortChange={(nextComPort) => {
              setComPort(nextComPort);
              if (detectionState !== "idle") {
                setDetectionState("idle");
                setDetectionMessage("");
                setSlots(getEmptySlotDetection());
                setDetectedSlots([]);
                syncDetectedPumpHardware([]);
              }
            }}
            onDetect={detectDevice}
          />

          <SlotDetectionWindow isDeviceDetected={isDeviceDetected} slots={slots} />

          <SerialConsole entries={serialLog} onClear={clearSerialLog} />

          <section className="rounded-lg border border-border/60 bg-white/72 p-4">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              <ListChecks className="h-4 w-4 text-orange-600" />
              Compiled Schedule
            </div>
            <div className="mt-3 grid gap-2">
              <Metric
                label="Events"
                value={`${summary.eventCount} / ${FIRMWARE_SCHEDULE_LIMITS.maxEvents}`}
                isOk={summary.eventsWithinLimit}
              />
              <Metric
                label="Transition Actions"
                value={String(summary.transitionActionCount)}
              />
              <Metric
                label="FPGA GPIO Actions"
                value={`${summary.gpioActionCount} / ${FIRMWARE_SCHEDULE_LIMITS.maxGpioActions}`}
                isOk={summary.gpioActionsWithinLimit}
              />
              <Metric
                label="Schedule Status"
                value={
                  summary.scheduleStatusRowCount === 0
                    ? "Off"
                    : !summary.scheduleStatusRowsWithinLimit
                      ? "Duplicate"
                      : summary.scheduleStatusRowsEmpty
                      ? "Ready"
                      : "Reserved"
                }
                isOk={summary.scheduleStatusRowsWithinLimit && summary.scheduleStatusRowsEmpty}
              />
              <Metric
                label="Hardware Assignments"
                value={
                  summary.hardwareAssignmentsComplete
                    ? summary.hardwareAssignmentsUnique
                      ? "Complete"
                      : "Duplicate"
                    : "Missing"
                }
                isOk={summary.hardwareAssignmentsComplete && summary.hardwareAssignmentsUnique}
              />
              <Metric
                label="Busiest Event"
                value={`${summary.maxActionBytesAtEvent} / ${FIRMWARE_SCHEDULE_LIMITS.maxEventActionBytes} B`}
                isOk={summary.actionBytesWithinLimit}
              />
            </div>
          </section>

          <section className="rounded-lg border border-border/60 bg-slate-50/80 p-4">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              <Cpu className="h-4 w-4 text-slate-500" />
              Firmware Constraints
            </div>
            <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
              <div className="flex items-center justify-between gap-3">
                <span>Schedule events</span>
                <span className="font-mono text-foreground">{FIRMWARE_SCHEDULE_LIMITS.maxEvents}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Action bytes per event</span>
                <span className="font-mono text-foreground">
                  {FIRMWARE_SCHEDULE_LIMITS.maxEventActionBytes} B
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Event spacing</span>
                <span className="font-mono text-foreground">
                  {FIRMWARE_SCHEDULE_LIMITS.minEventSpacingMs} ms
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>USB payload</span>
                <span className="font-mono text-foreground">
                  {FIRMWARE_SCHEDULE_LIMITS.maxProtocolPayloadBytes} B
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Event payload ceiling</span>
                <span className="font-mono text-foreground">{summary.maxEventPayloadBytes} B</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Pump channels</span>
                <span className="font-mono text-foreground">
                  {FIRMWARE_SCHEDULE_LIMITS.maxPumps}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>FPGA GPIO outputs</span>
                <span className="font-mono text-foreground">
                  {FIRMWARE_SCHEDULE_LIMITS.maxGpioOutputs}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>FPGA GPIO actions</span>
                <span className="font-mono text-foreground">
                  {FIRMWARE_SCHEDULE_LIMITS.maxGpioActions}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Schedule status outputs</span>
                <span className="font-mono text-foreground">1</span>
              </div>
            </div>
          </section>
        </div>
      </CardContent>
    </Card>
  );
}
