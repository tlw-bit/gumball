import math
import discord

from config import CONFIG
from storage import load_data, save_data, load_stock, stock_page_embed, get_items_by_rarity, user_bucket, ts, utcnow, has_staff_role


class StockView(discord.ui.View):
    def __init__(self, bot, rarity: str = "blue", page: int = 0):
        super().__init__(timeout=None)
        self.bot = bot
        self.rarity = rarity
        self.page = page

    @discord.ui.select(
        custom_id="stock:rarity_select",
        placeholder="Choose a rarity",
        min_values=1,
        max_values=1,
        options=[discord.SelectOption(label=v["label"], value=k, emoji="🎁") for k, v in CONFIG["rarities"].items()],
    )
    async def rarity_select(self, interaction: discord.Interaction, select: discord.ui.Select):
        self.rarity = select.values[0]
        self.page = 0
        await interaction.response.edit_message(embed=stock_page_embed(load_stock(), self.rarity, self.page), view=self)

    @discord.ui.button(label="Previous", style=discord.ButtonStyle.secondary, custom_id="stock:prev")
    async def prev_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.page = max(0, self.page - 1)
        await interaction.response.edit_message(embed=stock_page_embed(load_stock(), self.rarity, self.page), view=self)

    @discord.ui.button(label="Next", style=discord.ButtonStyle.secondary, custom_id="stock:next")
    async def next_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        stock = load_stock()
        items = get_items_by_rarity(stock, self.rarity)
        pages = max(1, math.ceil(len(items) / 10))
        self.page = min(pages - 1, self.page + 1)
        await interaction.response.edit_message(embed=stock_page_embed(stock, self.rarity, self.page), view=self)


class DepositDecisionView(discord.ui.View):
    def __init__(self, bot):
        super().__init__(timeout=None)
        self.bot = bot

    async def _handle(self, interaction: discord.Interaction, approved: bool):
        if not isinstance(interaction.user, discord.Member) or not has_staff_role(interaction.user):
            await interaction.response.send_message("You are not allowed to do that.", ephemeral=True)
            return
        embed = interaction.message.embeds[0] if interaction.message and interaction.message.embeds else None
        if not embed or not embed.footer or not embed.footer.text.startswith("deposit_id:"):
            await interaction.response.send_message("Missing deposit reference.", ephemeral=True)
            return
        deposit_id = embed.footer.text.split(":", 1)[1].strip()
        data = load_data()
        deposit = data["deposits"].get(deposit_id)
        if not deposit:
            await interaction.response.send_message("Deposit not found.", ephemeral=True)
            return
        if deposit["status"] != "pending":
            await interaction.response.send_message("Deposit already handled.", ephemeral=True)
            return

        deposit["status"] = "approved" if approved else "denied"
        deposit["handled_by"] = interaction.user.id
        deposit["handled_at"] = ts()
        if approved:
            user = user_bucket(data, deposit["user_id"])
            user["tokens"] += deposit["tokens"]
            user["history"].append({"type": "deposit_approved", "amount": deposit["tokens"], "source": deposit["deposit_type"], "time": ts()})
        save_data(data)

        status = "Approved" if approved else "Denied"
        colour = 0x57F287 if approved else 0xED4245
        new_embed = discord.Embed(title=f"Deposit {status}", colour=colour, timestamp=utcnow())
        new_embed.add_field(name="User", value=f"<@{deposit['user_id']}>", inline=True)
        new_embed.add_field(name="Type", value=deposit["deposit_type"], inline=True)
        new_embed.add_field(name="Submitted amount", value=str(deposit["raw_amount"]), inline=True)
        new_embed.add_field(name="Tokens", value=str(deposit["tokens"]), inline=True)
        new_embed.add_field(name="Handled by", value=interaction.user.mention, inline=True)
        new_embed.add_field(name="Status", value=status, inline=True)
        new_embed.set_footer(text=f"deposit_id:{deposit_id}")
        await interaction.response.edit_message(embed=new_embed, view=None)

        target = self.bot.get_user(deposit["user_id"])
        if target:
            try:
                await target.send(f"Your {deposit['deposit_type']} deposit was {status.lower()}. Tokens: {deposit['tokens']}")
            except Exception:
                pass

    @discord.ui.button(label="Approve", style=discord.ButtonStyle.success, custom_id="deposit:approve")
    async def approve(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._handle(interaction, True)

    @discord.ui.button(label="Deny", style=discord.ButtonStyle.danger, custom_id="deposit:deny")
    async def deny(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._handle(interaction, False)
