export const VISUALIZER_STYLES = [
  { id: "bars", name: "Barras", description: "Columnas limpias y precisas" },
  { id: "mirror", name: "Espejo", description: "Simetría desde el centro" },
  { id: "line", name: "Línea", description: "Trazo continuo y orgánico" },
  { id: "radial", name: "Radial", description: "Espectro circular" },
  { id: "dots", name: "Puntos", description: "Matriz sutil de partículas" },
  { id: "wave", name: "Onda", description: "Cinta suave y minimalista" },
] as const;

export type VisualizerStyle = (typeof VISUALIZER_STYLES)[number]["id"];
export type BackgroundMode = "transparent" | "black" | "chroma";

export interface AudioAnalysis {
  duration: number;
  frameRate: number;
  bands: number;
  frames: Uint8Array;
  peaks: Uint8Array;
}

export interface VisualizerSettings {
  style: VisualizerStyle;
  color: string;
  secondaryColor: string;
  opacity: number;
  amplitude: number;
  cutoff: number;
  smoothing: number;
  thickness: number;
  glow: number;
  background: BackgroundMode;
}

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  quality: "draft" | "standard" | "high";
}

export const DEFAULT_VISUALIZER_SETTINGS: VisualizerSettings = {
  style: "bars",
  color: "#a78bfa",
  secondaryColor: "#67e8f9",
  opacity: 0.92,
  amplitude: 1.1,
  cutoff: 0.08,
  smoothing: 0.42,
  thickness: 0.62,
  glow: 0.3,
  background: "transparent",
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  quality: "standard",
};
