import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, getRenderChunkFrames, getRenderConcurrency, parseOptions, type FfmpegExportOptions } from "./ffmpeg-export";

const BASE_OPTIONS: FfmpegExportOptions = {
  width: 1280,
  height: 720,
  fps: 30,
  quality: "standard",
  duration: 3.125,
  frames: 94,
  bands: 64,
  analysisFps: 12,
  analysisFrames: 38,
  style: "bars",
  color: "#a78bfa",
  secondaryColor: "#67e8f9",
  opacity: 0.92,
  amplitude: 0.7,
  cutoff: 0,
  smoothing: 0,
  thickness: 0.41,
  glow: 0.3,
};

describe("parseOptions", () => {
  it("accepts all visualizer styles", () => {
    for (const style of ["bars", "mirror", "line", "radial", "dots", "wave"]) {
      expect(parseOptions(`/api/export-ffmpeg?style=${style}`).style).toBe(style);
    }
  });

  it("rejects unknown styles", () => {
    expect(() => parseOptions("/api/export-ffmpeg?style=unknown")).toThrow("no es compatible");
  });

  it("accepts common frame rates and rejects unsupported ones", () => {
    for (const fps of [24, 25, 30, 48, 50, 60]) {
      expect(parseOptions(`/api/export-ffmpeg?style=bars&fps=${fps}`).fps).toBe(fps);
    }
    expect(parseOptions("/api/export-ffmpeg?style=bars&fps=12").fps).toBe(24);
  });

  it("parses analysis and visual settings", () => {
    const options = parseOptions("/api/export-ffmpeg?style=wave&fps=30&duration=3.125&frames=94&bands=64&analysisFps=12&analysisFrames=38&opacity=.92&amplitude=.7&cutoff=.1&smoothing=.4&thickness=.41&glow=.3");
    expect(options).toMatchObject({
      style: "wave",
      duration: 3.125,
      frames: 94,
      bands: 64,
      analysisFps: 12,
      analysisFrames: 38,
      opacity: 0.92,
      amplitude: 0.7,
      cutoff: 0.1,
      smoothing: 0.4,
      thickness: 0.41,
      glow: 0.3,
    });
  });
});

describe("buildFfmpegArgs", () => {
  it("encodes shared canvas frames as H.264", () => {
    const args = buildFfmpegArgs("output.mp4", BASE_OPTIONS);
    const command = args.join(" ");

    expect(args).toContain("output.mp4");
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
    expect(command).toContain("-f rawvideo -pixel_format rgba -video_size 1280x720 -framerate 30 -i pipe:0");
    expect(command).toContain("settb=expr=1/1000000");
    expect(command).toContain("setpts=PTS*0.997340425532");
    expect(command).toContain("setts=duration=33245:time_base=1/1000000:prescale=1");
  });

  it("keeps an exact timeline for hour-long exports", () => {
    const args = buildFfmpegArgs("output.mp4", {
      ...BASE_OPTIONS,
      width: 160,
      height: 90,
      quality: "draft",
      duration: 3_958.204083,
      frames: 118_747,
      analysisFrames: 47_499,
      glow: 0,
    });
    const command = args.join(" ");
    expect(command).toContain("setpts=PTS*0.999992610255");
    expect(command).toContain("setts=duration=33333:time_base=1/1000000:prescale=1");
  });
});

describe("FFmpeg render parallelism", () => {
  it("uses small chunks for 4K frames to cap memory", () => {
    expect(getRenderChunkFrames({ width: 3840, height: 2160 })).toBe(1);
    expect(getRenderChunkFrames({ width: 1280, height: 720 })).toBeGreaterThan(1);
  });

  it("allows forcing sequential rendering from the environment", () => {
    const previous = process.env.SPECTRA_FFMPEG_RENDER_WORKERS;
    process.env.SPECTRA_FFMPEG_RENDER_WORKERS = "1";
    try {
      expect(getRenderConcurrency({ width: 1280, height: 720 })).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.SPECTRA_FFMPEG_RENDER_WORKERS;
      else process.env.SPECTRA_FFMPEG_RENDER_WORKERS = previous;
    }
  });
});
