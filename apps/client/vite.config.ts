import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const src = fileURLToPath(new URL("./src", import.meta.url));
// Data the Rust core (crates/wad-core) and the UI share: the app catalog and
// the preset desktops.
const coreData = fileURLToPath(new URL("../../crates/wad-core/data", import.meta.url));
// The web portal also serves the page machines sign in with GitHub on
// (src/signin/machine-signin.ts).
const pages = {
  main: fileURLToPath(new URL("./index.html", import.meta.url)),
  ...(process.env.VITE_TARGET === "online" && { machineSignin: fileURLToPath(new URL("./machine-signin.html", import.meta.url)) }),
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Keep Tauri's output visible under `tauri dev`.
  clearScreen: false,
  resolve: {
    alias: {
      "@core-data": coreData,
      "@core": `${src}/core`,
      "@": src,
    },
  },
  // Matches where wadd serves the built app (wadcreator.port), so Firebase
  // auth and CORS behave the same in dev and on the machine.
  build: { rollupOptions: { input: pages } },
  server: { host: "localhost", port: 8081, strictPort: true },
  preview: { host: "localhost", port: 8081, strictPort: true },
  // Rules tests need the emulator: npm run test:rules.
  test: { exclude: [...configDefaults.exclude, "tests/rules/**", "src-tauri/**"], setupFiles: ["src/test-setup.ts"] },
});
