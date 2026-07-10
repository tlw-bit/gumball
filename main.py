import discord
from discord import app_commands
from discord.ext import commands, tasks
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
        "bot": {},
        "rates": {},
        "colour_groups": [],
        "stock": {},
        "channels": {},
        "users": {},
        "deposit_requests": [],
        "pull_history": [],
        "furni_deposits": []
    }

def save_index(data):
    with open("index.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

DATA = load_index()

# ✅ Get token from Koyeb Environment Variable (safe)
BOT_TOKEN = os.getenv("BOT_TOKEN", DATA["bot"].get("token", ""))
YOUR_HABBO_NAME = DATA["bot"]["habbo_name"]
ADMIN_ROLE_ID = DATA["bot"]["admin_role_id"]  # ✅ Uses your owner role ID

COST_PER_PULL = DATA["rates"]["cost_per_pull"]
STARTING_TOKENS = DATA["rates"]["starting_tokens"]
FURNI_PER_TOKEN = DATA["rates"]["furni_per_token"]
TOKEN_PACKAGES = DATA["rates"]["token_packages"]
BASE_RATE = DATA["rates"]["base_rate"]
MIN_DEPOSIT = DATA["rates"]["min_deposit"]
COLOUR_GROUPS = DATA["colour_groups"]
STOCK = DATA["stock"]
CHANNELS = DATA["channels"]

# --------------------------
# Helper Functions
# --------------------------
def get_user(user_id):
    user_id = str(user_id)
    if user_id not in DATA["users"]:
        DATA["users"][user_id] = {"balance": STARTING_TOKENS}
        save_index(DATA)
    return DATA["users"][user_id]

def pick_colour_group():
    total = sum(g["chance"] for g in COLOUR_GROUPS)
    roll = random.uniform(0, total)
    current = 0
    for group in COLOUR_GROUPS:
        current += group["chance"]
        if roll <= current:
            return group

def get_random_item_from_group(colour_id):
    items = STOCK.get(colour_id, [])
    available = [i for i in items if i["stock"] > 0]
    return random.choice(available) if available else None

def get_furni_image(name):
    slug = name.lower().replace(" ", "_").replace("'", "").replace("&", "and")
    return f"https://images.habbo.com/dcr/hof_furni/{slug}_icon.png"

# --------------------------
# Bot Setup
# --------------------------
intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)
tree = bot.tree

# --------------------------
# 🎮 User Commands
# --------------------------
@tree.command(name="gumball", description="🎟️ Pull the lever! Cost: 1 Token")
async def gumball(interaction: discord.Interaction):
    user = get_user(interaction.user.id)
    if user["balance"] < COST_PER_PULL:
        return await interaction.response.send_message(
            f"❌ Not enough tokens! You have {user['balance']}, need {COST_PER_PULL}.", ephemeral=True
        )

    user["balance"] -= COST_PER_PULL
    save_index(DATA)

    await interaction.response.send_message("🎪 Pulling lever... 🔄 Spinning...")
    msg = await interaction.original_response()
    for _ in range(6):
        await msg.edit(content=f"🎪 Spinning... {random.choice(['🔵','🟣','💚','🟪','✨'])}")
        await asyncio.sleep(0.35)

    group = pick_colour_group()
    won_item = get_random_item_from_group(group["id"])

    if not won_item:
        user["balance"] += COST_PER_PULL
        save_index(DATA)
        return await msg.edit(content=f"😕 No stock in {group['name']} — token refunded.")

    won_item["stock"] -= 1
    save_index(DATA)

    credit_value = random.randint(group["credit_min"], group["credit_max"])
    tokens_won = random.randint(group["token_min"], group["token_max"])
    user["balance"] += tokens_won
    save_index(DATA)

    DATA["pull_history"].append({
        "user": str(interaction.user),
        "colour": group["name"],
        "item": won_item["name"],
        "value": credit_value,
        "tokens_won": tokens_won,
        "net": tokens_won - COST_PER_PULL,
        "time": time.strftime("%Y-%m-%d %H:%M")
    })
    save_index(DATA)

    color_map = {
        "blue": 0x3498db,
        "purple": 0x9b59b6,
        "green": 0x2ecc71,
        "lilac": 0xa884f7,
        "golden": 0xFFD700
    }

    embed = discord.Embed(
        title="🎉 CONGRATULATIONS! YOU WON!",
        description=f"{interaction.user.mention}",
        color=color_map[group["id"]]
    )
    embed.add_field(name="🎁 Prize", value=f"**{won_item['name']}**", inline=False)
    embed.add_field(name="💸 Value", value=f"{credit_value} Credits", inline=True)
    embed.add_field(name="🎟️ Tokens", value=f"+{tokens_won}", inline=True)
    embed.add_field(name="📝 Collection", value="Contact an admin to collect.", inline=False)
    embed.set_thumbnail(url=get_furni_image(won_item["name"]))
    embed.set_footer(text=f"Cost: 1 Token | New Balance: {user['balance']}")

    await msg.edit(content=None, embed=embed)

    # 📢 Public win announcement
    win_channel = bot.get_channel(CHANNELS.get("wins"))
    if win_channel:
        announce = discord.Embed(
            title="✨ NEW WIN!",
            description=f"{interaction.user.mention} won **{group['name']}**!",
            color=color_map[group["id"]]
        )
        announce.add_field(name="Prize", value=won_item["name"], inline=True)
        announce.add_field(name="Value", value=f"{credit_value} Credits", inline=True)
        await win_channel.send(embed=announce)

@tree.command(name="balance", description="💳 Check your token balance")
async def balance(interaction: discord.Interaction):
    user = get_user(interaction.user.id)
    await interaction.response.send_message(f"💰 Balance: **{user['balance']} Tokens**")

@tree.command(name="deposit", description="🪙 Buy tokens with Habbo Credits")
@app_commands.describe(habbo_name="Your Habbo name", credits_sent="Amount sent")
async def deposit(interaction: discord.Interaction, habbo_name: str, credits_sent: int):
    if credits_sent < MIN_DEPOSIT:
        return await interaction.response.send_message(f"❌ Min: {MIN_DEPOSIT}c", ephemeral=True)
    if any(r["user_id"] == str(interaction.user.id) and r["status"] == "Pending" for r in DATA["deposit_requests"]):
        return await interaction.response.send_message("⚠️ You have a pending request.", ephemeral=True)

    tokens = TOKEN_PACKAGES.get(str(credits_sent), credits_sent // BASE_RATE)
    req = {
        "id": len(DATA["deposit_requests"]) + 1,
        "user_id": str(interaction.user.id),
        "habbo": habbo_name,
        "credits": credits_sent,
        "tokens": tokens,
        "status": "Pending",
        "time": time.ctime()
    }
    DATA["deposit_requests"].append(req)
    save_index(DATA)
    await interaction.response.send_message(f"✅ Request: {credits_sent}c → {tokens} Tokens\nSend to: `{YOUR_HABBO_NAME}`")

@tree.command(name="depositfurni", description="📦 Deposit furni: 20 = 1 Token")
@app_commands.describe(habbo_name="Your Habbo name", amount="Number of furni")
async def depositfurni(interaction: discord.Interaction, habbo_name: str, amount: int):
    if amount < FURNI_PER_TOKEN:
        return await interaction.response.send_message(f"❌ Min: {FURNI_PER_TOKEN} furni", ephemeral=True)
    tokens = amount // FURNI_PER_TOKEN
    remainder = amount % FURNI_PER_TOKEN

    if any(d["user_id"] == str(interaction.user.id) and d["status"] == "Pending" for d in DATA["furni_deposits"]):
        return await interaction.response.send_message("⚠️ Pending request exists.", ephemeral=True)

    dep = {
        "id": len(DATA["furni_deposits"]) + 1,
        "user_id": str(interaction.user.id),
        "discord": str(interaction.user),
        "habbo": habbo_name,
        "amount": amount,
        "tokens": tokens,
        "remainder": remainder,
        "status": "Pending",
        "time": time.ctime()
    }
    DATA["furni_deposits"].append(dep)
    save_index(DATA)
    await interaction.response.send_message(f"✅ Request: {amount} Furni → {tokens} Tokens\nSend to: `{YOUR_HABBO_NAME}`")

# --------------------------
# 🛠️ Admin Commands (Only Owner Role)
# --------------------------
@tree.command(name="setshopchannel", description="📌 Set shop display channel")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def setshopchannel(interaction: discord.Interaction, channel: discord.TextChannel):
    CHANNELS["shop"] = channel.id
    save_index(DATA)
    await interaction.response.send_message(f"✅ Shop channel set to {channel.mention}")

@tree.command(name="setwinchannel", description="📢 Set win announcement channel")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def setwinchannel(interaction: discord.Interaction, channel: discord.TextChannel):
    CHANNELS["wins"] = channel.id
    save_index(DATA)
    await interaction.response.send_message(f"✅ Win channel set to {channel.mention}")

@tree.command(name="addfurni", description="➕ Add furni to stock")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def addfurni(interaction: discord.Interaction, colour: str, name: str, stock: int):
    if colour not in STOCK:
        return await interaction.response.send_message("❌ Use: blue/purple/green/lilac/golden", ephemeral=True)
    existing = next((i for i in STOCK[colour] if i["name"].lower() == name.lower()), None)
    if existing:
        existing["stock"] += stock
    else:
        STOCK[colour].append({"name": name, "stock": stock})
    save_index(DATA)
    await interaction.response.send_message(f"✅ Added: {name} × {stock} in {colour}")

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
    await interaction.response.send_message(f"✅ Updated: {name} now {item.get('stock',0)}")

@tree.command(name="viewstock", description="📋 View all stock")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def viewstock(interaction: discord.Interaction):
    embed = discord.Embed(title="📦 Current Stock", color=0x9b59b6)
    for g in COLOUR_GROUPS:
        items = "\n".join([f"• {i['name']} × {i['stock']}" for i in STOCK[g["id"]] if i["stock"]>0]) or "Empty"
        embed.add_field(name=g["name"], value=items, inline=False)
    await interaction.response.send_message(embed=embed)

@tree.command(name="pending", description="👀 View pending credit deposits")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def pending(interaction: discord.Interaction):
    pending = [r for r in DATA["deposit_requests"] if r["status"] == "Pending"]
    if not pending:
        return await interaction.response.send_message("✅ No pending requests", ephemeral=True)
    embed = discord.Embed(title="⏳ Pending Deposits", color=0xf39c12)
    for r in pending:
        embed.add_field(name=f"#{r['id']}", value=f"Habbo: {r['habbo']}\n{r['credits']}c → {r['tokens']} tokens", inline=False)
    await interaction.response.send_message(embed=embed)

@tree.command(name="approve", description="✅ Approve credit deposit")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def approve(interaction: discord.Interaction, request_id: int):
    req = next((r for r in DATA["deposit_requests"] if r["id"] == request_id and r["status"] == "Pending"), None)
    if not req:
        return await interaction.response.send_message("❌ Not found", ephemeral=True)
    user = get_user(req["user_id"])
    user["balance"] += req["tokens"]
    req["status"] = "Approved"
    save_index(DATA)
    await interaction.response.send_message(f"✅ Added {req['tokens']} tokens")

@tree.command(name="pendingfurni", description="📋 View pending furni deposits")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def pendingfurni(interaction: discord.Interaction):
    pending = [d for d in DATA["furni_deposits"] if d["status"] == "Pending"]
    if not pending:
        return await interaction.response.send_message("✅ No pending", ephemeral=True)
    embed = discord.Embed(title="⏳ Pending Furni", color=0xf39c12)
    for d in pending:
        embed.add_field(name=f"#{d['id']}", value=f"Habbo: {d['habbo']}\n{d['amount']} → {d['tokens']} tokens", inline=False)
    await interaction.response.send_message(embed=embed)

@tree.command(name="approvefurni", description="✅ Approve furni deposit")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def approvefurni(interaction: discord.Interaction, deposit_id: int):
    req = next((d for d in DATA["furni_deposits"] if d["id"] == deposit_id and d["status"] == "Pending"), None)
    if not req:
        return await interaction.response.send_message("❌ Not found", ephemeral=True)
    user = get_user(req["user_id"])
    user["balance"] += req["tokens"]
    req["status"] = "Approved"
    save_index(DATA)
    await interaction.response.send_message(f"✅ Added {req['tokens']} tokens")

@tree.command(name="pullhistory", description="📜 View recent win history")
@app_commands.checks.has_role(ADMIN_ROLE_ID)
async def pullhistory(interaction: discord.Interaction):
    if not DATA["pull_history"]:
        return await interaction.response.send_message("📭 No history yet", ephemeral=True)
    embed = discord.Embed(title="📜 Recent Wins", color=0x9b59b6)
    for entry in reversed(DATA["pull_history"][-10:]):
        embed.add_field(name=entry["time"], value=f"{entry['user']} → {entry['colour']} | {entry['item']} | Net: {entry['net']}", inline=False)
    await interaction.response.send_message(embed=embed)

# --------------------------
# 🔄 Auto Refresh Shop
# --------------------------
@tasks.loop(minutes=5)
async def refresh_shop():
    channel = bot.get_channel(CHANNELS.get("shop"))
    if not channel:
        return
    embed = discord.Embed(
        title="🛋️ GUMBALL FURNI SHOP",
        description="Use `/gumball` to play — 1 Token per pull!",
        color=0x9b59b6
    )
    for g in COLOUR_GROUPS:
        items = "\n".join([f"• {i['name']} × {i['stock']}" for i in STOCK[g["id"]] if i["stock"]>0]) or "✅ Empty"
        embed.add_field(name=g["name"], value=items, inline=False)
    async for msg in channel.history(limit=10):
        if msg.author == bot.user and msg.embeds and msg.embeds[0].title == "🛋️ GUMBALL FURNI SHOP":
            await msg.delete()
            break
    await channel.send(embed=embed)

@bot.event
async def on_ready():
    await tree.sync()
    refresh_shop.start()
    print("✅ Bot online — using owner role ID for admin access")

bot.run(BOT_TOKEN)
