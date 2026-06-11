import type { TriggerMode } from "@/types/scheduler";

export const DEFAULT_TRIGGER_MODE: TriggerMode = "pulse";
export const DEFAULT_TRIGGER_FREQUENCY_HZ = 1;
export const DEFAULT_TRIGGER_DUTY_CYCLE = 50;
export const DEFAULT_REQUIRE_COMPLETE_PERIODS = true;
export const DEFAULT_PERIOD_MULTIPLIER = 2;
export const FPGA_PWM_CLOCK_HZ = 10_000_000;
export const FPGA_PHASE_ACCUMULATOR_STEPS = 2 ** 32;
export const FPGA_DUTY_THRESHOLD_MAX = 0xffffffff;

export const TRIGGER_MODE_LABELS: Record<TriggerMode, string> = {
  pulse: "Pulse",
  waveform: "PWM waveform",
  "sync-division": "Synchronized",
};

export function normalizeFrequencyHz(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_TRIGGER_FREQUENCY_HZ;
  }

  return value;
}

export function normalizeDutyCycle(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_TRIGGER_DUTY_CYCLE;
  }

  return Math.min(100, Math.max(0, value));
}

export function getDutyThresholdFromDutyCycle(dutyCycle: number) {
  const normalizedDutyCycle = normalizeDutyCycle(dutyCycle);

  if (normalizedDutyCycle >= 100) {
    return FPGA_DUTY_THRESHOLD_MAX;
  }

  return Math.min(
    FPGA_DUTY_THRESHOLD_MAX,
    Math.max(0, Math.round((normalizedDutyCycle / 100) * FPGA_PHASE_ACCUMULATOR_STEPS)),
  );
}

export function getDutyCycleFromThreshold(dutyThreshold: number) {
  if (!Number.isFinite(dutyThreshold) || dutyThreshold <= 0) {
    return 0;
  }

  const normalizedThreshold = Math.min(
    FPGA_DUTY_THRESHOLD_MAX,
    Math.max(0, Math.round(dutyThreshold)),
  );

  return normalizedThreshold >= FPGA_DUTY_THRESHOLD_MAX
    ? 100
    : normalizeDutyCycle((normalizedThreshold / FPGA_PHASE_ACCUMULATOR_STEPS) * 100);
}

export function getBinaryRepresentableDutyCycle(dutyCycle: number) {
  return getDutyCycleFromThreshold(getDutyThresholdFromDutyCycle(dutyCycle));
}

export function normalizeRequireCompletePeriods(value: boolean | undefined) {
  return value ?? DEFAULT_REQUIRE_COMPLETE_PERIODS;
}

export function normalizePeriodMultiplier(value: number | undefined) {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_PERIOD_MULTIPLIER;
  }

  return Math.max(1, Math.round(value));
}

export function getPeriodMsFromFrequencyHz(frequencyHz: number) {
  return 1_000 / normalizeFrequencyHz(frequencyHz);
}

export function getPwmPhaseStep(frequencyHz: number) {
  const normalizedFrequencyHz = normalizeFrequencyHz(frequencyHz);
  return Math.min(
    0xffffffff,
    Math.max(
      1,
      Math.round(
        (normalizedFrequencyHz * FPGA_PHASE_ACCUMULATOR_STEPS) / FPGA_PWM_CLOCK_HZ,
      ),
    ),
  );
}

export function getDerivedPhaseStep(
  sourceFrequencyHz: number,
  periodMultiplier: number | undefined,
) {
  const multiplier = normalizePeriodMultiplier(periodMultiplier);
  const sourcePhaseStep = getPwmPhaseStep(sourceFrequencyHz);

  if (sourcePhaseStep % multiplier !== 0) {
    return null;
  }

  return sourcePhaseStep / multiplier;
}

export function getDerivedFrequencyHz(
  sourceFrequencyHz: number,
  periodMultiplier: number | undefined,
) {
  const derivedPhaseStep = getDerivedPhaseStep(sourceFrequencyHz, periodMultiplier);

  return derivedPhaseStep === null
    ? null
    : getActualFrequencyHzFromPhaseStep(derivedPhaseStep);
}

export function getActualFrequencyHzFromPhaseStep(phaseStep: number) {
  return (phaseStep * FPGA_PWM_CLOCK_HZ) / FPGA_PHASE_ACCUMULATOR_STEPS;
}

export function getActualPeriodMsFromFrequencyHz(frequencyHz: number) {
  return 1_000 / getActualFrequencyHzFromPhaseStep(getPwmPhaseStep(frequencyHz));
}

export function getCompletePeriodDurationMs(
  durationMs: number,
  frequencyHz: number,
  startMs = 0,
) {
  const actualPeriodMs = getActualPeriodMsFromFrequencyHz(frequencyHz);
  const requestedDurationMs =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs : actualPeriodMs;
  const periodCount = Math.max(1, Math.round(requestedDurationMs / actualPeriodMs));
  const startUs = Math.max(0, Math.round(startMs * 1_000));
  const boundaryUs = Math.round(startUs + periodCount * actualPeriodMs * 1_000);
  const stopUs = Math.max(startUs + 1, boundaryUs - 1);

  return (stopUs - startUs) / 1_000;
}

export function getFrequencyHzFromPeriodMs(periodMs: number) {
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    return DEFAULT_TRIGGER_FREQUENCY_HZ;
  }

  return normalizeFrequencyHz(1_000 / periodMs);
}

export function getHighTimeMsFromDutyCycle(frequencyHz: number, dutyCycle: number) {
  return (
    getPeriodMsFromFrequencyHz(frequencyHz) *
    (getDutyThresholdFromDutyCycle(dutyCycle) / FPGA_PHASE_ACCUMULATOR_STEPS)
  );
}

export function getDutyCycleFromHighTimeMs(frequencyHz: number, highTimeMs: number) {
  const periodMs = getPeriodMsFromFrequencyHz(frequencyHz);

  if (!Number.isFinite(highTimeMs) || highTimeMs <= 0) {
    return 0;
  }

  return getDutyCycleFromThreshold(
    Math.round((highTimeMs / periodMs) * FPGA_PHASE_ACCUMULATOR_STEPS),
  );
}

export function getTriggerModeLabel(triggerMode: TriggerMode | undefined) {
  return TRIGGER_MODE_LABELS[triggerMode ?? DEFAULT_TRIGGER_MODE];
}

export function getTriggerFrequencyLabel(frequencyHz: number | undefined) {
  const normalizedFrequencyHz = normalizeFrequencyHz(
    frequencyHz ?? DEFAULT_TRIGGER_FREQUENCY_HZ,
  );
  return `${normalizedFrequencyHz.toLocaleString(undefined, {
    maximumFractionDigits: 6,
    minimumFractionDigits: normalizedFrequencyHz % 1 === 0 ? 0 : 1,
  })} Hz`;
}
