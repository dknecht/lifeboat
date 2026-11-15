import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web client builds into ../dist, which the Worker serves as static assets.
// `npm run dev:web` serves it with hot reload and forwards API calls to the local Worker.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:1337" } },
});
