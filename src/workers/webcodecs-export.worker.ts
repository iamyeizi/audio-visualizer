import { ArrayBufferTarget, FileSystemWritableFileStreamTarget, Muxer } from "webm-muxer";
import { fillSpectrumFrame } from "../lib/audio-analysis";
import type { AudioAnalysis, ExportSettings, VisualizerSettings } from "../lib/types";
import { renderVisualizer } from "../lib/visualizer-renderer";

type WorkerRequest =
  | { type: "abort" }
  | {
    type: "start";
    analysis: Omit<AudioAnalysis, "frames" | "peaks"> & { frames: ArrayBuffer };
    visualizer: VisualizerSettings;
    settings: ExportSettings;
    config: VideoEncoderConfig;
    fileHandle: FileSystemFileHandle | null;
  };

let aborted = false;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "abort") {
    aborted = true;
    return;
  }
  void exportWithWebCodecs(event.data).catch((error) => {
    self.postMessage({
      type: "error",
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : "No se pudo exportar el video WebM.",
    });
  });
};

async function exportWithWebCodecs(request: Extract<WorkerRequest, { type: "start" }>) {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined" || typeof OffscreenCanvas === "undefined") {
    throw new DOMException("Este worker no ofrece WebCodecs para crear el video.", "NotSupportedError");
  }

  const analysis: AudioAnalysis = {
    duration: request.analysis.duration,
    frameRate: request.analysis.frameRate,
    bands: request.analysis.bands,
    frames: new Uint8Array(request.analysis.frames),
    peaks: new Uint8Array(0),
  };
  const keepAlpha = request.visualizer.background === "transparent";
  const writable = request.fileHandle ? await request.fileHandle.createWritable() : null;
  const target = writable ? new FileSystemWritableFileStreamTarget(writable) : new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: "V_VP9",
      width: request.settings.width,
      height: request.settings.height,
      frameRate: request.settings.fps,
      alpha: keepAlpha,
    },
  });

  let encoderError: DOMException | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => { encoderError = error; },
  });
  encoder.configure(request.config);

  try {
    const canvas = new OffscreenCanvas(request.settings.width, request.settings.height);
    const context = canvas.getContext("2d", { alpha: keepAlpha });
    if (!context) throw new Error("No se pudo crear el lienzo de exportación.");

    const spectrum = new Float32Array(analysis.bands);
    const preparedSpectrum = new Float32Array(analysis.bands);
    const schedule = createFrameSchedule(analysis.duration, request.settings.fps);

    for (let frameIndex = 0; frameIndex < schedule.timestamps.length; frameIndex += 1) {
      throwIfAborted();
      if (encoderError) throw encoderError;
      while (encoder.encodeQueueSize > 8) {
        throwIfAborted();
        await sleep(4);
      }

      const time = frameIndex / request.settings.fps;
      fillSpectrumFrame(analysis, time, spectrum);
      renderVisualizer(context, spectrum, request.visualizer, {
        width: request.settings.width,
        height: request.settings.height,
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
      encoder.encode(frame, { keyFrame: frameIndex % (request.settings.fps * 4) === 0 });
      frame.close();

      if (frameIndex % request.settings.fps === 0) {
        self.postMessage({ type: "progress", value: frameIndex / schedule.timestamps.length });
        await sleep(0);
      }
    }

    throwIfAborted();
    const endpointFrame = new VideoFrame(canvas, {
      timestamp: schedule.endTimestamp,
      duration: 1,
      alpha: keepAlpha ? "keep" : "discard",
    });
    encoder.encode(endpointFrame, { keyFrame: true });
    endpointFrame.close();
    await encoder.flush();
    muxer.finalize();

    if (writable) {
      await writable.close();
      self.postMessage({ type: "complete" });
      return;
    }
    if (target instanceof ArrayBufferTarget) {
      self.postMessage({ type: "complete", buffer: target.buffer }, [target.buffer]);
    }
  } catch (error) {
    if (writable) await writable.abort().catch(() => undefined);
    throw error;
  } finally {
    encoder.close();
  }
}

function createFrameSchedule(duration: number, fps: number) {
  const safeDuration = Math.max(0, duration);
  const totalFrames = Math.max(1, Math.ceil(safeDuration * fps));
  const timestamps = Array.from(
    { length: totalFrames },
    (_, frameIndex) => Math.round((frameIndex / fps) * 1_000_000),
  );
  const endTimestamp = Math.max(1, Math.round(safeDuration * 1_000_000));
  return { timestamps, endTimestamp };
}

function throwIfAborted() {
  if (aborted) throw new DOMException("Exportación cancelada", "AbortError");
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export {};
