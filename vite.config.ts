import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Matches where wadd serves the built app (wadcreator.port), so Firebase
  // auth and CORS behave the same in dev and on the machine.
  server: { host: "localhost", port: 8081, strictPort: true },
  preview: { host: "localhost", port: 8081, strictPort: true },
});
