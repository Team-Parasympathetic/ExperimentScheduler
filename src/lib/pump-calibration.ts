import { clamp } from "@/lib/utils";
import type { Block, PumpRateMode, Row } from "@/types/scheduler";

export const MAX_PUMP_VOLTAGE = 5;
export const MIN_CALIBRATION_POINTS = 2;
export const DEFAULT_CALIBRATION_POINTS = 5;
export const DEFAULT_CALIBRATION_DURATION_MS = 10_000;
export const DEFAULT_PUMP_FLOW_UL_PER_MIN_PER_VOLT = 200;
export const DEFAULT_FIXED_PUMP_FLOW_UL_PER_MIN = 400;

export interface PumpCalibrationPoint {
  id: string;
  measuredFlowRate: number | null;
}

export interface FixedPumpCalibrationPoint {
  id: string;
  durationMs: number;
  measuredVolumeUl: number | null;
}

export interface PumpCalibrationFit {
  isValid: boolean;
  pointCount: number;
  slopeFlowPerVolt: number;
  interceptFlowRate: number;
  rSquared: number | null;
}

export interface FixedPumpCalibrationFit {
  isValid: boolean;
  pointCount: number;
  slopeVolumeUlPerSecond: number;
  interceptVolumeUl: number;
  rSquared: number | null;
}

export interface VariablePumpCalibrationConfig {
  vMax: number;
  points: PumpCalibrationPoint[];
}

export interface FixedPumpCalibrationConfig {
  points: FixedPumpCalibrationPoint[];
}

export interface PumpCalibrationConfig {
  variable: VariablePumpCalibrationConfig;
  fixed: FixedPumpCalibrationConfig;
}

export type PumpCalibrationConfigByRowId = Record<string, PumpCalibrationConfig>;

export interface PumpCalibrationSetFile {
  kind: "pumpCalibrationSet";
  schemaVersion: 1;
  savedAt: string;
  activeRowId: string | null;
  channelNamesByRowId: Record<string, string>;
  calibrationsByRowId: PumpCalibrationConfigByRowId;
}

export function normalizePumpRateMode(value: unknown): PumpRateMode {
  return value === "fixed" ? "fixed" : "variable";
}

export function normalizePumpVoltage(value: number, vMax = MAX_PUMP_VOLTAGE) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return clamp(value, 0, normalizePumpVMax(vMax));
}

export function normalizePumpVMax(value: number) {
  if (!Number.isFinite(value)) {
    return MAX_PUMP_VOLTAGE;
  }

  return clamp(value, 0, MAX_PUMP_VOLTAGE);
}

export function normalizeCalibrationPointCount(value: number) {
  if (!Number.isFinite(value)) {
    return MIN_CALIBRATION_POINTS;
  }

  return Math.max(MIN_CALIBRATION_POINTS, Math.round(value));
}

export function getCalibrationPointVoltage(index: number, pointCount: number, vMax: number) {
  const normalizedPointCount = normalizeCalibrationPointCount(pointCount);

  if (normalizedPointCount <= 1) {
    return 0;
  }

  return (normalizePumpVMax(vMax) * index) / (normalizedPointCount - 1);
}

export function createCalibrationPoints(pointCount = DEFAULT_CALIBRATION_POINTS) {
  return Array.from(
    { length: normalizeCalibrationPointCount(pointCount) },
    (_, index): PumpCalibrationPoint => ({
      id: `cal-point-${index + 1}`,
      measuredFlowRate: null,
    }),
  );
}

export function createFixedCalibrationPoints(pointCount = DEFAULT_CALIBRATION_POINTS) {
  return Array.from(
    { length: normalizeCalibrationPointCount(pointCount) },
    (_, index): FixedPumpCalibrationPoint => ({
      id: `fixed-cal-point-${index + 1}`,
      durationMs: (index + 1) * 5_000,
      measuredVolumeUl: null,
    }),
  );
}

export function normalizeFixedPumpDurationMs(value: number) {
  if (!Number.isFinite(value)) {
    return 500;
  }

  return Math.max(500, Math.round(value));
}

export function createDefaultPumpCalibrationConfig(): PumpCalibrationConfig {
  return {
    variable: {
      vMax: MAX_PUMP_VOLTAGE,
      points: createCalibrationPoints(DEFAULT_CALIBRATION_POINTS),
    },
    fixed: {
      points: createFixedCalibrationPoints(DEFAULT_CALIBRATION_POINTS),
    },
  };
}

export function normalizeVariablePumpCalibrationConfig(
  calibration: Partial<VariablePumpCalibrationConfig> | null | undefined,
): VariablePumpCalibrationConfig {
  const vMax = normalizePumpVMax(calibration?.vMax ?? MAX_PUMP_VOLTAGE);
  const sourcePoints =
    Array.isArray(calibration?.points) && calibration.points.length >= MIN_CALIBRATION_POINTS
      ? calibration.points
      : createCalibrationPoints(DEFAULT_CALIBRATION_POINTS);
  const points = sourcePoints.map((point, index) => ({
    id: typeof point.id === "string" && point.id ? point.id : `cal-point-${index + 1}`,
    measuredFlowRate:
      point.measuredFlowRate === null || point.measuredFlowRate === undefined
        ? null
        : Number.isFinite(point.measuredFlowRate)
          ? Math.max(0, Number(point.measuredFlowRate.toFixed(3)))
          : null,
  }));

  return {
    vMax,
    points:
      points.length >= MIN_CALIBRATION_POINTS
        ? points
        : createCalibrationPoints(MIN_CALIBRATION_POINTS),
  };
}

export function normalizeFixedPumpCalibrationConfig(
  calibration: Partial<FixedPumpCalibrationConfig> | null | undefined,
): FixedPumpCalibrationConfig {
  const sourcePoints =
    Array.isArray(calibration?.points) && calibration.points.length >= MIN_CALIBRATION_POINTS
      ? calibration.points
      : createFixedCalibrationPoints(DEFAULT_CALIBRATION_POINTS);
  const points = sourcePoints.map((point, index) => ({
    id: typeof point.id === "string" && point.id ? point.id : `fixed-cal-point-${index + 1}`,
    durationMs: normalizeFixedPumpDurationMs(point.durationMs),
    measuredVolumeUl:
      point.measuredVolumeUl === null || point.measuredVolumeUl === undefined
        ? null
        : Number.isFinite(point.measuredVolumeUl)
          ? Math.max(0, Number(point.measuredVolumeUl.toFixed(3)))
          : null,
  }));

  return {
    points:
      points.length >= MIN_CALIBRATION_POINTS
        ? points
        : createFixedCalibrationPoints(MIN_CALIBRATION_POINTS),
  };
}

export function normalizePumpCalibrationConfig(
  calibration: Partial<PumpCalibrationConfig & VariablePumpCalibrationConfig> | null | undefined,
): PumpCalibrationConfig {
  const legacyVariable =
    calibration && ("vMax" in calibration || "points" in calibration)
      ? {
          vMax: calibration.vMax,
          points: calibration.points as PumpCalibrationPoint[] | undefined,
        }
      : null;

  return {
    variable: normalizeVariablePumpCalibrationConfig(calibration?.variable ?? legacyVariable),
    fixed: normalizeFixedPumpCalibrationConfig(calibration?.fixed),
  };
}

export function getPumpCalibrationFit({
  points,
  vMax,
}: VariablePumpCalibrationConfig): PumpCalibrationFit {
  const usablePoints = points
    .map((point, index) => ({
      voltage: getCalibrationPointVoltage(index, points.length, vMax),
      flowRate: point.measuredFlowRate,
    }))
    .filter(
      (point): point is { voltage: number; flowRate: number } =>
        point.flowRate !== null &&
        Number.isFinite(point.flowRate) &&
        point.flowRate >= 0 &&
        Number.isFinite(point.voltage),
    );

  if (usablePoints.length < MIN_CALIBRATION_POINTS) {
    return {
      isValid: false,
      pointCount: usablePoints.length,
      slopeFlowPerVolt: 0,
      interceptFlowRate: 0,
      rSquared: null,
    };
  }

  const meanVoltage =
    usablePoints.reduce((sum, point) => sum + point.voltage, 0) / usablePoints.length;
  const meanFlow =
    usablePoints.reduce((sum, point) => sum + point.flowRate, 0) / usablePoints.length;
  const voltageVariance = usablePoints.reduce(
    (sum, point) => sum + (point.voltage - meanVoltage) ** 2,
    0,
  );

  if (voltageVariance <= Number.EPSILON) {
    return {
      isValid: false,
      pointCount: usablePoints.length,
      slopeFlowPerVolt: 0,
      interceptFlowRate: 0,
      rSquared: null,
    };
  }

  const covariance = usablePoints.reduce(
    (sum, point) => sum + (point.voltage - meanVoltage) * (point.flowRate - meanFlow),
    0,
  );
  const slopeFlowPerVolt = covariance / voltageVariance;
  const interceptFlowRate = meanFlow - slopeFlowPerVolt * meanVoltage;
  const totalFlowVariance = usablePoints.reduce(
    (sum, point) => sum + (point.flowRate - meanFlow) ** 2,
    0,
  );
  const residualVariance = usablePoints.reduce((sum, point) => {
    const predictedFlow = slopeFlowPerVolt * point.voltage + interceptFlowRate;
    return sum + (point.flowRate - predictedFlow) ** 2;
  }, 0);

  return {
    isValid: slopeFlowPerVolt > 0,
    pointCount: usablePoints.length,
    slopeFlowPerVolt,
    interceptFlowRate,
    rSquared:
      totalFlowVariance <= Number.EPSILON
        ? 1
        : 1 - residualVariance / totalFlowVariance,
  };
}

export function getFixedPumpCalibrationFit({
  points,
}: FixedPumpCalibrationConfig): FixedPumpCalibrationFit {
  const usablePoints = points
    .map((point) => ({
      seconds: point.durationMs / 1_000,
      volumeUl: point.measuredVolumeUl,
    }))
    .filter(
      (point): point is { seconds: number; volumeUl: number } =>
        point.volumeUl !== null &&
        Number.isFinite(point.volumeUl) &&
        point.volumeUl >= 0 &&
        Number.isFinite(point.seconds) &&
        point.seconds > 0,
    );

  if (usablePoints.length < MIN_CALIBRATION_POINTS) {
    return {
      isValid: false,
      pointCount: usablePoints.length,
      slopeVolumeUlPerSecond: DEFAULT_FIXED_PUMP_FLOW_UL_PER_MIN / 60,
      interceptVolumeUl: 0,
      rSquared: null,
    };
  }

  const meanSeconds =
    usablePoints.reduce((sum, point) => sum + point.seconds, 0) / usablePoints.length;
  const meanVolume =
    usablePoints.reduce((sum, point) => sum + point.volumeUl, 0) / usablePoints.length;
  const timeVariance = usablePoints.reduce(
    (sum, point) => sum + (point.seconds - meanSeconds) ** 2,
    0,
  );

  if (timeVariance <= Number.EPSILON) {
    return {
      isValid: false,
      pointCount: usablePoints.length,
      slopeVolumeUlPerSecond: DEFAULT_FIXED_PUMP_FLOW_UL_PER_MIN / 60,
      interceptVolumeUl: 0,
      rSquared: null,
    };
  }

  const covariance = usablePoints.reduce(
    (sum, point) => sum + (point.seconds - meanSeconds) * (point.volumeUl - meanVolume),
    0,
  );
  const slopeVolumeUlPerSecond = covariance / timeVariance;
  const interceptVolumeUl = meanVolume - slopeVolumeUlPerSecond * meanSeconds;
  const totalVolumeVariance = usablePoints.reduce(
    (sum, point) => sum + (point.volumeUl - meanVolume) ** 2,
    0,
  );
  const residualVariance = usablePoints.reduce((sum, point) => {
    const predictedVolume = slopeVolumeUlPerSecond * point.seconds + interceptVolumeUl;
    return sum + (point.volumeUl - predictedVolume) ** 2;
  }, 0);

  return {
    isValid: slopeVolumeUlPerSecond > 0,
    pointCount: usablePoints.length,
    slopeVolumeUlPerSecond,
    interceptVolumeUl,
    rSquared:
      totalVolumeVariance <= Number.EPSILON
        ? 1
        : 1 - residualVariance / totalVolumeVariance,
  };
}

export function getPumpVoltageForFlowRate(
  flowRate: number,
  fit: PumpCalibrationFit,
  vMax: number,
) {
  if (!Number.isFinite(flowRate) || flowRate <= 0) {
    return 0;
  }

  const voltage = fit.isValid
    ? (flowRate - fit.interceptFlowRate) / fit.slopeFlowPerVolt
    : flowRate / DEFAULT_PUMP_FLOW_UL_PER_MIN_PER_VOLT;

  return normalizePumpVoltage(voltage, vMax);
}

export function encodePumpVoltageAsFirmwareFlowRate(voltage: number, vMax = MAX_PUMP_VOLTAGE) {
  return (
    normalizePumpVoltage(voltage, vMax) *
    DEFAULT_PUMP_FLOW_UL_PER_MIN_PER_VOLT
  );
}

export function getFixedPumpVolumeForDuration(
  durationMs: number,
  fit: FixedPumpCalibrationFit,
) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }

  const seconds = durationMs / 1_000;
  return Math.max(0, fit.slopeVolumeUlPerSecond * seconds + fit.interceptVolumeUl);
}

export function getFixedPumpFlowRateForDuration(
  durationMs: number,
  fit: FixedPumpCalibrationFit,
) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }

  const totalVolumeUl = getFixedPumpVolumeForDuration(durationMs, fit);
  return (totalVolumeUl / durationMs) * 60_000;
}

export function applyPumpCalibrationToBlocksByRowId(
  blocks: Block[],
  rows: Row[],
  calibrationsByRowId: PumpCalibrationConfigByRowId,
) {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const defaultCalibration = createDefaultPumpCalibrationConfig();

  return blocks.map((block) => {
    const row = rowsById.get(block.rowId);

    if (row?.deviceType !== "peristaltic") {
      return block;
    }

    const calibration = normalizePumpCalibrationConfig(
      calibrationsByRowId[block.rowId] ?? defaultCalibration,
    );

    if (normalizePumpRateMode(row.pumpRateMode) === "fixed") {
      return {
        ...block,
        flowRate: encodePumpVoltageAsFirmwareFlowRate(MAX_PUMP_VOLTAGE),
      };
    }

    const fit = getPumpCalibrationFit(calibration.variable);
    const voltage = getPumpVoltageForFlowRate(block.flowRate, fit, calibration.variable.vMax);

    return {
      ...block,
      flowRate: encodePumpVoltageAsFirmwareFlowRate(voltage, calibration.variable.vMax),
    };
  });
}

export function createPumpCalibrationSetFile({
  activeRowId,
  calibrationsByRowId,
  rows,
}: {
  activeRowId: string | null;
  calibrationsByRowId: PumpCalibrationConfigByRowId;
  rows: Row[];
}): PumpCalibrationSetFile {
  const channelNamesByRowId = Object.fromEntries(
    rows
      .filter((row) => row.deviceType === "peristaltic")
      .map((row) => [row.id, row.name]),
  );

  return {
    kind: "pumpCalibrationSet",
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    activeRowId,
    channelNamesByRowId,
    calibrationsByRowId: Object.fromEntries(
      rows
        .filter((row) => row.deviceType === "peristaltic")
        .map((row) => [
          row.id,
          normalizePumpCalibrationConfig(
            calibrationsByRowId[row.id] ?? createDefaultPumpCalibrationConfig(),
          ),
        ]),
    ),
  };
}
