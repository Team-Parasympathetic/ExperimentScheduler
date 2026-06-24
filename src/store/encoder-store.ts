import { create } from "zustand";
import type {
  EncoderMonitorSample,
  EncoderMonitorSnapshot,
  EncoderMonitorStatus,
} from "@/lib/encoder-api";

export type EncoderConnectionState = "idle" | "connecting" | "connected" | "error";

export interface EncoderHistoryPoint {
  t: number;
  rpm: number;
}

interface EncoderState {
  encoderPort: string;
  connectionState: EncoderConnectionState;
  message: string;
  latestSample: EncoderMonitorSample | null;
  latestStatus: EncoderMonitorStatus | null;
  rpmByChannel: number[];
  historyByChannel: EncoderHistoryPoint[][];
  totalMissedFrames: number;
  setEncoderPort: (encoderPort: string) => void;
  setConnectionState: (connectionState: EncoderConnectionState, message?: string) => void;
  ingestSample: (sample: EncoderMonitorSample) => void;
  ingestStatus: (status: EncoderMonitorStatus) => void;
  ingestSnapshot: (snapshot: EncoderMonitorSnapshot) => void;
  resetTelemetry: () => void;
}

const ENCODER_PORT_STORAGE_KEY = "experiment-scheduler:last-encoder-port";
const DEFAULT_ENCODER_PORT = "COM8";
const ENCODER_CHANNEL_COUNT = 8;
const HISTORY_WINDOW_MS = 10_000;
const MAX_HISTORY_POINTS = 650;

function getInitialHistory() {
  return Array.from({ length: ENCODER_CHANNEL_COUNT }, () => [] as EncoderHistoryPoint[]);
}

function getStoredEncoderPort() {
  if (typeof window === "undefined") {
    return DEFAULT_ENCODER_PORT;
  }

  try {
    return window.localStorage.getItem(ENCODER_PORT_STORAGE_KEY) || DEFAULT_ENCODER_PORT;
  } catch {
    return DEFAULT_ENCODER_PORT;
  }
}

function storeEncoderPort(encoderPort: string) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(ENCODER_PORT_STORAGE_KEY, encoderPort);
  } catch {
    // The in-memory port still updates when local storage is blocked.
  }
}

function normalizeRpmChannels(sample: EncoderMonitorSample) {
  return Array.from({ length: ENCODER_CHANNEL_COUNT }, (_, channel) => {
    const value = Number(sample.rpm[channel]);
    return Number.isFinite(value) ? value : 0;
  });
}

function appendHistoryPoint(
  historyByChannel: EncoderHistoryPoint[][],
  rpmByChannel: number[],
  timestampMs: number,
) {
  const cutoffMs = timestampMs - HISTORY_WINDOW_MS;

  return historyByChannel.map((history, channel) => [
    ...history.filter((point) => point.t >= cutoffMs),
    {
      t: timestampMs,
      rpm: rpmByChannel[channel],
    },
  ].slice(-MAX_HISTORY_POINTS));
}

function getStreamingMessage(portName: string) {
  return `Pump RPM telemetry on ${portName}.`;
}

export const useEncoderStore = create<EncoderState>((set) => ({
  encoderPort: getStoredEncoderPort(),
  connectionState: "idle",
  message: "",
  latestSample: null,
  latestStatus: null,
  rpmByChannel: Array.from({ length: ENCODER_CHANNEL_COUNT }, () => 0),
  historyByChannel: getInitialHistory(),
  totalMissedFrames: 0,
  setEncoderPort: (encoderPort) => {
    storeEncoderPort(encoderPort);
    set({ encoderPort });
  },
  setConnectionState: (connectionState, message = "") =>
    set({ connectionState, message }),
  ingestSample: (sample) =>
    set((state) => {
      const rpmByChannel = normalizeRpmChannels(sample);
      const isDuplicateSample =
        state.latestSample?.receivedAtMs === sample.receivedAtMs &&
        state.latestSample?.seq === sample.seq;
      const historyByChannel = isDuplicateSample
        ? state.historyByChannel
        : appendHistoryPoint(state.historyByChannel, rpmByChannel, sample.receivedAtMs);

      return {
        connectionState: "connected",
        latestSample: sample,
        message: getStreamingMessage(sample.portName),
        rpmByChannel,
        historyByChannel,
        totalMissedFrames: isDuplicateSample
          ? state.totalMissedFrames
          : state.totalMissedFrames + Math.max(0, sample.missedFrames),
      };
    }),
  ingestStatus: (status) =>
    set((state) => ({
      connectionState: state.connectionState === "error" ? "error" : "connected",
      latestStatus: status,
      message:
        status.framesReceived > 0
          ? getStreamingMessage(status.portName)
          : status.message,
    })),
  ingestSnapshot: (snapshot) =>
    set((state) => {
      const nextState: Partial<EncoderState> = {
        connectionState: snapshot.connected ? "connected" : "idle",
      };

      if (snapshot.status) {
        nextState.latestStatus = snapshot.status;
        nextState.message = snapshot.status.message;
      }

      if (snapshot.sample) {
        const rpmByChannel = normalizeRpmChannels(snapshot.sample);
        const isDuplicateSample =
          state.latestSample?.receivedAtMs === snapshot.sample.receivedAtMs &&
          state.latestSample?.seq === snapshot.sample.seq;
        nextState.latestSample = snapshot.sample;
        nextState.rpmByChannel = rpmByChannel;
        nextState.historyByChannel = isDuplicateSample
          ? state.historyByChannel
          : appendHistoryPoint(
              state.historyByChannel,
              rpmByChannel,
              snapshot.sample.receivedAtMs,
            );
        nextState.totalMissedFrames = isDuplicateSample
          ? state.totalMissedFrames
          : state.totalMissedFrames + Math.max(0, snapshot.sample.missedFrames);
        nextState.message = getStreamingMessage(snapshot.sample.portName);
      }

      return nextState;
    }),
  resetTelemetry: () =>
    set({
      latestSample: null,
      latestStatus: null,
      rpmByChannel: Array.from({ length: ENCODER_CHANNEL_COUNT }, () => 0),
      historyByChannel: getInitialHistory(),
      totalMissedFrames: 0,
    }),
}));
