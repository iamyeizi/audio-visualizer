import { describe, expect, it } from "vitest";
import { estimateExportSize } from "./export-video";

describe("estimateExportSize", () => {
  it("scales with duration", () => {
    const settings = { width: 1920, height: 1080, fps: 30, quality: "standard" as const };
    expect(estimateExportSize(settings, 120)).toBe(estimateExportSize(settings, 60) * 2);
  });
});
