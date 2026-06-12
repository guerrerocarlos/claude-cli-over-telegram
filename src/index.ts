#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { Storage } from "./storage.js";
import { ClaudeExecBackend } from "./claudeExec.js";
import { createTelegramBot, telegramCommandMenu } from "./telegram.js";
import { startHealthServer } from "./health.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config.databasePath);
  const interruptedRuns = storage.prepareInterruptedRunsForResume();

  const healthServer = startHealthServer(config);
  const claude = new ClaudeExecBackend(config.claudeBin);
  const bot = createTelegramBot(config, storage, claude, { recoverRuns: interruptedRuns });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    healthServer.close();
    await bot.stop();
    storage.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.init();
  try {
    const commands = telegramCommandMenu();
    await bot.api.setMyCommands(commands);
    logger.info("telegram bot commands updated", { count: commands.length });
  } catch (error) {
    logger.warn("failed to update telegram bot commands", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  logger.info("telegram bot starting", {
    botUsername: bot.botInfo.username,
    databasePath: config.databasePath,
    defaultSandboxMode: config.defaultSandboxMode,
    alwaysYoloMode: config.alwaysYoloMode,
  });
  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => {
      logger.info("telegram bot started", { botUsername: info.username });
    },
  });
}

main().catch((error) => {
  logger.error("fatal startup error", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exit(1);
});
