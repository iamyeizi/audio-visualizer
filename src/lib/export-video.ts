import { ArrayBufferTarget, FileSystemWritableFileStreamTarget, Muxer } from "webm-muxer";
import { fillSpectrumFrame } from "./audio-analysis";
import type { AudioAnalysis, ExportSettings, VisualizerSettings } from "./types";
import { renderVisualizer } from "./visualizer-renderer";

interface ExportCallbacks {
  onProgress: (value: number) => void;
  onModeChange?: (mode: ExportMode) => void;
  signal?: AbortSignal;
}

export type ExportMode = "accelerated" | "realtime";

const QUALITY_FACTOR = { draft: 0.025, standard: 0.045, high: 0.075 } as const;

export function estimateExportSize(settings: ExportSettings, duration: number) {
  const bitrate = getBitrate(settings);
  return (bitrate * duration) / 8;
}

export function createFrameSchedule(duration: number, fps: number) {
  const safeDuration = Math.max(0, duration);
  const totalFrames = Math.max(1, Math.ceil(safeDuration * fps));
  const timestamps = Array.from(
    { length: totalFrames },
    (_, frameIndex) => Math.round((frameIndex / fps) * 1_000_000),
  );
  const endTimestamp = Math.max(1, Math.round(safeDuration * 1_000_000));
  return { timestamps, endTimestamp };
}

export async function exportWebM(
  analysis: AudioAnalysis,
  visualizer: VisualizerSettings,
  settings: ExportSettings,
  fileName: string,
  callbacks: ExportCallbacks,
) {
  const fileHandle = await chooseOutputFile(fileName);
  if (supportsAcceleratedExport()) {
    return exportWithWebCodecs(analysis, visualizer, settings, fileName, callbacks, fileHandle);
  }
  if (supportsRealtimeExport()) {
    callbacks.onModeChange?.("realtime");
    return exportWithMediaRecorder(analysis, visualizer, settings, fileName, callbacks, fileHandle);
  }
  throw new Error("Este navegador no ofrece WebCodecs ni MediaRecorder para crear el video.");
}

export function getExportMode(): ExportMode | null {
  if (supportsAcceleratedExport()) return "accelerated";
  if (supportsRealtimeExport()) return "realtime";
  return null;
}

async function exportWithWebCodecs(
  analysis: AudioAnalysis,
  visualizer: VisualizerSettings,
  settings: ExportSettings,
  fileName: string,
  callbacks: ExportCallbacks,
  fileHandle: FileSystemFileHandle | null,
) {
  const keepAlpha = visualizer.background === "transparent";
  const config: VideoEncoderConfig = {
    codec: "vp09.00.10.08",
    width: settings.width,
    height: settings.height,
    framerate: settings.fps,
    bitrate: getBitrate(settings),
    alpha: keepAlpha ? "keep" : "discard",
    latencyMode: "quality",
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) {
    if (supportsRealtimeExport()) {
      callbacks.onModeChange?.("realtime");
      return exportWithMediaRecorder(analysis, visualizer, settings, fileName, callbacks, fileHandle);
    }
    throw new Error("Este equipo no soporta codificación VP9 con la configuración seleccionada.");
  }
  callbacks.onModeChange?.("accelerated");

  const writable = fileHandle ? await fileHandle.createWritable() : null;
  const target = writable ? new FileSystemWritableFileStreamTarget(writable) : new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: "V_VP9",
      width: settings.width,
      height: settings.height,
      frameRate: settings.fps,
      alpha: keepAlpha,
    },
  });

  let encoderError: DOMException | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => { encoderError = error; },
  });
  encoder.configure(support.config ?? config);

  const canvas = new OffscreenCanvas(settings.width, settings.height);
  const context = canvas.getContext("2d", { alpha: keepAlpha });
  if (!context) throw new Error("No se pudo crear el lienzo de exportación.");
  const spectrum = new Float32Array(analysis.bands);
  const preparedSpectrum = new Float32Array(analysis.bands);
  const schedule = createFrameSchedule(analysis.duration, settings.fps);
  const nominalFrameDuration = Math.round(1_000_000 / settings.fps);

  try {
    for (let frameIndex = 0; frameIndex < schedule.timestamps.length; frameIndex += 1) {
      if (callbacks.signal?.aborted) throw new DOMException("Exportación cancelada", "AbortError");
      if (encoderError) throw encoderError;
      while (encoder.encodeQueueSize > 8) await sleep(4);

      const time = frameIndex / settings.fps;
      fillSpectrumFrame(analysis, time, spectrum);
      renderVisualizer(context, spectrum, visualizer, {
        width: settings.width,
        height: settings.height,
        time,
        preparedSpectrum,
      });
      const timestamp = schedule.timestamps[frameIndex];
      const nextTimestamp = schedule.timestamps[frameIndex + 1] ?? schedule.endTimestamp;
      const frame = new VideoFrame(canvas, {
        timestamp,
        duration: Math.max(1, nextTimestamp - timestamp),
        alpha: keepAlpha ? "keep" : "discard",
      });
      encoder.encode(frame, { keyFrame: frameIndex % (settings.fps * 4) === 0 });
      frame.close();

      if (frameIndex % settings.fps === 0) {
        callbacks.onProgress(frameIndex / schedule.timestamps.length);
        await sleep(0);
      }
    }

    // webm-muxer derives the container duration from the last chunk timestamp.
    // An endpoint frame prevents the file from ending one frame before the audio.
    const endpointFrame = new VideoFrame(canvas, {
      timestamp: schedule.endTimestamp,
      duration: nominalFrameDuration,
      alpha: keepAlpha ? "keep" : "discard",
    });
    encoder.encode(endpointFrame, { keyFrame: true });
    endpointFrame.close();
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

async function exportWithMediaRecorder(
  analysis: AudioAnalysis,
  visualizer: VisualizerSettings,
  settings: ExportSettings,
  fileName: string,
  callbacks: ExportCallbacks,
  fileHandle: FileSystemFileHandle | null,
) {
  const keepAlpha = false;
  const canvas = document.createElement("canvas");
  canvas.width = settings.width;
  canvas.height = settings.height;
  const context = canvas.getContext("2d", { alpha: keepAlpha });
  if (!context) throw new Error("No se pudo crear el lienzo de exportación compatible.");

  const mimeType = getRecorderMimeType();
  if (!mimeType) throw new Error("Chrome no ofrece un encoder WebM compatible en este contexto.");
  const stream = canvas.captureStream(settings.fps);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: getBitrate(settings) });
  const writable = fileHandle ? await fileHandle.createWritable() : null;
  const chunks: Blob[] = [];
  let writeQueue = Promise.resolve();
  const spectrum = new Float32Array(analysis.bands);
  const preparedSpectrum = new Float32Array(analysis.bands);
  const fallbackSettings = visualizer.background === "transparent"
    ? { ...visualizer, background: "chroma" as const }
    : visualizer;

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    if (writable) writeQueue = writeQueue.then(() => writable.write(event.data));
    else chunks.push(event.data);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let animationFrame = 0;
      const startedAt = performance.now();
      const abort = () => {
        cancelAnimationFrame(animationFrame);
        if (recorder.state !== "inactive") recorder.stop();
        reject(new DOMException("Exportación cancelada", "AbortError"));
      };
      callbacks.signal?.addEventListener("abort", abort, { once: true });
      recorder.onerror = () => reject(new Error("MediaRecorder detuvo la exportación."));
      recorder.onstop = () => {
        callbacks.signal?.removeEventListener("abort", abort);
        resolve();
      };

      const draw = (now: number) => {
        const time = Math.min(analysis.duration, (now - startedAt) / 1000);
        fillSpectrumFrame(analysis, time, spectrum);
        renderVisualizer(context, spectrum, fallbackSettings, {
          width: settings.width,
          height: settings.height,
          time,
          preparedSpectrum,
        });
        callbacks.onProgress(time / analysis.duration);
        if (time >= analysis.duration) {
          recorder.stop();
          return;
        }
        animationFrame = requestAnimationFrame(draw);
      };

      recorder.start(1_000);
      animationFrame = requestAnimationFrame(draw);
    });

    await writeQueue;
    callbacks.onProgress(1);
    if (writable) await writable.close();
    else downloadBlob(new Blob(chunks, { type: mimeType }), fileName);
  } catch (error) {
    if (writable) await writable.abort().catch(() => undefined);
    throw error;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function getBitrate(settings: ExportSettings) {
  const raw = settings.width * settings.height * settings.fps * QUALITY_FACTOR[settings.quality];
  const minimum = settings.width * settings.height <= 854 * 480 ? 250_000 : 500_000;
  return Math.round(Math.max(minimum, Math.min(12_000_000, raw)));
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

function supportsAcceleratedExport() {
  return window.isSecureContext
    && typeof globalThis.VideoEncoder !== "undefined"
    && typeof globalThis.VideoFrame !== "undefined"
    && typeof globalThis.OffscreenCanvas !== "undefined";
}

function supportsRealtimeExport() {
  const canvas = document.createElement("canvas");
  return typeof globalThis.MediaRecorder !== "undefined" && typeof canvas.captureStream === "function";
}

function getRecorderMimeType() {
  return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    .find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? null;
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle>;
  }
}
