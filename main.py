import discord
from discord import app_commands
from discord.ext import commands, tasks
from discord.ui import View, Button
import random
import json
import time
import asyncio
import os

# --------------------------
# Load & Save Data
# --------------------------
def load_index():
    if os.path.exists("index.json"):
        with open("index.json", "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "bot": {}, "rates": {}, "colour_groups": {}, "stock": {}, "channels": {},
        "users": {}, "deposit_requests": {}, "pull_history": {}, "furni_deposits": {}, "pending_claims": {}
    }

def save_index(data):
    with open("index.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

DATA = load_index()

# ✅ Configuration
BOT_TOKEN = os.getenv("BOT_TOKEN", DATA["bot"].get("token", ""))
YOUR_HABBO_NAME = DATA["bot"]["habbo_name"]
ADMIN_ROLE_ID = DATA["bot"]["admin_role_id"]
SUPPORT_ROLE_ID = DATA["bot"]["support_role_id"]
ROOM_LINK = "https://www.habbo.com/room/80384728"
STOCK_CHANNEL = DATA["channels"]["shop"]
CLAIMS_CHANNEL = DATA["channels"]["claims"]
MOD_AWARENESS = DATA["channels"]["mod_awareness"]

COST_PER_PULL = DATA["rates"]["cost_per_pull"]
STARTING_TOKENS = DATA["rates"]["starting_tokens"]
FURNI_PER_TOKEN = DATA["rates"]["furni_per_token"]
TOKEN_PACKAGES = DATA["rates"]["token_packages"]
BASE_RATE = DATA["rates"]["base_rate"]
MIN_DEPOSIT = DATA["rates"]["min_deposit"]
COLOUR_GROUPS = DATA["colour_groups"]
STOCK = DATA["stock"]

# --------------------------
# Helper Functions
# --------------------------
def get_user(user_id):
    user_id = str(user_id)
    if user_id not in DATA["users"]:
        DATA["users"][user_id] = {"balance": STARTING_TOKENS, "habbo_name": ""}
        save_index(DATA)
    return DATA["users"][user_id]

def pick_colour_group():
    total = sum(g["chance"] for g in COLOUR_GROUPS)
    roll = random.uniform(0, total)
    current = 0
    for g in COLOUR_GROUPS:
        current += g["chance"]
        if roll <= current:
            return g

def get_random_item(colour_id):
    items = STOCK.get(colour_id, [])
    avail = [i for i in items if i["stock"] > 0]
    return random.choice(avail) if avail else None

def get_furni_image(name):
    slug = name.lower().replace(" ", "_").replace("'", "").replace("&", "and")
    return f"https://images.habbo.com/dcr/hof_furni/{slug}_icon.png"

def get_habbo_avatar(username):
    return f"https://www.habbo.com/habbo-imaging/avatarimage?user={username}&direction=2&head_direction=2&gesture=sml&size=s"

def get_average_price(group):
    return f"{(group['credit_min'] + group['credit_max']) // 2} Credits"

# --------------------------
# Claim View with Permissions & Logging
# --------------------------
class ClaimView(View):
    def __init__(self, claim_id, winner_id):
        super().__init__(timeout=None)
        self.claim_id = claim_id
        self.winner_id = int(winner_id)

    @discord.ui.button(label="📩 Request to Claim", style=discord.ButtonStyle.primary, custom_id="request_claim")
    async def request_claim(self, interaction: discord.Interaction, button: Button):
        if interaction.user.id != self.winner_id:
            return await interaction.response.send_message("❌ Only the winner can request this prize!", ephemeral=True)

        claim = DATA["pending_claims"].get(str(self.claim_id))
        if not claim:
            return await interaction.response.send_message("❌ Claim not found.", ephemeral=True)

        claim["status"] = "Requested"
        save_index(DATA)

        embed = interaction.message.embeds[0]
        embed.description = f"**Status:** 📩 REQUESTED\n**User:** {claim['discord']}\n**Habbo:** `{claim['habbo_name']}`"
        await interaction.message.edit(embed=embed, view=self)

        mod_channel = bot.get_channel(MOD_AWARENESS)
        if mod_channel:
            log_embed = discord.Embed(
                title="📥 NEW CLAIM REQUEST",
                description=f"<@&{ADMIN_ROLE_ID}> **{claim['habbo_name']}** has won **{claim['item']}** — please arrange a trade.",
                color=0xf39c12
            )
            log_embed.add_field(name="Value", value=claim["value"], inline=True)
            log_embed.add_field(name="Rarity", value=claim["colour"], inline=True)
            log_embed.set_thumbnail(url=get_furni_image(claim["item"]))
            await mod_channel.send(content=f"<@&{ADMIN_ROLE_ID}>", embed=log_embed)

        await interaction.response.send_message("✅ Request sent! A staff member will contact you shortly.", ephemeral=True)

    @discord.ui.button(label="✅ Mark as Traded", style=discord.ButtonStyle.success, custom_id="mark_traded")
    async def mark_traded(self, interaction: discord.Interaction, button: Button):
        if not (interaction.user.get_role(ADMIN_ROLE_ID) or interaction.user.get_role(SUPPORT_ROLE_ID)):
            return await interaction.response.send_message("❌ Only Admin or Support can mark this as traded.", ephemeral=True)

        claim = DATA["pending_claims"].get(str(self.claim_id))
        if not claim:
            return await interaction.response.send_message("❌ Claim not found.", ephemeral=True)

        mod_channel = bot.get_channel(MOD_AWARENESS)
        if mod_channel:
            log_embed = discord.Embed(
                title="✅ PRIZE AWARDED",
                description=f"**Habbo User:** `{claim['habbo_name']}`\n**Prize:** {claim['item']}\n**Traded by:** {interaction.user.mention}",
                color=0x2ecc71
            )
            log_embed.add_field(name="Value", value=claim["value"], inline=True)
            log_embed.add_field(name="Completed", value=time.strftime("%Y-%m-%d %H:%M"), inline=True)
            log_embed.set_thumbnail(url=get_furni_image(claim["item"]))
            await mod_channel.send(embed=log_embed)

        embed = interaction.message.embeds[0]
        embed.description = f"**Status:** ✅ COMPLETED\n**User:** {claim['discord']}\n**Habbo:** `{claim['habbo_name']}`\n**Traded by:** {interaction.user.mention}"
        await interaction.message.edit(embed=embed, view=None)

        DATA["pending_claims"].pop(str(self.claim_id), None)
        save_index(DATA)
        await interaction.response.send_message("✅ Claim marked as traded.", ephemeral=True)

# --------------------------
# Bot Setup
# --------------------------
intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)
tree = bot.tree

# --------------------------
# 🎮 Gumball Command
# --------------------------
@tree.command(name="gumball", description="🎟️ Pull the lever — 1 Token per try")
async def gumball(interaction: discord.Interaction):
    user = get_user(interaction.user.id)
    if user["balance"] < COST_PER_PULL:
        return await interaction.response.send_message(
            f"❌ Not enough tokens! You have **{user['balance']}**, need **{COST_PER_PULL}**.\nUse `/deposit` or `/depositfurni` to get more.", ephemeral=True
        )

    user["balance"] -= COST_PER_PULL
    save_index(DATA)

    await interaction.response.send_message("🎪 Pulling lever... 🔄 Spinning...")
    msg = await interaction.original_response()
    for _ in range(6):
        await msg.edit(content=f"🎪 Spinning... {random.choice(['🔵','🟣','💚','🟪','✨'])}")
        await asyncio.sleep(0.35)

    group = pick_colour_group()
    won_item = get_random_item(group["id"])

    if not won_item:
        user["balance"] += COST_PER_PULL
        save_index(DATA)
        return await msg.edit(content=f"😕 No stock in {group['name']} — your token has been refunded.")

    won_item["stock"] -= 1
    save_index(DATA)

    credit_val = random.randint(group["credit_min"], group["credit_max"])
    avg_price = get_average_price(group)
    tokens_won = random.randint(group["token_min"], group["token_max"])
    user["balance"] += tokens_won
    new_balance = user["balance"]
    save_index(DATA)

    DATA["pull_history"].append({
        "user": str(interaction.user), "colour": group["name"], "item": won_item["name"],
        "value": credit_val, "tokens_won": tokens_won, "net": tokens_won - COST_PER_PULL,
        "time": time.strftime("%Y-%m-%d %H:%M")
    })
    save_index(DATA)

    color_map = {"blue":0x3498db, "purple":0x9b59b6, "green":0x2ecc71, "lilac":0xa884f7, "golden":0xFFD700}
    habbo_face = get_habbo_avatar(user.get("habbo_name", "Habbo"))
    furni_pic = get_furni_image(won_item["name"])

    win_embed = discord.Embed(
        title="🎉 CONGRATULATIONS! YOU WON!",
        description=f"{interaction.user.mention}",
        color=color_map[group["id"]]
    )
    win_embed.set_thumbnail(url=furni_pic)
    win_embed.set_author(name=interaction.user.display_name, icon_url=habbo_face)
    win_embed.add_field(name="🎁 Prize", value=f"**{won_item['name']}**", inline=False)
    win_embed.add_field(name="💸 Value", value=f"**{credit_val} Credits**", inline=True)
    win_embed.add_field(name="📊 Avg Price", value=f"**~{avg_price}**", inline=True)
    win_embed.add_field(name="🎟️ Tokens Gained", value=f"+{tokens_won}", inline=True)
    win_embed.add_field(name="💰 Tokens Remaining", value=f"**{new_balance} Tokens**", inline=False)
    win_embed.add_field(name="📝 Claim Info", value="Request sent to **gumball-claims** — click **Request to Claim** there.", inline=False)
    win_embed.set_footer(text=f"Cost: 1 Token")

    await msg.edit(content=None, embed=win_embed)

    claim_id = int(time.time() * 1000)
    claim_data = {
        "claim_id": claim_id,
        "discord": str(interaction.user),
        "discord_id": interaction.user.id,
        "habbo_name": user.get("habbo_name", "Not set — use `/sethabbo` first!"),
        "item": won_item["name"],
        "value": f"{credit_val} Credits",
        "colour": group["name"],
        "status": "Pending",
        "time": time.strftime("%Y-%m-%d %H:%M")
    }
    DATA["pending_claims"][str(claim_id)] = claim_data
    save_index(DATA)

    claims_channel = bot.get_channel(CLAIMS_CHANNEL)
    if claims_channel:
        claim_embed = discord.Embed(
            title="📥 NEW PRIZE CLAIM",
            description=f"**Status:** ⏳ Pending\n**User:** {interaction.user.mention}\n**Habbo:** `{claim_data['habbo_name']}`",
            color=color_map[group["id"]]
        )
        claim_embed.set_thumbnail(url=furni_pic)
        claim_embed.set_author(name=interaction.user.display_name, icon_url=habbo_face)
        claim_embed.add_field(name="🎁 Item", value=won_item["name"], inline=False)
        claim_embed.add_field(name="💸 Value", value=f"{credit_val} Credits", inline=True)
        claim_embed.add_field(name="📊 Avg Price", value=f"~{avg_price}", inline=True)
        claim_embed.add_field(name="🎨 Rarity", value=group["name"], inline=True)
        claim_embed.set_footer(text=f"Claim ID: {claim_id}")

        await claims_channel.send(embed=claim_embed, view=ClaimView(claim_id=claim_id, winner_id=interaction.user.id))

# --------------------------
# Other Commands
# --------------------------
@tree.command(name="sethabbo", description="🔗 Link your Habbo username to your account")
async def sethabbo(interaction: discord.Interaction, habbo_name: str):
    user = get_user(interaction.user.id)
    user["habbo_name"] = habbo_name
    save_index(DATA)
    await interaction.response.send_message(f"✅ Habbo username set to: **{habbo_name}**", ephemeral=True)

@tree.command(name="balance", description="💳 Check your token balance")
async def balance(interaction: discord.Interaction):
    user = get_user(interaction.user.id)
    habbo = user.get("habbo_name", "Not set")
    embed = discord.Embed(title="💰 Your Balance", color=0x2ecc71)
    embed.set_thumbnail(url=get_habbo_avatar(habbo))
    embed.add_field(name="Tokens", value=f"**{user['balance']}**", inline=False)
    embed.add_field(name="Habbo", value=f"`{habbo}`", inline=False)
    await interaction.response.send_message(embed=embed)

@tree.command(name="deposit", description="🪙 Buy tokens with Habbo Credits")
@app_commands.describe(habbo_name="Your Habbo username", credits_sent="Amount sent")
async def deposit(interaction: discord.Interaction, habbo_name: str, credits_sent: int):
    if credits_sent < MIN_DEPOSIT:
        return await interaction.response.send_message(
            f"❌ Minimum: {MIN_DEPOSIT} Credits\nPackages:\n3c = 1 Token\n15c = 5 Tokens\n25c = 10 Tokens\n50c = 25 Tokens", ephemeral=True
        )
    if any(r["user_id"] == str(interaction.user.id) and r["status"] == "Pending" for r in DATA["deposit_requests"]):
        return await interaction.response.send_message("⚠️ You already have a pending request.", ephemeral=True)

    tokens = TOKEN_PACKAGES.get(str(credits_sent), credits_sent // BASE_RATE)
    req = {"id": len(DATA["deposit_requests"])+1, "user_id": str(interaction.user.id), "habbo": habbo_name, "credits": credits_sent, "tokens": tokens, "status": "Pending", "time": time.ctime()}
    DATA["deposit_requests"].append(req)
    save_index(DATA)
    await interaction.response.send_message(f"✅ Request: {credits_sent}c → {tokens} Tokens\n📍 {ROOM_LINK}\n✅ Deposit into **TOKEN CHEST**")

@tree.command(name="depositfurni", description="📦 Exchange furni: 20 = 1 Token")
@app_commands.describe(habbo_name="Your Habbo username", amount="Number of furni")
async def depositfurni(interaction: discord.Interaction, habbo_name: str, amount: int):
    if amount < FURNI_PER_TOKEN:
        return await interaction.response.send_message(f"❌ Minimum: {FURNI_PER_TOKEN} Furni", ephemeral=True)
    tokens = amount // FURNI_PER_TOKEN
    req = {"id": len(DATA["furni_deposits"])+1, "user_id": str(interaction.user.id), "habbo": habbo_name, "amount": amount, "tokens": tokens, "remainder": amount%FURNI_PER_TOKEN, "status": "Pending", "time": time.ctime()}
    DATA["furni_deposits"].append(req)
    save_index(DATA)
    await interaction.response.send_message(f"✅ Request: {amount} → {tokens} Tokens\n📍 {ROOM_LINK}\n✅ Deposit into **FURNI CHEST**")

@tree.command(name="howtogettokens", description="📋 Token guide")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def howtogettokens(interaction: discord.Interaction):
    embed = discord.Embed(title="🛒 HOW TO GET TOKENS", description="Two ways to play!", color=0x2ecc71)
    embed.add_field(name="🔹 Buy Credits", value=f"Command: `/deposit`\nRates: 3c=1, 15c=5, 25c=10, 50c=25\n📍 [Room]({ROOM_LINK}) → **TOKEN CHEST**", inline=False)
    embed.add_field(name="🔹 Exchange Furni", value=f"Command: `/depositfurni`\nRate: **20 Furni = 1 Token**\n📍 [Room]({ROOM_LINK}) → **FURNI CHEST**", inline=False)
    embed.add_field(name="🎁 Claiming", value="Wins go to **gumball-claims** — click **Request to Claim** when ready.", inline=False)
    await interaction.response.send_message(embed=embed)

@tree.command(name="howtocollectprize", description="📋 Claim guide")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def howtocollectprize(interaction: discord.Interaction):
    embed = discord.Embed(title="🎁 HOW TO COLLECT", description="Congratulations on your win!", color=0xFFD700)
    embed.add_field(name="📩 How to Claim", value="Go to **gumball-claims** and click **Request to Claim** on your prize.", inline=False)
    embed.add_field(name="📍 Collection Room", value=f"[Click here]({ROOM_LINK}) or search `cherby` → **Approval**", inline=False)
    await interaction.response.send_message(embed=embed)

# --------------------------
# Admin Commands
# --------------------------
@tree.command(name="addfurni", description="➕ Add furni")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def addfurni(interaction: discord.Interaction, colour: str, name: str, stock: int):
    if colour not in STOCK:
        return await interaction.response.send_message("❌ Valid colours: blue / purple / green / lilac / golden", ephemeral=True)
    existing = next((i for i in STOCK[colour] if i["name"].lower() == name.lower()), None)
    if existing:
        existing["stock"] += stock
    else:
        STOCK[colour].append({"name": name, "stock": stock})
    save_index(DATA)
    await interaction.response.send_message(f"✅ Added: **{name}** × {stock} to {colour}")

@tree.command(name="removefurni", description="➖ Remove furni")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def removefurni(interaction: discord.Interaction, colour: str, name: str, amount: int):
    if colour not in STOCK:
        return await interaction.response.send_message("❌ Invalid colour", ephemeral=True)
    item = next((i for i in STOCK[colour] if i["name"].lower() == name.lower()), None)
    if not item:
        return await interaction.response.send_message("❌ Item not found", ephemeral=True)
    if item["stock"] <= amount:
        STOCK[colour].remove(item)
    else:
        item["stock"] -= amount
    save_index(DATA)
    await interaction.response.send_message(f"✅ Updated: **{name}** now has {item.get('stock',0)} left")

@tree.command(name="viewstock", description="📋 View all current stock")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def viewstock(interaction: discord.Interaction):
    embed = discord.Embed(title="📦 Full Stock List", color=0x9b59b6)
    for g in COLOUR_GROUPS:
        items = "\n".join([f"• {i['name']} × {i['stock']}" for i in STOCK[g["id"]] if i["stock"]>0]) or "✅ Empty"
        embed.add_field(name=g["name"], value=items, inline=False)
    await interaction.response.send_message(embed=embed)

@tree.command(name="pending", description="👀 View pending credit deposits")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def pending(interaction: discord.Interaction):
    pending = [r for r in DATA["deposit_requests"] if r["status"] == "Pending"]
    if not pending:
        return await interaction.response.send_message("✅ No pending requests", ephemeral=True)
    embed = discord.Embed(title="⏳ Pending Credit Deposits", color=0xf39c12)
    for r in pending:
        embed.add_field(name=f"#{r['id']}", value=f"Habbo: {r['habbo']}\n{r['credits']}c → {r['tokens']} tokens", inline=False)
    await interaction.response.send_message(embed=embed)

@tree.command(name="approve", description="✅ Approve credit deposit")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def approve(interaction: discord.Interaction, request_id: int):
    req = next((r for r in DATA["deposit_requests"] if r["id"] == request_id and r["status"] == "Pending"), None)
    if not req:
        return await interaction.response.send_message("❌ Request not found.", ephemeral=True)
    user = get_user(req["user_id"])
    user["balance"] += req["tokens"]
    req["status"] = "Approved"
    save_index(DATA)
    await interaction.response.send_message(f"✅ Added **{req['tokens']} Tokens** to {req['habbo_name']}")

# --------------------------
# Auto‑Refresh Stock Display
# --------------------------
@tasks.loop(minutes=5)
async def refresh_shop():
    channel = bot.get_channel(STOCK_CHANNEL)
    if not channel:
        return
    embed = discord.Embed(
        title="🛋️ GUMBALL FURNI STOCK",
        description="All available items — **1 Token per pull** | Use `/gumball` to play!",
        color=0x9b59b6
    )
    for g in COLOUR_GROUPS:
        items = "\n".join([f"• {i['name']} × {i['stock']}" for i in STOCK[g["id"]] if i["stock"]>0]) or "✅ No stock available"
        embed.add_field(name=g["name"], value=items, inline=False)
    embed.set_footer(text="Stock updates every 5 minutes")

    async for msg in channel.history(limit=10):
        if msg.author == bot.user and msg.embeds and msg.embeds[0].title == "🛋️ GUMBALL FURNI STOCK":
            await msg.delete()
            break
    await channel.send(embed=embed)

@bot.event
async def on_ready():
    await tree.sync()
    refresh_shop.start()
    bot.add_view(ClaimView(0, 0))
    print("✅ Bot online — All systems active")

bot.run(BOT_TOKEN)
