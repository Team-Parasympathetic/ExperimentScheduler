import {
  FolderOpen,
  Gauge,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useState } from "react";
import nectowLabLogo from "@/assets/nectow-lab-logo.svg";
import { OverviewMinimap } from "@/components/overview-minimap";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DraftNumberInput } from "@/components/ui/draft-number-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  GRID_OPTIONS,
  ZOOM_LEVELS,
  formatTimelineTime,
} from "@/lib/time";
import {
  FIRMWARE_SCHEDULE_LIMITS,
  getFirmwareScheduleSummary,
} from "@/lib/firmware-constraints";
import {
  applyPumpCalibrationToBlocksByRowId,
  createPumpCalibrationSetFile,
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
import {
  useBoardStore,
  type ScheduleCommand,
} from "@/store/board-store";
import { usePumpCalibrationStore } from "@/store/pump-calibration-store";
import { useSchedulerStore } from "@/store/scheduler-store";
import type { Block, DeviceType, Row } from "@/types/scheduler";

interface ScheduleFile {
  kind: "experimentSchedule";
  schemaVersion: 1;
  savedAt: string;
  rows: Row[];
  blocks: Block[];
  gridSizeMs: number;
  zoomPxPerMinute: number;
  experimentDurationMs: number;
  lastCalibrationFileName: string;
}

interface TopToolbarProps {
  totalDurationMs: number;
  viewportStartMs: number;
  viewportDurationMs: number;
  onJumpToTime: (timeMs: number, behavior?: ScrollBehavior) => void;
}

export function TopToolbar({
  totalDurationMs,
  viewportDurationMs,
  viewportStartMs,
  onJumpToTime,
}: TopToolbarProps) {
  const rows = useSchedulerStore((state) => state.rows);
  const blocks = useSchedulerStore((state) => state.blocks);
  const gridSizeMs = useSchedulerStore((state) => state.gridSizeMs);
  const zoomPxPerMinute = useSchedulerStore((state) => state.zoomPxPerMinute);
  const experimentState = useSchedulerStore((state) => state.experimentState);
  const playheadMs = useSchedulerStore((state) => state.playheadMs);
  const addRow = useSchedulerStore((state) => state.addRow);
  const loadSchedule = useSchedulerStore((state) => state.loadSchedule);
  const startExperiment = useSchedulerStore((state) => state.startExperiment);
  const resetExperiment = useSchedulerStore((state) => state.resetExperiment);
  const setGridSizeMs = useSchedulerStore((state) => state.setGridSizeMs);
  const setExperimentDurationMs = useSchedulerStore((state) => state.setExperimentDurationMs);
  const setZoomPxPerMinute = useSchedulerStore((state) => state.setZoomPxPerMinute);
  const comPort = useBoardStore((state) => state.comPort);
  const scheduleCommandState = useBoardStore((state) => state.scheduleCommandState);
  const isCalibrationRunning = useBoardStore((state) => state.isCalibrationRunning);
  const scheduleMessage = useBoardStore((state) => state.scheduleMessage);
  const appendSerialLog = useBoardStore((state) => state.appendSerialLog);
  const setScheduleCommandState = useBoardStore((state) => state.setScheduleCommandState);
  const setScheduleMessage = useBoardStore((state) => state.setScheduleMessage);
  const calibrationsByRowId = usePumpCalibrationStore((state) => state.calibrationsByRowId);
  const lastCalibrationFileName = usePumpCalibrationStore(
    (state) => state.lastCalibrationFileName,
  );
  const calibrationRunRowId = usePumpCalibrationStore((state) => state.runRowId);
  const setLastCalibrationFileName = usePumpCalibrationStore(
    (state) => state.setLastCalibrationFileName,
  );
  const importCalibrationSet = usePumpCalibrationStore((state) => state.importCalibrationSet);

  const zoomIndex = ZOOM_LEVELS.indexOf(zoomPxPerMinute as (typeof ZOOM_LEVELS)[number]);
  const canZoomOut = zoomIndex > 0;
  const canZoomIn = zoomIndex >= 0 && zoomIndex < ZOOM_LEVELS.length - 1;
  const panelClassName = "toolbar-panel shrink-0 rounded-2xl border border-border/60 bg-white/72 p-3";
  const zoomPxPerSecond = zoomPxPerMinute / 60;
  const zoomLabel = `${Number.isInteger(zoomPxPerSecond) ? zoomPxPerSecond : zoomPxPerSecond.toFixed(1)} px/s`;
  const totalDurationSeconds = totalDurationMs / 1_000;
  const gridSizeSeconds = gridSizeMs / 1_000;
  const [newChannelType, setNewChannelType] = useState<DeviceType>("peristaltic");
  const [scheduleFileName, setScheduleFileName] = useState(() =>
    getDefaultJsonFileName("schedule"),
  );
  const [scheduleFiles, setScheduleFiles] = useState<string[]>([]);
  const [selectedScheduleFile, setSelectedScheduleFile] = useState("");
  const [scheduleFilePendingDelete, setScheduleFilePendingDelete] = useState("");
  const [scheduleFileMessage, setScheduleFileMessage] = useState("");
  const firmwareSummary = getFirmwareScheduleSummary(blocks, rows);
  const selectedChannelCount = rows.filter((row) => row.deviceType === newChannelType).length;
  const selectedChannelLimit =
    newChannelType === "trigger"
      ? FIRMWARE_SCHEDULE_LIMITS.maxGpioOutputs
      : FIRMWARE_SCHEDULE_LIMITS.maxPumps;
  const canAddChannel = selectedChannelCount < selectedChannelLimit;
  const isBoardBusy = scheduleCommandState !== null || isCalibrationRunning;
  const canUploadSchedule =
    firmwareSummary.isWithinLimits && firmwareSummary.eventCount > 0 && !isBoardBusy;

  const refreshScheduleFiles = async () => {
    try {
      const files = await listProjectJsonFiles("schedules");
      setScheduleFiles(files);
      setSelectedScheduleFile((current) => current || files[0] || "");
    } catch (error) {
      setScheduleFileMessage(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void refreshScheduleFiles();
  }, []);

  const runScheduleCommand = async (command: ScheduleCommand) => {
    if (isCalibrationRunning) {
      return;
    }

    const trimmedComPort = comPort.trim();
    const commandLabel =
      command === "upload" ? "Upload" : command === "start" ? "Start" : "Stop";

    setScheduleCommandState(command);
    setScheduleMessage(`${commandLabel} in progress on ${trimmedComPort || "COM port"}...`);

    try {
      const result =
        command === "upload"
          ? await uploadBoardSchedule({
              portName: trimmedComPort,
              rows,
              blocks: applyPumpCalibrationToBlocksByRowId(
                blocks,
                rows,
                calibrationsByRowId,
              ),
            })
          : command === "start"
            ? await startBoardSchedule(trimmedComPort)
            : await stopBoardSchedule(trimmedComPort);

      appendSerialLog(result.log, `# ${commandLabel} ${trimmedComPort || "COM port"}`);
      setScheduleMessage(result.ok ? result.message : `Failed: ${result.message}`);

      if (result.ok && command === "upload") {
        resetExperiment();
      }

      if (result.ok && command === "start") {
        startExperiment();
      }

      if (result.ok && command === "stop") {
        resetExperiment();
      }
    } catch (error) {
      setScheduleMessage(
        `Failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setScheduleCommandState(null);
    }
  };

  const saveScheduleFile = async () => {
    try {
      const companionCalibrationFileName =
        lastCalibrationFileName || getDefaultJsonFileName("calibration");
      const savedCalibrationFileName = await saveProjectJsonFile({
        folder: "calibrations",
        fileName: companionCalibrationFileName,
        content: createPumpCalibrationSetFile({
          activeRowId: calibrationRunRowId,
          calibrationsByRowId,
          rows,
        }),
      });
      const scheduleFile: ScheduleFile = {
        kind: "experimentSchedule",
        schemaVersion: 1,
        savedAt: new Date().toISOString(),
        rows,
        blocks,
        gridSizeMs,
        zoomPxPerMinute,
        experimentDurationMs: totalDurationMs,
        lastCalibrationFileName: savedCalibrationFileName,
      };
      const savedFileName = await saveProjectJsonFile({
        folder: "schedules",
        fileName: scheduleFileName,
        content: scheduleFile,
      });

      setLastCalibrationFileName(savedCalibrationFileName);
      setScheduleFileName(savedFileName);
      setSelectedScheduleFile(savedFileName);
      setScheduleFilePendingDelete("");
      setScheduleFileMessage(`Saved ${savedFileName} with ${savedCalibrationFileName}.`);
      await refreshScheduleFiles();
    } catch (error) {
      setScheduleFileMessage(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const loadScheduleFile = async () => {
    if (!selectedScheduleFile) {
      setScheduleFileMessage("Select a schedule file first.");
      return;
    }

    try {
      const scheduleFile = await loadProjectJsonFile<ScheduleFile>(
        "schedules",
        selectedScheduleFile,
      );

      if (scheduleFile.kind !== "experimentSchedule") {
        throw new Error("Selected file is not an experiment schedule.");
      }

      loadSchedule({
        rows: scheduleFile.rows,
        blocks: scheduleFile.blocks,
        gridSizeMs: scheduleFile.gridSizeMs,
        zoomPxPerMinute: scheduleFile.zoomPxPerMinute,
        experimentDurationMs: scheduleFile.experimentDurationMs,
      });
      setScheduleFileName(selectedScheduleFile);
      setScheduleFilePendingDelete("");

      if (scheduleFile.lastCalibrationFileName) {
        try {
          const calibrationFile = await loadProjectJsonFile<PumpCalibrationSetFile>(
            "calibrations",
            scheduleFile.lastCalibrationFileName,
          );
          importCalibrationSet(calibrationFile, scheduleFile.lastCalibrationFileName);
          setScheduleFileMessage(
            `Loaded ${selectedScheduleFile} with ${scheduleFile.lastCalibrationFileName}.`,
          );
        } catch (error) {
          setScheduleFileMessage(
            `Loaded ${selectedScheduleFile}; calibration failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } else {
        setScheduleFileMessage(`Loaded ${selectedScheduleFile}.`);
      }
    } catch (error) {
      setScheduleFileMessage(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const deleteScheduleFile = async (fileToDelete: string) => {
    if (!fileToDelete) {
      setScheduleFileMessage("Select a schedule file first.");
      return;
    }

    try {
      const deletedFileName = await deleteProjectJsonFile("schedules", fileToDelete);
      const files = await listProjectJsonFiles("schedules");
      const nextSelectedFile =
        files.find((fileName) => fileName !== deletedFileName) ?? files[0] ?? "";

      setScheduleFiles(files);
      setSelectedScheduleFile(nextSelectedFile);
      setScheduleFileName(nextSelectedFile || getDefaultJsonFileName("schedule"));
      setScheduleFilePendingDelete("");
      setScheduleFileMessage(`Deleted ${deletedFileName}.`);
    } catch (error) {
      setScheduleFileMessage(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <Card className="adaptive-toolbar glass-panel mb-4 overflow-hidden border-border/70 shadow-panel">
      <CardContent className="toolbar-content space-y-4 p-4">
        <div className="toolbar-header flex flex-wrap items-start justify-between gap-4">
          <div className="toolbar-copy min-w-0">
            <h1 className="sr-only">Nectow Lab Experiment Scheduler</h1>
            <img
              src={nectowLabLogo}
              alt="Nectow Lab"
              className="toolbar-logo h-14 w-auto max-w-[340px]"
            />
          </div>

          <div className="toolbar-badges flex flex-wrap items-center gap-2">
            <Badge variant={experimentState === "running" ? "success" : "default"}>
              {experimentState === "running" ? "Experiment Running" : "Experiment Idle"}
            </Badge>
            <Badge variant="default">Playhead {formatTimelineTime(playheadMs)}</Badge>
            <Badge variant="default">{rows.length} channels</Badge>
            <Badge variant="default">{blocks.length} commands</Badge>
            <Badge
              className={
                firmwareSummary.eventsWithinLimit
                  ? undefined
                  : "border-rose-200 bg-rose-50 text-rose-700"
              }
            >
              {firmwareSummary.eventCount}/{FIRMWARE_SCHEDULE_LIMITS.maxEvents} events
            </Badge>
          </div>
        </div>

        <div className="toolbar-deck thin-scrollbar flex gap-3 overflow-x-auto overflow-y-hidden pb-2">
          <div
            className={cn(
              `${panelClassName} w-[390px] min-w-[390px] transition-opacity`,
              isCalibrationRunning && "bg-slate-100/80 opacity-60",
            )}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <Label>Experiment Control</Label>
              <Badge
                className={
                  isCalibrationRunning
                    ? "border-slate-200 bg-slate-50 text-slate-600"
                    : firmwareSummary.isWithinLimits
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-rose-200 bg-rose-50 text-rose-700"
                }
              >
                {isCalibrationRunning
                  ? "Calibrating"
                  : firmwareSummary.isWithinLimits
                  ? "Ready"
                  : "Blocked"}
              </Badge>
            </div>
            <div className="flex gap-2">
              <Button
                className="min-w-[88px] flex-1"
                size="sm"
                disabled={!canUploadSchedule}
                title={
                  firmwareSummary.isWithinLimits
                    ? "Clear and upload schedule to the board"
                    : "Resolve firmware schedule limits before upload"
                }
                onClick={() => runScheduleCommand("upload")}
              >
                <Upload className="h-4 w-4" />
                {scheduleCommandState === "upload" ? "Uploading" : "Upload"}
              </Button>
              <Button
                className="min-w-[88px] flex-1"
                size="sm"
                variant="secondary"
                disabled={isBoardBusy}
                onClick={() => runScheduleCommand("start")}
              >
                <Play className="h-4 w-4" />
                {scheduleCommandState === "start" ? "Starting" : "Start"}
              </Button>
              <Button
                className="min-w-[88px] flex-1"
                size="sm"
                variant="outline"
                disabled={isBoardBusy}
                title="Stop the board schedule and reset the playhead"
                onClick={() => runScheduleCommand("stop")}
              >
                <Square className="h-4 w-4" />
                {scheduleCommandState === "stop" ? "Stopping" : "Stop"}
              </Button>
            </div>
            {scheduleMessage ? (
              <div
                className={
                  scheduleMessage.toLowerCase().includes("failed") ||
                  scheduleMessage.toLowerCase().includes("error")
                    ? "mt-2 truncate rounded-lg border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700"
                    : "mt-2 truncate rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600"
                }
                title={scheduleMessage}
              >
                {scheduleMessage}
              </div>
            ) : null}
          </div>

          <div className={`${panelClassName} w-[176px] min-w-[176px]`}>
            <Label htmlFor="grid-size">Grid Increment</Label>
            <Select
              id="grid-size"
              value={String(gridSizeMs)}
              onChange={(event) => setGridSizeMs(Number(event.target.value))}
            >
              {GRID_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>

          <div className={`${panelClassName} w-[250px] min-w-[250px]`}>
            <Label>Zoom</Label>
            <div className="flex items-center gap-2">
              <Button
                disabled={!canZoomOut}
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                  if (canZoomOut) {
                    setZoomPxPerMinute(ZOOM_LEVELS[zoomIndex - 1]);
                  }
                }}
              >
                <ZoomOut className="h-4 w-4" />
              </Button>
              <div className="min-w-[112px] flex-1 rounded-xl border border-border/60 bg-slate-50/85 px-3 py-2 text-center text-sm text-foreground">
                <div className="truncate font-medium">{zoomLabel}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {zoomPxPerMinute}px/min
                </div>
              </div>
              <Button
                disabled={!canZoomIn}
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                  if (canZoomIn) {
                    setZoomPxPerMinute(ZOOM_LEVELS[zoomIndex + 1]);
                  }
                }}
              >
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className={`${panelClassName} w-[260px] min-w-[260px]`}>
            <Label htmlFor="experiment-length">Experiment Length (s)</Label>
            <div className="relative">
              <Gauge className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-600" />
              <DraftNumberInput
                id="experiment-length"
                className="pl-9"
                min={60}
                minValue={60}
                placeholder="Minimum 1m"
                step={gridSizeSeconds}
                type="number"
                value={totalDurationSeconds}
                onCommit={(value) => {
                  setExperimentDurationMs(value * 1_000);
                }}
              />
            </div>
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
              {formatTimelineTime(totalDurationMs)} min:sec
            </div>
          </div>

          <div className={`${panelClassName} w-[330px] min-w-[330px]`}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <Label htmlFor="schedule-file-name">Schedule File</Label>
              <Button
                className="h-7 px-2"
                size="sm"
                variant="ghost"
                onClick={() => void refreshScheduleFiles()}
                title="Refresh schedule files"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="grid gap-2">
              <Input
                id="schedule-file-name"
                value={scheduleFileName}
                onChange={(event) => setScheduleFileName(event.target.value)}
              />
              <div className="grid grid-cols-[minmax(0,1fr),auto] gap-2">
                <Select
                  value={selectedScheduleFile}
                  onChange={(event) => {
                    setSelectedScheduleFile(event.target.value);
                    setScheduleFilePendingDelete("");
                    if (event.target.value) {
                      setScheduleFileName(event.target.value);
                    }
                  }}
                >
                  <option value="">No saved schedules</option>
                  {scheduleFiles.map((fileName) => (
                    <option key={fileName} value={fileName}>
                      {fileName}
                    </option>
                  ))}
                </Select>
                <Button
                  aria-label="Delete selected schedule"
                  disabled={!selectedScheduleFile}
                  size="icon"
                  title="Delete selected schedule"
                  variant="outline"
                  onClick={() => setScheduleFilePendingDelete(selectedScheduleFile)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {scheduleFilePendingDelete ? (
                <div className="grid grid-cols-[minmax(0,1fr),auto,auto] items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-2 py-2 text-[11px] text-rose-700">
                  <div className="truncate" title={scheduleFilePendingDelete}>
                    Delete {scheduleFilePendingDelete}?
                  </div>
                  <Button
                    className="h-7 px-2 text-[11px]"
                    size="sm"
                    variant="ghost"
                    onClick={() => setScheduleFilePendingDelete("")}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="h-7 px-2 text-[11px]"
                    size="sm"
                    variant="destructive"
                    onClick={() => void deleteScheduleFile(scheduleFilePendingDelete)}
                  >
                    Delete
                  </Button>
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="outline" onClick={saveScheduleFile}>
                  <Save className="h-4 w-4" />
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!selectedScheduleFile}
                  onClick={loadScheduleFile}
                >
                  <FolderOpen className="h-4 w-4" />
                  Load
                </Button>
              </div>
              {scheduleFileMessage ? (
                <div className="truncate rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
                  {scheduleFileMessage}
                </div>
              ) : null}
            </div>
          </div>

          <div className={`${panelClassName} toolbar-panel--wide w-[760px] min-w-[760px]`}>
            <Label>Schedule Overview</Label>
            <OverviewMinimap
              blocks={blocks}
              rows={rows}
              totalDurationMs={totalDurationMs}
              viewportDurationMs={viewportDurationMs}
              viewportStartMs={viewportStartMs}
              onJumpToTime={onJumpToTime}
            />
          </div>

          <div className={`${panelClassName} toolbar-panel--narrow flex w-[230px] min-w-[230px] flex-col gap-3`}>
            <Label>Channels</Label>
            <Select
              value={newChannelType}
              onChange={(event) => setNewChannelType(event.target.value as DeviceType)}
            >
              <option value="peristaltic">Peristaltic pump</option>
              <option value="trigger">Trigger output</option>
            </Select>
            <Button
              size="sm"
              className="justify-start"
              disabled={!canAddChannel}
              title={
                canAddChannel
                  ? "Add channel"
                  : `Firmware limit: ${selectedChannelLimit} ${
                      newChannelType === "trigger" ? "trigger outputs" : "pump channels"
                    }`
              }
              onClick={() => addRow(newChannelType)}
            >
              <Plus className="h-4 w-4" />
              Add Channel
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
