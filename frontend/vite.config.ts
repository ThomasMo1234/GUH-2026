import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies /api and /ws to FastAPI, so the browser only ever talks to ONE origin.
// That is what makes a single tunnel URL (cloudflared / ngrok) work for phones.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true, // let tunnel hostnames through
    proxy: {
      "/api": "http://localhost:8000",
      "/ws": { target: "ws://localhost:8000", ws: true },
    },
  },
});
