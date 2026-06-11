import type { Connect } from "vite";
import { createCanvas } from "@napi-rs/canvas";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { fillSpectrumFrame } from "../src/lib/audio-analysis";
import type { AudioAnalysis, VisualizerSettings } from "../src/lib/types";
import { renderVisualizer } from "../src/lib/visualizer-renderer";

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const QUALITY_CRF = { draft: 30, standard: 24, high: 18 } as const;
const MAX_RENDER_WORKERS = 6;
const TARGET_RENDER_CHUNK_BYTES = 48 * 1024 * 1024;
const jobs = new Map<string, FfmpegJob>();
let startupCleanupStarted = false;
let signalHandlersRegistered = false;

export interface FfmpegExportOptions {
  width: number;
  height: number;
  fps: number;
  quality: keyof typeof QUALITY_CRF;
  duration: number;
  frames: number;
  bands: number;
  analysisFps: number;
  analysisFrames: number;
  style: VisualizerStyle;
  color: string;
  secondaryColor: string;
  opacity: number;
  amplitude: number;
  cutoff: number;
  smoothing: number;
  thickness: number;
  glow: number;
}

type VisualizerStyle = "bars" | "mirror" | "line" | "radial" | "dots" | "wave";
type RenderChunkResult = { startFrame: number; frameCount: number; pixels: Uint8Array };
type RenderChunkRequest = { index: number; startFrame: number; frameCount: number };
type RenderWorkerMessage = RenderChunkResult & { id: number; error?: string };

interface FfmpegJob {
  id: string;
  workdir: string;
  inputPath: string;
  outputPath: string;
  process: ChildProcess | null;
  status: "running" | "complete" | "error" | "cancelled";
  progress: number;
  error?: string;
  cleanupTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  cleanupStarted?: boolean;
}

export function createFfmpegExportMiddleware(): Connect.NextHandleFunction {
  if (!startupCleanupStarted) {
    startupCleanupStarted = true;
    void cleanupOrphanWorkdirs();
  }
  registerShutdownHandlers();

  return async (request, response, next) => {
    if (!request.url?.startsWith("/api/export-ffmpeg")) {
      next();
      return;
    }

    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "POST" && url.pathname === "/api/export-ffmpeg/start") {
        await startJob(request, response, url);
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/export-ffmpeg/progress/")) {
        sendProgress(response, url.pathname.split("/").at(-1) ?? "");
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/export-ffmpeg/download/")) {
        await sendDownload(response, url.pathname.split("/").at(-1) ?? "");
        return;
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/api/export-ffmpeg/")) {
        await cancelJob(response, url.pathname.split("/").at(-1) ?? "");
        return;
      }
      response.statusCode = 404;
      response.end("Not found");
    } catch (error) {
      if (!response.headersSent) {
        response.statusCode = error instanceof RequestError ? error.statusCode : 500;
        response.end(error instanceof Error ? error.message : "FFmpeg export failed");
      }
    }
  };
}

export function buildFfmpegArgs(outputPath: string, options: FfmpegExportOptions) {
  const timelineScale = options.duration / (options.frames / options.fps);

  return [
    "-hide_banner",
    "-y",
    "-f", "rawvideo",
    "-pixel_format", "rgba",
    "-video_size", `${options.width}x${options.height}`,
    "-framerate", String(options.fps),
    "-i", "pipe:0",
    "-vf", `settb=expr=1/1000000,setpts=PTS*${formatNumber(timelineScale, 12)},format=yuv420p`,
    "-c:v", "libx264",
    "-bf", "0",
    "-preset", "veryfast",
    "-crf", String(QUALITY_CRF[options.quality]),
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostats",
    "-fps_mode", "vfr",
    "-enc_time_base", "1/1000000",
    "-bsf:v", `setts=duration=${Math.round((options.duration / options.frames) * 1_000_000)}:time_base=1/1000000:prescale=1`,
    "-video_track_timescale", "1000000",
    outputPath,
  ];
}

export function parseOptions(url: string): FfmpegExportOptions {
  const params = new URL(url, "http://localhost").searchParams;
  const width = clampNumber(params.get("width"), 16, 3840, 1280);
  const height = clampNumber(params.get("height"), 16, 2160, 720);
  const fps = parseAllowedFps(params.get("fps"));
  const quality = parseQuality(params.get("quality"));
  const duration = clampFloat(params.get("duration"), 0.001, 24 * 60 * 60, 1);
  const bands = clampNumber(params.get("bands"), 8, 256, 64);
  const frames = clampNumber(params.get("frames"), 1, Math.ceil(duration * fps) + 1, Math.ceil(duration * fps));
  const analysisFps = clampFloat(params.get("analysisFps"), 1, 120, 12);
  const analysisFrames = clampNumber(params.get("analysisFrames"), 1, Math.ceil(duration * analysisFps) + 1, Math.ceil(duration * analysisFps));
  const style = parseStyle(params.get("style"));
  return {
    width,
    height,
    fps,
    quality,
    duration,
    frames,
    bands,
    analysisFps,
    analysisFrames,
    style,
    color: normalizeHexColor(params.get("color") ?? "#ffffff"),
    secondaryColor: normalizeHexColor(params.get("secondaryColor") ?? "#ffffff"),
    opacity: clampFloat(params.get("opacity"), 0.05, 1, 0.92),
    amplitude: clampFloat(params.get("amplitude"), 0.25, 2.5, 1.1),
    cutoff: clampFloat(params.get("cutoff"), 0, 0.65, 0.08),
    smoothing: clampFloat(params.get("smoothing"), 0, 1, 0.42),
    thickness: clampFloat(params.get("thickness"), 0.15, 1, 0.62),
    glow: clampFloat(params.get("glow"), 0, 1, 0.3),
  };
}

function parseStyle(value: string | null): VisualizerStyle {
  if (value === "bars" || value === "mirror" || value === "line" || value === "radial" || value === "dots" || value === "wave") return value;
  throw new RequestError(400, "El estilo solicitado no es compatible.");
}

function parseAllowedFps(value: string | null) {
  const fps = Number(value);
  return [24, 25, 30, 48, 50, 60].includes(fps) ? fps : 24;
}

function parseQuality(value: string | null): FfmpegExportOptions["quality"] {
  return value === "draft" || value === "high" ? value : "standard";
}

function clampNumber(value: string | null, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clampFloat(value: string | null, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeHexColor(value: string) {
  const color = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return `0x${color.slice(1)}`;
  if (/^0x[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  return "0xffffff";
}

async function makeWorkdir() {
  const directory = path.join(tmpdir(), `spectra-ffmpeg-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function cleanupOrphanWorkdirs() {
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("spectra-ffmpeg-"))
      .map((entry) => rm(path.join(tmpdir(), entry.name), { recursive: true, force: true })),
  );
}

async function startJob(request: IncomingMessage, response: ServerResponse, url: URL) {
  const options = parseOptions(url.toString());
  const workdir = await makeWorkdir();
  const inputPath = path.join(workdir, "analysis.gray");
  const outputPath = path.join(workdir, "overlay.mp4");
  try {
    await writeRequestBody(request, inputPath, options.analysisFrames * options.bands);
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const job: FfmpegJob = {
      id,
      workdir,
      inputPath,
      outputPath,
      process: null,
      status: "running",
      progress: 0,
    };
    jobs.set(id, job);
    runFfmpegJob(job, options, options.duration);
    sendJson(response, 202, { id });
  } catch (error) {
    await rm(workdir, { recursive: true, force: true });
    throw error;
  }
}

function sendProgress(response: ServerResponse, id: string) {
  const job = jobs.get(id);
  if (!job) {
    sendJson(response, 404, { status: "error", progress: 0, error: "Job no encontrado." });
    return;
  }
  sendJson(response, 200, {
    status: job.status,
    progress: job.progress,
    error: job.error,
  });
}

async function sendDownload(response: ServerResponse, id: string) {
  const job = jobs.get(id);
  if (!job) {
    response.statusCode = 404;
    response.end("Job no encontrado.");
    return;
  }
  if (job.status !== "complete") {
    response.statusCode = 409;
    response.end("El export FFmpeg todavía no terminó.");
    return;
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", "video/mp4");
  response.setHeader("Content-Disposition", 'attachment; filename="spectrum-ffmpeg.mp4"');
  await pipeline(createReadStream(job.outputPath), response);
  await cleanupJob(job);
}

async function cancelJob(response: ServerResponse, id: string) {
  const job = jobs.get(id);
  if (!job) {
    sendJson(response, 200, { ok: true });
    return;
  }
  job.status = "cancelled";
  terminateJob(job);
  sendJson(response, 200, { ok: true });
}

async function writeRequestBody(request: IncomingMessage, filePath: string, expectedBytes: number) {
  const length = Number(request.headers["content-length"] ?? 0);
  if (length > MAX_UPLOAD_BYTES) throw new RequestError(413, "Los datos del espectro son demasiado grandes para este modo FFmpeg.");
  if (length > 0 && length !== expectedBytes) throw new RequestError(400, "Los datos del espectro están incompletos.");

  let received = 0;
  request.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) request.destroy(new RequestError(413, "Los datos del espectro son demasiado grandes para este modo FFmpeg."));
  });

  await pipeline(request, createWriteStream(filePath));
  if (received !== expectedBytes) throw new RequestError(400, "Los datos del espectro están incompletos.");
}

function runFfmpegJob(job: FfmpegJob, options: FfmpegExportOptions, duration: number) {
  const ffmpeg = spawn("ffmpeg", buildFfmpegArgs(job.outputPath, options), {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  job.process = ffmpeg;
  let stderr = "";
  let progressBuffer = "";

  ffmpeg.stdout.on("data", (chunk: Buffer) => {
    progressBuffer = `${progressBuffer}${chunk.toString("utf8")}`;
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop() ?? "";
    for (const line of lines) updateJobProgress(job, line, duration);
  });
  ffmpeg.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  ffmpeg.on("error", (error) => {
    job.status = "error";
    job.error = error.message;
    scheduleCleanup(job);
  });
  ffmpeg.on("close", (code) => {
    job.process = null;
    if (job.killTimer) clearTimeout(job.killTimer);
    if (job.status === "cancelled") {
      void cleanupJob(job);
      return;
    }
    if (job.status === "error") {
      scheduleCleanup(job);
      return;
    }
    if (code === 0) {
      job.status = "complete";
      job.progress = 1;
    } else {
      job.status = "error";
      job.error = stderr || `FFmpeg terminó con código ${code}.`;
    }
    scheduleCleanup(job);
  });

  void renderFramesToFfmpeg(job, options, ffmpeg).catch((error) => {
    if (job.status !== "running") return;
    job.status = "error";
    job.error = error instanceof Error ? error.message : "No se pudieron renderizar los fotogramas.";
    ffmpeg.stdin.destroy();
    terminateProcess(job, "SIGTERM");
  });
}

async function renderFramesToFfmpeg(job: FfmpegJob, options: FfmpegExportOptions, ffmpeg: ChildProcess) {
  if (!ffmpeg.stdin) throw new Error("FFmpeg no abrió el canal de video.");
  const frames = new Uint8Array(await readFile(job.inputPath));
  if (getRenderConcurrency(options) > 1) {
    await renderFramesToFfmpegParallel(job, options, ffmpeg, frames);
    return;
  }
  await renderFramesToFfmpegSequential(job, options, ffmpeg, frames);
}

async function renderFramesToFfmpegSequential(
  job: FfmpegJob,
  options: FfmpegExportOptions,
  ffmpeg: ChildProcess,
  frames: Uint8Array,
) {
  const analysis: AudioAnalysis = {
    duration: options.duration,
    frameRate: options.analysisFps,
    bands: options.bands,
    frames,
    peaks: new Uint8Array(options.analysisFrames),
  };
  const visualizer: VisualizerSettings = {
    style: options.style,
    color: colorToCss(options.color),
    secondaryColor: colorToCss(options.secondaryColor),
    opacity: options.opacity,
    amplitude: options.amplitude,
    cutoff: options.cutoff,
    smoothing: options.smoothing,
    thickness: options.thickness,
    glow: options.glow,
    background: "chroma",
  };
  const canvas = createCanvas(options.width, options.height);
  const context = canvas.getContext("2d");
  const stdin = ffmpeg.stdin;
  if (!stdin) throw new Error("FFmpeg cerró el canal de video.");
  const spectrum = new Float32Array(options.bands);
  const preparedSpectrum = new Float32Array(options.bands);

  for (let frameIndex = 0; frameIndex < options.frames; frameIndex += 1) {
    if (job.status !== "running") return;
    const time = frameIndex / options.fps;
    fillSpectrumFrame(analysis, time, spectrum);
    renderVisualizer(
      context as unknown as CanvasRenderingContext2D,
      spectrum,
      visualizer,
      { width: options.width, height: options.height, time, preparedSpectrum },
    );
    if (!stdin.write(canvas.data())) await waitForDrain(ffmpeg);
    updateRenderProgress(job, frameIndex + 1, options.frames);
    if (frameIndex % 4 === 0) await yieldToEventLoop();
  }
  stdin.end();
}

async function renderFramesToFfmpegParallel(
  job: FfmpegJob,
  options: FfmpegExportOptions,
  ffmpeg: ChildProcess,
  frames: Uint8Array,
) {
  const concurrency = getRenderConcurrency(options);
  const chunkFrames = getRenderChunkFrames(options);
  const stdin = ffmpeg.stdin;
  if (!stdin) throw new Error("FFmpeg cerró el canal de video.");
  const chunks = Array.from({ length: Math.ceil(options.frames / chunkFrames) }, (_, index) => {
    const startFrame = index * chunkFrames;
    return {
      index,
      startFrame,
      frameCount: Math.min(chunkFrames, options.frames - startFrame),
    };
  });
  const workerCount = Math.min(concurrency, chunks.length);
  const workers = Array.from({ length: workerCount }, () => createRenderWorker(options, frames));
  const completed = new Map<number, RenderChunkResult>();
  const waiters = new Map<number, { resolve: (result: RenderChunkResult) => void; reject: (error: unknown) => void }>();
  let nextToRender = 0;
  let writtenFrames = 0;
  let renderError: unknown;

  const failRender = (error: unknown) => {
    renderError = error;
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  };

  const storeResult = (index: number, result: RenderChunkResult) => {
    const waiter = waiters.get(index);
    if (waiter) {
      waiters.delete(index);
      waiter.resolve(result);
      return;
    }
    completed.set(index, result);
  };

  const waitForChunk = (index: number) => {
    const result = completed.get(index);
    if (result) {
      completed.delete(index);
      return Promise.resolve(result);
    }
    if (renderError) return Promise.reject(renderError);
    return new Promise<RenderChunkResult>((resolve, reject) => {
      waiters.set(index, { resolve, reject });
    });
  };

  const renderLoop = async (worker: Worker) => {
    while (job.status === "running") {
      const chunk = chunks[nextToRender];
      if (!chunk) return;
      nextToRender += 1;
      const result = await renderChunkInWorker(worker, chunk);
      storeResult(chunk.index, result);
    }
  };

  const renderLoops = workers.map((worker) => renderLoop(worker).catch(failRender));

  try {
    for (let nextToWrite = 0; nextToWrite < chunks.length; nextToWrite += 1) {
      if (job.status !== "running") return;
      const result = await waitForChunk(nextToWrite);
      if (job.status !== "running") return;
      if (!stdin.write(result.pixels)) await waitForDrain(ffmpeg);
      writtenFrames += result.frameCount;
      updateRenderProgress(job, writtenFrames, options.frames);
      await yieldToEventLoop();
    }
    await Promise.all(renderLoops);
    stdin.end();
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}

function createRenderWorker(
  options: FfmpegExportOptions,
  frames: Uint8Array,
) {
  return new Worker(new URL("./ffmpeg-render-worker.js", import.meta.url), {
    workerData: { options, frames },
  });
}

let renderMessageId = 0;

function renderChunkInWorker(worker: Worker, chunk: RenderChunkRequest) {
  return new Promise<RenderChunkResult>((resolve, reject) => {
    const id = renderMessageId = (renderMessageId + 1) % Number.MAX_SAFE_INTEGER;
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message: RenderWorkerMessage) => {
      if (message.id !== id) return;
      cleanup();
      if (message.error) {
        reject(new Error(message.error));
        return;
      }
      resolve({
        startFrame: message.startFrame,
        frameCount: message.frameCount,
        pixels: message.pixels,
      });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      if (code !== 0) reject(new Error(`El worker de render terminó con código ${code}.`));
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.postMessage({ id, startFrame: chunk.startFrame, frameCount: chunk.frameCount });
  });
}

export function getRenderConcurrency(options: Pick<FfmpegExportOptions, "width" | "height">) {
  const configured = Number(process.env.SPECTRA_FFMPEG_RENDER_WORKERS);
  const cpuDefault = Math.max(1, Math.min(MAX_RENDER_WORKERS, availableParallelism() - 1));
  const requested = Number.isFinite(configured) && configured > 0 ? Math.round(configured) : cpuDefault;
  const frameBytes = options.width * options.height * 4;
  const memoryBound = Math.max(1, Math.floor((TARGET_RENDER_CHUNK_BYTES * 4) / frameBytes));
  return Math.max(1, Math.min(requested, memoryBound));
}

export function getRenderChunkFrames(options: Pick<FfmpegExportOptions, "width" | "height">) {
  const frameBytes = options.width * options.height * 4;
  return Math.max(1, Math.floor(TARGET_RENDER_CHUNK_BYTES / frameBytes));
}

function updateRenderProgress(job: FfmpegJob, renderedFrames: number, totalFrames: number) {
  job.progress = Math.max(job.progress, Math.min(0.92, (renderedFrames / totalFrames) * 0.92));
}

function waitForDrain(ffmpeg: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    if (!ffmpeg.stdin) {
      reject(new Error("FFmpeg cerró el canal de video."));
      return;
    }
    const cleanup = () => {
      ffmpeg.stdin?.off("drain", onDrain);
      ffmpeg.stdin?.off("error", onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    ffmpeg.stdin.once("drain", onDrain);
    ffmpeg.stdin.once("error", onError);
  });
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function updateJobProgress(job: FfmpegJob, line: string, duration: number) {
  const [key, value] = line.split("=");
  if (key !== "out_time_ms" && key !== "out_time_us") return;
  const microseconds = Number(value);
  if (!Number.isFinite(microseconds)) return;
  job.progress = Math.max(job.progress, Math.min(0.99, microseconds / 1_000_000 / duration));
}

function colorToCss(value: string) {
  return `#${normalizeHexColor(value).slice(2)}`;
}

function formatNumber(value: number, precision = 6) {
  return Number(value.toFixed(precision)).toString();
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function scheduleCleanup(job: FfmpegJob) {
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    void cleanupJob(job);
  }, 10 * 60_000);
}

function terminateJob(job: FfmpegJob) {
  jobs.delete(job.id);
  terminateProcess(job, "SIGTERM");
  if (job.killTimer) clearTimeout(job.killTimer);
  job.killTimer = setTimeout(() => {
    terminateProcess(job, "SIGKILL");
    void cleanupJob(job);
  }, 2_000);
}

function terminateProcess(job: FfmpegJob, signal: NodeJS.Signals) {
  const pid = job.process?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have already exited between cancellation and cleanup.
    }
  }
}

async function cleanupJob(job: FfmpegJob) {
  if (job.cleanupStarted) return;
  job.cleanupStarted = true;
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  if (job.killTimer) clearTimeout(job.killTimer);
  jobs.delete(job.id);
  terminateProcess(job, "SIGKILL");
  await rm(job.workdir, { recursive: true, force: true });
}

function registerShutdownHandlers() {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  const terminateAll = (exitCode: number) => {
    for (const job of Array.from(jobs.values())) {
      job.status = "cancelled";
      terminateJob(job);
    }
    setTimeout(() => process.exit(exitCode), 2_500).unref();
  };
  process.once("SIGTERM", () => terminateAll(0));
  process.once("SIGINT", () => terminateAll(130));
}

class RequestError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
