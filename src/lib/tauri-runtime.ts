import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const TAURI_UNAVAILABLE_MESSAGE =
  "Desktop backend unavailable. Run the app with Tauri to use device, schedule, and file commands.";

export function hasTauriRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export function invokeTauri<T>(command: string, args?: Record<string, unknown>) {
  if (!hasTauriRuntime()) {
    return Promise.reject(new Error(TAURI_UNAVAILABLE_MESSAGE));
  }

  return invoke<T>(command, args);
}
