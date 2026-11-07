import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin({ exclude: ["@solo/shared"] })], build: { rollupOptions: { input: resolve("src/main/index.ts") } } },
  preload: { plugins: [externalizeDepsPlugin({ exclude: ["@solo/shared"] })], build: { rollupOptions: { input: resolve("src/preload/index.ts") } } },
  renderer: { root: "src/renderer", plugins: [react()], build: { assetsInlineLimit: 0, rollupOptions: { input: resolve("src/renderer/index.html") } } },
});
