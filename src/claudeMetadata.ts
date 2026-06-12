export interface ClaudeModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
}

export interface ClaudeUsageSnapshot {
  rateLimits: any | null;
  usage: any | null;
}

const CLAUDE_MODELS: ClaudeModelInfo[] = [
  {
    id: "sonnet",
    model: "sonnet",
    displayName: "Claude Sonnet",
    description: "Claude Code's Sonnet alias.",
    isDefault: true,
    hidden: false,
  },
  {
    id: "opus",
    model: "opus",
    displayName: "Claude Opus",
    description: "Claude Code's Opus alias.",
    isDefault: false,
    hidden: false,
  },
  {
    id: "fable",
    model: "fable",
    displayName: "Claude Fable",
    description: "Claude Code's Fable alias.",
    isDefault: false,
    hidden: false,
  },
];

export async function listClaudeModels(_claudeBin: string): Promise<ClaudeModelInfo[]> {
  return CLAUDE_MODELS;
}

export async function readClaudeUsage(_claudeBin: string): Promise<ClaudeUsageSnapshot> {
  return { rateLimits: null, usage: null };
}
