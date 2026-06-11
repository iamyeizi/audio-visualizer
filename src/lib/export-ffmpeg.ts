import type { AudioAnalysis, ExportSettings, VisualizerSettings } from "./types";

interface ExportFfmpegCallbacks {
  onProgress: (value: number) => void;
  signal?: AbortSignal;
}

export async function exportWithFfmpeg(
  analysis: AudioAnalysis,
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

  const spectrum = createFfmpegSpectrumPayload(analysis, visualizer, settings);
  const params = new URLSearchParams({
    width: String(settings.width),
    height: String(settings.height),
    fps: String(settings.fps),
    quality: settings.quality,
    duration: String(analysis.duration),
    frames: String(spectrum.frameCount),
    bands: String(analysis.bands),
    analysisFps: String(analysis.frameRate),
    analysisFrames: String(spectrum.analysisFrameCount),
    style: visualizer.style,
    color: visualizer.color,
    secondaryColor: visualizer.secondaryColor,
    opacity: String(visualizer.opacity),
    amplitude: String(visualizer.amplitude),
    cutoff: String(visualizer.cutoff),
    smoothing: String(visualizer.smoothing),
    thickness: String(visualizer.thickness),
    glow: String(visualizer.glow),
  });

  try {
    callbacks.onProgress(0.02);
    const startResponse = await fetch(`/api/export-ffmpeg/start?${params}`, {
      method: "POST",
      body: new Uint8Array(spectrum.bytes).buffer,
      headers: { "Content-Type": "application/octet-stream" },
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

export function createFfmpegSpectrumPayload(
  analysis: AudioAnalysis,
  visualizer: VisualizerSettings,
  settings: ExportSettings,
) {
  const frameCount = Math.max(1, Math.ceil(analysis.duration * settings.fps));
  void visualizer;
  return {
    bytes: analysis.frames,
    frameCount,
    analysisFrameCount: Math.max(1, Math.floor(analysis.frames.length / analysis.bands)),
  };
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
