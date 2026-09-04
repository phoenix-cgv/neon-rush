import { defineConfig } from "vite";

// base: "./" is not cosmetic — the game is served from something like
// http://server/~student/neon-rush/, not from a domain root. Any absolute
// path ("/assets/car.glb") 404s there while working perfectly in dev.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
  },
  server: {
    port: 5173,
  },
});
