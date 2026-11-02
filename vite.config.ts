import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Source lives in web/, the build lands in public/ where @fastify/static serves it.
export default defineConfig({
  root: "web",
  plugins: [vue()],
  build: { outDir: "../public", emptyOutDir: true },
  server: {
    proxy: {
      "/it4788": { target: "http://localhost:3000", ws: true },
      "/health": "http://localhost:3000",
    },
  },
});
