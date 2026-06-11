import type { VisualizerSettings } from "./types";

export interface RenderOptions {
  width: number;
  height: number;
  time?: number;
  preparedSpectrum?: Float32Array;
}

export function renderVisualizer(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  spectrum: ArrayLike<number>,
  settings: VisualizerSettings,
  options: RenderOptions,
) {
  const { width, height, time = 0 } = options;
  context.save();
  context.clearRect(0, 0, width, height);
  drawBackground(context, settings.background, width, height);

  const values = prepareSpectrumInto(
    spectrum,
    settings.cutoff,
    settings.amplitude,
    settings.smoothing,
    options.preparedSpectrum,
  );
  context.globalAlpha = settings.opacity;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowBlur = Math.round(settings.glow * Math.min(width, height) * 0.045);
  context.shadowColor = settings.color;
  context.strokeStyle = createGradient(context, settings, width, height);
  context.fillStyle = createGradient(context, settings, width, height);

  switch (settings.style) {
    case "mirror": drawMirror(context, values, settings, width, height); break;
    case "line": drawLine(context, values, settings, width, height); break;
    case "radial": drawRadial(context, values, settings, width, height, time); break;
    case "dots": drawDots(context, values, settings, width, height); break;
    case "wave": drawWave(context, values, settings, width, height); break;
    default: drawBars(context, values, settings, width, height);
  }
  context.restore();
}

export function prepareSpectrum(source: ArrayLike<number>, cutoff: number, amplitude: number, smoothing: number) {
  const output = new Float32Array(source.length);
  return prepareSpectrumInto(source, cutoff, amplitude, smoothing, output);
}

export function prepareSpectrumInto(
  source: ArrayLike<number>,
  cutoff: number,
  amplitude: number,
  smoothing: number,
  target?: Float32Array,
) {
  const output = target?.length === source.length ? target : new Float32Array(source.length);
  const threshold = Math.min(0.95, Math.max(0, cutoff));
  for (let index = 0; index < source.length; index += 1) {
    const raw = Math.max(0, Number(source[index]) || 0);
    output[index] = Math.min(1, Math.max(0, (raw - threshold) / (1 - threshold)) * amplitude);
  }
  const passes = Math.round(Math.max(0, Math.min(1, smoothing)) * 4);
  for (let pass = 0; pass < passes; pass += 1) {
    for (let index = 1; index < output.length - 1; index += 1) {
      output[index] = output[index] * 0.58 + (output[index - 1] + output[index + 1]) * 0.21;
    }
  }
  return output;
}

function drawBackground(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, mode: VisualizerSettings["background"], width: number, height: number) {
  context.fillStyle = mode === "chroma" ? "#00ff00" : "#000000";
  context.fillRect(0, 0, width, height);
}

function createGradient(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, settings: VisualizerSettings, width: number, height: number) {
  const gradient = context.createLinearGradient(width * 0.1, height * 0.5, width * 0.9, height * 0.5);
  gradient.addColorStop(0, settings.color);
  gradient.addColorStop(0.5, settings.secondaryColor);
  gradient.addColorStop(1, settings.color);
  return gradient;
}

function drawBars(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, values: Float32Array, settings: VisualizerSettings, width: number, height: number) {
  const span = width * 0.82;
  const startX = (width - span) / 2;
  const baseline = height * 0.72;
  const maxHeight = height * 0.46;
  const slot = span / values.length;
  const barWidth = Math.max(1, slot * settings.thickness);
  for (let index = 0; index < values.length; index += 1) {
    const barHeight = Math.max(barWidth, values[index] * maxHeight);
    roundRect(context, startX + index * slot + (slot - barWidth) / 2, baseline - barHeight, barWidth, barHeight, barWidth / 2);
    context.fill();
  }
}

function drawMirror(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, values: Float32Array, settings: VisualizerSettings, width: number, height: number) {
  const span = width * 0.82;
  const startX = (width - span) / 2;
  const baseline = height / 2;
  const maxHeight = height * 0.34;
  const slot = span / values.length;
  const barWidth = Math.max(1, slot * settings.thickness);
  for (let index = 0; index < values.length; index += 1) {
    const barHeight = Math.max(barWidth, values[index] * maxHeight);
    roundRect(context, startX + index * slot + (slot - barWidth) / 2, baseline - barHeight, barWidth, barHeight * 2, barWidth / 2);
    context.fill();
  }
}

function drawLine(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, values: Float32Array, settings: VisualizerSettings, width: number, height: number) {
  const span = width * 0.82;
  const startX = (width - span) / 2;
  const baseline = height * 0.68;
  const maxHeight = height * 0.44;
  context.lineWidth = Math.max(1.5, settings.thickness * height * 0.009);
  context.beginPath();
  for (let index = 0; index < values.length; index += 1) {
    const x = startX + (index / Math.max(1, values.length - 1)) * span;
    const y = baseline - values[index] * maxHeight;
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  }
  context.stroke();
}

function drawRadial(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, values: Float32Array, settings: VisualizerSettings, width: number, height: number, time: number) {
  const centerX = width / 2;
  const centerY = height / 2;
  const innerRadius = Math.min(width, height) * 0.16;
  const maxLength = Math.min(width, height) * 0.23;
  context.lineWidth = Math.max(1, settings.thickness * Math.min(width, height) * 0.007);
  for (let index = 0; index < values.length; index += 1) {
    const angle = (index / values.length) * Math.PI * 2 - Math.PI / 2 + Math.sin(time * 0.2) * 0.02;
    const length = Math.max(context.lineWidth, values[index] * maxLength);
    context.beginPath();
    context.moveTo(centerX + Math.cos(angle) * innerRadius, centerY + Math.sin(angle) * innerRadius);
    context.lineTo(centerX + Math.cos(angle) * (innerRadius + length), centerY + Math.sin(angle) * (innerRadius + length));
    context.stroke();
  }
}

function drawDots(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, values: Float32Array, settings: VisualizerSettings, width: number, height: number) {
  const span = width * 0.82;
  const startX = (width - span) / 2;
  const baseline = height * 0.72;
  const maxHeight = height * 0.45;
  const slot = span / values.length;
  const radius = Math.max(1.2, slot * settings.thickness * 0.28);
  for (let index = 0; index < values.length; index += 1) {
    const levels = Math.max(1, Math.round(values[index] * 8));
    for (let level = 0; level < levels; level += 1) {
      const x = startX + index * slot + slot / 2;
      const y = baseline - (level / 8) * maxHeight;
      context.globalAlpha = settings.opacity * (0.4 + (level / levels) * 0.6);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
  }
}

function drawWave(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, values: Float32Array, settings: VisualizerSettings, width: number, height: number) {
  const span = width * 0.82;
  const startX = (width - span) / 2;
  const baseline = height / 2;
  const maxHeight = height * 0.3;
  context.beginPath();
  context.moveTo(startX, baseline);
  for (let index = 0; index < values.length; index += 1) {
    const x = startX + (index / Math.max(1, values.length - 1)) * span;
    context.lineTo(x, baseline - values[index] * maxHeight);
  }
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const x = startX + (index / Math.max(1, values.length - 1)) * span;
    context.lineTo(x, baseline + values[index] * maxHeight);
  }
  context.closePath();
  context.globalAlpha = settings.opacity * 0.62;
  context.fill();
  context.globalAlpha = settings.opacity;
  context.lineWidth = Math.max(1, settings.thickness * height * 0.005);
  context.stroke();
}

function roundRect(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}
