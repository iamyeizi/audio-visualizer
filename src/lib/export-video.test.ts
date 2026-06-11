import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrameSchedule, estimateExportSize, getExportMode } from "./export-video";
import { createFfmpegSpectrumPayload } from "./export-ffmpeg";

const secureContextDescriptor = Object.getOwnPropertyDescriptor(window, "isSecureContext");

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream");
  if (secureContextDescriptor) Object.defineProperty(window, "isSecureContext", secureContextDescriptor);
  else Reflect.deleteProperty(window, "isSecureContext");
});

describe("estimateExportSize", () => {
  it("scales with duration", () => {
    const settings = { width: 1920, height: 1080, fps: 30, quality: "standard" as const };
    expect(estimateExportSize(settings, 120)).toBe(estimateExportSize(settings, 60) * 2);
  });

  it("ends the accelerated frame schedule at the exact audio duration", () => {
    const schedule = createFrameSchedule(3_600.123, 30);
    expect(schedule.endTimestamp).toBe(3_600_123_000);
    expect(schedule.timestamps.at(-1)).toBeLessThan(schedule.endTimestamp);
    expect(schedule.endTimestamp - (schedule.timestamps.at(-1) ?? 0)).toBeLessThanOrEqual(33_334);
  });

  it("uses absolute timestamps without accumulating frame rounding drift", () => {
    const schedule = createFrameSchedule(3_600, 30);
    expect(schedule.timestamps[108_000 - 1]).toBe(Math.round((107_999 / 30) * 1_000_000));
    expect(schedule.endTimestamp).toBe(3_600_000_000);
  });

  it("selects accelerated export in a secure WebCodecs context", () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    vi.stubGlobal("VideoEncoder", class {});
    vi.stubGlobal("VideoFrame", class {});
    vi.stubGlobal("OffscreenCanvas", class {});
    expect(getExportMode()).toBe("accelerated");
  });

  it("falls back to realtime recording when WebCodecs is unavailable", () => {
    Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", { configurable: true, value: vi.fn() });
    vi.stubGlobal("MediaRecorder", class { static isTypeSupported() { return true; } });
    expect(getExportMode()).toBe("realtime");
  });
});

describe("createFfmpegSpectrumPayload", () => {
  it("sends the original compact analysis so the shared renderer applies settings", () => {
    const analysis = {
      duration: 0.1,
      frameRate: 12,
      bands: 2,
      frames: new Uint8Array([64, 192, 64, 192]),
      peaks: new Uint8Array([0, 0]),
    };
    const payload = createFfmpegSpectrumPayload(
      analysis,
      {
        style: "bars",
        color: "#ffffff",
        secondaryColor: "#ffffff",
        opacity: 0.92,
        amplitude: 0.7,
        cutoff: 0.5,
        smoothing: 0,
        thickness: 0.41,
        glow: 0.3,
        background: "chroma",
      },
      { width: 1920, height: 1080, fps: 30, quality: "standard" },
    );

    expect(payload.frameCount).toBe(3);
    expect(payload.analysisFrameCount).toBe(2);
    expect(payload.bytes).toBe(analysis.frames);
  });
});
