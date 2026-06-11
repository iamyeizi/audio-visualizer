import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { loadEnv } from "vite";

const getAllowedHosts = (value: string | undefined) =>
  value
    ?.split(",")
    .map((host) => host.trim())
    .filter(Boolean) ?? [];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const allowedHosts = getAllowedHosts(process.env.SPECTRA_ALLOWED_HOSTS ?? env.SPECTRA_ALLOWED_HOSTS);

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
      watch: {
        usePolling: process.env.CHOKIDAR_USEPOLLING === "true",
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
    },
  };
});
