import { hasTauriRuntime, invokeTauri } from "@/lib/tauri-runtime";

export type ProjectDataFolder = "calibrations" | "schedules";

export function getDefaultJsonFileName(prefix: string) {
  const timestamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace("T", "-")
    .replace(/:/g, "");

  return `${prefix}-${timestamp}.json`;
}

export function normalizeJsonFileName(fileName: string, fallbackPrefix: string) {
  const trimmed = fileName.trim() || getDefaultJsonFileName(fallbackPrefix);
  const baseName = trimmed
    .replace(/\.json$/i, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return `${baseName || fallbackPrefix}.json`;
}

export function listProjectJsonFiles(folder: ProjectDataFolder) {
  if (!hasTauriRuntime()) {
    return Promise.resolve([]);
  }

  return invokeTauri<string[]>("list_data_files", { folder });
}

export function saveProjectJsonFile({
  content,
  fileName,
  folder,
}: {
  content: unknown;
  fileName: string;
  folder: ProjectDataFolder;
}) {
  return invokeTauri<string>("save_data_file", {
    folder,
    fileName: normalizeJsonFileName(fileName, folder),
    content: JSON.stringify(content, null, 2),
  });
}

export function deleteProjectJsonFile(folder: ProjectDataFolder, fileName: string) {
  return invokeTauri<string>("delete_data_file", {
    folder,
    fileName,
  });
}

export async function loadProjectJsonFile<T>(folder: ProjectDataFolder, fileName: string) {
  const content = await invokeTauri<string>("load_data_file", { folder, fileName });
  return JSON.parse(content) as T;
}
