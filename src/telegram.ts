import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bot, InputFile, type Context } from "grammy";
import type { AppConfig } from "./config.js";
import type {
  ClaudeBackend,
  ClaudeRunEvent,
  CronJobRecord,
  InterruptedRunRecord,
  RunRecord,
  SandboxMode,
  TopicBinding,
  WorkItemRecord,
  WorkItemStatus,
} from "./types.js";
import { Storage } from "./storage.js";
import { RunQueue } from "./runQueue.js";
import { resolveAllowedRepoPath } from "./pathPolicy.js";
import { codeBlock, markdownV2Chunks, truncateText } from "./text.js";
import { commitAll, currentBranch, diffSummary, fullDiff, isGitRepository, pushHead, statusShort } from "./git.js";
import { listClaudeModels, readClaudeUsage } from "./claudeMetadata.js";
import { logger } from "./logger.js";
import { TelegramSendQueue } from "./telegramSendQueue.js";
import type { BridgeRequest, BridgeResult } from "./health.js";
import { nextCronRunAfter, validateCronExpression } from "./cron.js";
import {
  saveTelegramFileToContext,
  saveTranscriptForAudio,
  transcribeStoredAudio,
  type StoredContextFile,
  type TelegramFileRef,
} from "./telegramMedia.js";

interface TopicRef {
  chatId: number;
  messageThreadId: number;
}

interface SendOptions {
  notify?: boolean;
  replyToMessageId?: number | null;
}

interface TelegramFileLike {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

interface TelegramPhotoLike extends TelegramFileLike {
  width?: number;
  height?: number;
}

interface TelegramMessageWithFiles {
  message_id?: number;
  caption?: string;
  photo?: TelegramPhotoLike[];
  document?: TelegramFileLike;
  audio?: TelegramFileLike;
  video?: TelegramFileLike;
  animation?: TelegramFileLike;
  video_note?: TelegramFileLike;
  voice?: TelegramFileLike;
  sticker?: TelegramFileLike;
}

interface HandlePromptOptions {
  forceQueue?: boolean;
}

interface CreateTelegramBotOptions {
  recoverRuns?: InterruptedRunRecord[];
  queue?: RunQueue;
}

const sendQueues = new WeakMap<AppConfig, TelegramSendQueue>();
const replyStorages = new WeakMap<AppConfig, Storage>();

export function createTelegramBot(
  config: AppConfig,
  storage: Storage,
  claude: ClaudeBackend,
  options: CreateTelegramBotOptions = {},
): Bot {
  const bot = new Bot(config.telegramBotToken);
  const queue = options.queue ?? new RunQueue(config.maxParallelRuns);
  const sendQueue = sendQueueFor(config);
  replyStorages.set(config, storage);

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!fromId || !chatId) {
      return;
    }

    if (config.allowedTelegramUserIds.size === 0 || config.allowedTelegramChatIds.size === 0) {
      storage.audit({
        telegramUserId: fromId,
        chatId,
        messageThreadId: ctx.message?.message_thread_id ?? null,
        eventType: "bootstrap_setup_message",
        details: { username: ctx.from?.username ?? null },
      });
      await reply(ctx, bootstrapSetupText(ctx, config), config, sendQueue);
      return;
    }

    if (!config.allowedTelegramUserIds.has(fromId)) {
      storage.audit({
        telegramUserId: fromId,
        chatId,
        messageThreadId: ctx.message?.message_thread_id ?? null,
        eventType: "unauthorized_message",
        details: { username: ctx.from?.username ?? null },
      });
      return;
    }

    if (!config.allowedTelegramChatIds.has(chatId)) {
      storage.audit({
        telegramUserId: fromId,
        chatId,
        messageThreadId: ctx.message?.message_thread_id ?? null,
        eventType: "unauthorized_chat",
        details: { username: ctx.from?.username ?? null },
      });
      await reply(
        ctx,
        [
          "This chat is not authorized.",
          "",
          "Add this value to .env, then restart the bot:",
          "",
          codeBlock(`ALLOWED_TELEGRAM_CHAT_IDS=${chatId}`),
        ].join("\n"),
        config,
        sendQueue,
      );
      return;
    }

    const topic = getTopicRef(ctx, config);
    const text = ctx.message && "text" in ctx.message
      ? ctx.message.text
      : ctx.message && "caption" in ctx.message
        ? ctx.message.caption
        : null;
    if (topic && text) {
      storage.addTopicMessage({
        chatId: topic.chatId,
        messageThreadId: topic.messageThreadId,
        telegramMessageId: ctx.message?.message_id ?? null,
        direction: "in",
        authorId: fromId,
        authorName: formatTelegramUser(ctx.from),
        text,
      });
      logger.info("telegram inbound text accepted", {
        chatId: topic.chatId,
        messageThreadId: topic.messageThreadId,
        telegramMessageId: ctx.message?.message_id ?? null,
        fromId,
        textLength: text.length,
        isCommand: text.trimStart().startsWith("/"),
      });
    }

    await next();
  });

  bot.command("help", async (ctx) => {
    await reply(ctx, helpText(), config, sendQueue);
  });

  bot.command("bind", async (ctx) => {
    const topic = getTopicRef(ctx, config);
    if (!topic) {
      await reply(ctx, "This chat has no topic id. Use this command inside a Telegram forum topic.", config);
      return;
    }

    const requestedPath = ctx.match.trim();
    if (!requestedPath) {
      await reply(ctx, "Usage: /bind /absolute/path or /bind ~/path", config);
      return;
    }

    try {
      const repoPath = await resolveAllowedRepoPath(requestedPath, config.allowedRepoRoots);
      const topicName = topicNameForPath(repoPath);
      const isRepo = await isGitRepository(repoPath);

      const binding = storage.upsertBinding({
        chatId: topic.chatId,
        messageThreadId: topic.messageThreadId,
        topicName,
        repoPath,
        createdByUserId: ctx.from?.id ?? 0,
        sandboxMode: effectiveSandboxMode(config, config.defaultSandboxMode),
      });
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: topic.chatId,
        messageThreadId: topic.messageThreadId,
        eventType: "bind",
        details: { repoPath },
      });

      const branch = isRepo ? await currentBranch(repoPath) : "(not a git repository)";
      const renameResult = await renameForumTopicForBinding(ctx, binding, topicName);
      await reply(
        ctx,
        [
          `Bound this topic to:`,
          codeBlock(binding.repoPath),
          "",
          `Branch:\n${codeBlock(branch)}`,
          `Model:\n${codeBlock(await modelLabel(config, binding))}`,
          `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
          `Mode:\n${codeBlock(effectiveSandboxMode(config, binding.sandboxMode))}`,
          isRepo ? null : "Git commands are unavailable until this path is initialized as a repo.",
          renameResult,
        ]
          .filter(Boolean)
          .join("\n"),
        config,
      );
    } catch (error) {
      await reply(ctx, error instanceof Error ? error.message : String(error), config);
    }
  });

  bot.command("create", async (ctx) => {
    const topic = getTopicRef(ctx, config);
    if (!topic) {
      await reply(ctx, "Use /create from topic 0. Enable ALLOW_UNTHREADED_CHATS for the general topic.", config);
      return;
    }
    if (topic.messageThreadId !== 0) {
      await reply(ctx, "Use /create only from topic 0 so new workspaces are created from one place.", config);
      return;
    }

    const requestedFolder = ctx.match.trim();
    if (!requestedFolder) {
      await reply(ctx, "Usage: /create folder-name", config);
      return;
    }

    try {
      const repoPath = resolveNewWorkspacePath(requestedFolder, config.allowedRepoRoots);
      const topicName = topicNameForPath(repoPath);
      const directoryState = await ensureWorkspaceDirectory(repoPath);

      const createdTopic = await ctx.api.createForumTopic(topic.chatId, topicName);
      const binding = storage.upsertBinding({
        chatId: topic.chatId,
        messageThreadId: createdTopic.message_thread_id,
        topicName,
        repoPath,
        createdByUserId: ctx.from?.id ?? 0,
        sandboxMode: effectiveSandboxMode(config, config.defaultSandboxMode),
      });

      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: topic.chatId,
        messageThreadId: createdTopic.message_thread_id,
        eventType: "create_workspace_topic",
        details: { repoPath, topicName },
      });

      await reply(
        ctx,
        [
          "Created folder and topic:",
          codeBlock(repoPath),
          "",
          directoryState === "existed" ? "Folder already existed; topic and binding were created." : null,
          `Topic: ${topicName}`,
          `message_thread_id: ${createdTopic.message_thread_id}`,
        ]
          .filter(Boolean)
          .join("\n"),
        config,
      );
      await sendText(
        bot,
        config,
        binding,
        [
          "This topic is ready.",
          "",
          directoryState === "existed" ? "Bound existing folder:" : "Bound new folder:",
          codeBlock(repoPath),
          "",
          "Send a normal message here to start working in this folder.",
        ].join("\n"),
        { notify: true },
      );
    } catch (error) {
      await reply(ctx, `Could not create workspace topic:\n${codeBlock(errorMessage(error))}`, config);
    }
  });

  bot.command("where", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }

    const isRepo = await isGitRepository(binding.repoPath);
    const branch = isRepo ? await currentBranch(binding.repoPath) : "(not a git repository)";
    const status = isRepo ? await statusShort(binding.repoPath) : "not a git repository";
    await reply(
      ctx,
      [
        `Repo: ${binding.repoPath}`,
        codeBlock(binding.repoPath),
        `Branch:\n${codeBlock(branch)}`,
        `Model:\n${codeBlock(await modelLabel(config, binding))}`,
        `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
        `Mode:\n${codeBlock(effectiveSandboxMode(config, binding.sandboxMode))}`,
        `Claude session:\n${codeBlock(binding.claudeThreadId ?? "(new)")}`,
        `Status:\n${codeBlock(binding.status)}`,
        "",
        `Git status:\n${codeBlock(status)}`,
      ].join("\n"),
      config,
    );
  });

  bot.command("models", async (ctx) => {
    try {
      const models = await listClaudeModels(config.claudeBin);
      await reply(
        ctx,
        [
          "Common Claude model aliases:",
          codeBlock(
            models
              .map((model) => `${model.model}${model.isDefault ? " (default)" : ""} - ${model.displayName}`)
              .join("\n"),
          ),
          "Set this topic with /model <model>. Full Claude model names are also accepted.",
        ].join("\n"),
        config,
      );
    } catch (error) {
      await reply(ctx, `Could not list models:\n${codeBlock(errorMessage(error))}`, config);
    }
  });

  bot.command("model", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }

    const requestedModel = ctx.match.trim();
    if (!requestedModel) {
      await reply(
        ctx,
        [
          "Current model:",
          codeBlock(await modelLabel(config, binding)),
          "",
          "Use /models to list available models.",
          "Use /model <model> to set this topic.",
          "Use /model default to return to Claude config default.",
        ].join("\n"),
        config,
      );
      return;
    }

    if (requestedModel === "default" || requestedModel === "clear" || requestedModel === "reset") {
      storage.updateBindingModel(binding.id, null);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "model",
        details: { model: null },
      });
      await reply(ctx, `Topic model reset to Claude config default:\n${codeBlock(await globalModelLabel(config, binding.repoPath))}`, config);
      return;
    }

    try {
      storage.updateBindingModel(binding.id, requestedModel);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "model",
        details: { model: requestedModel },
      });
      await reply(
        ctx,
        [`Topic model set to:`, codeBlock(requestedModel), "", "A fresh Claude session will start on the next run."].join("\n"),
        config,
      );
    } catch (error) {
      await reply(ctx, `Could not set model:\n${codeBlock(errorMessage(error))}`, config);
    }
  });

  bot.command("plan", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }

    const requestedState = parsePlanMode(ctx.match.trim());
    if (requestedState === null) {
      await reply(
        ctx,
        [
          `Plan mode is ${formatPlanMode(binding.planMode)}.`,
          "",
          "Usage:",
          codeBlock(["/plan on", "/plan off"].join("\n")),
        ].join("\n"),
        config,
      );
      return;
    }

    storage.updateBindingPlanMode(binding.id, requestedState);
    storage.audit({
      telegramUserId: ctx.from?.id ?? null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "plan_mode",
      details: { planMode: requestedState },
    });
    await reply(
      ctx,
      [
        `Plan mode ${requestedState ? "enabled" : "disabled"}.`,
        "A fresh Claude session will start on the next run.",
      ].join("\n"),
      config,
    );
  });

  bot.command("mode", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }

    const mode = parseMode(ctx.match.trim());
    if (!mode) {
      await reply(ctx, "Usage: /mode read or /mode write", config);
      return;
    }

    storage.updateBindingMode(binding.id, mode);
    storage.audit({
      telegramUserId: ctx.from?.id ?? null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "mode",
      details: { mode },
    });
    await reply(
      ctx,
      config.alwaysYoloMode
        ? `Mode saved as ${mode}, but CLAUDE_ALWAYS_YOLO is enabled. Runs will use danger-full-access.`
        : `Mode set to ${mode}.`,
      config,
    );
  });

  bot.command("topic", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    const topicName = topicNameForPath(binding.repoPath);
    const renameResult = await renameForumTopicForBinding(ctx, binding, topicName);
    await reply(ctx, renameResult || `No forum topic to rename for ${binding.repoPath}.`, config);
  });

  bot.command("new", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    storage.updateBindingThread(binding.id, null);
    storage.audit({
      telegramUserId: ctx.from?.id ?? null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "new_thread",
      details: { bindingId: binding.id },
    });
    await reply(ctx, "Started a fresh Claude session for this topic.", config);
  });

  bot.command("status", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    const active = storage.getActiveRun(binding.id);
    const usage = await readStatusText(config);
    if (!active) {
      await reply(
        ctx,
        [
          `Idle.`,
          `Repo:\n${codeBlock(binding.repoPath)}`,
          `Model:\n${codeBlock(await modelLabel(config, binding))}`,
          `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
          `Mode:\n${codeBlock(effectiveSandboxMode(config, binding.sandboxMode))}`,
          usage,
        ].join("\n"),
        config,
      );
      return;
    }
    await reply(
      ctx,
      [
        `Run #${active.id} is ${active.status}.`,
        `Model:\n${codeBlock(await modelLabel(config, binding))}`,
        `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
        `Prompt:\n${codeBlock(truncateText(active.prompt, 700))}`,
        usage,
      ].join("\n"),
      config,
    );
  });

  bot.command("stop", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }

    const active = storage.getActiveRun(binding.id);
    const interrupted = await claude.interrupt(binding.id);
    if (active) {
      storage.stopRun(active.id);
      storage.updateBindingStatus(binding.id, "idle");
    }
    await reply(ctx, interrupted ? "Stopped active Claude run." : "No active Claude process found.", config);
  });

  bot.command("diff", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    if (!(await ensureGitRepository(ctx, config, binding))) {
      return;
    }
    const summary = await diffSummary(binding.repoPath);
    await reply(ctx, `Diff summary:\n${codeBlock(summary, "diff")}`, config);

    const diff = await fullDiff(binding.repoPath);
    if (diff.length > config.maxTelegramMessageChars) {
      await ctx.api.sendDocument(
        binding.chatId,
        new InputFile(Buffer.from(diff), "diff.patch"),
        { message_thread_id: binding.messageThreadId, disable_notification: true },
      );
    } else if (diff.trim()) {
      await reply(ctx, codeBlock(diff, "diff"), config);
    }
  });

  bot.command("commit", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    if (!(await ensureNoActiveRun(ctx, config, storage, binding))) {
      return;
    }
    if (!(await ensureGitRepository(ctx, config, binding))) {
      return;
    }
    const message = ctx.match.trim();
    if (!message) {
      await reply(ctx, "Usage: /commit Commit message", config);
      return;
    }

    try {
      const output = await commitAll(binding.repoPath, message);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "commit",
        details: { message },
      });
      await reply(ctx, codeBlock(output), config);
    } catch (error) {
      await reply(ctx, `Commit failed:\n${codeBlock(errorMessage(error))}`, config);
    }
  });

  bot.command("push", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    if (!(await ensureNoActiveRun(ctx, config, storage, binding))) {
      return;
    }
    if (!(await ensureGitRepository(ctx, config, binding))) {
      return;
    }

    try {
      const output = await pushHead(binding.repoPath);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "push",
        details: {},
      });
      await reply(ctx, codeBlock(output), config);
    } catch (error) {
      await reply(ctx, `Push failed:\n${codeBlock(errorMessage(error))}`, config);
    }
  });

  bot.command("unbind", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    storage.deleteBinding(binding.id);
    await reply(ctx, "Unbound this topic.", config);
  });

  bot.command("ask", async (ctx) => {
    const text = ctx.match.trim();
    if (!text) {
      await reply(ctx, "Usage: /ask what you want Claude to do", config);
      return;
    }
    await handlePrompt(ctx, config, storage, claude, bot, queue, text);
  });

  bot.command("queue", async (ctx) => {
    const text = ctx.match.trim();
    if (!text) {
      await reply(ctx, "Usage: /queue what Claude should do after the current run", config);
      return;
    }
    await handlePrompt(ctx, config, storage, claude, bot, queue, text, { forceQueue: true });
  });

  bot.command("dashboard", async (ctx) => {
    const topic = getTopicRef(ctx, config);
    if (!topic) {
      await reply(ctx, "Use this inside a Telegram forum topic, or enable ALLOW_UNTHREADED_CHATS.", config);
      return;
    }
    storage.audit({
      telegramUserId: ctx.from?.id ?? null,
      chatId: topic.chatId,
      messageThreadId: topic.messageThreadId,
      eventType: "manager_dashboard",
      details: {},
    });
    await reply(ctx, managerDashboardText(storage, topic.chatId), config);
  });

  bot.command("topics", async (ctx) => {
    const topic = getTopicRef(ctx, config);
    if (!topic) {
      await reply(ctx, "Use this inside a Telegram forum topic, or enable ALLOW_UNTHREADED_CHATS.", config);
      return;
    }
    await reply(ctx, managerTopicsText(storage, topic.chatId), config);
  });

  bot.command("todo", async (ctx) => {
    const topic = getTopicRef(ctx, config);
    if (!topic) {
      await reply(ctx, "Use this inside a Telegram forum topic, or enable ALLOW_UNTHREADED_CHATS.", config);
      return;
    }
    await reply(ctx, managerTodoText(storage, topic.chatId), config);
  });

  bot.command("work", async (ctx) => {
    const topic = getTopicRef(ctx, config);
    if (!topic) {
      await reply(ctx, "Use this inside a Telegram forum topic, or enable ALLOW_UNTHREADED_CHATS.", config);
      return;
    }
    await reply(ctx, workItemsText(storage, topic.chatId, /^all$/i.test(ctx.match.trim())), config);
  });

  bot.command("work_add", async (ctx) => {
    await handleWorkAddCommand(ctx, config, storage, ctx.match.trim());
  });

  bot.command("work_done", async (ctx) => {
    await handleWorkStatusCommand(ctx, config, storage, ctx.match.trim(), "done");
  });

  bot.command("work_blocked", async (ctx) => {
    await handleWorkStatusCommand(ctx, config, storage, ctx.match.trim(), "blocked");
  });

  bot.command("work_cancel", async (ctx) => {
    await handleWorkStatusCommand(ctx, config, storage, ctx.match.trim(), "canceled");
  });

  bot.command("queue_topic", async (ctx) => {
    await handleManagerQueueTopicCommand(ctx, config, storage, claude, bot, queue, ctx.match.trim());
  });

  bot.command("assign", async (ctx) => {
    await handleManagerQueueTopicCommand(ctx, config, storage, claude, bot, queue, ctx.match.trim());
  });

  bot.command("cron", async (ctx) => {
    await handleCronCommand(ctx, config, storage, ctx.match.trim());
  });

  bot.on("message:file", async (ctx) => {
    await handleFileMessage(ctx, config, storage, claude, bot, queue);
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) {
      return;
    }
    await handlePrompt(ctx, config, storage, claude, bot, queue, text);
  });

  bot.catch((error) => {
    logger.error("telegram bot error", {
      error: errorMessage(error.error),
      stack: error.error instanceof Error ? error.error.stack : null,
      updateId: error.ctx.update.update_id,
    });
  });

  if (options.recoverRuns?.length) {
    queueMicrotask(() => {
      void resumeInterruptedRuns(bot, config, storage, claude, queue, options.recoverRuns ?? []);
    });
  }

  return bot;
}

function sendQueueFor(config: AppConfig): TelegramSendQueue {
  const existing = sendQueues.get(config);
  if (existing) {
    return existing;
  }

  const queue = new TelegramSendQueue(config.telegramSendIntervalMs);
  sendQueues.set(config, queue);
  return queue;
}

async function handleFileMessage(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  claude: ClaudeBackend,
  bot: Bot,
  queue: RunQueue,
): Promise<void> {
  const binding = await requireBinding(ctx, config, storage);
  if (!binding) {
    return;
  }

  const instruction = captionInstruction(ctx);
  if (instruction.unsupportedCommand) {
    await reply(ctx, "Send bot commands as text messages. Use a plain caption as the instruction for uploaded files.", config);
    return;
  }

  const fileRefs = extractTelegramFileRefs(ctx);
  if (fileRefs.length === 0) {
    return;
  }

  if (fileRefs.length === 1 && fileRefs[0]?.kind === "voice") {
    await handleVoiceMessage(ctx, config, storage, claude, bot, queue, binding, fileRefs[0]);
    return;
  }

  try {
    const storedFiles: StoredContextFile[] = [];
    for (const fileRef of fileRefs) {
      const storedFile = await saveTelegramFileToContext(
        bot,
        config,
        binding.repoPath,
        fileRef,
        ctx.message?.message_id ?? null,
      );
      storedFiles.push(storedFile);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "telegram_file_saved",
        details: {
          kind: storedFile.kind,
          path: storedFile.relativePath,
          size: storedFile.fileSize,
          mimeType: storedFile.mimeType,
        },
      });
    }

    await reply(ctx, uploadedFilesSavedText(storedFiles), config);
    await handlePrompt(
      ctx,
      config,
      storage,
      claude,
      bot,
      queue,
      uploadedFilesPrompt(storedFiles, instruction.text),
    );
  } catch (error) {
    await reply(ctx, `Could not save Telegram upload:\n${codeBlock(errorMessage(error))}`, config);
  }
}

async function handleVoiceMessage(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  claude: ClaudeBackend,
  bot: Bot,
  queue: RunQueue,
  binding: TopicBinding,
  fileRef: TelegramFileRef,
): Promise<void> {
  try {
    await reply(ctx, "Voice message received. Saving and transcribing it now.", config);
    const storedAudio = await saveTelegramFileToContext(
      bot,
      config,
      binding.repoPath,
      fileRef,
      ctx.message?.message_id ?? null,
    );
    const transcript = await transcribeStoredAudio(config, storedAudio);
    if (!transcript) {
      await reply(ctx, `Saved voice message to ${codeBlock(storedAudio.relativePath)} but transcription was empty.`, config);
      return;
    }

    const storedTranscript = await saveTranscriptForAudio(binding.repoPath, storedAudio, transcript);
    storage.audit({
      telegramUserId: ctx.from?.id ?? null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "telegram_voice_transcribed",
      details: {
        audioPath: storedAudio.relativePath,
        transcriptPath: storedTranscript.relativePath,
        audioSize: storedAudio.fileSize,
        transcriptSize: storedTranscript.fileSize,
      },
    });

    await reply(
      ctx,
      [
        "Voice message transcribed.",
        "",
        "Transcript:",
        codeBlock(transcript.trim()),
      ].join("\n"),
      config,
    );
    await handlePrompt(
      ctx,
      config,
      storage,
      claude,
      bot,
      queue,
      voiceTranscriptPrompt(transcript),
    );
  } catch (error) {
    await reply(ctx, `Could not transcribe Telegram voice message:\n${codeBlock(errorMessage(error))}`, config);
  }
}

async function handleManagerQueueTopicCommand(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  claude: ClaudeBackend,
  bot: Bot,
  queue: RunQueue,
  input: string,
): Promise<void> {
  const topic = getTopicRef(ctx, config);
  if (!topic) {
    await reply(ctx, "Use this inside a Telegram forum topic, or enable ALLOW_UNTHREADED_CHATS.", config);
    return;
  }

  const result = await queueManagerTopicRun({
    storage,
    bot,
    config,
    claude,
    queue,
    managerTopic: topic,
    telegramUserId: ctx.from?.id ?? null,
    input,
    replyToMessageId: null,
  });
  await reply(ctx, result.message, config);
}

export interface QueueManagerTopicRunInput {
  storage: Storage;
  bot: Bot;
  config: AppConfig;
  claude: ClaudeBackend;
  queue: RunQueue;
  managerTopic: TopicRef;
  telegramUserId: number | null;
  input: string;
  replyToMessageId: number | null;
  notify?: boolean;
  source?: string;
}

export interface QueueManagerTopicRunResult {
  ok: boolean;
  message: string;
  runId?: number;
  topicId?: number;
  topicName?: string;
  repoPath?: string;
  queuedBehind?: number;
}

export async function queueManagerTopicRun(input: QueueManagerTopicRunInput): Promise<QueueManagerTopicRunResult> {
  const { storage, bot, config, claude, queue, managerTopic, telegramUserId } = input;
  const request = parseManagerQueueTopicRequest(input.input);
  if (!request) {
    return { ok: false, message: "Usage: /queue_topic <topic-id-or-name> <prompt>" };
  }

  const binding = findManagerTargetBinding(storage, managerTopic.chatId, request.selector);
  if (!binding) {
    return {
      ok: false,
      message: [
        `Could not find managed topic: ${request.selector}`,
        "",
        "Known topics:",
        codeBlock(managerTopicSelectorList(storage, managerTopic.chatId)),
      ].join("\n"),
    };
  }

  const key = topicKey(binding.chatId, binding.messageThreadId);
  const queuedBehind = queue.depth(key);
  let run = storage.createRun(binding.id, null, request.prompt);
  storage.audit({
    telegramUserId,
    chatId: managerTopic.chatId,
    messageThreadId: managerTopic.messageThreadId,
    eventType: "manager_queue_topic",
    details: {
      source: input.source ?? "manager",
      targetMessageThreadId: binding.messageThreadId,
      targetTopicName: topicDisplayName(binding),
      runId: run.id,
      queuedBehind,
    },
  });

  const taskMessageId = await sendText(
    bot,
    config,
    binding,
    [
      `Manager queued run #${run.id}.`,
      "",
      "Prompt:",
      codeBlock(request.prompt),
    ].join("\n"),
    { notify: input.notify ?? true, replyToMessageId: input.replyToMessageId },
  );
  if (taskMessageId !== null) {
    storage.updateRunTelegramMessageId(run.id, taskMessageId);
    run = { ...run, telegramMessageId: taskMessageId };
  }

  queue.enqueue(key, async () => {
    const freshBinding = storage.getBindingById(binding.id);
    if (!freshBinding) {
      storage.failRun(run.id, "topic binding was removed before the manager-queued run started");
      return;
    }
    await executeRun(bot, config, storage, claude, { ...freshBinding, planMode: run.planMode }, run, request.prompt);
  });

  return {
    ok: true,
    message: [
      `Queued run #${run.id} in ${topicDisplayName(binding)}.`,
      `Topic: ${binding.messageThreadId}`,
      queuedBehind > 0 ? `Behind ${queuedBehind} active/queued run(s).` : "It will start when a worker slot is available.",
    ].join("\n"),
    runId: run.id,
    topicId: binding.messageThreadId,
    topicName: topicDisplayName(binding),
    repoPath: binding.repoPath,
    queuedBehind,
  };
}

interface CreateCronInput {
  chatId: number;
  currentMessageThreadId: number;
  telegramUserId: number | null;
  input: string;
}

interface CreateCronResult {
  ok: boolean;
  message: string;
  cronId?: number;
  topicId?: number;
  topicName?: string;
  repoPath?: string;
  nextRunAt?: string;
}

async function handleCronCommand(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  input: string,
): Promise<void> {
  const topic = getTopicRef(ctx, config);
  if (!topic) {
    await reply(ctx, "Use this inside a Telegram forum topic, or enable ALLOW_UNTHREADED_CHATS.", config);
    return;
  }

  const trimmed = input.trim();
  if (!trimmed || /^list$/i.test(trimmed)) {
    await reply(ctx, cronListText(storage, topic.chatId), config);
    return;
  }

  const offMatch = trimmed.match(/^(?:off|disable)\s+#?(\d+)\s*$/i);
  if (offMatch) {
    const cronId = Number.parseInt(offMatch[1] ?? "", 10);
    const changed = storage.setCronJobEnabledForChat(topic.chatId, cronId, false);
    await reply(ctx, changed ? `Disabled cron #${cronId}.` : `Could not find cron #${cronId}.`, config);
    return;
  }

  const result = createCronForTopic(storage, {
    chatId: topic.chatId,
    currentMessageThreadId: topic.messageThreadId,
    telegramUserId: ctx.from?.id ?? null,
    input: trimmed,
  });
  await reply(ctx, result.message, config);
}

function createCronForTopic(storage: Storage, input: CreateCronInput): CreateCronResult {
  const parsed = parseCronCommandInput(storage, input.chatId, input.currentMessageThreadId, input.input);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }

  const nextRunAt = nextCronRunAfter(parsed.cronExpression, new Date()).toISOString();
  const job = storage.createCronJob({
    chatId: input.chatId,
    bindingId: parsed.binding.id,
    createdByUserId: input.telegramUserId,
    cronExpression: parsed.cronExpression,
    prompt: parsed.prompt,
    nextRunAt,
  });
  storage.audit({
    telegramUserId: input.telegramUserId,
    chatId: input.chatId,
    messageThreadId: input.currentMessageThreadId,
    eventType: "cron_created",
    details: {
      cronId: job.id,
      targetMessageThreadId: parsed.binding.messageThreadId,
      cronExpression: parsed.cronExpression,
      nextRunAt,
    },
  });

  return {
    ok: true,
    message: [
      `Created cron #${job.id} for ${topicDisplayName(parsed.binding)}.`,
      `Schedule: ${codeBlock(parsed.cronExpression)}`,
      `Next run: ${codeBlock(nextRunAt)}`,
      "Prompt:",
      codeBlock(parsed.prompt),
    ].join("\n"),
    cronId: job.id,
    topicId: parsed.binding.messageThreadId,
    topicName: topicDisplayName(parsed.binding),
    repoPath: parsed.binding.repoPath,
    nextRunAt,
  };
}

type ParsedCronCommand =
  | { ok: true; binding: TopicBinding; cronExpression: string; prompt: string }
  | { ok: false; message: string };

function parseCronCommandInput(
  storage: Storage,
  chatId: number,
  currentMessageThreadId: number,
  input: string,
): ParsedCronCommand {
  const tokens = input.trim().split(/\s+/);
  if (tokens.length < 6) {
    return {
      ok: false,
      message: [
        "Usage:",
        codeBlock([
          "/cron <minute> <hour> <day> <month> <weekday> <prompt>",
          "/cron <topic-id-or-name> <minute> <hour> <day> <month> <weekday> <prompt>",
          "/cron list",
          "/cron off <id>",
        ].join("\n")),
      ].join("\n"),
    };
  }

  const currentBinding = storage.getBinding(chatId, currentMessageThreadId);
  const currentTopicCron = parseCronAt(tokens, 0);
  if (currentTopicCron && currentBinding) {
    return { ok: true, binding: currentBinding, ...currentTopicCron };
  }

  const selector = tokens[0] ?? "";
  const targetCron = parseCronAt(tokens, 1);
  if (!targetCron) {
    return { ok: false, message: "Could not parse cron expression. Use 5 fields like `0 * * * *`." };
  }

  const binding = findManagerTargetBinding(storage, chatId, selector);
  if (!binding) {
    return {
      ok: false,
      message: [
        `Could not find managed topic: ${selector}`,
        "",
        "Known topics:",
        codeBlock(managerTopicSelectorList(storage, chatId)),
      ].join("\n"),
    };
  }
  return { ok: true, binding, ...targetCron };
}

function parseCronAt(tokens: string[], offset: number): { cronExpression: string; prompt: string } | null {
  if (tokens.length < offset + 6) {
    return null;
  }
  const expression = tokens.slice(offset, offset + 5).join(" ");
  let cronExpression: string;
  try {
    cronExpression = validateCronExpression(expression);
  } catch {
    return null;
  }

  const prompt = tokens.slice(offset + 5).join(" ").trim();
  return prompt ? { cronExpression, prompt } : null;
}

function cronListText(storage: Storage, chatId: number): string {
  const jobs = storage.listCronJobsForChat(chatId);
  if (jobs.length === 0) {
    return "No cron jobs in this chat yet.";
  }

  return [
    "Cron jobs:",
    codeBlock(
      jobs
        .map((job) => {
          const binding = storage.getBindingById(job.bindingId);
          const target = binding ? `${topicDisplayName(binding)} (#${binding.messageThreadId})` : `removed binding ${job.bindingId}`;
          return [
            `#${job.id} ${job.enabled ? "enabled" : "disabled"} ${job.cronExpression}`,
            `  target: ${target}`,
            `  next: ${job.nextRunAt}`,
            `  runs: ${job.runCount}${job.lastRunId ? `, last run #${job.lastRunId}` : ""}`,
            job.lastError ? `  last error: ${job.lastError}` : null,
            `  prompt: ${truncateText(job.prompt, 140)}`,
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n"),
    ),
  ].join("\n");
}

async function handleWorkAddCommand(ctx: Context, config: AppConfig, storage: Storage, input: string): Promise<void> {
  const topic = getTopicRef(ctx, config);
  if (!topic) {
    await reply(ctx, "Use this inside a Telegram forum topic, or enable ALLOW_UNTHREADED_CHATS.", config);
    return;
  }

  const result = createWorkItemForTopic(storage, {
    chatId: topic.chatId,
    currentMessageThreadId: topic.messageThreadId,
    telegramUserId: ctx.from?.id ?? null,
    input,
  });
  await reply(ctx, result.message, config);
}

async function handleWorkStatusCommand(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  input: string,
  status: WorkItemStatus,
): Promise<void> {
  const topic = getTopicRef(ctx, config);
  if (!topic) {
    await reply(ctx, "Use this inside a Telegram forum topic, or enable ALLOW_UNTHREADED_CHATS.", config);
    return;
  }

  const parsed = parseWorkItemIdAndText(input);
  if (!parsed) {
    const command = status === "canceled" ? "cancel" : status === "done" ? "done" : status;
    await reply(ctx, `Usage: /work_${command} <id> <note>`, config);
    return;
  }

  const item = storage.updateWorkItemForChat(topic.chatId, parsed.workItemId, {
    status,
    evidence: parsed.text || null,
  });
  if (!item) {
    await reply(ctx, `Could not find work item #${parsed.workItemId}.`, config);
    return;
  }

  storage.audit({
    telegramUserId: ctx.from?.id ?? null,
    chatId: topic.chatId,
    messageThreadId: topic.messageThreadId,
    eventType: "work_item_status",
    details: { workItemId: item.id, status, evidence: parsed.text || null },
  });
  await reply(ctx, `Updated work item #${item.id} to ${item.status}.`, config);
}

interface CreateWorkItemInput {
  chatId: number;
  currentMessageThreadId: number;
  telegramUserId: number | null;
  input: string;
  selector?: string;
  title?: string;
  detail?: string | null;
  priority?: string | null;
  dueAt?: string | null;
}

interface CreateWorkItemResult {
  ok: boolean;
  message: string;
  workItemId?: number;
  topicId?: number;
  topicName?: string;
  repoPath?: string;
  workItem?: WorkItemRecord;
}

function createWorkItemForTopic(storage: Storage, input: CreateWorkItemInput): CreateWorkItemResult {
  const parsed = parseWorkAddInput(storage, input.chatId, input.currentMessageThreadId, input.input, input.selector, input.title);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }

  const item = storage.createWorkItem({
    chatId: input.chatId,
    bindingId: parsed.binding.id,
    createdByUserId: input.telegramUserId,
    title: parsed.title,
    detail: input.detail ?? null,
    priority: input.priority ?? null,
    dueAt: input.dueAt ?? null,
  });
  storage.audit({
    telegramUserId: input.telegramUserId,
    chatId: input.chatId,
    messageThreadId: input.currentMessageThreadId,
    eventType: "work_item_created",
    details: {
      workItemId: item.id,
      targetMessageThreadId: parsed.binding.messageThreadId,
      title: parsed.title,
    },
  });

  return {
    ok: true,
    message: [
      `Created work item #${item.id} for ${topicDisplayName(parsed.binding)}.`,
      `Status: ${item.status}`,
      `Title: ${item.title}`,
    ].join("\n"),
    workItemId: item.id,
    topicId: parsed.binding.messageThreadId,
    topicName: topicDisplayName(parsed.binding),
    repoPath: parsed.binding.repoPath,
    workItem: item,
  };
}

type ParsedWorkAddInput =
  | { ok: true; binding: TopicBinding; title: string }
  | { ok: false; message: string };

function parseWorkAddInput(
  storage: Storage,
  chatId: number,
  currentMessageThreadId: number,
  input: string,
  explicitSelector?: string,
  explicitTitle?: string,
): ParsedWorkAddInput {
  if (explicitSelector || explicitTitle) {
    const selector = explicitSelector?.trim() ?? "";
    const title = explicitTitle?.trim() ?? "";
    if (!selector || !title) {
      return { ok: false, message: "create_work_item requires topic and title." };
    }
    const binding = findManagerTargetBinding(storage, chatId, selector);
    return binding
      ? { ok: true, binding, title }
      : { ok: false, message: `Could not find managed topic: ${selector}` };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return {
      ok: false,
      message: [
        "Usage:",
        codeBlock(["/work_add <title>", "/work_add <topic-id-or-name> <title>"].join("\n")),
      ].join("\n"),
    };
  }

  const currentBinding = storage.getBinding(chatId, currentMessageThreadId);
  const routed = parseManagerQueueTopicRequest(trimmed);
  if (routed) {
    const target = findManagerTargetBinding(storage, chatId, routed.selector);
    if (target) {
      return { ok: true, binding: target, title: routed.prompt };
    }
  }

  if (currentBinding) {
    return { ok: true, binding: currentBinding, title: trimmed };
  }

  return { ok: false, message: "Use /work_add inside a bound topic or provide a topic selector." };
}

function parseWorkItemIdAndText(input: string): { workItemId: number; text: string } | null {
  const match = input.trim().match(/^#?(\d+)(?:\s+([\s\S]+))?$/);
  if (!match) {
    return null;
  }
  const workItemId = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(workItemId) ? { workItemId, text: (match[2] ?? "").trim() } : null;
}

export async function handleTelegramBridgeRequest(input: {
  storage: Storage;
  bot: Bot;
  config: AppConfig;
  claude: ClaudeBackend;
  queue: RunQueue;
  request: BridgeRequest;
}): Promise<BridgeResult> {
  const { storage, bot, config, claude, queue, request } = input;

  if (request.action === "list_topics") {
    const topics = storage.listBindingsForChat(request.chatId).map((binding) => {
      const active = storage.getActiveRun(binding.id);
      const latest = storage.getLatestRun(binding.id);
      return {
        topicId: binding.messageThreadId,
        topicName: topicDisplayName(binding),
        repoPath: binding.repoPath,
        status: binding.status,
        activeRunId: active?.id ?? null,
        latestRunId: latest?.id ?? null,
        latestRunStatus: latest?.status ?? null,
      };
    });
    return {
      ok: true,
      message: topics.length > 0 ? `Found ${topics.length} bound topic(s).` : "No bound topics found.",
      topics,
    };
  }

  if (request.action === "list_crons") {
    const crons = storage.listCronJobsForChat(request.chatId).map((job) => {
      const binding = storage.getBindingById(job.bindingId);
      return {
        cronId: job.id,
        enabled: job.enabled,
        cron: job.cronExpression,
        prompt: job.prompt,
        nextRunAt: job.nextRunAt,
        lastRunAt: job.lastRunAt,
        lastRunId: job.lastRunId,
        lastError: job.lastError,
        runCount: job.runCount,
        topicId: binding?.messageThreadId ?? null,
        topicName: binding ? topicDisplayName(binding) : null,
        repoPath: binding?.repoPath ?? null,
      };
    });
    return {
      ok: true,
      message: crons.length > 0 ? `Found ${crons.length} cron job(s).` : "No cron jobs found.",
      crons,
    };
  }

  if (request.action === "delete_cron") {
    if (!request.cronId) {
      return { ok: false, message: "delete_cron requires cronId." };
    }
    const changed = storage.setCronJobEnabledForChat(request.chatId, request.cronId, false);
    return {
      ok: changed,
      message: changed ? `Disabled cron #${request.cronId}.` : `Could not find cron #${request.cronId}.`,
    };
  }

  if (request.action === "list_work_items") {
    const workItems = storage.listWorkItemsForChat(request.chatId, {
      includeClosed: request.includeClosed ?? false,
      limit: request.limit ?? 50,
    });
    return {
      ok: true,
      message: workItems.length > 0 ? `Found ${workItems.length} work item(s).` : "No work items found.",
      workItems: workItems.map((item) => formatWorkItemForBridge(storage, item)),
    };
  }

  if (request.action === "create_work_item") {
    const selector = request.selector?.trim() ?? "";
    const title = request.title?.trim() ?? "";
    if (!selector || !title) {
      return { ok: false, message: "create_work_item requires topic and title." };
    }
    return createWorkItemForTopic(storage, {
      chatId: request.chatId,
      currentMessageThreadId: 0,
      telegramUserId: null,
      input: "",
      selector,
      title,
      detail: request.detail?.trim() || null,
      priority: request.priority?.trim() || null,
      dueAt: request.dueAt?.trim() || null,
    });
  }

  if (request.action === "update_work_item" || request.action === "complete_work_item") {
    if (!request.workItemId) {
      return { ok: false, message: `${request.action} requires workItemId.` };
    }
    const status: WorkItemStatus | undefined =
      request.action === "complete_work_item"
        ? "done"
        : request.status
          ? normalizeWorkItemStatus(request.status) ?? undefined
          : undefined;
    if (request.status && !status) {
      return { ok: false, message: "status must be one of open, in_progress, blocked, done, canceled." };
    }
    const update: {
      status?: WorkItemStatus;
      detail?: string | null;
      priority?: string;
      evidence?: string | null;
      dueAt?: string | null;
    } = {};
    if (status) {
      update.status = status;
    }
    if (request.detail !== undefined) {
      update.detail = request.detail;
    }
    if (request.priority !== undefined) {
      update.priority = request.priority;
    }
    if (request.evidence !== undefined) {
      update.evidence = request.evidence;
    }
    if (request.dueAt !== undefined) {
      update.dueAt = request.dueAt;
    }
    const item = storage.updateWorkItemForChat(request.chatId, request.workItemId, update);
    if (!item) {
      return { ok: false, message: `Could not find work item #${request.workItemId}.` };
    }
    return {
      ok: true,
      message: `Updated work item #${item.id} to ${item.status}.`,
      workItemId: item.id,
      workItem: formatWorkItemForBridge(storage, item),
    };
  }

  if (request.action === "create_cron") {
    const selector = request.selector?.trim() ?? "";
    const cron = request.cron?.trim() ?? "";
    const prompt = request.prompt?.trim() ?? "";
    if (!selector || !cron || !prompt) {
      return { ok: false, message: "create_cron requires topic, cron, and prompt." };
    }
    return createCronForTopic(storage, {
      chatId: request.chatId,
      currentMessageThreadId: 0,
      telegramUserId: null,
      input: `${selector} ${cron} ${prompt}`,
    });
  }

  if (request.action === "read_topic_messages") {
    const selector = request.selector?.trim() ?? "";
    if (!selector) {
      return { ok: false, message: "read_topic_messages requires a topic selector." };
    }
    const binding = findManagerTargetBinding(storage, request.chatId, selector);
    if (!binding) {
      return { ok: false, message: `Could not find topic: ${selector}` };
    }

    const messages = storage.listTopicMessages(request.chatId, binding.messageThreadId, request.limit ?? 25);
    return {
      ok: true,
      message:
        messages.length > 0
          ? `Found ${messages.length} stored message(s) for ${topicDisplayName(binding)}.`
          : `No stored messages for ${topicDisplayName(binding)} yet. Only messages observed after this feature was deployed are available.`,
      topicId: binding.messageThreadId,
      topicName: topicDisplayName(binding),
      repoPath: binding.repoPath,
      messages,
    };
  }

  if (request.action === "create_topic") {
    const requestedFolder = request.selector?.trim() ?? "";
    if (!requestedFolder) {
      return { ok: false, message: "create_topic requires a folder name or path." };
    }

    try {
      const repoPath = resolveNewWorkspacePath(requestedFolder, config.allowedRepoRoots);
      const topicName = topicNameForPath(repoPath);
      const directoryState = await ensureWorkspaceDirectory(repoPath);
      const createdTopic = await bot.api.createForumTopic(request.chatId, topicName);
      const binding = storage.upsertBinding({
        chatId: request.chatId,
        messageThreadId: createdTopic.message_thread_id,
        topicName,
        repoPath,
        createdByUserId: 0,
        sandboxMode: effectiveSandboxMode(config, config.defaultSandboxMode),
      });
      storage.audit({
        telegramUserId: null,
        chatId: request.chatId,
        messageThreadId: createdTopic.message_thread_id,
        eventType: "bridge_create_topic",
        details: { repoPath, topicName, directoryState },
      });
      await sendText(bot, config, binding, [`Created topic for:`, codeBlock(repoPath)].join("\n"), {
        notify: false,
      });
      return {
        ok: true,
        message: `${directoryState === "existed" ? "Reused existing folder and c" : "C"}reated topic ${topicName} (#${createdTopic.message_thread_id}).`,
        topicId: createdTopic.message_thread_id,
        topicName,
        repoPath,
      };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }

  const selector = request.selector?.trim() ?? "";
  const prompt = request.prompt?.trim() ?? "";
  if (!selector || !prompt) {
    return { ok: false, message: "queue_topic requires topic and prompt." };
  }

  return queueManagerTopicRun({
    storage,
    bot,
    config,
    claude,
    queue,
    managerTopic: { chatId: request.chatId, messageThreadId: 0 },
    telegramUserId: null,
    input: `${selector} ${prompt}`,
    replyToMessageId: null,
  });
}

interface ManagerQueueTopicRequest {
  selector: string;
  prompt: string;
}

function parseQueueTopicAlias(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const idAlias = trimmed.match(/^#\s*([0-9]+)\s*[:\-]?\s*([\s\S]+)$/);
  if (idAlias) {
    const selector = idAlias[1] ?? "";
    const prompt = (idAlias[2] ?? "").trim();
    return prompt ? `${selector} ${prompt}` : null;
  }

  const quotedAlias = trimmed.match(/^(?:topic|to)\s+"([^"]+)"\s*[:\-]?\s*([\s\S]+)$/i);
  if (quotedAlias) {
    const selector = (quotedAlias[1] ?? "").trim();
    const prompt = (quotedAlias[2] ?? "").trim();
    return prompt ? `"${selector}" ${prompt}` : null;
  }

  const simpleAlias = trimmed.match(/^(?:topic|to)\s+([A-Za-z0-9._-]+)\s*[:\-]?\s*([\s\S]+)$/i);
  if (simpleAlias) {
    const selector = (simpleAlias[1] ?? "").trim();
    const prompt = (simpleAlias[2] ?? "").trim();
    return prompt ? `${selector} ${prompt}` : null;
  }

  return null;
}

function parseManagerQueueTopicRequest(input: string): ManagerQueueTopicRequest | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const quoted = trimmed.match(/^"([^"]+)"\s+([\s\S]+)\s*$/);
  if (quoted) {
    const selector = (quoted[1] ?? "").trim();
    const prompt = (quoted[2] ?? "").trim();
    return prompt ? { selector, prompt } : null;
  }

  const split = trimmed.match(/^(\S+)\s+([\s\S]+)\s*$/);
  if (!split) {
    return null;
  }

  const selector = (split[1] ?? "").trim();
  const prompt = (split[2] ?? "").trim();
  if (!selector || !prompt) {
    return null;
  }

  return { selector, prompt };
}

function parseEmbeddedManagerQueueCommand(text: string): string | null {
  const match = text.match(/(?:^|\s)\/(assign|queue_topic)\s+([\s\S]+)$/i);
  if (!match) {
    return null;
  }

  const extracted = (match[2] ?? "").trim();
  return extracted.length > 0 ? extracted : null;
}

function findManagerTargetBinding(storage: Storage, chatId: number, selector: string): TopicBinding | null {
  const bindings = storage.listBindingsForChat(chatId);
  if (bindings.length === 0) {
    return null;
  }

  const normalizedSelector = selector.trim().toLowerCase();
  const numericMatch = normalizedSelector.match(/^\s*#?(\d+)\s*$/);
  if (numericMatch) {
    const targetThreadId = Number.parseInt(numericMatch[1] ?? "", 10);
    return bindings.find((binding) => binding.messageThreadId === targetThreadId) ?? null;
  }

  const topicNameMatch = bindings.find((binding) =>
    topicDisplayName(binding).toLowerCase() === normalizedSelector,
  );
  if (topicNameMatch) {
    return topicNameMatch;
  }

  const repoNameMatch = bindings.find((binding) =>
    path.basename(binding.repoPath).toLowerCase() === normalizedSelector,
  );
  if (repoNameMatch) {
    return repoNameMatch;
  }

  const startsWithMatches = bindings.filter(
    (binding) =>
      topicDisplayName(binding).toLowerCase().startsWith(normalizedSelector) ||
      path.basename(binding.repoPath).toLowerCase().startsWith(normalizedSelector),
  );
  if (startsWithMatches.length === 1) {
    return startsWithMatches[0] ?? null;
  }

  return null;
}

function managerTopicSelectorList(storage: Storage, chatId: number): string {
  const bindings = storage.listBindingsForChat(chatId);
  if (bindings.length === 0) {
    return "No worker topics are currently bound.";
  }

  return bindings
    .map(
      (binding) =>
        `#${binding.messageThreadId}: ${topicDisplayName(binding)} (${path.basename(binding.repoPath)})`,
    )
    .join("\n");
}


async function handlePrompt(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  claude: ClaudeBackend,
  bot: Bot,
  queue: RunQueue,
  text: string,
  options: HandlePromptOptions = {},
): Promise<void> {
  const binding = await requireBinding(ctx, config, storage);
  if (!binding) {
    return;
  }

  const active = storage.getActiveRun(binding.id);
  if (!options.forceQueue && active && active.status === "running" && claude.steer) {
    try {
      const steered = await claude.steer(binding.id, text);
      if (steered) {
        storage.audit({
          telegramUserId: ctx.from?.id ?? null,
          chatId: binding.chatId,
          messageThreadId: binding.messageThreadId,
          eventType: "run_steered",
          details: { runId: active.id },
        });
        await reply(ctx, `Sent steering note to run #${active.id}.`, config);
        return;
      }
    } catch (error) {
      await reply(ctx, `Could not steer active run; queued as a follow-up.\n${codeBlock(errorMessage(error))}`, config);
    }
  }

  const key = topicKey(binding.chatId, binding.messageThreadId);
  const queuedBehind = queue.depth(key);
  const run = storage.createRun(binding.id, ctx.message?.message_id ?? null, text);

  if (queuedBehind > 0) {
    await reply(ctx, `Queued run #${run.id} behind ${queuedBehind} active/queued run(s).`, config);
  } else {
    await reply(
      ctx,
      [
        `Started run #${run.id}.`,
        `Repo:\n${codeBlock(binding.repoPath)}`,
        `Model:\n${codeBlock(await modelLabel(config, binding))}`,
        `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
        `Mode:\n${codeBlock(effectiveSandboxMode(config, binding.sandboxMode))}`,
      ].join("\n"),
      config,
    );
  }

  queue.enqueue(key, async () => {
    const freshBinding = storage.getBindingById(binding.id);
    if (!freshBinding) {
      storage.failRun(run.id, "topic binding was removed before the run started");
      return;
    }
    await executeRun(bot, config, storage, claude, freshBinding, run, text);
  });
}

export async function resumeInterruptedRuns(
  bot: Bot,
  config: AppConfig,
  storage: Storage,
  claude: ClaudeBackend,
  queue: RunQueue,
  runs: InterruptedRunRecord[],
): Promise<void> {
  for (const run of runs) {
    const binding = storage.getBindingById(run.bindingId);
    if (!binding) {
      storage.failRun(run.id, "topic binding was removed before the service could resume the run");
      continue;
    }

    const key = topicKey(binding.chatId, binding.messageThreadId);
    queue.enqueue(key, async () => {
      const freshBinding = storage.getBindingById(run.bindingId);
      if (!freshBinding) {
        storage.failRun(run.id, "topic binding was removed before the service could resume the run");
        return;
      }

      storage.audit({
        telegramUserId: null,
        chatId: freshBinding.chatId,
        messageThreadId: freshBinding.messageThreadId,
        eventType: "run_resumed_after_restart",
        details: { runId: run.id, repoPath: freshBinding.repoPath },
      });

      try {
        await sendText(
          bot,
          config,
          freshBinding,
          resumeNoticeText(run),
          { notify: true },
        );
      } catch (error) {
        logger.warn("failed to send restart resume notice", {
          runId: run.id,
          chatId: freshBinding.chatId,
          messageThreadId: freshBinding.messageThreadId,
          error: errorMessage(error),
        });
      }
      await executeRun(bot, config, storage, claude, freshBinding, run, resumePromptForRun(run));
    });
  }
}

function resumeNoticeText(run: InterruptedRunRecord): string {
  if (run.interruptedStatus === "running") {
    return [
      `Service restarted while run #${run.id} was running.`,
      "Resuming the saved Claude thread with a continue prompt.",
    ].join("\n");
  }

  return [
    `Service restarted while run #${run.id} was queued.`,
    "Starting the saved prompt now.",
  ].join("\n");
}

function resumePromptForRun(run: InterruptedRunRecord): string {
  if (run.interruptedStatus === "queued") {
    return run.prompt;
  }

  return [
    "The Claude CLI over Telegram service restarted while the previous turn was running.",
    "Continue the interrupted work from the existing thread and current workspace state.",
    "Do not restart from scratch unless that is necessary to recover safely.",
    "",
    "Original saved prompt for reference:",
    run.prompt,
  ].join("\n");
}

const agentMessageBatchMinChars = 600;
const agentMessageBatchMaxChars = 1200;
const agentMessageBatchMaxCount = 4;

async function executeRun(
  bot: Bot,
  config: AppConfig,
  storage: Storage,
  claude: ClaudeBackend,
  binding: TopicBinding,
  run: RunRecord,
  prompt: string,
): Promise<void> {
  let lockAcquired = false;
  let finalMessage = "";
  let lastSentAgentMessage = "";
  const pendingAgentMessages: string[] = [];
  let lastProgressAt = 0;

  const flushAgentMessages = async (options: SendOptions = {}): Promise<void> => {
    const text = pendingAgentMessages.join("\n\n").trim();
    pendingAgentMessages.length = 0;
    if (!text || text === lastSentAgentMessage) {
      return;
    }
    await sendText(bot, config, binding, text, options);
    lastSentAgentMessage = text;
  };

  try {
    const sandboxMode = effectiveSandboxMode(config, binding.sandboxMode);

    if (isWriteSandbox(sandboxMode)) {
      lockAcquired = storage.acquireWriteLock(binding.repoPath, run.id);
      if (!lockAcquired) {
        const lock = storage.getRepoLock(binding.repoPath);
        const message = lock
          ? `Repo is busy. Write lock is held by run #${lock.runId} since ${lock.acquiredAt}.`
          : "Repo is busy.";
        storage.failRun(run.id, message);
        await sendText(bot, config, binding, message);
        return;
      }
    }

    storage.updateRunStarted(run.id);
    storage.updateBindingStatus(binding.id, "running");
    await pinRunMessage(bot, binding, run);
    storage.audit({
      telegramUserId: null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "run_started",
      details: { runId: run.id, repoPath: binding.repoPath, sandboxMode },
    });

    for await (const event of claude.run({
      bindingId: binding.id,
      repoPath: binding.repoPath,
      prompt,
      claudeThreadId: binding.claudeThreadId,
      sandboxMode,
      approvalPolicy: binding.approvalPolicy,
      model: binding.model,
      planMode: binding.planMode,
    })) {
      if (event.type === "started" && event.threadId) {
        storage.updateBindingThread(binding.id, event.threadId);
        storage.updateRunClaudeId(run.id, event.threadId);
        continue;
      }

      if (event.type === "agent_message") {
        finalMessage = event.text;
        const text = event.text.trim();
        if (!text) {
          continue;
        }

        if (text.length >= agentMessageBatchMinChars) {
          await flushAgentMessages();
          if (text !== lastSentAgentMessage) {
            await sendText(bot, config, binding, text);
            lastSentAgentMessage = text;
          }
          continue;
        }

        pendingAgentMessages.push(text);
        const batchText = pendingAgentMessages.join("\n\n");
        if (
          pendingAgentMessages.length >= agentMessageBatchMaxCount ||
          batchText.length >= agentMessageBatchMaxChars
        ) {
          await flushAgentMessages();
        }
        continue;
      }

      if (event.type === "command_started") {
        await flushAgentMessages();
        await sendText(bot, config, binding, codeBlock(truncateText(event.text, 900), "bash"));
        continue;
      }

      if (event.type === "command_completed") {
        await flushAgentMessages();
        if (event.text.trim()) {
          await sendText(bot, config, binding, codeBlock(truncateText(event.text, 1200)));
        }
        continue;
      }

      if (event.type === "file_changed") {
        await flushAgentMessages();
        await sendText(bot, config, binding, `Changed:\n${codeBlock(event.text)}`);
        continue;
      }

      if (event.type === "progress") {
        const nowMs = Date.now();
        if (nowMs - lastProgressAt > 20_000) {
          lastProgressAt = nowMs;
          await sendChatAction(bot, binding);
        }
        continue;
      }

      if (event.type === "failed") {
        await flushAgentMessages();
        storage.failRun(run.id, event.error, event.exitCode ?? null);
        await sendText(
          bot,
          config,
          binding,
          `Run #${run.id} failed:\n${codeBlock(truncateText(event.error, 2500))}`,
          { notify: true },
        );
        return;
      }

      if (event.type === "completed") {
        finalMessage = event.finalMessage || finalMessage;
      }
    }

    const completionMessage = finalMessage || "Claude completed without a final message.";
    storage.completeRun(run.id, completionMessage);
    if (pendingAgentMessages.length > 0 && pendingAgentMessages.at(-1) === completionMessage.trim()) {
      await flushAgentMessages({ notify: true });
    } else {
      await flushAgentMessages();
      await sendText(
        bot,
        config,
        binding,
        completionMessage === lastSentAgentMessage ? "Done." : completionMessage,
        { notify: true },
      );
    }
  } catch (error) {
    const message = errorMessage(error);
    storage.failRun(run.id, message);
    await sendText(bot, config, binding, `Run #${run.id} failed:\n${codeBlock(truncateText(message, 2500))}`, {
      notify: true,
    });
  } finally {
    if (lockAcquired) {
      storage.releaseLock(binding.repoPath, run.id);
    }
    storage.updateBindingStatus(binding.id, "idle");
  }
}

function getTopicRef(ctx: Context, config: AppConfig): TopicRef | null {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return null;
  }

  const messageThreadId = ctx.message?.message_thread_id;
  if (typeof messageThreadId === "number") {
    return { chatId, messageThreadId };
  }

  if (config.allowUnthreadedChats) {
    return { chatId, messageThreadId: 0 };
  }

  return null;
}

async function requireBinding(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
): Promise<TopicBinding | null> {
  const topic = getTopicRef(ctx, config);
  if (!topic) {
    await reply(ctx, "Use this inside a Telegram forum topic, or enable ALLOW_UNTHREADED_CHATS.", config);
    return null;
  }

  const binding = storage.getBinding(topic.chatId, topic.messageThreadId);
  if (!binding) {
    await reply(ctx, "This topic is not bound. Use /bind /absolute/path/to/repo first.", config);
    return null;
  }

  return binding;
}

async function ensureNoActiveRun(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  binding: TopicBinding,
): Promise<boolean> {
  const active = storage.getActiveRun(binding.id);
  if (!active) {
    return true;
  }

  await reply(
    ctx,
    `Run #${active.id} is ${active.status}. Use /status or /stop before git write operations.`,
    config,
  );
  return false;
}

async function ensureGitRepository(
  ctx: Context,
  config: AppConfig,
  binding: TopicBinding,
): Promise<boolean> {
  if (await isGitRepository(binding.repoPath)) {
    return true;
  }

  await reply(
    ctx,
    [
      `This path is not a git repository:`,
      codeBlock(binding.repoPath),
      "",
      "Claude can still work here. Ask it to initialize git if that is what you want:",
      "",
      codeBlock("/ask initialize this directory as a git repository"),
    ].join("\n"),
    config,
  );
  return false;
}

function bootstrapSetupText(ctx: Context, config: AppConfig): string {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const messageThreadId = ctx.message?.message_thread_id;
  const missing = [
    config.allowedTelegramUserIds.size === 0 ? "ALLOWED_TELEGRAM_USER_IDS" : null,
    config.allowedTelegramChatIds.size === 0 ? "ALLOWED_TELEGRAM_CHAT_IDS" : null,
  ].filter(Boolean);

  return [
    "Bot setup is incomplete.",
    "",
    `Missing: ${missing.join(", ")}`,
    "",
    "Add these values to .env, then restart the bot:",
    "",
    codeBlock(
      [
        `ALLOWED_TELEGRAM_USER_IDS=${userId ?? ""}`,
        `ALLOWED_TELEGRAM_CHAT_IDS=${chatId ?? ""}`,
        typeof messageThreadId === "number" ? `# Current topic message_thread_id=${messageThreadId}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
    "For forum groups, the chat ID authorizes the whole group. Topic IDs are discovered per message and do not go in ALLOWED_TELEGRAM_CHAT_IDS.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function reply(
  ctx: Context,
  text: string,
  config: AppConfig,
  sendQueue = sendQueueFor(config),
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }
  const messageThreadId = ctx.message?.message_thread_id;
  for (const chunk of markdownV2Chunks(text, config.maxTelegramMessageChars)) {
    const options =
      typeof messageThreadId === "number"
        ? {
            message_thread_id: messageThreadId,
            link_preview_options: { is_disabled: true },
            parse_mode: "MarkdownV2" as const,
            disable_notification: true,
          }
        : {
            link_preview_options: { is_disabled: true },
            parse_mode: "MarkdownV2" as const,
            disable_notification: true,
          };
    try {
      const message = await sendQueue.sendMessage(ctx.api, chatId, chunk, options);
      replyStorages.get(config)?.addTopicMessage({
        chatId,
        messageThreadId: typeof messageThreadId === "number" ? messageThreadId : 0,
        telegramMessageId: message.message_id,
        direction: "out",
        authorId: ctx.me.id,
        authorName: `@${ctx.me.username} / ${ctx.me.first_name} / ${ctx.me.id}`,
        text,
      });
      logger.info("telegram reply sent", {
        chatId,
        messageThreadId: typeof messageThreadId === "number" ? messageThreadId : null,
        telegramMessageId: message.message_id,
        textLength: chunk.length,
      });
    } catch (error) {
      logger.error("telegram reply failed", {
        chatId,
        messageThreadId: typeof messageThreadId === "number" ? messageThreadId : null,
        error: errorMessage(error),
      });
      throw error;
    }
  }
}

async function sendText(
  bot: Bot,
  config: AppConfig,
  binding: TopicBinding,
  text: string,
  options: SendOptions = {},
): Promise<number | null> {
  const chunks = markdownV2Chunks(text, config.maxTelegramMessageChars);
  let firstMessageId: number | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const message = await sendQueueFor(config).sendMessage(bot.api, binding.chatId, chunk, {
      message_thread_id: binding.messageThreadId,
      link_preview_options: { is_disabled: true },
      parse_mode: "MarkdownV2",
      disable_notification: !(options.notify === true && index === 0),
      ...(options.replyToMessageId ? { reply_parameters: { message_id: options.replyToMessageId } } : {}),
    });
    firstMessageId ??= message.message_id;
  }
  return firstMessageId;
}

async function sendChatAction(bot: Bot, binding: TopicBinding): Promise<void> {
  try {
    await bot.api.sendChatAction(binding.chatId, "typing", {
      message_thread_id: binding.messageThreadId,
    });
  } catch (error) {
    logger.warn("failed to send chat action", { error: errorMessage(error) });
  }
}

async function pinRunMessage(bot: Bot, binding: TopicBinding, run: RunRecord): Promise<void> {
  if (run.telegramMessageId === null) {
    return;
  }

  try {
    await bot.api.pinChatMessage(binding.chatId, run.telegramMessageId, {
      disable_notification: true,
    });
  } catch (error) {
    logger.warn("failed to pin telegram run message", {
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      runId: run.id,
      telegramMessageId: run.telegramMessageId,
      error: errorMessage(error),
    });
  }
}

function parseMode(input: string): SandboxMode | null {
  if (input === "read" || input === "read-only") {
    return "read-only";
  }
  if (input === "write" || input === "workspace-write") {
    return "workspace-write";
  }
  return null;
}

function parsePlanMode(input: string): boolean | null {
  if (["on", "true", "yes", "1", "plan"].includes(input)) {
    return true;
  }
  if (["off", "false", "no", "0", "default"].includes(input)) {
    return false;
  }
  return null;
}

function formatPlanMode(planMode: boolean): string {
  return planMode ? "on" : "off";
}

function effectiveSandboxMode(config: AppConfig, sandboxMode: SandboxMode): SandboxMode {
  return config.alwaysYoloMode ? "danger-full-access" : sandboxMode;
}

function isWriteSandbox(sandboxMode: SandboxMode): boolean {
  return sandboxMode === "workspace-write" || sandboxMode === "danger-full-access";
}

function extractTelegramFileRefs(ctx: Context): TelegramFileRef[] {
  const message = ctx.message as TelegramMessageWithFiles | undefined;
  if (!message) {
    return [];
  }

  const refs: TelegramFileRef[] = [];
  if (message.photo?.length) {
    const photo = [...message.photo].sort((left, right) => {
      const leftPixels = (left.width ?? 0) * (left.height ?? 0);
      const rightPixels = (right.width ?? 0) * (right.height ?? 0);
      return rightPixels - leftPixels;
    })[0];
    if (photo) {
      refs.push(fileRef("photo", photo, "telegram-photo.jpg"));
    }
  }

  pushFileRef(refs, "document", message.document);
  pushFileRef(refs, "audio", message.audio);
  pushFileRef(refs, "video", message.video);
  pushFileRef(refs, "animation", message.animation);
  pushFileRef(refs, "video_note", message.video_note, "telegram-video-note.mp4");
  pushFileRef(refs, "voice", message.voice, "telegram-voice.oga");
  pushFileRef(refs, "sticker", message.sticker, "telegram-sticker.webp");

  return refs;
}

function pushFileRef(
  refs: TelegramFileRef[],
  kind: string,
  value: TelegramFileLike | undefined,
  fallbackName: string | null = null,
): void {
  if (!value) {
    return;
  }
  refs.push(fileRef(kind, value, fallbackName));
}

function fileRef(kind: string, value: TelegramFileLike, fallbackName: string | null): TelegramFileRef {
  return {
    kind,
    fileId: value.file_id,
    fileUniqueId: value.file_unique_id,
    originalName: value.file_name ?? fallbackName,
    mimeType: value.mime_type ?? null,
    fileSize: value.file_size ?? null,
  };
}

function captionInstruction(ctx: Context): { text: string; unsupportedCommand: boolean } {
  const message = ctx.message as TelegramMessageWithFiles | undefined;
  const caption = message?.caption?.trim() ?? "";
  if (!caption) {
    return { text: "", unsupportedCommand: false };
  }

  const askMatch = caption.match(/^\/ask(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (askMatch) {
    return { text: askMatch[1]?.trim() ?? "", unsupportedCommand: false };
  }

  return { text: caption, unsupportedCommand: caption.startsWith("/") };
}

function uploadedFilesSavedText(files: StoredContextFile[]): string {
  return ["Saved Telegram upload to:", codeBlock(files.map((file) => file.relativePath).join("\n"))].join("\n");
}

function uploadedFilesPrompt(files: StoredContextFile[], instruction: string): string {
  const lines = [
    "Telegram uploaded file(s) were saved under this repository's .context folder.",
    "",
    "Saved file(s):",
    files
      .map((file) =>
        [
          `- ${file.relativePath}`,
          `kind=${file.kind}`,
          file.mimeType ? `mime=${file.mimeType}` : null,
          `size=${file.fileSize} bytes`,
          file.originalName ? `original=${file.originalName}` : null,
        ]
          .filter(Boolean)
          .join(" "),
      )
      .join("\n"),
  ];

  if (instruction) {
    lines.push("", "User caption/instructions:", instruction);
  } else {
    lines.push(
      "",
      "No explicit caption/instructions were included. Inspect the saved file(s) if useful, summarize what is available, and ask what the user wants done next if the next action is unclear.",
    );
  }

  lines.push("", "Use these local paths as context. Copy or move files only if the user asked for that.");
  return lines.join("\n");
}

function voiceTranscriptPrompt(transcript: string): string {
  return [
    "A Telegram voice message was transcribed.",
    "",
    "Transcript:",
    "",
    transcript,
  ].join("\n");
}

function managerDashboardText(storage: Storage, chatId: number): string {
  const bindings = storage.listBindingsForChat(chatId);
  const actionable = storage.listActionableRunsForChat(chatId, 12);
  const workItems = storage.listWorkItemsForChat(chatId, { limit: 12 });
  const running = actionable.filter((item) => item.run.status === "running").length;
  const queued = actionable.filter((item) => item.run.status === "queued").length;
  const failed = actionable.filter((item) => item.run.status === "failed").length;

  return [
    "Topic dashboard",
    "",
    "Summary:",
    codeBlock(
      [
        `bound topics: ${bindings.length}`,
        `running: ${running}`,
        `queued: ${queued}`,
        `failed needing review: ${failed}`,
        `open work items: ${workItems.length}`,
      ].join("\n"),
    ),
    "Work items:",
    workItems.length > 0
      ? codeBlock(workItems.map((item) => formatWorkItemLine(storage, item)).join("\n"))
      : codeBlock("none"),
    "",
    "Active work:",
    actionable.length > 0
      ? codeBlock(actionable.map(({ binding, run }) => formatManagerRunLine(binding, run)).join("\n"))
      : codeBlock("none"),
    "",
    "Use /topics for all bindings and /todo for actionable runs.",
  ].join("\n");
}

function managerTopicsText(storage: Storage, chatId: number): string {
  const bindings = storage.listBindingsForChat(chatId);
  if (bindings.length === 0) {
    return "No bound topics in this chat yet. Use /create to create a new topic or /bind inside an existing topic.";
  }

  return [
    "Managed topics:",
    codeBlock(
      bindings
        .map((binding) => {
          const active = storage.getActiveRun(binding.id);
          const latest = storage.getLatestRun(binding.id);
          const runLabel = active
            ? `active #${active.id} ${active.status}`
            : latest
              ? `latest #${latest.id} ${latest.status}`
              : "no runs";
          return [
            `topic ${binding.messageThreadId}: ${topicDisplayName(binding)}`,
            `  status: ${binding.status}; ${runLabel}`,
            `  repo: ${binding.repoPath}`,
          ].join("\n");
        })
        .join("\n\n"),
    ),
  ].join("\n");
}

function managerTodoText(storage: Storage, chatId: number): string {
  const workItems = storage.listWorkItemsForChat(chatId, { limit: 30 });
  const actionable = storage.listActionableRunsForChat(chatId, 20);
  if (workItems.length === 0 && actionable.length === 0) {
    return [
      "Topic todo:",
      codeBlock("No open work items, queued runs, running runs, or failed runs found."),
    ].join("\n");
  }

  const grouped = [
    ["Running", actionable.filter((item) => item.run.status === "running")],
    ["Queued", actionable.filter((item) => item.run.status === "queued")],
    ["Needs review", actionable.filter((item) => item.run.status === "failed")],
  ] as const;

  return [
    "Topic todo:",
    workItems.length > 0
      ? ["", "Work items:", codeBlock(workItems.map((item) => formatWorkItemLine(storage, item)).join("\n"))].join("\n")
      : "",
    ...grouped.flatMap(([label, items]) =>
      items.length > 0
        ? [
            "",
            `${label}:`,
            codeBlock(items.map(({ binding, run }) => formatManagerRunLine(binding, run)).join("\n")),
          ]
        : [],
    ),
  ].join("\n");
}

function workItemsText(storage: Storage, chatId: number, includeClosed: boolean): string {
  const workItems = storage.listWorkItemsForChat(chatId, { includeClosed, limit: 50 });
  if (workItems.length === 0) {
    return includeClosed ? "No work items in this chat yet." : "No open work items in this chat yet.";
  }
  return [
    includeClosed ? "Work items:" : "Open work items:",
    codeBlock(workItems.map((item) => formatWorkItemLine(storage, item)).join("\n")),
  ].join("\n");
}

function formatWorkItemLine(storage: Storage, item: WorkItemRecord): string {
  const binding = item.bindingId ? storage.getBindingById(item.bindingId) : null;
  const target = binding ? topicDisplayName(binding) : "unassigned";
  const due = item.dueAt ? ` due:${item.dueAt}` : "";
  const evidence = item.evidence ? ` - ${oneLine(item.evidence, 70)}` : "";
  return `#${item.id} ${item.status.padEnd(11)} ${item.priority.padEnd(7)} ${target}${due} - ${oneLine(item.title, 90)}${evidence}`;
}

function formatWorkItemForBridge(storage: Storage, item: WorkItemRecord): Record<string, unknown> {
  const binding = item.bindingId ? storage.getBindingById(item.bindingId) : null;
  return {
    workItemId: item.id,
    status: item.status,
    priority: item.priority,
    title: item.title,
    detail: item.detail,
    evidence: item.evidence,
    dueAt: item.dueAt,
    completedAt: item.completedAt,
    updatedAt: item.updatedAt,
    topicId: binding?.messageThreadId ?? null,
    topicName: binding ? topicDisplayName(binding) : null,
    repoPath: binding?.repoPath ?? null,
    lastRunId: item.lastRunId,
  };
}

function normalizeWorkItemStatus(value: string): WorkItemStatus | null {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return normalized === "open" ||
    normalized === "in_progress" ||
    normalized === "blocked" ||
    normalized === "done" ||
    normalized === "canceled"
    ? normalized
    : null;
}

function formatManagerRunLine(binding: TopicBinding, run: RunRecord): string {
  return `#${run.id} ${run.status.padEnd(9)} ${topicDisplayName(binding)} - ${oneLine(run.prompt, 90)}`;
}

function topicDisplayName(binding: TopicBinding): string {
  return binding.topicName || path.basename(binding.repoPath) || `topic ${binding.messageThreadId}`;
}

function oneLine(value: string, maxLength: number): string {
  return truncateText(value.replace(/\s+/g, " ").trim(), maxLength);
}


async function modelLabel(config: AppConfig, binding: TopicBinding): Promise<string> {
  if (binding.model) {
    return `${binding.model} (topic)`;
  }
  return globalModelLabel(config, binding.repoPath);
}

async function globalModelLabel(config: AppConfig, cwd?: string): Promise<string> {
  void config;
  void cwd;
  return "(Claude Code default)";
}

async function readStatusText(config: AppConfig): Promise<string> {
  try {
    const usage = await readClaudeUsage(config.claudeBin);
    return [
      "Account:",
      codeBlock([formatRateLimits(usage.rateLimits), formatTokenUsage(usage.usage)].filter(Boolean).join("\n")),
    ].join("\n");
  } catch (error) {
    return `Account:\n${codeBlock(`unavailable: ${errorMessage(error)}`)}`;
  }
}

function formatRateLimits(response: any): string {
  const snapshot = response?.rateLimits ?? response?.rate_limits ?? response;
  if (!snapshot) {
    return "rate limits unavailable";
  }

  const lines = [
    snapshot.planType || snapshot.plan_type ? `plan: ${snapshot.planType ?? snapshot.plan_type}` : null,
    snapshot.limitName || snapshot.limit_name || snapshot.limitId || snapshot.limit_id
      ? `limit: ${snapshot.limitName ?? snapshot.limit_name ?? snapshot.limitId ?? snapshot.limit_id}`
      : null,
    snapshot.rateLimitReachedType || snapshot.rate_limit_reached_type
      ? `reached: ${snapshot.rateLimitReachedType ?? snapshot.rate_limit_reached_type}`
      : null,
    formatRateLimitWindow("primary", snapshot.primary),
    formatRateLimitWindow("secondary", snapshot.secondary),
    formatCredits(snapshot.credits),
    formatSpendLimit(snapshot.individualLimit ?? snapshot.individual_limit),
  ].filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : "rate limits unavailable";
}

function formatRateLimitWindow(label: string, window: any): string | null {
  if (!window) {
    return null;
  }
  const used = typeof window.usedPercent === "number" ? window.usedPercent : window.used_percent;
  const duration = window.windowDurationMins ?? window.window_duration_mins;
  const resetsAt = typeof window.resetsAt === "number" ? window.resetsAt : window.resets_at;
  const parts = [`${label}: ${formatPercent(used)} used`];
  if (duration) {
    parts.push(`${duration}m window`);
  }
  if (resetsAt) {
    parts.push(`resets ${formatUnixSeconds(resetsAt)}`);
  }
  return parts.join(", ");
}

function formatCredits(credits: any): string | null {
  if (!credits) {
    return null;
  }
  if (credits.unlimited) {
    return "credits: unlimited";
  }
  if (credits.balance !== null && credits.balance !== undefined) {
    return `credits: ${credits.balance}`;
  }
  return typeof credits.hasCredits === "boolean" ? `credits: ${credits.hasCredits ? "available" : "none"}` : null;
}

function formatSpendLimit(limit: any): string | null {
  if (!limit) {
    return null;
  }
  const lines = [`spend remaining: ${formatPercent(limit.remainingPercent ?? limit.remaining_percent)}`];
  if (limit.resetsAt ?? limit.resets_at) {
    lines.push(`resets ${formatUnixSeconds(limit.resetsAt ?? limit.resets_at)}`);
  }
  return lines.join(", ");
}

function formatTokenUsage(response: any): string {
  const summary = response?.summary;
  if (!summary) {
    return "usage unavailable";
  }
  const lines = [
    `lifetime tokens: ${formatNumber(summary.lifetimeTokens ?? summary.lifetime_tokens)}`,
    summary.peakDailyTokens ?? summary.peak_daily_tokens
      ? `peak daily tokens: ${formatNumber(summary.peakDailyTokens ?? summary.peak_daily_tokens)}`
      : null,
    summary.currentStreakDays ?? summary.current_streak_days
      ? `current streak: ${formatNumber(summary.currentStreakDays ?? summary.current_streak_days)}d`
      : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function formatPercent(value: unknown): string {
  return typeof value === "number" ? `${Math.round(value)}%` : "unknown";
}

function formatNumber(value: unknown): string {
  if (value === null || value === undefined) {
    return "unknown";
  }
  const numberValue = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(numberValue) ? new Intl.NumberFormat("en-US").format(numberValue) : String(value);
}

function formatUnixSeconds(value: unknown): string {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return "unknown";
  }
  return new Date(numberValue * 1000).toISOString();
}

function topicKey(chatId: number, messageThreadId: number): string {
  return `${chatId}:${messageThreadId}`;
}

function helpText(): string {
  return [
    "Claude over Telegram commands:",
    "",
    "/bind <absolute_repo_path> - bind this topic to a git repo",
    "/create <folder> - from topic 0, create a folder, topic, and binding",
    "/where - show repo, branch, mode, and git status",
    "/models - list available Claude models",
    "/model - show or set this topic's Claude model",
    "/plan - show or toggle plan mode for this topic",
    "/mode read - use read-only Claude sandbox",
    "/mode write - allow Claude workspace edits",
    "/topic - rename this Telegram topic to the bound folder name",
    "/new - start a fresh Claude session",
    "/dashboard - show all topic activity",
    "/topics - list all bound topics",
    "/todo - show open work items plus running, queued, and failed runs",
    "/work - list open work items",
    "/work all - list open and closed work items",
    "/work_add <title> - create a work item for this topic",
    "/work_add <topic-id-or-name> <title> - create a work item for another topic",
    "/work_done <id> <evidence> - mark a work item done",
    "/work_blocked <id> <reason> - mark a work item blocked",
    "/work_cancel <id> <reason> - cancel a work item",
    "/status - show active queued/running task",
    "/stop - stop the active Claude process",
    "/diff - show diff summary and attach full diff when large",
    "/commit <message> - commit repo changes",
    "/push - push current HEAD to origin",
    "/unbind - remove this topic binding",
    "/ask <prompt> - send a Claude prompt as a command",
    "/queue <prompt> - queue the next Claude turn instead of steering the active run",
    "/queue_topic <topic-id-or-name> <prompt> - queue prompt for a worker topic",
    "/assign <topic-id-or-name> <prompt> - alias for /queue_topic",
    "/cron <5-field-cron> <prompt> - schedule a recurring prompt for this topic",
    "/cron <topic-id-or-name> <5-field-cron> <prompt> - schedule another topic",
    "/cron list - list scheduled prompts in this chat",
    "/cron off <id> - disable a scheduled prompt",
    "",
    "Any ordinary message in a bound topic is sent to Claude if Telegram privacy mode allows it. Use /queue to force a follow-up turn, or /ask when privacy mode is enabled.",
  ].join("\n");
}

export function telegramCommandMenu(): Array<{ command: string; description: string }> {
  return [
    { command: "bind", description: "Bind this topic to a folder" },
    { command: "create", description: "Create a folder and topic from topic 0" },
    { command: "where", description: "Show this topic binding and status" },
    { command: "models", description: "List available Claude models" },
    { command: "model", description: "Show or set this topic model" },
    { command: "plan", description: "Show or toggle plan mode" },
    { command: "mode", description: "Set read or write sandbox mode" },
    { command: "topic", description: "Rename this Telegram topic" },
    { command: "new", description: "Start a fresh Claude session" },
    { command: "dashboard", description: "Show topic activity" },
    { command: "topics", description: "List managed topic bindings" },
    { command: "todo", description: "Show work items and run state" },
    { command: "work", description: "List work items" },
    { command: "work_add", description: "Create a work item" },
    { command: "work_done", description: "Mark work item done" },
    { command: "work_blocked", description: "Mark work item blocked" },
    { command: "work_cancel", description: "Cancel a work item" },
    { command: "status", description: "Show active queued or running task" },
    { command: "stop", description: "Stop the active Claude process" },
    { command: "diff", description: "Show git diff summary" },
    { command: "commit", description: "Commit repo changes" },
    { command: "push", description: "Push current HEAD" },
    { command: "unbind", description: "Remove this topic binding" },
    { command: "ask", description: "Send a Claude prompt as a command" },
    { command: "queue", description: "Queue the next Claude turn" },
    { command: "queue_topic", description: "Queue a prompt for a worker topic" },
    { command: "assign", description: "Alias for /queue_topic" },
    { command: "cron", description: "Create or list scheduled prompts" },
  ];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const maybe = error as Error & { stderr?: string; stdout?: string };
    return [error.message, maybe.stderr, maybe.stdout].filter(Boolean).join("\n");
  }
  return String(error);
}

function formatTelegramUser(user: Context["from"]): string {
  if (!user) {
    return "unknown";
  }
  const parts = [
    user.username ? `@${user.username}` : null,
    [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
    String(user.id),
  ].filter(Boolean);
  return parts.join(" / ");
}

function resolveNewWorkspacePath(requestedFolder: string, allowedRoots: string[]): string {
  if (allowedRoots.length === 0) {
    throw new Error("ALLOWED_REPO_ROOTS must contain at least one root.");
  }

  const expanded = expandCreateWorkspacePath(requestedFolder);
  const repoPath = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(allowedRoots[0] ?? "", path.normalize(expanded));

  const insideAllowedRoot = allowedRoots.some((root) => {
    const relative = path.relative(root, repoPath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (!insideAllowedRoot) {
    throw new Error(`Folder must stay inside allowed roots: ${allowedRoots.join(", ")}`);
  }

  return repoPath;
}

function expandCreateWorkspacePath(requestedFolder: string): string {
  if (requestedFolder === "~") {
    return os.homedir();
  }
  if (requestedFolder.startsWith("~/")) {
    return path.join(os.homedir(), requestedFolder.slice(2));
  }
  if (requestedFolder.startsWith("~")) {
    throw new Error("Only ~ and ~/ paths are supported; ~user expansion is not supported.");
  }

  const normalized = path.normalize(requestedFolder);
  if (normalized === "." || normalized.startsWith("..")) {
    throw new Error("Use a folder path inside an allowed root.");
  }

  return normalized;
}

async function ensureWorkspaceDirectory(repoPath: string): Promise<"created" | "existed"> {
  try {
    await mkdir(repoPath);
    return "created";
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code !== "EEXIST") {
      throw error;
    }

    const existing = await stat(repoPath);
    if (!existing.isDirectory()) {
      throw new Error(`Path already exists and is not a directory: ${repoPath}`);
    }
    return "existed";
  }
}

function topicNameForPath(repoPath: string): string {
  const trimmedPath = repoPath.replace(/\/+$/, "");
  const folderName = trimmedPath.split("/").filter(Boolean).pop() ?? trimmedPath;
  return (folderName || repoPath).slice(0, 128);
}

async function renameForumTopicForBinding(
  ctx: Context,
  binding: TopicBinding,
  topicName: string,
): Promise<string | null> {
  if (binding.messageThreadId <= 0) {
    return null;
  }

  try {
    await ctx.api.editForumTopic(binding.chatId, binding.messageThreadId, { name: topicName });
    return `Topic renamed to: ${topicName}`;
  } catch (error) {
    logger.warn("failed to rename telegram topic", {
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      topicName,
      error: errorMessage(error),
    });
    return `Topic rename failed: ${errorMessage(error)}`;
  }
}
