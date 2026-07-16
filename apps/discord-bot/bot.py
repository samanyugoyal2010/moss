"""A small Discord bot that indexes messages in Moss and searches them semantically."""

from __future__ import annotations

import os
import sys
from typing import Final

import discord
from discord.ext import commands
from dotenv import load_dotenv
from moss import DocumentInfo, MossClient, QueryOptions

REQUIRED_ENV: Final = (
    "DISCORD_BOT_TOKEN",
    "MOSS_PROJECT_ID",
    "MOSS_PROJECT_KEY",
    "MOSS_INDEX_NAME",
)
BOT_BRAND: Final = "Moss"
BOT_ACTIVITY: Final = "semantic search with Moss"


def build_document(message: discord.Message, text: str | None = None) -> DocumentInfo:
    """Convert a Discord message into a Moss document with useful source metadata."""
    return DocumentInfo(
        id=str(message.id),
        text=text if text is not None else message.content,
        metadata={
            "channel_id": str(message.channel.id),
            "channel_name": getattr(message.channel, "name", "unknown"),
            "author_id": str(message.author.id),
            "author_name": str(message.author),
            "url": message.jump_url,
        },
    )


def build_interaction_document(interaction: discord.Interaction, text: str) -> DocumentInfo:
    """Convert a slash interaction into a Moss document."""
    channel = interaction.channel
    return DocumentInfo(
        id=f"interaction-{interaction.id}",
        text=text,
        metadata={
            "channel_id": str(channel.id) if channel else "unknown",
            "channel_name": getattr(channel, "name", "unknown"),
            "author_id": str(interaction.user.id),
            "author_name": str(interaction.user),
            "url": "",
        },
    )


class MossDiscordBot(commands.Bot):
    """Discord bot that writes messages to and searches one Moss index."""

    def __init__(self, moss: MossClient, index_name: str) -> None:
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(command_prefix="!", intents=intents)
        self.moss = moss
        self.index_name = index_name
        self.index_exists = False

    async def setup_hook(self) -> None:
        """Register commands and detect whether the configured index already exists."""
        indexes = await self.moss.list_indexes()
        self.index_exists = any(index.name == self.index_name for index in indexes)
        await self.tree.sync()

    async def add_message_to_index(self, message: discord.Message, text: str | None = None) -> None:
        """Create the index on first use, then append subsequent messages."""
        text = text if text is not None else message.content
        if not text.strip():
            return
        document = build_document(message, text)
        if self.index_exists:
            await self.moss.add_docs(self.index_name, [document])
        else:
            await self.moss.create_index(self.index_name, [document], "moss-minilm")
            self.index_exists = True


async def send_chunks(ctx: commands.Context[commands.Bot], text: str) -> None:
    """Send a response without exceeding Discord's 2,000-character limit."""
    for offset in range(0, len(text), 1900):
        chunk = text[offset : offset + 1900]
        await ctx.send(chunk, allowed_mentions=discord.AllowedMentions.none())


def create_bot() -> MossDiscordBot:
    """Build a configured bot, failing early with a useful message if setup is incomplete."""
    load_dotenv()
    missing = [name for name in REQUIRED_ENV if not os.getenv(name)]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")

    moss = MossClient(os.environ["MOSS_PROJECT_ID"], os.environ["MOSS_PROJECT_KEY"])
    bot = MossDiscordBot(moss, os.environ["MOSS_INDEX_NAME"])

    @bot.event
    async def on_ready() -> None:
        await bot.change_presence(
            status=discord.Status.online,
            activity=discord.Game(name=BOT_ACTIVITY),
        )
        print(f"{BOT_BRAND} bot logged in as {bot.user}; Moss index: {bot.index_name}")

    @bot.command(name="moss-index")
    @commands.has_guild_permissions(manage_messages=True)
    async def index_message(ctx: commands.Context[commands.Bot], *, text: str) -> None:
        """Index explicit knowledge text: !moss-index The refund policy is ..."""
        await bot.add_message_to_index(ctx.message, text)
        await ctx.send(f"{BOT_BRAND} indexed that knowledge.")

    @bot.command(name="ask")
    async def ask(ctx: commands.Context[commands.Bot], *, question: str) -> None:
        """Search Moss and return the most relevant indexed messages."""
        if not bot.index_exists:
            await ctx.send(f"The {BOT_BRAND} index is empty. Ask a moderator to run `!moss-index <text>`.")
            return
        results = await bot.moss.query(bot.index_name, question, QueryOptions(top_k=3))
        if not results.docs:
            await ctx.send(f"{BOT_BRAND} couldn't find anything relevant in the index.")
            return
        lines = [f"**{result.score:.2f}** {result.text}" for result in results.docs]
        await send_chunks(ctx, "\n".join(lines))

    @bot.tree.command(name="moss-index", description="Add a knowledge item to the Moss index")
    @discord.app_commands.checks.has_permissions(manage_messages=True)
    async def slash_index(interaction: discord.Interaction, text: str) -> None:
        """Slash-command equivalent of !moss-index."""
        await interaction.response.defer()
        document = build_interaction_document(interaction, text)
        if bot.index_exists:
            await bot.moss.add_docs(bot.index_name, [document])
        else:
            await bot.moss.create_index(bot.index_name, [document], "moss-minilm")
            bot.index_exists = True
        await interaction.followup.send(f"{BOT_BRAND} indexed that knowledge.")

    @bot.tree.command(name="ask", description="Search the Moss knowledge index")
    async def slash_ask(interaction: discord.Interaction, question: str) -> None:
        """Slash-command equivalent of !ask."""
        if not bot.index_exists:
            await interaction.response.send_message(
                f"The {BOT_BRAND} index is empty.",
                allowed_mentions=discord.AllowedMentions.none(),
            )
            return
        await interaction.response.defer()
        results = await bot.moss.query(bot.index_name, question, QueryOptions(top_k=3))
        response = "\n".join(f"**{result.score:.2f}** {result.text}" for result in results.docs)
        await interaction.followup.send(
            response[:1900] or f"{BOT_BRAND} couldn't find anything relevant.",
            allowed_mentions=discord.AllowedMentions.none(),
        )

    @bot.event
    async def on_command_error(
        ctx: commands.Context[commands.Bot], error: commands.CommandError
    ) -> None:
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("You need the Manage Messages permission to index knowledge.")
        elif isinstance(error, commands.MissingRequiredArgument):
            await ctx.send("Usage: `!moss-index <text>` or `!ask <question>`.")
        else:
            print(f"Command failed: {error!r}", file=sys.stderr)
            await ctx.send("That command failed. Check the bot logs for details.")

    @bot.tree.error
    async def on_app_command_error(
        interaction: discord.Interaction, error: discord.app_commands.AppCommandError
    ) -> None:
        if isinstance(error, discord.app_commands.errors.MissingPermissions):
            message = "You need the Manage Messages permission to index knowledge."
        else:
            print(f"Slash command failed: {error!r}", file=sys.stderr)
            message = "That command failed. Check the bot logs for details."
        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)

    return bot


if __name__ == "__main__":
    try:
        create_bot().run(os.environ["DISCORD_BOT_TOKEN"])
    except RuntimeError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
