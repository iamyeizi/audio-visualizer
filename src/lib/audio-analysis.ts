import type { AudioAnalysis } from "./types";

const ANALYSIS_SAMPLE_RATE = 12_000;
const ANALYSIS_FPS = 12;
const ANALYSIS_BANDS = 64;

interface WorkerResult {
  type: "complete";
  frames: ArrayBuffer;
  peaks: ArrayBuffer;
}

export async function analyzeAudioFile(
  file: File,
  onProgress: (progress: number, phase: string) => void,
  signal?: AbortSignal,
): Promise<AudioAnalysis> {
  onProgress(0.02, "Decodificando audio");
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (!Context) throw new Error("Este navegador no incluye Web Audio API.");

  const audioContext = new Context({ sampleRate: ANALYSIS_SAMPLE_RATE });
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await audioContext.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error("No se pudo decodificar el archivo. Prueba WAV, MP3, M4A, AAC, OGG o FLAC compatible con tu navegador.");
  } finally {
    await audioContext.close();
  }

  if (signal?.aborted) throw new DOMException("Análisis cancelado", "AbortError");
  onProgress(0.2, "Preparando señal");

  const signalData = mixToMono(audioBuffer);
  const duration = audioBuffer.duration;
  const worker = new Worker(new URL("../workers/spectrum.worker.ts", import.meta.url), { type: "module" });

  return new Promise<AudioAnalysis>((resolve, reject) => {
    const abort = () => {
      worker.terminate();
      reject(new DOMException("Análisis cancelado", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });

    worker.onmessage = (event: MessageEvent<WorkerResult | { type: "progress"; value: number }>) => {
      if (event.data.type === "progress") {
        onProgress(0.2 + event.data.value * 0.8, "Calculando espectro");
        return;
      }
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      resolve({
        duration,
        frameRate: ANALYSIS_FPS,
        bands: ANALYSIS_BANDS,
        frames: new Uint8Array(event.data.frames),
        peaks: new Uint8Array(event.data.peaks),
      });
    };
    worker.onerror = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      reject(new Error("El analizador de espectro se detuvo inesperadamente."));
    };
    worker.postMessage(
      { signal: signalData.buffer, sampleRate: audioBuffer.sampleRate, fps: ANALYSIS_FPS, bands: ANALYSIS_BANDS },
      [signalData.buffer],
    );
  });
}

function mixToMono(buffer: AudioBuffer) {
  if (buffer.numberOfChannels === 1) {
    const source = buffer.getChannelData(0);
    const copy = new Float32Array(source.length);
    copy.set(source);
    return copy;
  }
  const output = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const source = buffer.getChannelData(channel);
    for (let index = 0; index < output.length; index += 1) output[index] += source[index] / buffer.numberOfChannels;
  }
  return output;
}

export function fillSpectrumFrame(analysis: AudioAnalysis, time: number, target: Float32Array) {
  const maxFrame = Math.max(0, Math.floor(analysis.frames.length / analysis.bands) - 1);
  const exactFrame = Math.max(0, Math.min(maxFrame, time * analysis.frameRate));
  const leftFrame = Math.floor(exactFrame);
  const rightFrame = Math.min(maxFrame, leftFrame + 1);
  const mix = exactFrame - leftFrame;
  for (let band = 0; band < analysis.bands; band += 1) {
    const left = analysis.frames[leftFrame * analysis.bands + band] ?? 0;
    const right = analysis.frames[rightFrame * analysis.bands + band] ?? left;
    target[band] = (left + (right - left) * mix) / 255;
  }
  return target;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
