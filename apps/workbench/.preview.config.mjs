import { defineConfig } from "vite";
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 55446,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:55431", changeOrigin: false } },
  },
});
