import type { AgentConfig, AgentRuntime } from "./types";

export const RUNTIMES: { value: AgentRuntime; label: string; models: string[] }[] = [
  { value: "claude-code", label: "Claude Code", models: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"] },
  { value: "codex", label: "Codex CLI", models: ["gpt-5-codex", "gpt-5"] },
  { value: "gemini-cli", label: "Gemini CLI", models: ["gemini-3-pro", "gemini-3-flash"] },
  { value: "deepseek", label: "DeepSeek", models: ["deepseek-v4", "deepseek-coder", "deepseek-r2"] },
  { value: "opencode", label: "OpenCode", models: ["claude-sonnet-5", "gpt-5", "deepseek-v4", "qwen3-coder"] },
  { value: "qwen-code", label: "Qwen Code", models: ["qwen3-coder-plus", "qwen3-coder"] },
  { value: "aider", label: "Aider", models: ["claude-sonnet-5", "gpt-5", "local (ollama)"] },
  { value: "lm-studio", label: "LM Studio", models: ["qwen3-coder-30b (local)", "gpt-oss-20b (local)", "llama-4-scout (local)"] },
  { value: "custom", label: "Custom", models: [] },
];

export const PERMISSIONS: { key: keyof AgentConfig["permissions"]; label: string; hint: string }[] = [
  { key: "terminal", label: "Terminal", hint: "Run shell commands" },
  { key: "writeFiles", label: "Write files", hint: "Create and edit files in the wadspace" },
  { key: "installPackages", label: "Install packages", hint: "apt, npm, pip…" },
  { key: "internet", label: "Internet access", hint: "Reach the network outside the container" },
];

export const defaultAgent = (): AgentConfig => ({
  enabled: true,
  runtime: "claude-code",
  model: RUNTIMES[0].models[0],
  prompt: "",
  instructions: "",
  autonomy: "ask",
  permissions: { internet: true, terminal: true, writeFiles: true, installPackages: false },
});

export const runtimeLabel = (a: AgentConfig) => (a.runtime === "custom" ? a.command?.split(" ")[0] || "Custom agent" : RUNTIMES.find((r) => r.value === a.runtime)?.label ?? a.runtime);
