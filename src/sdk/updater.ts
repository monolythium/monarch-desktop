// Self-update facade — wraps the Tauri updater plugin behind a tiny
// surface the UI layer can consume without knowing about Tauri APIs.
//
// Boot flow:
//   1. App.tsx calls `checkForUpdate()` once after the shell mounts.
//   2. If a new release is found, the result includes the new version
//      and notes. App.tsx shows the UpdateBanner.
//   3. User clicks "Install" → `downloadAndInstallUpdate(onProgress)`
//      streams progress; on completion we `relaunch()` so the freshly
//      installed binary boots.
//
// Errors and the non-Tauri (browser preview) runtime both yield
// `available: false` — the banner stays hidden. We don't propagate
// network errors to the UI: failing to fetch the update manifest is
// not user-actionable, and a noisy banner would be worse than silence.

import type { Update } from "@tauri-apps/plugin-updater";

let pendingUpdate: Update | null = null;

export interface UpdateAvailable {
  available: true;
  version: string;
  notes: string | null;
  pubDate: string | null;
}

export interface UpdateUnavailable {
  available: false;
}

export type UpdateCheckResult = UpdateAvailable | UpdateUnavailable;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!isTauri()) return { available: false };
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update === null) return { available: false };
    pendingUpdate = update;
    return {
      available: true,
      version: update.version,
      notes: update.body ?? null,
      pubDate: update.date ?? null,
    };
  } catch {
    return { available: false };
  }
}

export async function downloadAndInstallUpdate(
  onProgress?: (downloaded: number, total: number | undefined) => void,
): Promise<void> {
  if (!pendingUpdate) {
    throw new Error("no update pending — call checkForUpdate() first");
  }
  let downloaded = 0;
  let contentLength: number | undefined;
  await pendingUpdate.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        contentLength = event.data.contentLength;
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, contentLength);
        break;
      case "Finished":
        onProgress?.(contentLength ?? downloaded, contentLength);
        break;
    }
  });
  pendingUpdate = null;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

export function dismissPendingUpdate(): void {
  pendingUpdate = null;
}
