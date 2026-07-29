export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export interface TopicBinding {
  id: number;
  chatId: number;
  messageThreadId: number;
  topicName: string | null;
  repoPath: string;
  claudeThreadId: string | null;
  model: string | null;
  planMode: boolean;
  sandboxMode: SandboxMode;
  approvalPolicy: "never";
  status: string;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: number;
  bindingId: number;
  telegramMessageId: number | null;
  prompt: string;
  planMode: boolean;
  status: RunStatus;
  claudeRunId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  finalMessage: string | null;
  errorMessage: string | null;
}

export interface CronJobRecord {
  id: number;
  chatId: number;
  bindingId: number;
  createdByUserId: number | null;
  cronExpression: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: number | null;
  lastError: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export type WorkItemStatus = "open" | "in_progress" | "blocked" | "done" | "canceled";

export interface WorkItemRecord {
  id: number;
  chatId: number;
  bindingId: number | null;
  createdByUserId: number | null;
  title: string;
  detail: string | null;
  status: WorkItemStatus;
  priority: string;
  evidence: string | null;
  lastRunId: number | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface InterruptedRunRecord extends RunRecord {
  interruptedStatus: Extract<RunStatus, "queued" | "running">;
}

export interface ClaudeRunRequest {
  bindingId: number;
  repoPath: string;
  prompt: string;
  claudeThreadId: string | null;
  model: string | null;
  planMode: boolean;
  sandboxMode: SandboxMode;
  approvalPolicy: "never";
}

export type ClaudeRunEvent =
  | { type: "started"; threadId?: string; text?: string }
  | { type: "progress"; text: string }
  | { type: "command_started"; text: string }
  | { type: "command_completed"; text: string }
  | { type: "file_changed"; text: string }
  | { type: "agent_message"; text: string }
  | { type: "completed"; finalMessage?: string }
  | { type: "failed"; error: string; exitCode?: number };

export interface ClaudeBackend {
  run(request: ClaudeRunRequest): AsyncIterable<ClaudeRunEvent>;
  interrupt(bindingId: number): Promise<boolean>;
  steer?(bindingId: number, prompt: string): Promise<boolean>;
}
