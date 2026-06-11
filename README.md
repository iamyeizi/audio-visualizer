# Spectra Studio

Web app client-side para convertir audio en overlays de espectro destinados a editores como CapCut. El audio no se sube a un servidor.

## Funciones

- WAV, MP3, M4A, AAC, OGG, OPUS y FLAC según los codecs disponibles en el navegador.
- Seis estilos: Barras, Espejo, Línea, Radial, Puntos y Onda.
- Color doble, opacidad, amplitud, cut, suavizado, grosor y brillo.
- Preview sincronizado con reproducción y búsqueda.
- Exportación WebM VP9 acelerada, sin audio, a 24/30/60 fps.
- Fondo transparente, negro o verde chroma.
- Resoluciones HD, Full HD, vertical, cuadrada y 4K.
- Escritura directa a disco con File System Access API para no guardar videos largos completos en RAM.

## Desarrollo

Requiere Node.js 22 o superior.

```bash
pnpm install
pnpm dev
```

La app queda disponible en `http://localhost:5173`.

## Verificación

```bash
pnpm test
pnpm build
```

## Docker con Vite y hot reload

```bash
docker compose up --build
```

Abrir `http://localhost:8081`. Los cambios en `src/` se reflejan mediante Vite HMR sin reconstruir la imagen.

## Docker de producción

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

La versión de producción compila los assets y los sirve con Nginx en `http://localhost:8081`.

## Flujo recomendado para CapCut

1. Cargar el audio y esperar a que termine el análisis.
2. Ajustar el diseño observando la vista previa.
3. Exportar con fondo `Transparente` en Chrome o Edge.
4. Si CapCut no reconoce el canal alpha, exportar con `Verde chroma` y aplicar Chroma Key dentro de CapCut.
5. Colocar el overlay desde el segundo 0 del video. La duración exportada coincide con la del audio.

## Consideraciones para audios de una hora

El análisis reduce el audio a 12 kHz y se ejecuta en un Web Worker. La exportación se codifica más rápido que tiempo real cuando el hardware lo permite. El tiempo final depende de resolución, fps, estilo y GPU. Chrome y Edge ofrecen el flujo más completo; otros navegadores pueden reproducir y previsualizar, pero no siempre exponen `VideoEncoder` o guardado directo a disco.

WebCodecs requiere un contexto seguro. `http://localhost:8081` se considera seguro en Chrome. Si se abre la aplicación mediante una IP de red como `http://192.168.x.x:8081`, la app cambia automáticamente a `MediaRecorder`: renderiza en tiempo real y utiliza chroma key cuando se había elegido transparencia.

La exportación WebCodecs genera timestamps absolutos y fija el final del contenedor en la duración decodificada del audio. El fallback `MediaRecorder` depende del reloj real y puede variar unos pocos fotogramas; para sincronización precisa se recomienda abrir la app mediante `localhost`.
