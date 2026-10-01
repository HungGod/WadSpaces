import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "@fontsource-variable/inter";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "./styles/globals.css";
import { initBackend } from "./data";

// Apply the saved theme before the first paint so there's no flash.
try {
  document.documentElement.dataset.theme = localStorage.getItem("ws-theme") || "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}

// The backend (wadd offline, Firebase online) is ready before anything renders.
initBackend().then(async () => {
  const { default: App } = await import("./App");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
});
