import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateExportSize, getExportMode } from "./export-video";

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
