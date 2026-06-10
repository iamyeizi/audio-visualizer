const FFT_SIZE = 512;

self.onmessage = (event: MessageEvent<{ signal: ArrayBuffer; sampleRate: number; fps: number; bands: number }>) => {
  const { sampleRate, fps, bands } = event.data;
  const signal = new Float32Array(event.data.signal);
  const frameCount = Math.max(1, Math.ceil((signal.length / sampleRate) * fps));
  const frames = new Uint8Array(frameCount * bands);
  const peaks = new Uint8Array(frameCount);
  const real = new Float32Array(FFT_SIZE);
  const imaginary = new Float32Array(FFT_SIZE);
  const window = createHannWindow(FFT_SIZE);
  const previous = new Float32Array(bands);
  const binRanges = createLogBinRanges(bands, sampleRate, FFT_SIZE);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const center = Math.floor((frame / fps) * sampleRate);
    let peak = 0;
    for (let index = 0; index < FFT_SIZE; index += 1) {
      const sample = signal[center + index - FFT_SIZE / 2] ?? 0;
      peak = Math.max(peak, Math.abs(sample));
      real[index] = sample * window[index];
      imaginary[index] = 0;
    }
    fft(real, imaginary);

    for (let band = 0; band < bands; band += 1) {
      const [start, end] = binRanges[band];
      let sum = 0;
      for (let bin = start; bin <= end; bin += 1) {
        const magnitude = Math.hypot(real[bin], imaginary[bin]) / (FFT_SIZE / 2);
        sum += magnitude * magnitude;
      }
      const rms = Math.sqrt(sum / Math.max(1, end - start + 1));
      const db = 20 * Math.log10(Math.max(1e-7, rms));
      const normalized = Math.max(0, Math.min(1, (db + 78) / 68));
      const smoothed = normalized > previous[band]
        ? previous[band] * 0.28 + normalized * 0.72
        : previous[band] * 0.76 + normalized * 0.24;
      previous[band] = smoothed;
      frames[frame * bands + band] = Math.round(smoothed * 255);
    }
    peaks[frame] = Math.round(Math.min(1, Math.sqrt(peak)) * 255);
    if (frame % Math.max(1, Math.floor(frameCount / 100)) === 0) {
      self.postMessage({ type: "progress", value: frame / frameCount });
    }
  }

  self.postMessage({ type: "complete", frames: frames.buffer, peaks: peaks.buffer }, [frames.buffer, peaks.buffer]);
};

function createHannWindow(size: number) {
  const window = new Float32Array(size);
  for (let index = 0; index < size; index += 1) window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)));
  return window;
}

function createLogBinRanges(bands: number, sampleRate: number, fftSize: number) {
  const minFrequency = 45;
  const maxFrequency = Math.min(5_800, sampleRate / 2);
  return Array.from({ length: bands }, (_, index) => {
    const low = minFrequency * (maxFrequency / minFrequency) ** (index / bands);
    const high = minFrequency * (maxFrequency / minFrequency) ** ((index + 1) / bands);
    const start = Math.max(1, Math.floor((low * fftSize) / sampleRate));
    const end = Math.max(start, Math.min(fftSize / 2 - 1, Math.ceil((high * fftSize) / sampleRate)));
    return [start, end] as const;
  });
}

function fft(real: Float32Array, imaginary: Float32Array) {
  const size = real.length;
  let target = 0;
  for (let index = 1; index < size; index += 1) {
    let bit = size >> 1;
    while (target & bit) {
      target ^= bit;
      bit >>= 1;
    }
    target ^= bit;
    if (index < target) {
      [real[index], real[target]] = [real[target], real[index]];
      [imaginary[index], imaginary[target]] = [imaginary[target], imaginary[index]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const wLengthReal = Math.cos(angle);
    const wLengthImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let wReal = 1;
      let wImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * wReal - imaginary[odd] * wImaginary;
        const oddImaginary = real[odd] * wImaginary + imaginary[odd] * wReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = wReal * wLengthReal - wImaginary * wLengthImaginary;
        wImaginary = wReal * wLengthImaginary + wImaginary * wLengthReal;
        wReal = nextReal;
      }
    }
  }
}

export {};
