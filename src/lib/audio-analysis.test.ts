import { describe, expect, it } from "vitest";
import { fillSpectrumFrame } from "./audio-analysis";
import type { AudioAnalysis } from "./types";

describe("fillSpectrumFrame", () => {
  it("interpolates adjacent analysis frames", () => {
    const analysis: AudioAnalysis = {
      duration: 1,
      frameRate: 2,
      bands: 2,
      frames: Uint8Array.from([0, 100, 200, 255]),
      peaks: Uint8Array.from([0, 255]),
    };
    const result = fillSpectrumFrame(analysis, 0.25, new Float32Array(2));
    expect(result[0]).toBeCloseTo(100 / 255, 4);
    expect(result[1]).toBeCloseTo(177.5 / 255, 4);
  });

  it("clamps time to the available range", () => {
    const analysis: AudioAnalysis = {
      duration: 1,
      frameRate: 1,
      bands: 1,
      frames: Uint8Array.from([128]),
      peaks: Uint8Array.from([128]),
    };
    expect(fillSpectrumFrame(analysis, 99, new Float32Array(1))[0]).toBeCloseTo(128 / 255);
  });
});
