import { defineConfig } from "vite";

export default defineConfig({
  // relative base so the site works from any subpath (e.g. GitHub Pages)
  base: "./",
  server: {
    fs: { allow: [".."] },
  },
  build: { outDir: "dist" },
});
