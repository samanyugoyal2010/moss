# Moss Discord bot

This example turns a Discord server into a small semantic knowledge base. A moderator can add knowledge with `!moss-index <text>`, and anyone can search it with `!ask <question>`. Each indexed item keeps the author, channel, and jump URL as Moss metadata.

## Moss branding

In the Discord Developer Portal, set the application name and bot display name
to `Moss`, use the Moss logo as the application icon, and add a description
such as `Semantic search for your Discord knowledge base`. The bot sets its
online activity to `semantic search with Moss` when it connects. The portal
name, icon, and description are Discord-managed assets and cannot be changed
by the bot token at runtime.

## Setup

Create a Discord application and bot in the [Discord Developer Portal](https://discord.com/developers/applications). Under **Bot**, enable **Message Content Intent**. Under **Installation**, use the `bot` and `applications.commands` scopes and grant only these permissions:

- View Channels
- Send Messages
- Read Message History

The bot also needs **Manage Messages** in any channel where moderators will use `!moss-index` or `/moss-index`. Copy the environment template and fill in the four values:

```bash
cd apps/discord-bot
cp env.example .env
uv sync --dev
uv run python bot.py
```

The Moss project credentials are read only from environment variables. The configured index is created on the first `!moss-index` command and subsequent entries are appended with `add_docs`.

The bot registers `/moss-index` and `/ask` as Discord slash commands on startup. The legacy `!moss-index` and `!ask` commands remain available, so the Message Content Intent is required for those prefix commands.

## Commands

- `!moss-index <text>` — moderator-only; create or append a knowledge item.
- `!ask <question>` — return the three most relevant Moss results.
- `/moss-index text:<text>` — slash-command equivalent of `!moss-index`.
- `/ask question:<question>` — slash-command equivalent of `!ask`.

For production use, run the bot under a process supervisor, keep credentials in a secret manager, add rate limiting, and choose a privacy policy for messages before indexing them. Do not grant the Administrator permission.
