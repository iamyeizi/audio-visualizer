import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, parseOptions } from "./ffmpeg-export";

describe("parseOptions", () => {
  it("accepts YouTube common frame rates", () => {
    expect(parseOptions("/api/export-ffmpeg?fps=24").fps).toBe(24);
    expect(parseOptions("/api/export-ffmpeg?fps=25").fps).toBe(25);
    expect(parseOptions("/api/export-ffmpeg?fps=30").fps).toBe(30);
    expect(parseOptions("/api/export-ffmpeg?fps=48").fps).toBe(48);
    expect(parseOptions("/api/export-ffmpeg?fps=50").fps).toBe(50);
    expect(parseOptions("/api/export-ffmpeg?fps=60").fps).toBe(60);
  });

  it("rejects unsupported frame rates", () => {
    expect(parseOptions("/api/export-ffmpeg?fps=12").fps).toBe(24);
  });

  it("clamps dimensions and sanitizes colors", () => {
    const options = parseOptions("/api/export-ffmpeg?width=99999&height=1&color=%23a78bfa&secondaryColor=bad");
    expect(options.width).toBe(3840);
    expect(options.height).toBe(16);
    expect(options.color).toBe("0xa78bfa");
    expect(options.secondaryColor).toBe("0xffffff");
  });
});

describe("buildFfmpegArgs", () => {
  it("creates an H.264 chroma-key MP4 command", () => {
    const args = buildFfmpegArgs("input.mp3", "output.mp4", {
      width: 1280,
      height: 720,
      fps: 30,
      quality: "standard",
      color: "#a78bfa",
      secondaryColor: "#67e8f9",
    });

    expect(args).toContain("input.mp3");
    expect(args).toContain("output.mp4");
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
    expect(args).toContain("pipe:1");
    expect(args).toContain("-nostats");
    expect(args.join(" ")).toContain("showfreqs=s=1280x720:rate=30");
    expect(args.join(" ")).toContain("drawbox=x=0:y=0:w=iw:h=ih:color=0x00ff00:t=fill");
  });
});
