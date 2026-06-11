import type { Connect } from "vite";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const MAX_UPLOAD_BYTES = 600 * 1024 * 1024;
const QUALITY_CRF = { draft: 30, standard: 24, high: 18 } as const;
const jobs = new Map<string, FfmpegJob>();
let startupCleanupStarted = false;
let signalHandlersRegistered = false;

export interface FfmpegExportOptions {
  width: number;
  height: number;
  fps: number;
  quality: keyof typeof QUALITY_CRF;
  color: string;
  secondaryColor: string;
}

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

export function buildFfmpegArgs(inputPath: string, outputPath: string, options: FfmpegExportOptions) {
  const primary = normalizeHexColor(options.color);
  const secondary = normalizeHexColor(options.secondaryColor);
  const filter = [
    `[0:a]showfreqs=s=${options.width}x${options.height}:rate=${options.fps}:mode=bar:ascale=sqrt:fscale=log:colors=${primary}|${secondary},format=rgb24,split=2[base][freqsrc]`,
    "[base]drawbox=x=0:y=0:w=iw:h=ih:color=0x00ff00:t=fill[bg]",
    "[freqsrc]colorkey=0x000000:0.08:0.02[freq]",
    "[bg][freq]overlay=format=auto,format=yuv420p[v]",
  ].join(";");

  return [
    "-hide_banner",
    "-y",
    "-i", inputPath,
    "-filter_complex", filter,
    "-map", "[v]",
    "-an",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", String(QUALITY_CRF[options.quality]),
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostats",
    "-shortest",
    outputPath,
  ];
}

export function parseOptions(url: string): FfmpegExportOptions {
  const params = new URL(url, "http://localhost").searchParams;
  const width = clampNumber(params.get("width"), 16, 3840, 1280);
  const height = clampNumber(params.get("height"), 16, 2160, 720);
  const fps = parseAllowedFps(params.get("fps"));
  const quality = parseQuality(params.get("quality"));
  return {
    width,
    height,
    fps,
    quality,
    color: normalizeHexColor(params.get("color") ?? "#ffffff"),
    secondaryColor: normalizeHexColor(params.get("secondaryColor") ?? "#ffffff"),
  };
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
  const inputPath = path.join(workdir, "input.audio");
  const outputPath = path.join(workdir, "overlay.mp4");
  try {
    await writeRequestBody(request, inputPath);
    const duration = await getDuration(inputPath);
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
    runFfmpegJob(job, options, duration);
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

async function writeRequestBody(request: IncomingMessage, filePath: string) {
  const length = Number(request.headers["content-length"] ?? 0);
  if (length > MAX_UPLOAD_BYTES) throw new RequestError(413, "El audio es demasiado grande para este modo FFmpeg.");

  let received = 0;
  request.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) request.destroy(new RequestError(413, "El audio es demasiado grande para este modo FFmpeg."));
  });

  await pipeline(request, createWriteStream(filePath));
}

function runFfmpegJob(job: FfmpegJob, options: FfmpegExportOptions, duration: number) {
  const ffmpeg = spawn("ffmpeg", buildFfmpegArgs(job.inputPath, job.outputPath, options), {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
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
    if (code === 0) {
      job.status = "complete";
      job.progress = 1;
    } else {
      job.status = "error";
      job.error = stderr || `FFmpeg terminó con código ${code}.`;
    }
    scheduleCleanup(job);
  });
}

async function getDuration(inputPath: string) {
  return new Promise<number>((resolve) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    let stdout = "";
    ffprobe.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    ffprobe.on("close", () => {
      const duration = Number(stdout.trim());
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 1);
    });
    ffprobe.on("error", () => resolve(1));
  });
}

function updateJobProgress(job: FfmpegJob, line: string, duration: number) {
  const [key, value] = line.split("=");
  if (key !== "out_time_ms" && key !== "out_time_us") return;
  const microseconds = Number(value);
  if (!Number.isFinite(microseconds)) return;
  job.progress = Math.max(job.progress, Math.min(0.99, microseconds / 1_000_000 / duration));
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
