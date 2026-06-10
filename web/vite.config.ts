import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": "http://localhost:4000",
      "/data": "http://localhost:4000",
    },
    fs: { allow: [".."] },
  },
  build: { outDir: "dist" },
});
