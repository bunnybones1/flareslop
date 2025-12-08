import { defineConfig } from "vite";
import fs from "node:fs";

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    port: 5173,
    open: true,
    // Use local HTTPS only when the cert files exist (e.g., local dev). CI/production builds skip this.
    https:
      fs.existsSync("localhost-key.pem") && fs.existsSync("localhost.pem")
        ? {
            key: fs.readFileSync("localhost-key.pem"),
            cert: fs.readFileSync("localhost.pem"),
          }
        : undefined,
    proxy: {
      "/voice": {
        target: "https://192.168.50.4:8787",
        changeOrigin: true,
        secure: true, // self-signed cert for local dev
        xfwd: true,
        rewrite: (path) => path.replace(/^\/voice/, ""),
      },
      "/cell": {
        target: "wss://192.168.50.4:8787",
        ws: true,
        changeOrigin: true,
        secure: true,
        xfwd: true,
      },
    },
  },
});
