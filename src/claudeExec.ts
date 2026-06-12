import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { PLAN_MODE_DEVELOPER_INSTRUCTIONS } from "./planMode.js";
import type { ClaudeBackend, ClaudeRunEvent, ClaudeRunRequest, SandboxMode } from "./types.js";
import { logger } from "./logger.js";

interface JsonEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  error?: string | { message?: string };
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  tool_name?: string;
  tool_input?: unknown;
}

export class ClaudeExecBackend implements ClaudeBackend {
  private readonly active = new Map<number, ChildProcess>();

  constructor(private readonly claudeBin: string) {}

  async *run(request: ClaudeRunRequest): AsyncIterable<ClaudeRunEvent> {
    const args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      ...permissionArgs(request.sandboxMode),
    ];

    if (request.model) {
      args.push("--model", request.model);
    }
    if (request.planMode) {
      args.push("--permission-mode", "plan");
      args.push("--append-system-prompt", PLAN_MODE_DEVELOPER_INSTRUCTIONS);
    }
    if (request.claudeThreadId) {
      args.push("--resume", request.claudeThreadId);
    }
    args.push(request.prompt);

    const child = spawn(this.claudeBin, args, {
      cwd: request.repoPath,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.active.set(request.bindingId, child);
    let finalMessage = "";
    let stderr = "";

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
      if (stderr.length > 20_000) {
        stderr = stderr.slice(-20_000);
      }
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );

    child.once("error", (error) => {
      logger.error("claude process error", {
        bindingId: request.bindingId,
        error: error.message,
      });
    });

    yield { type: "started", text: `Started Claude in ${request.repoPath}` };

    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let event: JsonEvent;
      try {
        event = JSON.parse(line) as JsonEvent;
      } catch {
        yield { type: "progress", text: line };
        continue;
      }

      const mapped = this.mapEvent(event);
      if (!mapped) {
        continue;
      }

      if (mapped.type === "agent_message") {
        finalMessage = mapped.text;
      } else if (mapped.type === "completed" && mapped.finalMessage) {
        finalMessage = mapped.finalMessage;
      }

      yield mapped;
    }

    const exit = await exitPromise;
    this.active.delete(request.bindingId);

    if (exit.signal) {
      yield { type: "failed", error: `Claude stopped by signal ${exit.signal}` };
      return;
    }

    if (exit.code && exit.code !== 0) {
      yield {
        type: "failed",
        error: stderr.trim() || `Claude exited with code ${exit.code}`,
        exitCode: exit.code,
      };
      return;
    }

    yield { type: "completed", finalMessage };
  }

  async interrupt(bindingId: number): Promise<boolean> {
    const child = this.active.get(bindingId);
    if (!child) {
      return false;
    }

    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else if (child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }

    this.active.delete(bindingId);
    return true;
  }

  private mapEvent(event: JsonEvent): ClaudeRunEvent | null {
    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      return { type: "started", threadId: event.session_id };
    }

    if (event.type === "result") {
      if (event.is_error) {
        return { type: "failed", error: event.result || "Claude run failed." };
      }
      return { type: "completed", finalMessage: event.result ?? "" };
    }

    if (event.type === "error") {
      const error =
        typeof event.error === "string" ? event.error : event.error?.message ?? "Claude error";
      return { type: "failed", error };
    }

    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      const text = event.message.content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trim();
      if (text) {
        return { type: "agent_message", text };
      }

      const toolUse = event.message.content.find((item) => item.type === "tool_use");
      if (toolUse?.name) {
        return { type: "command_started", text: describeToolUse(toolUse.name, toolUse.input) };
      }
    }

    if (event.type === "tool_use" && event.tool_name) {
      return { type: "command_started", text: describeToolUse(event.tool_name, event.tool_input) };
    }

    return null;
  }
}

function permissionArgs(sandboxMode: SandboxMode): string[] {
  if (sandboxMode === "danger-full-access") {
    return ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"];
  }

  if (sandboxMode === "workspace-write") {
    return ["--permission-mode", "acceptEdits"];
  }

  return ["--permission-mode", "dontAsk", "--disallowedTools=Edit,Write,NotebookEdit"];
}

function describeToolUse(name: string, input: unknown): string {
  if (name === "Bash" && input && typeof input === "object") {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string" && command.trim()) {
      return command;
    }
  }

  return `${name}${input ? ` ${JSON.stringify(input)}` : ""}`;
}
