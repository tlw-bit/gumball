import logging

import discord
from discord import app_commands
from discord.ext import commands, tasks

from config import CONFIG
from storage import bootstrap_files, load_data, save_data, load_stock, stock_page_embed, ensure_leaderboard_window
from views import StockView, DepositDecisionView

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("habbo_gumball_bot")


class GumballBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.members = True
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        bootstrap_files()
        self.add_view(StockView(self))
        self.add_view(DepositDecisionView(self))
        await self.load_extension("commands")
        guild_id = CONFIG.get("guild_id")
        if guild_id:
            guild_obj = discord.Object(id=guild_id)
            self.tree.copy_global_to(guild=guild_obj)
            await self.tree.sync(guild=guild_obj)
        else:
            await self.tree.sync()
        self.stock_refresh.change_interval(minutes=CONFIG.get("stock_update_minutes", 15))
        self.stock_refresh.start()
        self.weekly_reset_check.start()

    async def on_ready(self):
        log.info("Logged in as %s (%s)", self.user, self.user.id)

    @tasks.loop(minutes=1)
    async def weekly_reset_check(self):
        data = load_data()
        old = data.get("leaderboard", {}).get("week_start")
        ensure_leaderboard_window(data)
        if old != data["leaderboard"]["week_start"]:
            save_data(data)
            cid = CONFIG.get("leaderboard_channel_id")
            channel = self.get_channel(cid) if cid else None
            if channel:
                await channel.send("Weekly leaderboard has been reset.")

    @tasks.loop(minutes=15)
    async def stock_refresh(self):
        data = load_data()
        channel_id = data.get("stock_channel_id") or CONFIG.get("stock_channel_id")
        message_id = data.get("stock_message_id")
        if not channel_id:
            return
        channel = self.get_channel(channel_id)
        if not channel:
            return
        embed = stock_page_embed(load_stock(), "blue", 0)
        view = StockView(self, "blue", 0)
        try:
            if message_id:
                msg = await channel.fetch_message(message_id)
                await msg.edit(embed=embed, view=view)
            else:
                msg = await channel.send(embed=embed, view=view)
                data["stock_message_id"] = msg.id
                data["stock_channel_id"] = channel.id
                save_data(data)
        except Exception as e:
            log.warning("Stock refresh failed: %s", e)


bot = GumballBot()


@bot.tree.error
async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    message = str(error)
    if isinstance(error, app_commands.CheckFailure):
        message = "You do not have permission to use that command."
    try:
        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)
    except Exception:
        pass


if __name__ == "__main__":
    if CONFIG["token"] == "PUT_BOT_TOKEN_HERE" or not CONFIG["token"]:
        raise RuntimeError("Set DISCORD_BOT_TOKEN or update config.py first.")
    bot.run(CONFIG["token"])
