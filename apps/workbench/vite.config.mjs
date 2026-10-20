import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  base: "/",
  server: {
    proxy: { "/api": process.env.EVOLOOP_API_TARGET || "http://127.0.0.1:4318" },
  },
});
