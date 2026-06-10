import { ArrayBufferTarget, FileSystemWritableFileStreamTarget, Muxer } from "webm-muxer";
import { fillSpectrumFrame } from "./audio-analysis";
import type { AudioAnalysis, ExportSettings, VisualizerSettings } from "./types";
import { renderVisualizer } from "./visualizer-renderer";

interface ExportCallbacks {
  onProgress: (value: number) => void;
  signal?: AbortSignal;
}

const QUALITY_FACTOR = { draft: 0.025, standard: 0.045, high: 0.075 } as const;

export function estimateExportSize(settings: ExportSettings, duration: number) {
  const bitrate = getBitrate(settings);
  return (bitrate * duration) / 8;
}

export async function exportWebM(
  analysis: AudioAnalysis,
  visualizer: VisualizerSettings,
  settings: ExportSettings,
  fileName: string,
  callbacks: ExportCallbacks,
) {
  if (!("VideoEncoder" in window)) {
    throw new Error("Tu navegador no permite exportación acelerada. Usa Chrome o Edge actualizado.");
  }
  if (!("OffscreenCanvas" in window)) {
    throw new Error("Tu navegador no permite renderizar el video fuera de pantalla. Usa Chrome o Edge actualizado.");
  }

  const fileHandle = await chooseOutputFile(fileName);

  const config: VideoEncoderConfig = {
    codec: "vp09.00.10.08",
    width: settings.width,
    height: settings.height,
    framerate: settings.fps,
    bitrate: getBitrate(settings),
    alpha: visualizer.background === "transparent" ? "keep" : "discard",
    latencyMode: "quality",
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error("Este equipo no soporta codificación VP9 con la configuración seleccionada.");

  const writable = fileHandle ? await fileHandle.createWritable() : null;
  const target = writable ? new FileSystemWritableFileStreamTarget(writable) : new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: "V_VP9",
      width: settings.width,
      height: settings.height,
      frameRate: settings.fps,
      alpha: visualizer.background === "transparent",
    },
  });

  let encoderError: DOMException | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => { encoderError = error; },
  });
  encoder.configure(support.config ?? config);

  const canvas = new OffscreenCanvas(settings.width, settings.height);
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("No se pudo crear el lienzo de exportación.");
  const spectrum = new Float32Array(analysis.bands);
  const totalFrames = Math.max(1, Math.ceil(analysis.duration * settings.fps));
  const frameDuration = Math.round(1_000_000 / settings.fps);

  try {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      if (callbacks.signal?.aborted) throw new DOMException("Exportación cancelada", "AbortError");
      if (encoderError) throw encoderError;
      while (encoder.encodeQueueSize > 8) await sleep(4);

      const time = frameIndex / settings.fps;
      fillSpectrumFrame(analysis, time, spectrum);
      renderVisualizer(context, spectrum, visualizer, { width: settings.width, height: settings.height, time });
      const frame = new VideoFrame(canvas, { timestamp: frameIndex * frameDuration, duration: frameDuration, alpha: "keep" });
      encoder.encode(frame, { keyFrame: frameIndex % (settings.fps * 4) === 0 });
      frame.close();

      if (frameIndex % settings.fps === 0) {
        callbacks.onProgress(frameIndex / totalFrames);
        await sleep(0);
      }
    }
    await encoder.flush();
    muxer.finalize();
    callbacks.onProgress(1);
    if (writable) {
      await writable.close();
    } else if (target instanceof ArrayBufferTarget) {
      downloadBlob(new Blob([target.buffer], { type: "video/webm" }), fileName);
    }
  } catch (error) {
    if (writable) await writable.abort().catch(() => undefined);
    throw error;
  } finally {
    encoder.close();
  }
}

export function exportPng(canvas: HTMLCanvasElement, fileName: string) {
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, fileName.replace(/\.[^.]+$/, "") + ".png");
  }, "image/png");
}

function getBitrate(settings: ExportSettings) {
  const raw = settings.width * settings.height * settings.fps * QUALITY_FACTOR[settings.quality];
  return Math.round(Math.max(700_000, Math.min(12_000_000, raw)));
}

async function chooseOutputFile(fileName: string) {
  if (!window.showSaveFilePicker) return null;
  return window.showSaveFilePicker({
    suggestedName: fileName,
    types: [{ description: "Video WebM", accept: { "video/webm": [".webm"] } }],
  });
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

declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle>;
  }
}
