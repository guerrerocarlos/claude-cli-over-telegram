# Claude CLI over Telegram

Run Claude from Telegram.

Each Telegram topic can be bound to a different folder, so one Telegram group can control many repos or worktrees at the same time.

## Quick Start With npx

Requirements:

- Node.js 20+
- The `claude` CLI installed and logged in on this machine
- A Telegram bot token from BotFather
- `ffmpeg` and `OPENAI_API_KEY` for Telegram voice transcription

Create a `.env` file:

```bash
mkdir -p ~/.claude-cli-over-telegram
cd ~/.claude-cli-over-telegram
nano .env
```

Paste this:

```text
TELEGRAM_BOT_TOKEN=123456:telegram-token
ALLOWED_TELEGRAM_USER_IDS=
ALLOWED_TELEGRAM_CHAT_IDS=
ALLOWED_REPO_ROOTS=/home/you
DATABASE_PATH=./state.sqlite
ALLOW_UNTHREADED_CHATS=true
CLAUDE_ALWAYS_YOLO=false
TELEGRAM_SEND_INTERVAL_MS=1500
MAX_TELEGRAM_FILE_BYTES=20971520
OPENAI_API_KEY=
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe
FFMPEG_BIN=ffmpeg
```

Start Claude CLI over Telegram:

```bash
npx github:guerrerocarlos/claude-cli-over-telegram
```

Send any message to the bot. If `ALLOWED_TELEGRAM_USER_IDS` or `ALLOWED_TELEGRAM_CHAT_IDS` is blank, Claude CLI over Telegram replies with the exact IDs to put in `.env`.

Update `.env`, restart the command, then bind a folder:

```text
/bind ~/my-project
```

Now send a normal Telegram message:

```text
summarize this repo
```

## Daily Use

Useful commands:

```text
/bind ~/path/to/project
/create ~/new-project-folder
/where
/models
/model
/model sonnet
/plan on
/plan off
/mode read
/mode write
/status
/stop
/new
/diff
/commit Commit message
/push
/ask do something specific
/queue do this after the current run
/dashboard
/topics
/todo
/work
/work_add <title>
/queue_topic <topic-id-or-name> <prompt>
/assign <topic-id-or-name> <prompt>
/cron 0 * * * * recurring prompt
```

Normal messages in a bound chat/topic are sent to Claude. While a run is active, use `/queue <prompt>` when you want the message to wait as the next turn. Use `/ask` if Telegram privacy mode prevents the bot from seeing ordinary group messages.

From topic 0, use `/create <folder>` to create a new folder inside `ALLOWED_REPO_ROOTS`, create a Telegram forum topic for it, and bind that new topic to the folder. If the folder already exists, the bot still creates and binds the topic and reports that it reused the existing folder. Relative paths are created under the first allowed root; `~/...` and absolute paths are accepted when they stay inside an allowed root. The bot must be allowed to manage forum topics, and `ALLOW_UNTHREADED_CHATS=true` is required when Telegram sends the general topic without a `message_thread_id`.

The bot publishes its slash-command menu to Telegram on startup, so newly added commands may require a service restart before they appear in Telegram's `/` picker.

Images, documents, audio, video, and other Telegram files are saved into the bound repository's `.context/` directory and then sent to Claude as local paths. If the upload has a caption, the caption is used as the instruction. A caption starting with `/ask` is also supported.

Voice messages are saved into `.context/`, converted with `ffmpeg` when Telegram sends an OpenAI-unsupported audio container, transcribed with the OpenAI API, saved as a `.transcript.txt` file, and then sent to Claude as the user's prompt. Set `OPENAI_API_KEY` before using voice transcription.

The bot pins the message that triggers each run and leaves the latest prompt pinned after completion so the task remains easy to find.

If the service restarts while runs are queued or active, it requeues those saved runs on startup and posts a notice in each affected Telegram topic. Queued runs start from the saved prompt. Interrupted running runs resume the saved Claude thread with a continue-style prompt instead of replaying the original prompt from scratch.

## Manager Control Plane

Claude CLI over Telegram includes the same generic Telegram manager surface as the Codex bot:

- `/dashboard`, `/topics`, and `/todo` inspect topic, run, and work state across a chat.
- `/work*` commands create and update persistent work items.
- `/queue_topic` and `/assign` queue prompts into another bound topic.
- `/cron` creates, lists, and disables recurring prompts.
- `POST /bridge` exposes the same actions to local tooling with `MANAGER_BRIDGE_TOKEN`.
- `npm run fleet:export`, `npm run fleet:restore`, and `npm run fleet:backup` export or restore sanitized fleet state.

Keep `MANAGER_BRIDGE_TOKEN` in the system env file, not in git.

## YOLO Mode

To make every Claude run use `danger-full-access` with approvals disabled:

```text
CLAUDE_ALWAYS_YOLO=true
```

Restart Claude CLI over Telegram after changing it.

## Run From A Clone

```bash
git clone https://github.com/guerrerocarlos/claude-cli-over-telegram.git
cd claude-cli-over-telegram
npm install
cp .env.example .env
npm run dev
```

Production-style local run:

```bash
npm run build
npm start
```

## Run At Boot

Claude CLI over Telegram includes a systemd service named `claude-cli-over-telegram`.

Pick the Linux user that should own Claude auth, config, repos, and runtime state. The examples below use variables so you can use your own account.

```bash
export SERVICE_USER="$USER"
export SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
export SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
export APP_DIR="$SERVICE_HOME/claude-cli-over-telegram"
export STATE_DIR="$SERVICE_HOME/.local/state/claude-cli-over-telegram"
```

1. Clone the repo into the service directory:

```bash
cd "$SERVICE_HOME"
git clone https://github.com/guerrerocarlos/claude-cli-over-telegram.git
cd "$APP_DIR"
npm install
```

2. Make sure Claude works as the service user:

```bash
claude --version
claude
```

Log in or finish Claude setup if the CLI prompts you. The service uses `$SERVICE_HOME/.claude`.

3. Install the systemd unit:

```bash
sudo install -d -m 0750 -o root -g "$SERVICE_GROUP" /etc/claude-cli-over-telegram
sudo install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR"
sudo cp deploy/systemd/claude-cli-over-telegram.service /etc/systemd/system/claude-cli-over-telegram.service
sudo sed -i \
  -e "s|^User=.*|User=$SERVICE_USER|" \
  -e "s|^Group=.*|Group=$SERVICE_GROUP|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
  -e "s|^Environment=HOME=.*|Environment=HOME=$SERVICE_HOME|" \
  -e "s|^ExecStart=.*|ExecStart=/usr/bin/node $APP_DIR/dist/index.js|" \
  /etc/systemd/system/claude-cli-over-telegram.service
sudo systemctl daemon-reload
```

4. Create the production env file:

```bash
sudo nano /etc/claude-cli-over-telegram/env
```

Use this shape:

```text
TELEGRAM_BOT_TOKEN=123456:telegram-token
ALLOWED_TELEGRAM_USER_IDS=12345678
ALLOWED_TELEGRAM_CHAT_IDS=-1001234567890
ALLOWED_REPO_ROOTS=/path/to/allowed/repos
DATABASE_PATH=/path/to/service-home/.local/state/claude-cli-over-telegram/state.sqlite
CLAUDE_BIN=claude
DEFAULT_SANDBOX_MODE=read-only
CLAUDE_ALWAYS_YOLO=false
ALLOW_UNTHREADED_CHATS=true
MAX_PARALLEL_RUNS=4
MAX_TELEGRAM_MESSAGE_CHARS=3500
TELEGRAM_SEND_INTERVAL_MS=1500
MAX_TELEGRAM_FILE_BYTES=20971520
OPENAI_API_KEY=sk-...
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe
FFMPEG_BIN=ffmpeg
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8787
```

Then lock it down:

```bash
sudo chown root:"$SERVICE_GROUP" /etc/claude-cli-over-telegram/env
sudo chmod 0640 /etc/claude-cli-over-telegram/env
```

5. Deploy, enable startup, and start the service:

```bash
SERVICE_USER="$SERVICE_USER" SERVICE_GROUP="$SERVICE_GROUP" APP_DIR="$APP_DIR" STATE_DIR="$STATE_DIR" ./scripts/deploy.sh
sudo systemctl enable claude-cli-over-telegram
sudo systemctl restart claude-cli-over-telegram
sudo systemctl status claude-cli-over-telegram --no-pager
```

Useful checks:

```bash
curl -fsS http://127.0.0.1:8787/health
journalctl -u claude-cli-over-telegram -f
```

After editing `/etc/claude-cli-over-telegram/env`, restart the service:

```bash
sudo systemctl restart claude-cli-over-telegram
```

## Health Check

Claude CLI over Telegram exposes:

```bash
curl -fsS http://127.0.0.1:8787/health
```

On the shared `/home/gnu` host, this service currently uses `HEALTH_PORT=8789` because `8787` is used by `codex-cli-over-telegram`.

## Security

Telegram access to Claude CLI over Telegram is remote control of your allowed folders.

Keep these tight:

```text
ALLOWED_TELEGRAM_USER_IDS=
ALLOWED_TELEGRAM_CHAT_IDS=
ALLOWED_REPO_ROOTS=
```

Only enable `CLAUDE_ALWAYS_YOLO=true` on a machine and Telegram group you fully trust.
