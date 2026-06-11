import type { ExportSettings, VisualizerSettings } from "./types";

interface ExportFfmpegCallbacks {
  onProgress: (value: number) => void;
  signal?: AbortSignal;
}

export async function exportWithFfmpeg(
  file: File,
  visualizer: VisualizerSettings,
  settings: ExportSettings,
  fileName: string,
  callbacks: ExportFfmpegCallbacks,
) {
  let jobId: string | null = null;
  const abort = () => {
    if (jobId) void fetch(`/api/export-ffmpeg/${jobId}`, { method: "DELETE" });
  };
  callbacks.signal?.addEventListener("abort", abort, { once: true });

  const params = new URLSearchParams({
    width: String(settings.width),
    height: String(settings.height),
    fps: String(settings.fps),
    quality: settings.quality,
    color: visualizer.color,
    secondaryColor: visualizer.secondaryColor,
  });

  try {
    callbacks.onProgress(0.02);
    const startResponse = await fetch(`/api/export-ffmpeg/start?${params}`, {
      method: "POST",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
      signal: callbacks.signal,
    });
    if (!startResponse.ok) throw new Error(await startResponse.text() || "No se pudo iniciar FFmpeg.");
    const started = await startResponse.json() as { id?: string };
    if (!started.id) throw new Error("El servidor FFmpeg no devolvió un job válido.");
    jobId = started.id;

    while (true) {
      if (callbacks.signal?.aborted) throw new DOMException("Exportación cancelada", "AbortError");
      await sleep(1_000);
      const progressResponse = await fetch(`/api/export-ffmpeg/progress/${jobId}`, { signal: callbacks.signal });
      if (!progressResponse.ok) throw new Error(await progressResponse.text() || "No se pudo consultar el progreso FFmpeg.");
      const progress = await progressResponse.json() as { status: string; progress: number; error?: string };
      callbacks.onProgress(Math.max(0.02, Math.min(0.99, progress.progress)));
      if (progress.status === "complete") break;
      if (progress.status === "error") throw new Error(progress.error || "FFmpeg no pudo completar la exportación.");
      if (progress.status === "cancelled") throw new DOMException("Exportación cancelada", "AbortError");
    }

    const downloadResponse = await fetch(`/api/export-ffmpeg/download/${jobId}`, { signal: callbacks.signal });
    if (!downloadResponse.ok) throw new Error(await downloadResponse.text() || "No se pudo descargar el MP4 FFmpeg.");
    const blob = await downloadResponse.blob();
    downloadBlob(blob, fileName.replace(/\.[^.]+$/, "") + ".mp4");
    callbacks.onProgress(1);
  } finally {
    callbacks.signal?.removeEventListener("abort", abort);
  }
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
