import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  server: {
    proxy: { "/api": process.env.EVOLOOP_API_TARGET || "http://127.0.0.1:4318" },
  },
});
