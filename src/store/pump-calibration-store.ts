import { create } from "zustand";
import {
  DEFAULT_CALIBRATION_DURATION_MS,
  createCalibrationPoints,
  createFixedCalibrationPoints,
  createDefaultPumpCalibrationConfig,
  normalizeCalibrationPointCount,
  normalizeCalibrationPointVoltage,
  normalizeFixedPumpCalibrationConfig,
  normalizeFixedPumpDurationMs,
  migratePumpCalibrationsToHardwareKeys,
  normalizePumpCalibrationConfig,
  normalizePumpCalibrationSetFile,
  normalizePumpVMax,
  normalizePumpVoltage,
  normalizeVariablePumpCalibrationConfig,
  type FixedPumpCalibrationPoint,
  type PumpCalibrationConfigByRowId,
  type PumpCalibrationPoint,
} from "@/lib/pump-calibration";
import type { Direction, Row } from "@/types/scheduler";

interface PumpCalibrationState {
  vMax: number;
  points: PumpCalibrationPoint[];
  fixedPoints: FixedPumpCalibrationPoint[];
  calibrationsByRowId: PumpCalibrationConfigByRowId;
  lastCalibrationFileName: string;
  runRowId: string | null;
  runDurationMs: number;
  runVoltage: number;
  runDirection: Direction;
  statusMessage: string;
  setVMax: (vMax: number) => void;
  setPointCount: (pointCount: number) => void;
  setPointVoltage: (pointId: string, voltage: number) => void;
  setPointMeasuredFlow: (pointId: string, measuredFlowRate: number | null) => void;
  setFixedPointCount: (pointCount: number) => void;
  setFixedPointDurationMs: (pointId: string, durationMs: number) => void;
  setFixedPointMeasuredVolume: (pointId: string, measuredVolumeUl: number | null) => void;
  setRunRowId: (rowId: string | null) => void;
  setRunDurationMs: (durationMs: number) => void;
  setRunVoltage: (voltage: number) => void;
  setRunDirection: (direction: Direction) => void;
  setStatusMessage: (message: string) => void;
  setLastCalibrationFileName: (fileName: string) => void;
  importCalibrationSet: (file: unknown, fileName?: string, rows?: Row[]) => void;
}

function normalizeMeasuredFlowRate(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Number(value.toFixed(3)));
}

function normalizeMeasuredVolume(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Number(value.toFixed(3)));
}

function getCalibrationForRow(
  calibrationsByRowId: PumpCalibrationConfigByRowId,
  rowId: string | null,
) {
  return normalizePumpCalibrationConfig(
    rowId ? calibrationsByRowId[rowId] : createDefaultPumpCalibrationConfig(),
  );
}

function withActiveCalibration(
  state: PumpCalibrationState,
  calibration: ReturnType<typeof normalizePumpCalibrationConfig>,
) {
  return {
    vMax: calibration.variable.vMax,
    points: calibration.variable.points,
    fixedPoints: calibration.fixed.points,
    calibrationsByRowId: state.runRowId
      ? {
          ...state.calibrationsByRowId,
          [state.runRowId]: calibration,
        }
      : state.calibrationsByRowId,
  };
}

const defaultCalibration = createDefaultPumpCalibrationConfig();

export const usePumpCalibrationStore = create<PumpCalibrationState>((set) => ({
  vMax: defaultCalibration.variable.vMax,
  points: defaultCalibration.variable.points,
  fixedPoints: defaultCalibration.fixed.points,
  calibrationsByRowId: {},
  lastCalibrationFileName: "",
  runRowId: null,
  runDurationMs: DEFAULT_CALIBRATION_DURATION_MS,
  runVoltage: 2.5,
  runDirection: "forward",
  statusMessage: "",
  setVMax: (vMax) =>
    set((state) => {
      const nextVMax = normalizePumpVMax(vMax);
      const variable = normalizeVariablePumpCalibrationConfig({
        vMax: nextVMax,
        points: state.points,
      });
      const calibration = normalizePumpCalibrationConfig({
        ...(state.runRowId ? state.calibrationsByRowId[state.runRowId] : undefined),
        variable,
        fixed: { points: state.fixedPoints },
      });

      return {
        ...withActiveCalibration(state, calibration),
        runVoltage: normalizePumpVoltage(state.runVoltage, nextVMax),
      };
    }),
  setPointCount: (pointCount) =>
    set((state) => {
      const nextPointCount = normalizeCalibrationPointCount(pointCount);
      const defaultPoints = createCalibrationPoints(nextPointCount, state.vMax);
      const nextPoints = Array.from({ length: nextPointCount }, (_, index) => {
        return state.points[index] ?? defaultPoints[index];
      });

      const variable = normalizeVariablePumpCalibrationConfig({
        vMax: state.vMax,
        points: nextPoints,
      });
      const calibration = normalizePumpCalibrationConfig({
        ...(state.runRowId ? state.calibrationsByRowId[state.runRowId] : undefined),
        variable,
        fixed: { points: state.fixedPoints },
      });

      return withActiveCalibration(state, calibration);
    }),
  setPointVoltage: (pointId, voltage) =>
    set((state) => {
      const nextPoints = state.points.map((point) =>
        point.id === pointId
          ? {
              ...point,
              voltage: normalizeCalibrationPointVoltage(voltage, state.vMax, point.voltage),
            }
          : point,
      );
      const variable = normalizeVariablePumpCalibrationConfig({
        vMax: state.vMax,
        points: nextPoints,
      });
      const calibration = normalizePumpCalibrationConfig({
        ...(state.runRowId ? state.calibrationsByRowId[state.runRowId] : undefined),
        variable,
        fixed: { points: state.fixedPoints },
      });

      return withActiveCalibration(state, calibration);
    }),
  setPointMeasuredFlow: (pointId, measuredFlowRate) =>
    set((state) => {
      const nextPoints = state.points.map((point) =>
        point.id === pointId
          ? {
              ...point,
              measuredFlowRate: normalizeMeasuredFlowRate(measuredFlowRate),
            }
          : point,
      );
      const variable = normalizeVariablePumpCalibrationConfig({
        vMax: state.vMax,
        points: nextPoints,
      });
      const calibration = normalizePumpCalibrationConfig({
        ...(state.runRowId ? state.calibrationsByRowId[state.runRowId] : undefined),
        variable,
        fixed: { points: state.fixedPoints },
      });

      return withActiveCalibration(state, calibration);
    }),
  setFixedPointCount: (pointCount) =>
    set((state) => {
      const nextPointCount = normalizeCalibrationPointCount(pointCount);
      const defaultPoints = createFixedCalibrationPoints(nextPointCount);
      const nextPoints = Array.from({ length: nextPointCount }, (_, index) => {
        return state.fixedPoints[index] ?? defaultPoints[index];
      });
      const fixed = normalizeFixedPumpCalibrationConfig({ points: nextPoints });
      const calibration = normalizePumpCalibrationConfig({
        ...(state.runRowId ? state.calibrationsByRowId[state.runRowId] : undefined),
        variable: { vMax: state.vMax, points: state.points },
        fixed,
      });

      return withActiveCalibration(state, calibration);
    }),
  setFixedPointDurationMs: (pointId, durationMs) =>
    set((state) => {
      const nextPoints = state.fixedPoints.map((point) =>
        point.id === pointId
          ? {
              ...point,
              durationMs: normalizeFixedPumpDurationMs(durationMs),
            }
          : point,
      );
      const fixed = normalizeFixedPumpCalibrationConfig({ points: nextPoints });
      const calibration = normalizePumpCalibrationConfig({
        ...(state.runRowId ? state.calibrationsByRowId[state.runRowId] : undefined),
        variable: { vMax: state.vMax, points: state.points },
        fixed,
      });

      return withActiveCalibration(state, calibration);
    }),
  setFixedPointMeasuredVolume: (pointId, measuredVolumeUl) =>
    set((state) => {
      const nextPoints = state.fixedPoints.map((point) =>
        point.id === pointId
          ? {
              ...point,
              measuredVolumeUl: normalizeMeasuredVolume(measuredVolumeUl),
            }
          : point,
      );
      const fixed = normalizeFixedPumpCalibrationConfig({ points: nextPoints });
      const calibration = normalizePumpCalibrationConfig({
        ...(state.runRowId ? state.calibrationsByRowId[state.runRowId] : undefined),
        variable: { vMax: state.vMax, points: state.points },
        fixed,
      });

      return withActiveCalibration(state, calibration);
    }),
  setRunRowId: (runRowId) =>
    set((state) => {
      const calibration = getCalibrationForRow(state.calibrationsByRowId, runRowId);

      return {
        runRowId,
        vMax: calibration.variable.vMax,
        points: calibration.variable.points,
        fixedPoints: calibration.fixed.points,
        calibrationsByRowId: runRowId
          ? {
              ...state.calibrationsByRowId,
              [runRowId]: calibration,
            }
          : state.calibrationsByRowId,
        runVoltage: normalizePumpVoltage(state.runVoltage, calibration.variable.vMax),
      };
    }),
  setRunDurationMs: (runDurationMs) =>
    set({
      runDurationMs: Math.max(500, Math.round(Number.isFinite(runDurationMs) ? runDurationMs : 500)),
    }),
  setRunVoltage: (runVoltage) =>
    set((state) => ({
      runVoltage: normalizePumpVoltage(runVoltage, state.vMax),
    })),
  setRunDirection: (runDirection) => set({ runDirection }),
  setStatusMessage: (statusMessage) => set({ statusMessage }),
  setLastCalibrationFileName: (lastCalibrationFileName) => set({ lastCalibrationFileName }),
  importCalibrationSet: (file, fileName = "", rows = []) =>
    set((state) => {
      const calibrationSet = normalizePumpCalibrationSetFile(file, rows);
      const calibrationsByRowId = migratePumpCalibrationsToHardwareKeys(
        calibrationSet.calibrationsByRowId,
        rows,
      );
      const nextRunRowId =
        state.runRowId && calibrationsByRowId[state.runRowId]
          ? state.runRowId
          : calibrationSet.activeRowId && calibrationsByRowId[calibrationSet.activeRowId]
            ? calibrationSet.activeRowId
            : Object.keys(calibrationsByRowId)[0] ?? null;
      const activeCalibration = getCalibrationForRow(calibrationsByRowId, nextRunRowId);

      return {
        calibrationsByRowId,
        runRowId: nextRunRowId,
        vMax: activeCalibration.variable.vMax,
        points: activeCalibration.variable.points,
        fixedPoints: activeCalibration.fixed.points,
        runVoltage: normalizePumpVoltage(state.runVoltage, activeCalibration.variable.vMax),
        lastCalibrationFileName: fileName || state.lastCalibrationFileName,
        statusMessage: fileName ? `Loaded calibration file ${fileName}.` : state.statusMessage,
      };
    }),
}));
