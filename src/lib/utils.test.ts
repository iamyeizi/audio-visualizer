import { describe, expect, it } from "vitest";
import { formatBytes, formatTime } from "./utils";

describe("formatTime", () => {
  it("formats short and long audio durations", () => {
    expect(formatTime(65.9)).toBe("01:05");
    expect(formatTime(3661)).toBe("1:01:01");
  });
});

describe("formatBytes", () => {
  it("uses readable units", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
  });
});
