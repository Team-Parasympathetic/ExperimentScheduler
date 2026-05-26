import { useEffect, useRef, useState } from "react";
import {
  Droplet,
  FlaskConical,
  FolderOpen,
  Play,
  RefreshCw,
  Save,
  Square,
  Table2,
  Trash2,
  TrendingUp,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DraftNumberInput,
  NullableDraftNumberInput,
} from "@/components/ui/draft-number-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  createPumpCalibrationSetFile,
  encodePumpVoltageAsFirmwareFlowRate,
  getFixedPumpCalibrationFit,
  getFixedPumpFlowRateForDuration,
  getFixedPumpVolumeForDuration,
  getPumpCalibrationFit,
  DEFAULT_PUMP_FLOW_UL_PER_MIN_PER_VOLT,
  MAX_PUMP_VOLTAGE,
  MIN_CALIBRATION_VOLTAGE,
  MIN_CALIBRATION_POINTS,
  type PumpCalibrationSetFile,
} from "@/lib/pump-calibration";
import {
  getDefaultJsonFileName,
  deleteProjectJsonFile,
  listProjectJsonFiles,
  loadProjectJsonFile,
  saveProjectJsonFile,
} from "@/lib/project-files";
import {
  startBoardSchedule,
  stopBoardSchedule,
  uploadBoardSchedule,
} from "@/lib/board-api";
import { cn } from "@/lib/utils";
import { useBoardStore } from "@/store/board-store";
import { usePumpCalibrationStore } from "@/store/pump-calibration-store";
import { useSchedulerStore } from "@/store/scheduler-store";
import type { Block, Direction } from "@/types/scheduler";

const CALIBRATION_START_DELAY_MS = 350;
const PRIME_VOLTAGE = 2.5;

function formatNumber(value: number, digits = 2) {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: value % 1 === 0 ? 0 : Math.min(1, digits),
  });
}

function formatVoltage(value: number) {
  return `${formatNumber(value, 3)} V`;
}

function getInverseFitLine(fit: ReturnType<typeof getPumpCalibrationFit>) {
  if (!fit.isValid) {
    return {
      slopeVoltagePerFlow: 1 / DEFAULT_PUMP_FLOW_UL_PER_MIN_PER_VOLT,
      interceptVoltage: 0,
    };
  }

  return {
    slopeVoltagePerFlow: 1 / fit.slopeFlowPerVolt,
    interceptVoltage: -fit.interceptFlowRate / fit.slopeFlowPerVolt,
  };
}

function formatFlowRate(value: number) {
  return `${formatNumber(value, value >= 100 ? 1 : 2)} uL/min`;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function PumpCalibrationPanel() {
  const calibrationRunIdRef = useRef(0);
  const rows = useSchedulerStore((state) => state.rows);
  const experimentState = useSchedulerStore((state) => state.experimentState);
  const comPort = useBoardStore((state) => state.comPort);
  const scheduleCommandState = useBoardStore((state) => state.scheduleCommandState);
  const isCalibrationRunning = useBoardStore((state) => state.isCalibrationRunning);
  const appendSerialLog = useBoardStore((state) => state.appendSerialLog);
  const setScheduleCommandState = useBoardStore((state) => state.setScheduleCommandState);
  const setCalibrationRunning = useBoardStore((state) => state.setCalibrationRunning);
  const setScheduleMessage = useBoardStore((state) => state.setScheduleMessage);
  const vMax = usePumpCalibrationStore((state) => state.vMax);
  const points = usePumpCalibrationStore((state) => state.points);
  const fixedPoints = usePumpCalibrationStore((state) => state.fixedPoints);
  const calibrationsByRowId = usePumpCalibrationStore((state) => state.calibrationsByRowId);
  const lastCalibrationFileName = usePumpCalibrationStore(
    (state) => state.lastCalibrationFileName,
  );
  const runRowId = usePumpCalibrationStore((state) => state.runRowId);
  const runDurationMs = usePumpCalibrationStore((state) => state.runDurationMs);
  const runVoltage = usePumpCalibrationStore((state) => state.runVoltage);
  const runDirection = usePumpCalibrationStore((state) => state.runDirection);
  const statusMessage = usePumpCalibrationStore((state) => state.statusMessage);
  const setVMax = usePumpCalibrationStore((state) => state.setVMax);
  const setPointCount = usePumpCalibrationStore((state) => state.setPointCount);
  const setPointVoltage = usePumpCalibrationStore((state) => state.setPointVoltage);
  const setPointMeasuredFlow = usePumpCalibrationStore((state) => state.setPointMeasuredFlow);
  const setFixedPointCount = usePumpCalibrationStore((state) => state.setFixedPointCount);
  const setFixedPointDurationMs = usePumpCalibrationStore(
    (state) => state.setFixedPointDurationMs,
  );
  const setFixedPointMeasuredVolume = usePumpCalibrationStore(
    (state) => state.setFixedPointMeasuredVolume,
  );
  const setRunRowId = usePumpCalibrationStore((state) => state.setRunRowId);
  const setRunDurationMs = usePumpCalibrationStore((state) => state.setRunDurationMs);
  const setRunVoltage = usePumpCalibrationStore((state) => state.setRunVoltage);
  const setRunDirection = usePumpCalibrationStore((state) => state.setRunDirection);
  const setStatusMessage = usePumpCalibrationStore((state) => state.setStatusMessage);
  const setLastCalibrationFileName = usePumpCalibrationStore(
    (state) => state.setLastCalibrationFileName,
  );
  const importCalibrationSet = usePumpCalibrationStore((state) => state.importCalibrationSet);
  const [calibrationFileName, setCalibrationFileName] = useState(() =>
    getDefaultJsonFileName("calibration"),
  );
  const [calibrationFiles, setCalibrationFiles] = useState<string[]>([]);
  const [selectedCalibrationFile, setSelectedCalibrationFile] = useState("");
  const [calibrationFilePendingDelete, setCalibrationFilePendingDelete] = useState("");
  const [fileMessage, setFileMessage] = useState("");
  const peristalticRows = rows.filter((row) => row.deviceType === "peristaltic");
  const selectedRunRowId =
    runRowId && peristalticRows.some((row) => row.id === runRowId)
      ? runRowId
      : peristalticRows[0]?.id ?? "";
  const selectedRunRow = peristalticRows.find((row) => row.id === selectedRunRowId) ?? null;
  const selectedPumpRateMode = selectedRunRow?.pumpRateMode === "fixed" ? "fixed" : "variable";
  const isFixedRatePump = selectedPumpRateMode === "fixed";
  const fit = getPumpCalibrationFit({ vMax, points });
  const fixedFit = getFixedPumpCalibrationFit({ points: fixedPoints });
  const inverseFit = getInverseFitLine(fit);
  const activeFitIsValid = isFixedRatePump ? fixedFit.isValid : fit.isValid;
  const activeFitPointCount = isFixedRatePump ? fixedFit.pointCount : fit.pointCount;
  const isMainScheduleRunning = experimentState === "running";
  const isBoardBusy = scheduleCommandState !== null || isCalibrationRunning || isMainScheduleRunning;
  const canRunCalibration = selectedRunRowId !== "" && !isBoardBusy;
  const canStopCalibration =
    isCalibrationRunning && scheduleCommandState === null && !isMainScheduleRunning;
  const calibrationLockMessage = isMainScheduleRunning
    ? "Main schedule is running; calibration is locked."
    : "";

  useEffect(() => {
    if (selectedRunRowId !== runRowId) {
      setRunRowId(selectedRunRowId || null);
    }
  }, [runRowId, selectedRunRowId, setRunRowId]);

  const refreshCalibrationFiles = async () => {
    try {
      const files = await listProjectJsonFiles("calibrations");
      setCalibrationFiles(files);
      setSelectedCalibrationFile((current) => current || lastCalibrationFileName || files[0] || "");
    } catch (error) {
      setFileMessage(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void refreshCalibrationFiles();
  }, []);

  useEffect(() => {
    if (!lastCalibrationFileName) {
      return;
    }

    setCalibrationFileName(lastCalibrationFileName);
    setSelectedCalibrationFile(lastCalibrationFileName);
  }, [lastCalibrationFileName]);

  const saveCalibrationFile = async () => {
    try {
      const calibrationFile = createPumpCalibrationSetFile({
        activeRowId: selectedRunRowId || null,
        calibrationsByRowId,
        rows,
      });
      const savedFileName = await saveProjectJsonFile({
        folder: "calibrations",
        fileName: calibrationFileName,
        content: calibrationFile,
      });

      setCalibrationFileName(savedFileName);
      setSelectedCalibrationFile(savedFileName);
      setLastCalibrationFileName(savedFileName);
      setCalibrationFilePendingDelete("");
      setFileMessage(`Saved ${savedFileName}.`);
      await refreshCalibrationFiles();
    } catch (error) {
      setFileMessage(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const loadCalibrationFile = async () => {
    if (!selectedCalibrationFile) {
      setFileMessage("Select a calibration file first.");
      return;
    }

    try {
      const calibrationFile = await loadProjectJsonFile<PumpCalibrationSetFile>(
        "calibrations",
        selectedCalibrationFile,
      );

      if (calibrationFile.kind !== "pumpCalibrationSet") {
        throw new Error("Selected file is not a pump calibration set.");
      }

      importCalibrationSet(calibrationFile, selectedCalibrationFile);
      setCalibrationFileName(selectedCalibrationFile);
      setCalibrationFilePendingDelete("");
      setFileMessage(`Loaded ${selectedCalibrationFile}.`);
    } catch (error) {
      setFileMessage(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const deleteCalibrationFile = async (fileToDelete: string) => {
    if (!fileToDelete) {
      setFileMessage("Select a calibration file first.");
      return;
    }

    try {
      const deletedFileName = await deleteProjectJsonFile("calibrations", fileToDelete);
      const files = await listProjectJsonFiles("calibrations");
      const nextSelectedFile =
        files.find((fileName) => fileName !== deletedFileName) ?? files[0] ?? "";

      setCalibrationFiles(files);
      setSelectedCalibrationFile(nextSelectedFile);
      setCalibrationFileName(nextSelectedFile || getDefaultJsonFileName("calibration"));
      setCalibrationFilePendingDelete("");

      if (lastCalibrationFileName === deletedFileName) {
        setLastCalibrationFileName("");
      }

      setFileMessage(`Deleted ${deletedFileName}.`);
    } catch (error) {
      setFileMessage(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runPumpPulse = async ({
    kind,
    voltage,
  }: {
    kind: "calibration" | "prime";
    voltage: number;
  }) => {
    const selectedRow = peristalticRows.find((row) => row.id === selectedRunRowId);
    const isPrime = kind === "prime";
    const pulseLabel = isPrime ? "prime" : "calibration";
    const pulseTitle = isPrime ? "Prime" : "Calibration";

    if (isMainScheduleRunning) {
      setStatusMessage(`Stop the main schedule before running ${pulseLabel}.`);
      return;
    }

    if (!selectedRow) {
      setStatusMessage("No peristaltic channel selected.");
      return;
    }

    const trimmedComPort = comPort.trim();
    const runId = calibrationRunIdRef.current + 1;
    const calibrationBlock: Block = {
      id: "calibration-pulse",
      rowId: selectedRow.id,
      startMs: 0,
      durationMs: runDurationMs,
      direction: runDirection,
      flowRate: isFixedRatePump
        ? encodePumpVoltageAsFirmwareFlowRate(MAX_PUMP_VOLTAGE)
        : encodePumpVoltageAsFirmwareFlowRate(voltage, vMax),
    };

    calibrationRunIdRef.current = runId;
    setCalibrationRunning(true);
    setScheduleCommandState("upload");
    setStatusMessage(
      isFixedRatePump
        ? `Uploading ${selectedRow.name} fixed-rate ${pulseLabel} pulse.`
        : `Uploading ${selectedRow.name} ${pulseLabel} pulse at ${formatVoltage(voltage)}.`,
    );
    setScheduleMessage(`${pulseTitle} upload in progress on ${trimmedComPort || "COM port"}...`);

    try {
      const uploadResult = await uploadBoardSchedule({
        portName: trimmedComPort,
        rows,
        blocks: [calibrationBlock],
      });

      appendSerialLog(uploadResult.log, `# ${pulseTitle} upload ${trimmedComPort || "COM port"}`);

      if (!uploadResult.ok) {
        setStatusMessage(`Failed: ${uploadResult.message}`);
        setScheduleMessage(`Failed: ${uploadResult.message}`);
        return;
      }

      setStatusMessage(`${pulseTitle} schedule uploaded.`);
      setScheduleMessage(uploadResult.message);
      await delay(CALIBRATION_START_DELAY_MS);

      if (runId !== calibrationRunIdRef.current) {
        return;
      }

      setScheduleCommandState("start");
      setStatusMessage(`Starting ${pulseLabel} pulse.`);
      setScheduleMessage(`${pulseTitle} start in progress on ${trimmedComPort || "COM port"}...`);

      const startResult = await startBoardSchedule(trimmedComPort);

      appendSerialLog(startResult.log, `# ${pulseTitle} start ${trimmedComPort || "COM port"}`);
      setStatusMessage(
        startResult.ok
          ? `${selectedRow.name} ${pulseLabel} running for ${formatNumber(runDurationMs / 1_000, 1)} s.`
          : `Failed: ${startResult.message}`,
      );
      setScheduleMessage(startResult.ok ? startResult.message : `Failed: ${startResult.message}`);

      if (startResult.ok) {
        setScheduleCommandState(null);
        await delay(runDurationMs);

        if (runId === calibrationRunIdRef.current) {
          setStatusMessage(`${pulseTitle} pulse complete.`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`Failed: ${message}`);
      setScheduleMessage(`Failed: ${message}`);
    } finally {
      if (runId === calibrationRunIdRef.current) {
        setScheduleCommandState(null);
        setCalibrationRunning(false);
      }
    }
  };

  const runCalibration = async () => {
    await runPumpPulse({
      kind: "calibration",
      voltage: runVoltage,
    });
  };

  const runPrime = async () => {
    await runPumpPulse({
      kind: "prime",
      voltage: Math.min(PRIME_VOLTAGE, vMax),
    });
  };

  const stopCalibration = async () => {
    if (!canStopCalibration) {
      return;
    }

    const trimmedComPort = comPort.trim();
    calibrationRunIdRef.current += 1;
    setScheduleCommandState("stop");
    setStatusMessage(`Stopping calibration on ${trimmedComPort || "COM port"}...`);
    setScheduleMessage(`Calibration stop in progress on ${trimmedComPort || "COM port"}...`);

    try {
      const stopResult = await stopBoardSchedule(trimmedComPort);

      appendSerialLog(stopResult.log, `# Calibration stop ${trimmedComPort || "COM port"}`);
      setStatusMessage(stopResult.ok ? "Calibration stopped." : `Failed: ${stopResult.message}`);
      setScheduleMessage(stopResult.ok ? stopResult.message : `Failed: ${stopResult.message}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusMessage(`Failed: ${message}`);
      setScheduleMessage(`Failed: ${message}`);
    } finally {
      setScheduleCommandState(null);
      setCalibrationRunning(false);
    }
  };

  return (
    <Card className="glass-panel h-full min-h-0 overflow-hidden border-border/70">
      <CardContent className="flex h-full min-h-0 flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Calibration
            </div>
            <h2 className="mt-1 text-xl font-semibold text-foreground">Pump Calibration</h2>
          </div>
          <Badge
            className={
              activeFitIsValid
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-slate-200 bg-slate-50 text-slate-600"
            }
          >
            {activeFitIsValid
              ? isFixedRatePump
                ? "Fixed Fit Active"
                : "Fit Active"
              : `${activeFitPointCount}/${MIN_CALIBRATION_POINTS} Points`}
          </Badge>
        </div>

        <div className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-auto pr-1">
          <section className="rounded-lg border border-border/60 bg-white/72 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                <Save className="h-4 w-4 text-slate-500" />
                Calibration File
              </div>
              <Button
                className="h-7 px-2"
                size="sm"
                variant="ghost"
                onClick={() => void refreshCalibrationFiles()}
                title="Refresh calibration files"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="grid gap-2">
              <Input
                value={calibrationFileName}
                onChange={(event) => setCalibrationFileName(event.target.value)}
              />
              <div className="grid grid-cols-[minmax(0,1fr),auto] gap-2">
                <Select
                  value={selectedCalibrationFile}
                  onChange={(event) => {
                    setSelectedCalibrationFile(event.target.value);
                    setCalibrationFilePendingDelete("");
                    if (event.target.value) {
                      setCalibrationFileName(event.target.value);
                    }
                  }}
                >
                  <option value="">No saved calibrations</option>
                  {calibrationFiles.map((fileName) => (
                    <option key={fileName} value={fileName}>
                      {fileName}
                    </option>
                  ))}
                </Select>
                <Button
                  aria-label="Delete selected calibration"
                  disabled={!selectedCalibrationFile}
                  size="icon"
                  title="Delete selected calibration"
                  variant="outline"
                  onClick={() => setCalibrationFilePendingDelete(selectedCalibrationFile)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {calibrationFilePendingDelete ? (
                <div className="grid grid-cols-[minmax(0,1fr),auto,auto] items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-2 py-2 text-[11px] text-rose-700">
                  <div className="truncate" title={calibrationFilePendingDelete}>
                    Delete {calibrationFilePendingDelete}?
                  </div>
                  <Button
                    className="h-7 px-2 text-[11px]"
                    size="sm"
                    variant="ghost"
                    onClick={() => setCalibrationFilePendingDelete("")}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="h-7 px-2 text-[11px]"
                    size="sm"
                    variant="destructive"
                    onClick={() => void deleteCalibrationFile(calibrationFilePendingDelete)}
                  >
                    Delete
                  </Button>
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="outline" onClick={saveCalibrationFile}>
                  <Save className="h-4 w-4" />
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!selectedCalibrationFile}
                  onClick={loadCalibrationFile}
                >
                  <FolderOpen className="h-4 w-4" />
                  Load
                </Button>
              </div>
              {fileMessage ? (
                <div className="truncate rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
                  {fileMessage}
                </div>
              ) : null}
            </div>
          </section>

          <section
            className={cn(
              "rounded-lg border border-border/60 bg-white/72 p-4 transition-opacity",
              isMainScheduleRunning && "bg-slate-100/80 opacity-60",
            )}
          >
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              <FlaskConical className="h-4 w-4 text-cyan-600" />
              Calibration Run
            </div>

            <div className="mt-3 grid gap-3">
              <div className="space-y-2">
                <Label htmlFor="calibration-pump">Pump</Label>
                <Select
                  id="calibration-pump"
                  disabled={isMainScheduleRunning}
                  value={selectedRunRowId}
                  onChange={(event) => setRunRowId(event.target.value || null)}
                >
                  {peristalticRows.length > 0 ? (
                    peristalticRows.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))
                  ) : (
                    <option value="">No peristaltic channels</option>
                  )}
                </Select>
              </div>

              <div className={cn("grid gap-3", !isFixedRatePump && "sm:grid-cols-2")}>
                <div className="space-y-2">
                  <Label htmlFor="calibration-duration">Duration</Label>
                  <div className="relative">
                    <DraftNumberInput
                      id="calibration-duration"
                      className="pr-10"
                      disabled={isMainScheduleRunning}
                      min={0.5}
                      minValue={0.5}
                      step={0.5}
                      type="number"
                      value={runDurationMs / 1_000}
                      onCommit={(value) => setRunDurationMs(value * 1_000)}
                    />
                    <span className="pointer-events-none absolute right-8 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                      s
                    </span>
                  </div>
                </div>

                {!isFixedRatePump ? (
                  <div className="space-y-2">
                    <Label htmlFor="calibration-voltage">Voltage</Label>
                    <div className="relative">
                      <DraftNumberInput
                        id="calibration-voltage"
                        className="pr-10"
                        disabled={isMainScheduleRunning}
                        max={vMax}
                        maxValue={vMax}
                        min={MIN_CALIBRATION_VOLTAGE}
                        minValue={MIN_CALIBRATION_VOLTAGE}
                        step={0.05}
                        type="number"
                        value={runVoltage}
                        onCommit={setRunVoltage}
                      />
                      <span className="pointer-events-none absolute right-8 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                        V
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-[minmax(160px,0.85fr),minmax(150px,0.8fr),minmax(190px,1fr),minmax(190px,1fr)]">
                <div className="min-w-0 space-y-2 sm:col-span-2 2xl:col-span-1">
                  <Label htmlFor="calibration-direction">Direction</Label>
                  <Select
                    id="calibration-direction"
                    disabled={isMainScheduleRunning}
                    value={runDirection}
                    onChange={(event) =>
                      setRunDirection(event.target.value as Direction)
                    }
                  >
                    <option value="forward">Forward</option>
                    <option value="reverse">Reverse</option>
                  </Select>
                </div>

                <Button
                  className="w-full self-end"
                  disabled={!canRunCalibration}
                  title={
                    isMainScheduleRunning
                      ? "Stop the main schedule before priming"
                      : isFixedRatePump
                      ? "Prime the selected fixed-rate pump"
                      : `Prime the selected pump at ${formatVoltage(Math.min(PRIME_VOLTAGE, vMax))}`
                  }
                  variant="secondary"
                  onClick={runPrime}
                >
                  <Droplet className="h-4 w-4" />
                  {isMainScheduleRunning ? "Locked" : isBoardBusy ? "Running" : "Prime"}
                </Button>

                <Button
                  className="w-full self-end"
                  disabled={!canRunCalibration}
                  title={
                    isMainScheduleRunning
                      ? "Stop the main schedule before running calibration"
                      : undefined
                  }
                  onClick={runCalibration}
                >
                  {scheduleCommandState === "upload" ? (
                    <Upload className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  {isMainScheduleRunning ? "Locked" : isBoardBusy ? "Running" : "Run Calibration"}
                </Button>
                <Button
                  className="w-full self-end"
                  disabled={!canStopCalibration}
                  title={
                    isCalibrationRunning
                      ? "Stop the active calibration pulse"
                      : "No calibration pulse is running"
                  }
                  variant="outline"
                  onClick={stopCalibration}
                >
                  <Square className="h-4 w-4" />
                  {scheduleCommandState === "stop" ? "Stopping" : "Stop Calibration"}
                </Button>
              </div>
            </div>

            {calibrationLockMessage || statusMessage ? (
              <div
                className={cn(
                  "mt-3 rounded-lg border px-3 py-2 text-xs",
                  statusMessage.toLowerCase().includes("failed")
                    ? "border-rose-200 bg-rose-50 text-rose-700"
                    : "border-slate-200 bg-slate-50 text-slate-600",
                )}
              >
                {calibrationLockMessage || statusMessage}
              </div>
            ) : null}
          </section>

          <section className="rounded-lg border border-border/60 bg-white/72 p-4">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              <Table2 className="h-4 w-4 text-orange-600" />
              Calibration Table
            </div>

            {isFixedRatePump ? (
              <>
                <div className="mt-3 max-w-[180px] space-y-2">
                  <Label htmlFor="fixed-calibration-point-count">Points</Label>
                  <DraftNumberInput
                    id="fixed-calibration-point-count"
                    min={MIN_CALIBRATION_POINTS}
                    minValue={MIN_CALIBRATION_POINTS}
                    step={1}
                    type="number"
                    value={fixedPoints.length}
                    onCommit={setFixedPointCount}
                  />
                </div>

                <div className="mt-4 overflow-hidden rounded-lg border border-border/60">
                  <div className="grid grid-cols-[52px,minmax(96px,0.9fr),minmax(124px,1.1fr)] bg-slate-50/90 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    <div>Point</div>
                    <div>Duration</div>
                    <div>Measured Volume</div>
                  </div>
                  <div className="divide-y divide-border/60">
                    {fixedPoints.map((point, index) => (
                      <div
                        key={point.id}
                        className="grid grid-cols-[52px,minmax(96px,0.9fr),minmax(124px,1.1fr)] items-center gap-2 px-3 py-2"
                      >
                        <div className="text-xs font-semibold text-muted-foreground">
                          {index + 1}
                        </div>
                        <div className="relative">
                          <DraftNumberInput
                            className="h-8 pr-8 text-xs"
                            min={0.5}
                            minValue={0.5}
                            step={0.5}
                            type="number"
                            value={point.durationMs / 1_000}
                            onCommit={(value) =>
                              setFixedPointDurationMs(point.id, value * 1_000)
                            }
                          />
                          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                            s
                          </span>
                        </div>
                        <div className="relative">
                          <NullableDraftNumberInput
                            className="h-8 pr-10 text-xs"
                            min={0}
                            minValue={0}
                            step={1}
                            type="number"
                            value={point.measuredVolumeUl}
                            onCommit={(value) =>
                              setFixedPointMeasuredVolume(point.id, value)
                            }
                          />
                          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                            uL
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="calibration-vmax">V_MAX</Label>
                    <div className="relative">
                      <DraftNumberInput
                        className="pr-10"
                        id="calibration-vmax"
                        max={MAX_PUMP_VOLTAGE}
                        maxValue={MAX_PUMP_VOLTAGE}
                        min={MIN_CALIBRATION_VOLTAGE}
                        minValue={MIN_CALIBRATION_VOLTAGE}
                        step={0.05}
                        type="number"
                        value={vMax}
                        onCommit={setVMax}
                      />
                      <span className="pointer-events-none absolute right-8 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                        V
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="calibration-point-count">Points</Label>
                    <DraftNumberInput
                      id="calibration-point-count"
                      min={MIN_CALIBRATION_POINTS}
                      minValue={MIN_CALIBRATION_POINTS}
                      step={1}
                      type="number"
                      value={points.length}
                      onCommit={setPointCount}
                    />
                  </div>
                </div>

                <div className="mt-4 overflow-hidden rounded-lg border border-border/60">
                  <div className="grid grid-cols-[52px,minmax(108px,0.95fr),minmax(120px,1.05fr)] bg-slate-50/90 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    <div>Point</div>
                    <div>Voltage</div>
                    <div>Measured Flow</div>
                  </div>
                  <div className="divide-y divide-border/60">
                    {points.map((point, index) => (
                      <div
                        key={point.id}
                        className="grid grid-cols-[52px,minmax(108px,0.95fr),minmax(120px,1.05fr)] items-center gap-2 px-3 py-2"
                      >
                        <div className="text-xs font-semibold text-muted-foreground">
                          {index + 1}
                        </div>
                        <div className="relative">
                          <DraftNumberInput
                            className="h-8 pr-10 text-xs"
                            max={vMax}
                            maxValue={vMax}
                            min={MIN_CALIBRATION_VOLTAGE}
                            minValue={MIN_CALIBRATION_VOLTAGE}
                            step={0.05}
                            type="number"
                            value={point.voltage}
                            onCommit={(value) => setPointVoltage(point.id, value)}
                          />
                          <span className="pointer-events-none absolute right-8 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                            V
                          </span>
                        </div>
                        <div className="relative">
                          <NullableDraftNumberInput
                            className="h-8 pr-16 text-xs"
                            min={0}
                            minValue={0}
                            step={1}
                            type="number"
                            value={point.measuredFlowRate}
                            onCommit={(value) => setPointMeasuredFlow(point.id, value)}
                          />
                          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                            uL/min
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </section>

          <section className="rounded-lg border border-border/60 bg-slate-50/80 p-4">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              <TrendingUp className="h-4 w-4 text-slate-500" />
              Fit Line
            </div>

            <div className="mt-3 grid gap-2 text-sm">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-white/72 px-3 py-2">
                <span className="text-muted-foreground">Slope</span>
                <span className="font-mono text-foreground">
                  {isFixedRatePump
                    ? `${formatNumber(fixedFit.slopeVolumeUlPerSecond, 4)} uL/s`
                    : `${formatNumber(inverseFit.slopeVoltagePerFlow, 6)} V/(uL/min)`}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-white/72 px-3 py-2">
                <span className="text-muted-foreground">Intercept</span>
                <span className="font-mono text-foreground">
                  {isFixedRatePump
                    ? `${formatNumber(fixedFit.interceptVolumeUl, 3)} uL`
                    : `${formatNumber(inverseFit.interceptVoltage, 4)} V`}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-white/72 px-3 py-2">
                <span className="text-muted-foreground">R2</span>
                <span className="font-mono text-foreground">
                  {(isFixedRatePump ? fixedFit.rSquared : fit.rSquared) === null
                    ? "--"
                    : formatNumber((isFixedRatePump ? fixedFit.rSquared : fit.rSquared) ?? 0, 4)}
                </span>
              </div>
              {isFixedRatePump ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-white/72 px-3 py-2">
                  <span className="text-muted-foreground">At Run Duration</span>
                  <span className="font-mono text-foreground">
                    {`${formatNumber(getFixedPumpVolumeForDuration(runDurationMs, fixedFit), 2)} uL, ${formatFlowRate(getFixedPumpFlowRateForDuration(runDurationMs, fixedFit))}`}
                  </span>
                </div>
              ) : null}
              <div className="rounded-lg border border-border/60 bg-white/72 px-3 py-2 font-mono text-xs text-foreground">
                {isFixedRatePump
                  ? `volume = ${formatNumber(fixedFit.slopeVolumeUlPerSecond, 4)} * seconds + ${formatNumber(fixedFit.interceptVolumeUl, 3)}`
                  : `V = ${formatNumber(inverseFit.slopeVoltagePerFlow, 6)} * flow + ${formatNumber(inverseFit.interceptVoltage, 4)}`}
              </div>
            </div>
          </section>
        </div>
      </CardContent>
    </Card>
  );
}
