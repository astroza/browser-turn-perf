import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("./src/browser", import.meta.url));

export default defineConfig({
  root,
  build: {
    emptyOutDir: true,
    outDir: fileURLToPath(new URL("./dist/browser", import.meta.url)),
    target: "es2022",
  },
});
