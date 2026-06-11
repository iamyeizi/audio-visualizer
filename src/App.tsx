import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Check,
  Download,
  FileAudio,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToastViewport, type ToastMessage, type ToastVariant } from "@/components/ui/toast";
import { PreviewCanvas } from "@/components/preview-canvas";
import { analyzeAudioFile } from "@/lib/audio-analysis";
import { exportWithFfmpeg } from "@/lib/export-ffmpeg";
import { estimateExportSize, exportWebM, getExportMode } from "@/lib/export-video";
import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_VISUALIZER_SETTINGS,
  VISUALIZER_STYLES,
  type AudioAnalysis,
  type ExportSettings,
  type VisualizerSettings,
} from "@/lib/types";
import { cn, formatBytes, formatTime } from "@/lib/utils";

const RESOLUTIONS = [
  { value: "1920x1080", label: "Full HD · 1920 × 1080" },
  { value: "1280x720", label: "HD · 1280 × 720" },
  { value: "854x480", label: "SD · 854 × 480" },
  { value: "1080x1920", label: "Vertical · 1080 × 1920" },
  { value: "1080x1080", label: "Cuadrado · 1080 × 1080" },
  { value: "3840x2160", label: "4K · 3840 × 2160" },
];

type ExportEngine = "browser" | "ffmpeg";

export function App() {
  const [file, setFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null);
  const [visualizer, setVisualizer] = useState<VisualizerSettings>(DEFAULT_VISUALIZER_SETTINGS);
  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisPhase, setAnalysisPhase] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportEngine, setExportEngine] = useState<ExportEngine>("browser");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const dragDepthRef = useRef(0);

  const notify = useCallback((variant: ToastVariant, title: string, description?: string) => {
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    setToasts((current) => [...current, { id, variant, title, description }]);
  }, []);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  useEffect(() => {
    if (!isPlaying) return;
    let animationFrame = 0;
    const update = () => {
      const audio = audioRef.current;
      if (audio) setCurrentTime(audio.currentTime);
      animationFrame = requestAnimationFrame(update);
    };
    animationFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationFrame);
  }, [isPlaying]);

  const loadFile = useCallback(async (nextFile: File) => {
    if (!nextFile.type.startsWith("audio/") && !/\.(wav|mp3|m4a|aac|ogg|oga|flac|opus)$/i.test(nextFile.name)) {
      notify("error", "Formato no compatible", "Selecciona un archivo WAV, MP3, M4A, AAC, OGG, OPUS o FLAC.");
      return;
    }
    analysisAbortRef.current?.abort();
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setIsPlaying(false);
    setCurrentTime(0);
    setAnalysis(null);
    setFile(nextFile);
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(nextFile);
    });
    setIsAnalyzing(true);
    setAnalysisProgress(0);
    try {
      const result = await analyzeAudioFile(nextFile, (progress, phase) => {
        setAnalysisProgress(progress * 100);
        setAnalysisPhase(phase);
      }, controller.signal);
      setAnalysis(result);
      setAnalysisProgress(100);
      notify("success", "Audio listo", `${nextFile.name} se analizó completamente en este dispositivo.`);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      notify("error", "No se pudo analizar el audio", caught instanceof Error ? caught.message : undefined);
    } finally {
      if (analysisAbortRef.current === controller) setIsAnalyzing(false);
    }
  }, [notify]);

  const clearFile = () => {
    analysisAbortRef.current?.abort();
    audioRef.current?.pause();
    setIsPlaying(false);
    setFile(null);
    setAnalysis(null);
    setCurrentTime(0);
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !analysis) return;
    if (audio.paused) {
      await audio.play();
      setIsPlaying(true);
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  };

  const seek = (value: number[]) => {
    const audio = audioRef.current;
    if (!audio || !analysis) return;
    audio.currentTime = value[0];
    setCurrentTime(value[0]);
  };

  const beginExport = async () => {
    if (!analysis || !file) return;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setIsExporting(true);
    setExportProgress(0);
    try {
      const baseName = file.name.replace(/\.[^.]+$/, "");
      if (exportEngine === "ffmpeg") {
        await exportWithFfmpeg(file, visualizer, exportSettings, `${baseName}-spectrum-ffmpeg.mp4`, {
          signal: controller.signal,
          onProgress: (progress) => setExportProgress(progress * 100),
        });
        notify("success", "Exportación terminada", `${baseName}-spectrum-ffmpeg.mp4 está listo.`);
        return;
      }

      await exportWebM(analysis, visualizer, exportSettings, `${baseName}-spectrum.webm`, {
        signal: controller.signal,
        onProgress: (progress) => setExportProgress(progress * 100),
        onModeChange: (mode) => {
          if (mode === "realtime") {
            notify(
              "info",
              "Modo compatible activado",
              window.isSecureContext
                ? "WebCodecs no está disponible en este equipo. El video se renderizará en tiempo real."
                : "Esta dirección HTTP no es un contexto seguro. El video se renderizará en tiempo real y el fondo transparente se sustituirá por chroma key.",
            );
          }
        },
      });
      notify("success", "Exportación terminada", `${baseName}-spectrum.webm está listo.`);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") notify("info", "Exportación cancelada");
      else notify("error", "No se pudo exportar el video", caught instanceof Error ? caught.message : undefined);
    } finally {
      setIsExporting(false);
      exportAbortRef.current = null;
    }
  };

  const updateVisualizer = <Key extends keyof VisualizerSettings>(key: Key, value: VisualizerSettings[Key]) => {
    setVisualizer((current) => ({ ...current, [key]: value }));
  };

  const estimatedSize = useMemo(
    () => analysis ? estimateExportSize(exportSettings, analysis.duration) : 0,
    [analysis, exportSettings],
  );
  const exportMode = useMemo(() => getExportMode(), []);

  return (
    <main className="min-h-screen">
      <header className="border-b border-border/70 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-lg shadow-primary/20"><AudioLines className="h-5 w-5" /></div>
            <div><p className="text-sm font-semibold tracking-tight">Spectra Studio</p><p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Audio visualizer</p></div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1500px] gap-5 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="min-w-0 space-y-5">
          {!file ? (
            <Card
              className={cn("glass relative flex min-h-[540px] items-center justify-center overflow-hidden border-dashed transition-all duration-300", isDragging && "scale-[0.995] border-primary bg-primary/10 shadow-2xl shadow-primary/10")}
              onDragEnter={(event) => { event.preventDefault(); dragDepthRef.current += 1; setIsDragging(true); }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
              onDragLeave={() => { dragDepthRef.current -= 1; if (dragDepthRef.current <= 0) { dragDepthRef.current = 0; setIsDragging(false); } }}
              onDrop={(event) => {
                event.preventDefault();
                dragDepthRef.current = 0;
                setIsDragging(false);
                const dropped = event.dataTransfer.files[0];
                if (dropped) void loadFile(dropped);
              }}
            >
              <div className={cn("pointer-events-none absolute inset-3 rounded-xl border border-primary/0 opacity-0 transition-all duration-300", isDragging && "inset-5 border-primary/50 opacity-100")} />
              <div className={cn("pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,hsl(var(--primary)/0.16),transparent_48%)] opacity-0 transition-opacity duration-300", isDragging && "opacity-100")} />
              <CardContent className="flex max-w-xl flex-col items-center px-6 py-16 text-center">
                <div className="relative mb-7">
                  <div className={cn("absolute inset-0 rounded-full bg-primary/25 blur-2xl transition-all", isDragging && "scale-150 bg-primary/40")} />
                  {isDragging && <div className="absolute inset-0 animate-drop-ring rounded-2xl border-2 border-primary" />}
                  <div className={cn("relative flex h-20 w-20 items-center justify-center rounded-2xl border bg-card shadow-2xl transition-colors", isDragging && "animate-drop-float border-primary bg-primary text-primary-foreground")}><Upload className={cn("h-8 w-8 text-primary transition-colors", isDragging && "text-primary-foreground")} /></div>
                </div>
                <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">Convierte tu audio en un espectro listo para video</h1>
                <p className={cn("mt-4 max-w-md text-sm leading-6 text-muted-foreground transition-colors", isDragging && "font-medium text-primary")}>{isDragging ? "Suelta el audio para comenzar" : "Arrastra un WAV, MP3 u otro audio compatible. El archivo se procesa en este dispositivo y nunca se sube."}</p>
                <Button asChild className="mt-7 gap-2 shadow-lg shadow-primary/20">
                  <label className="cursor-pointer"><FileAudio className="h-4 w-4" />Seleccionar audio<input type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.flac,.opus" className="sr-only" onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void loadFile(selected); }} /></label>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card className="glass overflow-hidden">
                <div className="relative aspect-video w-full overflow-hidden bg-[linear-gradient(45deg,#121216_25%,transparent_25%),linear-gradient(-45deg,#121216_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#121216_75%),linear-gradient(-45deg,transparent_75%,#121216_75%)] bg-[length:24px_24px] bg-[position:0_0,0_12px,12px_-12px,-12px_0px]">
                  <PreviewCanvas analysis={analysis} settings={visualizer} time={currentTime} />
                  {isAnalyzing && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background/75 backdrop-blur-sm">
                      <div className="w-72 text-center"><LoaderCircle className="mx-auto mb-4 h-7 w-7 animate-spin text-primary" /><p className="text-sm font-medium">{analysisPhase}</p><Progress value={analysisProgress} className="mt-4" /><p className="mt-2 text-xs text-muted-foreground">{Math.round(analysisProgress)}%</p></div>
                    </div>
                  )}
                </div>
                <div className="border-t p-4">
                  <div className="mb-3 flex items-center gap-3">
                    <Button size="icon" variant="secondary" onClick={() => void togglePlayback()} disabled={!analysis} aria-label={isPlaying ? "Pausar" : "Reproducir"}>{isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}</Button>
                    <span className="w-12 text-right font-mono text-xs text-muted-foreground">{formatTime(currentTime)}</span>
                    <Slider value={[currentTime]} max={analysis?.duration || 1} step={0.01} onValueChange={seek} disabled={!analysis} aria-label="Posición del audio" />
                    <span className="w-12 font-mono text-xs text-muted-foreground">{formatTime(analysis?.duration || 0)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0"><p className="truncate text-sm font-medium">{file.name}</p><p className="text-xs text-muted-foreground">{formatBytes(file.size)}{analysis ? ` · ${formatTime(analysis.duration)}` : ""}</p></div>
                    <Button variant="ghost" size="icon" onClick={clearFile} aria-label="Quitar archivo"><X className="h-4 w-4" /></Button>
                  </div>
                </div>
              </Card>

              <Card className="glass">
                <CardHeader className="pb-4"><CardTitle className="text-sm">Estilo del espectro</CardTitle><CardDescription>Elige una composición. Todos los ajustes se conservan.</CardDescription></CardHeader>
                <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {VISUALIZER_STYLES.map((style) => (
                    <button key={style.id} type="button" onClick={() => updateVisualizer("style", style.id)} className={cn("relative rounded-lg border p-3 text-left transition-colors hover:bg-accent", visualizer.style === style.id && "border-primary bg-primary/5")}>
                      <StyleGlyph styleId={style.id} active={visualizer.style === style.id} />
                      <p className="mt-3 text-xs font-medium">{style.name}</p>
                      {visualizer.style === style.id && <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-primary" />}
                    </button>
                  ))}
                </CardContent>
              </Card>
            </>
          )}
        </section>

        <aside>
          <Card className="glass xl:sticky xl:top-6">
            <Tabs defaultValue="design">
              <CardHeader className="pb-0">
                <TabsList className="grid w-full grid-cols-2"><TabsTrigger value="design">Diseño</TabsTrigger><TabsTrigger value="export">Exportar</TabsTrigger></TabsList>
              </CardHeader>
              <CardContent className="pt-0">
                <TabsContent value="design" className="space-y-5">
                  <ColorControl label="Color principal" value={visualizer.color} onChange={(value) => updateVisualizer("color", value)} />
                  <ColorControl label="Color secundario" value={visualizer.secondaryColor} onChange={(value) => updateVisualizer("secondaryColor", value)} />
                  <Separator />
                  <RangeControl label="Opacidad" value={visualizer.opacity} min={0.05} max={1} step={0.01} display={`${Math.round(visualizer.opacity * 100)}%`} onChange={(value) => updateVisualizer("opacity", value)} />
                  <RangeControl label="Amplitud" value={visualizer.amplitude} min={0.25} max={2.5} step={0.05} display={`${visualizer.amplitude.toFixed(2)}×`} onChange={(value) => updateVisualizer("amplitude", value)} />
                  <RangeControl label="Cut / umbral" value={visualizer.cutoff} min={0} max={0.65} step={0.01} display={`${Math.round(visualizer.cutoff * 100)}%`} onChange={(value) => updateVisualizer("cutoff", value)} />
                  <RangeControl label="Suavizado" value={visualizer.smoothing} min={0} max={1} step={0.01} display={`${Math.round(visualizer.smoothing * 100)}%`} onChange={(value) => updateVisualizer("smoothing", value)} />
                  <RangeControl label="Grosor" value={visualizer.thickness} min={0.15} max={1} step={0.01} display={`${Math.round(visualizer.thickness * 100)}%`} onChange={(value) => updateVisualizer("thickness", value)} />
                  <RangeControl label="Brillo" value={visualizer.glow} min={0} max={1} step={0.01} display={`${Math.round(visualizer.glow * 100)}%`} onChange={(value) => updateVisualizer("glow", value)} />
                  <Button variant="outline" className="w-full gap-2" onClick={() => setVisualizer(DEFAULT_VISUALIZER_SETTINGS)}><RotateCcw className="h-3.5 w-3.5" />Restablecer</Button>
                </TabsContent>

                <TabsContent value="export" className="space-y-5">
                  <div className="space-y-2"><Label>Motor</Label><Select value={exportEngine} onValueChange={(value) => setExportEngine(value as ExportEngine)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="browser">Navegador · WebM</SelectItem><SelectItem value="ffmpeg">FFmpeg · MP4</SelectItem></SelectContent></Select></div>
                  <div className="space-y-2"><Label>Fondo</Label><Select value={visualizer.background} onValueChange={(value) => updateVisualizer("background", value as VisualizerSettings["background"])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="chroma">Verde</SelectItem><SelectItem value="transparent">Transparente</SelectItem><SelectItem value="black">Negro</SelectItem></SelectContent></Select></div>
                  <div className="space-y-2"><Label>Resolución</Label><Select value={`${exportSettings.width}x${exportSettings.height}`} onValueChange={(value) => { const [width, height] = value.split("x").map(Number); setExportSettings((current) => ({ ...current, width, height })); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{RESOLUTIONS.map((resolution) => <SelectItem key={resolution.value} value={resolution.value}>{resolution.label}</SelectItem>)}</SelectContent></Select></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2"><Label>Fotogramas</Label><Select value={String(exportSettings.fps)} onValueChange={(value) => setExportSettings((current) => ({ ...current, fps: Number(value) }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="24">24 fps</SelectItem><SelectItem value="25">25 fps</SelectItem><SelectItem value="30">30 fps</SelectItem><SelectItem value="48">48 fps</SelectItem><SelectItem value="50">50 fps</SelectItem><SelectItem value="60">60 fps</SelectItem></SelectContent></Select></div>
                    <div className="space-y-2"><Label>Calidad</Label><Select value={exportSettings.quality} onValueChange={(value) => setExportSettings((current) => ({ ...current, quality: value as ExportSettings["quality"] }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="draft">Borrador</SelectItem><SelectItem value="standard">Estándar</SelectItem><SelectItem value="high">Alta</SelectItem></SelectContent></Select></div>
                  </div>
                  <div className="rounded-lg border bg-background/40 p-3 text-xs text-muted-foreground"><div className="flex justify-between"><span>Formato</span><span className="text-foreground">{exportEngine === "ffmpeg" ? "MP4 · H.264" : "WebM · VP9"}</span></div><div className="mt-2 flex justify-between"><span>Tamaño estimado</span><span className="text-foreground">{analysis ? `~${formatBytes(estimatedSize)}` : "—"}</span></div></div>
                  {isExporting ? (
                    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4"><div className="flex items-center justify-between text-xs"><span className="font-medium">Renderizando video</span><span>{Math.round(exportProgress)}%</span></div><Progress value={exportProgress} /><Button variant="outline" size="sm" className="w-full" onClick={() => exportAbortRef.current?.abort()}>Cancelar</Button></div>
                  ) : (
                    <Button className="w-full gap-2 shadow-lg shadow-primary/20" disabled={!analysis || isAnalyzing} onClick={() => void beginExport()}><Download className="h-4 w-4" />{exportEngine === "ffmpeg" ? "Exportar MP4 FFmpeg" : "Exportar overlay WebM"}</Button>
                  )}
                </TabsContent>
              </CardContent>
            </Tabs>
          </Card>
        </aside>
      </div>
      {audioUrl && (
        <audio ref={audioRef} src={audioUrl} preload="metadata" aria-label="Audio cargado para la vista previa" onEnded={() => setIsPlaying(false)} onPause={() => setIsPlaying(false)}>
          <track kind="captions" src="data:text/vtt,WEBVTT%0A%0A" srcLang="es" label="Audio sin diálogo" default />
        </audio>
      )}
      <ToastViewport toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
    </main>
  );
}

function RangeControl({ label, value, min, max, step, display, onChange }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (value: number) => void }) {
  return <div className="space-y-2.5"><div className="flex items-center justify-between"><Label>{label}</Label><span className="font-mono text-[10px] text-muted-foreground">{display}</span></div><Slider value={[value]} min={min} max={max} step={step} onValueChange={(next) => onChange(next[0])} aria-label={label} /></div>;
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <div className="flex items-center justify-between"><Label>{label}</Label><label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border bg-background/60 px-2.5 text-xs font-mono"><span className="h-4 w-4 rounded-full border" style={{ backgroundColor: value }} />{value.toUpperCase()}<input type="color" value={value} onChange={(event) => onChange(event.target.value)} className="sr-only" /></label></div>;
}

function StyleGlyph({ styleId, active }: { styleId: string; active: boolean }) {
  const heights = styleId === "radial" ? [3, 5, 8, 5, 3] : styleId === "wave" ? [4, 7, 10, 7, 4] : [3, 6, 10, 8, 5, 7, 4];
  return <div className={cn("flex h-8 items-center justify-center gap-1 rounded bg-background/60 text-muted-foreground", active && "text-primary")}>{heights.map((height, index) => <span key={index} className={cn("w-0.5 rounded-full bg-current", styleId === "dots" && "h-1 w-1 rounded-full")} style={styleId === "dots" ? undefined : { height: `${height * 2}px` }} />)}</div>;
}
