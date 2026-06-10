import { forwardRef, useCallback, useEffect, useRef } from "react";
import type { AudioAnalysis, VisualizerSettings } from "@/lib/types";
import { fillSpectrumFrame } from "@/lib/audio-analysis";
import { renderVisualizer } from "@/lib/visualizer-renderer";

interface PreviewCanvasProps {
  analysis: AudioAnalysis | null;
  settings: VisualizerSettings;
  time: number;
}

export const PreviewCanvas = forwardRef<HTMLCanvasElement, PreviewCanvasProps>(({ analysis, settings, time }, forwardedRef) => {
  const localRef = useRef<HTMLCanvasElement | null>(null);
  const draw = useCallback(() => {
    const canvas = localRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const spectrum = analysis ? fillSpectrumFrame(analysis, time, new Float32Array(analysis.bands)) : createDemoSpectrum(64, time);
    renderVisualizer(context, spectrum, settings, { width: bounds.width, height: bounds.height, time });
  }, [analysis, settings, time]);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = localRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => drawRef.current());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    draw();
  }, [draw]);

  return (
    <canvas
      ref={(node) => {
        localRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      className="block h-full w-full"
      aria-label="Vista previa del espectro"
    />
  );
});
PreviewCanvas.displayName = "PreviewCanvas";

function createDemoSpectrum(length: number, time: number) {
  return Float32Array.from({ length }, (_, index) => {
    const shape = Math.sin((index / length) * Math.PI) ** 0.7;
    const motion = 0.42 + Math.sin(index * 0.7 + time * 2) * 0.12 + Math.sin(index * 0.21 - time * 1.3) * 0.1;
    return Math.max(0.06, shape * motion);
  });
}
