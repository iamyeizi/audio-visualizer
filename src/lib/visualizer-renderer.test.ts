import { describe, expect, it } from "vitest";
import { prepareSpectrum, prepareSpectrumInto } from "./visualizer-renderer";

describe("prepareSpectrum", () => {
  it("applies cutoff and amplitude without exceeding one", () => {
    const result = prepareSpectrum([0.1, 0.5, 1], 0.2, 2, 0);
    expect(Array.from(result)).toEqual([0, 0.75, 1]);
  });

  it("smooths sharp neighboring differences", () => {
    const result = prepareSpectrum([0, 1, 0], 0, 1, 1);
    expect(result[1]).toBeLessThan(1);
    expect(result[1]).toBeGreaterThan(0);
  });

  it("reuses a target buffer when provided", () => {
    const target = new Float32Array(3);
    const result = prepareSpectrumInto([0.1, 0.5, 1], 0.2, 2, 0, target);
    expect(result).toBe(target);
    expect(Array.from(result)).toEqual([0, 0.75, 1]);
  });
});
