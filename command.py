import uuid
import random
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

from config import CONFIG
from storage import (
    load_data, save_data, load_stock, save_stock, load_links, save_links,
    user_bucket, build_habbo_image_url, normalise_name, find_item,
    choose_rarity, get_items_by_rarity, leaderboard_add_spin,
    make_embed_with_attachment, stock_page_embed, utcnow, ts, has_staff_role, get_week_start
)
from views import StockView, DepositDecisionView


def guild_only():
    def predicate(interaction: discord.Interaction) -> bool:
        return interaction.guild is not None
    return app_commands.check(predicate)


def staff_only():
    async def predicate(interaction: discord.Interaction) -> bool:
        if not isinstance(interaction.user, discord.Member) or not has_staff_role(interaction.user):
            raise app_commands.CheckFailure("Staff only command.")
        return True
    return app_commands.check(predicate)


class GumballCommands(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(description="Shows all available commands")
    @guild_only()
    async def help(self, interaction: discord.Interaction):
        embed = discord.Embed(title="Gumball bot commands", colour=0x5865F2, timestamp=utcnow())
        embed.add_field(name="User", value="/balance, /howtoplay, /showprizes, /gumball, /claim, /depositcoins, /depositfurni", inline=False)
        embed.add_field(name="Staff", value="/addstock, /removestock, /addtokens, /removetokens, /history, /resetleaderboard", inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(description="Check your token balance")
    @guild_only()
    async def balance(self, interaction: discord.Interaction):
        data = load_data()
        user = user_bucket(data, interaction.user.id)
        await interaction.response.send_message(f"You have **{user['tokens']}** token(s).", ephemeral=True)

    @app_commands.command(description="View rates, rules, and rarity odds")
    @guild_only()
    async def howtoplay(self, interaction: discord.Interaction):
        lines = [
            f"Credits: {CONFIG['credits_per_token']} credits = 1 token",
            f"Furni: {CONFIG['furni_per_token']} item(s) = 1 token",
            "A spin costs 1 token.",
            "Use /claim after winning.",
            "Rarity odds:",
        ]
        for key, meta in CONFIG["rarities"].items():
            lines.append(f"- {meta['label']}: {meta['chance']}%")
        embed = discord.Embed(title="How to play", description="\n".join(lines), colour=0x2ECC71)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(description="Browse prize stock")
    @guild_only()
    async def showprizes(self, interaction: discord.Interaction):
        stock = load_stock()
        view = StockView(self.bot, "blue", 0)
        await interaction.response.send_message(embed=stock_page_embed(stock, "blue", 0), view=view, ephemeral=True)

    @app_commands.command(description="Spin the gumball machine")
    @guild_only()
    async def gumball(self, interaction: discord.Interaction):
        data = load_data()
        stock = load_stock()
        user = user_bucket(data, interaction.user.id)
        if user["tokens"] < 1:
            await interaction.response.send_message("You need at least 1 token to spin.", ephemeral=True)
            return

        rarity = choose_rarity()
        pool = get_items_by_rarity(stock, rarity)
        if not pool:
            fallback = [x for x in stock["items"] if x.get("quantity", 0) > 0]
            if not fallback:
                await interaction.response.send_message("There is no stock available right now.", ephemeral=True)
                return
            pool = fallback
            rarity = random.choice(pool)["rarity"]

        item = random.choice(pool)
        item["quantity"] -= 1
        user["tokens"] -= 1
        user["spins"] += 1
        user["total_spent"] += 1
        user["total_won"] += item.get("value", item["price"])
        claim_id = uuid.uuid4().hex[:10]
        data["pending_claims"][claim_id] = {
            "user_id": interaction.user.id,
            "item_name": item["name"],
            "rarity": rarity,
            "created_at": ts(),
            "claimed": False,
        }
        user["claims"].append(claim_id)
        user["history"].append({"type": "spin_win", "item": item["name"], "rarity": rarity, "claim_id": claim_id, "time": ts()})
        leaderboard_add_spin(data, interaction.user.id, item.get("value", item["price"]))
        save_data(data)
        save_stock(stock)

        desc = f"You won **{item['name']}** from the **{CONFIG['rarities'][rarity]['label']}** pool.\nClaim ID: `{claim_id}`\nUse `/claim claim_id:{claim_id}`."
        embed, file = await make_embed_with_attachment(item, "Gumball win", desc, CONFIG["rarities"][rarity]["colour"])
        if file:
            await interaction.response.send_message(embed=embed, file=file)
        else:
            await interaction.response.send_message(embed=embed)

    @app_commands.command(description="Claim a won prize")
    @app_commands.describe(claim_id="The claim ID from your winning spin")
    @guild_only()
    async def claim(self, interaction: discord.Interaction, claim_id: str):
        data = load_data()
        claim_entry = data["pending_claims"].get(claim_id)
        if not claim_entry or claim_entry["user_id"] != interaction.user.id:
            await interaction.response.send_message("Claim not found.", ephemeral=True)
            return
        if claim_entry["claimed"]:
            await interaction.response.send_message("That claim has already been processed.", ephemeral=True)
            return
        claim_entry["claimed"] = True
        claim_entry["claimed_at"] = ts()
        save_data(data)
        embed = discord.Embed(title="Claim submitted", colour=0xFEE75C, timestamp=utcnow())
        embed.description = f"Your claim for **{claim_entry['item_name']}** has been marked for staff processing."
        await interaction.response.send_message(embed=embed, ephemeral=True)

    async def _submit_deposit(self, interaction: discord.Interaction, deposit_type: str, amount: int):
        if amount <= 0:
            await interaction.response.send_message("Amount must be above 0.", ephemeral=True)
            return
        tokens = amount // CONFIG["credits_per_token"] if deposit_type == "credits" else amount // CONFIG["furni_per_token"]
        if tokens <= 0:
            await interaction.response.send_message("That amount does not convert into any tokens with the current rates.", ephemeral=True)
            return
        data = load_data()
        deposit_id = uuid.uuid4().hex[:10]
        data["deposits"][deposit_id] = {
            "user_id": interaction.user.id,
            "deposit_type": deposit_type,
            "raw_amount": amount,
            "tokens": tokens,
            "status": "pending",
            "created_at": ts(),
        }
        save_data(data)
        await interaction.response.send_message(f"Your {deposit_type} deposit request has been submitted for **{tokens}** token(s).", ephemeral=True)
        channel = self.bot.get_channel(CONFIG.get("deposit_log_channel_id")) if CONFIG.get("deposit_log_channel_id") else None
        if channel:
            embed = discord.Embed(title="Deposit request", colour=0x5865F2, timestamp=utcnow())
            embed.add_field(name="User", value=f"{interaction.user.mention} ({interaction.user.id})", inline=False)
            embed.add_field(name="Type", value=deposit_type, inline=True)
            embed.add_field(name="Submitted amount", value=str(amount), inline=True)
            embed.add_field(name="Token value", value=str(tokens), inline=True)
            embed.set_footer(text=f"deposit_id:{deposit_id}")
            await channel.send(embed=embed, view=DepositDecisionView(self.bot))

    @app_commands.command(description="Submit a credits deposit request")
    @app_commands.describe(amount="Credits deposited")
    @guild_only()
    async def depositcoins(self, interaction: discord.Interaction, amount: int):
        await self._submit_deposit(interaction, "credits", amount)

    @app_commands.command(description="Submit a furni deposit request")
    @app_commands.describe(amount="Furni items deposited")
    @guild_only()
    async def depositfurni(self, interaction: discord.Interaction, amount: int):
        await self._submit_deposit(interaction, "furni", amount)

    @app_commands.command(description="Add stock to a rarity pool")
    @app_commands.describe(name="Item name", rarity="Rarity key", quantity="Amount to add", price="Token price", force="Allow add without lookup", image_url="Custom image URL", value="Win value")
    @staff_only()
    @guild_only()
    async def addstock(self, interaction: discord.Interaction, name: str, rarity: str, quantity: int, price: int, force: bool = False, image_url: Optional[str] = None, value: Optional[int] = None):
        rarity = rarity.lower()
        if rarity not in CONFIG["rarities"]:
            await interaction.response.send_message("Invalid rarity.", ephemeral=True)
            return
        if quantity <= 0 or price < 0:
            await interaction.response.send_message("Quantity must be above 0 and price cannot be negative.", ephemeral=True)
            return
        stock = load_stock()
        existing = find_item(stock, name, rarity)
        if existing:
            existing["quantity"] += quantity
            if image_url:
                existing["image_url"] = image_url
            existing["price"] = price
            existing["value"] = value if value is not None else existing.get("value", price)
            item = existing
        else:
            if not force and not image_url:
                image_url = build_habbo_image_url(name)
            item = {
                "name": normalise_name(name),
                "rarity": rarity,
                "quantity": quantity,
                "price": price,
                "value": value if value is not None else price,
                "image_url": image_url or build_habbo_image_url(name),
            }
            stock["items"].append(item)
        save_stock(stock)
        embed, file = await make_embed_with_attachment(item, "Stock added", f"Added **{quantity}** of **{item['name']}** to **{CONFIG['rarities'][rarity]['label']}**.", CONFIG["rarities"][rarity]["colour"])
        if file:
            await interaction.response.send_message(embed=embed, file=file, ephemeral=True)
        else:
            await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(description="Remove or reduce stock")
    @app_commands.describe(name="Item name", rarity="Rarity key", quantity="Amount to remove")
    @staff_only()
    @guild_only()
    async def removestock(self, interaction: discord.Interaction, name: str, rarity: str, quantity: int):
        stock = load_stock()
        item = find_item(stock, name, rarity.lower())
        if not item:
            await interaction.response.send_message("Item not found.", ephemeral=True)
            return
        item["quantity"] -= quantity
        if item["quantity"] <= 0:
            stock["items"] = [x for x in stock["items"] if x is not item]
        save_stock(stock)
        await interaction.response.send_message("Stock updated.", ephemeral=True)

    @app_commands.command(description="Add tokens to a user")
    @app_commands.describe(user="Target user", amount="Amount of tokens")
    @staff_only()
    @guild_only()
    async def addtokens(self, interaction: discord.Interaction, user: discord.Member, amount: int):
        data = load_data()
        bucket = user_bucket(data, user.id)
        bucket["tokens"] += amount
        bucket["history"].append({"type": "staff_add", "amount": amount, "by": interaction.user.id, "time": ts()})
        save_data(data)
        await interaction.response.send_message(f"Added {amount} token(s) to {user.mention}.", ephemeral=True)

    @app_commands.command(description="Remove tokens from a user")
    @app_commands.describe(user="Target user", amount="Amount of tokens")
    @staff_only()
    @guild_only()
    async def removetokens(self, interaction: discord.Interaction, user: discord.Member, amount: int):
        data = load_data()
        bucket = user_bucket(data, user.id)
        bucket["tokens"] = max(0, bucket["tokens"] - amount)
        bucket["history"].append({"type": "staff_remove", "amount": amount, "by": interaction.user.id, "time": ts()})
        save_data(data)
        await interaction.response.send_message(f"Removed {amount} token(s) from {user.mention}.", ephemeral=True)

    @app_commands.command(description="View a user's stats")
    @app_commands.describe(user="User to inspect")
    @staff_only()
    @guild_only()
    async def history(self, interaction: discord.Interaction, user: discord.Member):
        data = load_data()
        bucket = user_bucket(data, user.id)
        profit = bucket["total_won"] - bucket["total_spent"]
        embed = discord.Embed(title=f"History for {user}", colour=0x5865F2, timestamp=utcnow())
        embed.add_field(name="Tokens", value=str(bucket["tokens"]))
        embed.add_field(name="Spins", value=str(bucket["spins"]))
        embed.add_field(name="Total spent", value=str(bucket["total_spent"]))
        embed.add_field(name="Total won", value=str(bucket["total_won"]))
        embed.add_field(name="Profit", value=str(profit))
        recent = bucket["history"][-5:]
        if recent:
            embed.add_field(name="Recent", value="\n".join(f"{x['type']} • {x['time']}" for x in recent), inline=False)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(description="Reset the weekly leaderboard")
    @staff_only()
    @guild_only()
    async def resetleaderboard(self, interaction: discord.Interaction):
        data = load_data()
        data["leaderboard"] = {"week_start": get_week_start(), "spins": {}, "value_won": {}}
        save_data(data)
        await interaction.response.send_message("Leaderboard reset.", ephemeral=True)

    @app_commands.command(description="Link your Discord account to a Habbo name")
    @app_commands.describe(habbo_name="Your Habbo name")
    @guild_only()
    async def linkhabbo(self, interaction: discord.Interaction, habbo_name: str):
        if not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message("Guild only.", ephemeral=True)
            return
        verified_role_id = CONFIG.get("verified_role_id")
        if verified_role_id and verified_role_id not in [r.id for r in interaction.user.roles]:
            await interaction.response.send_message("You must have the verified role first.", ephemeral=True)
            return
        links = load_links()
        links[str(interaction.user.id)] = normalise_name(habbo_name)
        save_links(links)
        try:
            await interaction.user.edit(nick=normalise_name(habbo_name))
        except Exception:
            pass
        await interaction.response.send_message(f"Linked to Habbo name **{normalise_name(habbo_name)}**.", ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(GumballCommands(bot))
