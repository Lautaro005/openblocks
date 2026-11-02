import { Robot, Sparkle } from "@phosphor-icons/react";

const SRC: Record<string, { src: string; mono?: boolean }> = {
  Ollama: { src: "/brands/ollama.png", mono: true },
  "LM Studio": { src: "/brands/lmstudio.png", mono: true },
  "Claude Code": { src: "/brands/anthropic.png", mono: true },
  "Anthropic API": { src: "/brands/anthropic.png", mono: true },
  Codex: { src: "/brands/openai.png", mono: true },
  OpenAI: { src: "/brands/openai.png", mono: true },
  OpenRouter: { src: "/brands/openrouter.svg", mono: true },
  OpenCue: { src: "/brands/opencue.svg" },
  "Gemma (local)": { src: "/brands/gemma.svg" },
  brain: { src: "/brands/brain.png", mono: true },
  lumina: { src: "/brands/lumina.svg" },
  Lumina: { src: "/brands/lumina.svg" },
  workstudio: { src: "/brands/workstudio.svg" },
  opencue: { src: "/brands/opencue.svg" },
};

export function Brand({ name, size = 16 }: { name: string; size?: number }) {
  const b = SRC[name];
  if (!b) return name === "OpenCue" ? <Robot size={size} /> : <Sparkle size={size} />;
  return <img className={`brand ${b.mono ? "mono" : ""}`} src={b.src} width={size} height={size} alt="" draggable={false} />;
}
