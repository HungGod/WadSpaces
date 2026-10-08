// Whether the app runs inside the Tauri shell (the machine app). In a browser
// (the online app, or offline dev against a dev wadd) it's false.
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
