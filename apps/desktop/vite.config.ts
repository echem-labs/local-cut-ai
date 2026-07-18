import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { version } from "./package.json";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist" },
  // Settings → About reads the app version straight from package.json —
  // injected at build, no IPC round-trip (review 4 §S6).
  define: { __APP_VERSION__: JSON.stringify(version) },
});
