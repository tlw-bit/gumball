import io
import os
import re
import json
import math
import uuid
import random
import datetime as dt
from typing import Any, Optional, List, Tuple

import aiohttp
import discord

from config import CONFIG, DATA_FILE, STOCK_FILE, LINKS_FILE


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def ts() -> str:
    return utcnow().isoformat()


def ensure_file(path: str, default: Any):
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(default, f, indent=2)


def bootstrap_files():
    ensure_file(DATA_FILE, {
        "users": {},
        "pending_claims": {},
        "deposits": {},
        "stock_message_id": None,
        "stock_channel_id": None,
        "leaderboard": {"week_start": None, "spins": {}, "value_won": {}},
    })
    ensure_file(STOCK_FILE, {"items": []})
    ensure_file(LINKS_FILE, {})


def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: str, data: Any):
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def load_data():
    return load_json(DATA_FILE)


def save_data(data):
    save_json(DATA_FILE, data)


def load_stock():
    return load_json(STOCK_FILE)


def save_stock(data):
    save_json(STOCK_FILE, data)


def load_links():
    return load_json(LINKS_FILE)


def save_links(data):
    save_json(LINKS_FILE, data)


def user_bucket(data: dict, user_id: int) -> dict:
    uid = str(user_id)
    if uid not in data["users"]:
        data["users"][uid] = {
            "tokens": 0,
            "spins": 0,
            "total_spent": 0,
            "total_won": 0,
            "history": [],
            "claims": [],
        }
    return data["users"][uid]


def has_staff_role(member: discord.Member) -> bool:
    ids = set(CONFIG["staff_role_ids"])
    return any(r.id in ids for r in member.roles) or member.guild_permissions.administrator


def normalise_name(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip()


def build_habbo_image_url(name: str) -> str:
    safe = re.sub(r"[^a-z0-9_\- ]", "", name.lower()).strip().replace(" ", "_") or "unknown"
    return f"https://images.habbo.com/c_images/catalogue/icons/{safe}_icon.png"


def find_item(stock: dict, name: str, rarity: Optional[str] = None) -> Optional[dict]:
    n = normalise_name(name).lower()
    for item in stock["items"]:
        if item["name"].lower() == n and (rarity is None or item["rarity"] == rarity):
            return item
    return None


def choose_rarity() -> str:
    keys = list(CONFIG["rarities"].keys())
    weights = [CONFIG["rarities"][k]["chance"] for k in keys]
    return random.choices(keys, weights=weights, k=1)[0]


def get_items_by_rarity(stock: dict, rarity: str) -> List[dict]:
    return [x for x in stock["items"] if x["rarity"] == rarity and x.get("quantity", 0) > 0]


def get_week_start(now: Optional[dt.datetime] = None) -> str:
    now = now or utcnow()
    weekday = now.weekday()
    days_since_sunday = (weekday + 1) % 7
    sunday = (now - dt.timedelta(days=days_since_sunday)).replace(hour=18, minute=0, second=0, microsecond=0)
    if now < sunday:
        sunday -= dt.timedelta(days=7)
    return sunday.isoformat()


def ensure_leaderboard_window(data: dict):
    current = get_week_start()
    lb = data.setdefault("leaderboard", {"week_start": None, "spins": {}, "value_won": {}})
    if lb.get("week_start") != current:
        lb["week_start"] = current
        lb["spins"] = {}
        lb["value_won"] = {}


def leaderboard_add_spin(data: dict, user_id: int, value: int):
    ensure_leaderboard_window(data)
    uid = str(user_id)
    lb = data["leaderboard"]
    lb["spins"][uid] = lb["spins"].get(uid, 0) + 1
    lb["value_won"][uid] = lb["value_won"].get(uid, 0) + value


async def fetch_image_bytes(url: str) -> Optional[bytes]:
    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                if resp.status == 200:
                    return await resp.read()
    except Exception:
        return None
    return None


async def resolve_image_bytes(item: dict) -> Tuple[Optional[bytes], str]:
    candidates = []
    if item.get("image_url"):
        candidates.append(item["image_url"])
    candidates.append(build_habbo_image_url(item["name"]))
    if CONFIG.get("default_image"):
        candidates.append(CONFIG["default_image"])
    if CONFIG.get("placeholder_image"):
        candidates.append(CONFIG["placeholder_image"])
    for url in candidates:
        data = await fetch_image_bytes(url)
        if data:
            return data, url
    return None, candidates[-1]


async def make_embed_with_attachment(item: dict, title: str, description: str, colour: int):
    embed = discord.Embed(title=title, description=description, colour=colour, timestamp=utcnow())
    image_bytes, src = await resolve_image_bytes(item)
    if image_bytes:
        filename = f"item_{uuid.uuid4().hex[:8]}.png"
        file = discord.File(io.BytesIO(image_bytes), filename=filename)
        embed.set_image(url=f"attachment://{filename}")
        embed.set_footer(text=f"Image source resolved • {src[:100]}")
        return embed, file
    embed.set_footer(text="No image available")
    return embed, None


def stock_page_embed(stock: dict, rarity: str, page: int = 0) -> discord.Embed:
    rarity_meta = CONFIG["rarities"][rarity]
    items = get_items_by_rarity(stock, rarity)
    per_page = 10
    pages = max(1, math.ceil(len(items) / per_page))
    page = max(0, min(page, pages - 1))
    chunk = items[page * per_page:(page + 1) * per_page]
    embed = discord.Embed(
        title=f"{rarity_meta['label']} prizes",
        colour=rarity_meta["colour"],
        description=f"Showing stock for **{rarity_meta['label']}** items. Page {page + 1}/{pages}.",
        timestamp=utcnow(),
    )
    if not chunk:
        embed.add_field(name="No stock", value="There are currently no items in this rarity.", inline=False)
    else:
        for item in chunk:
            embed.add_field(
                name=f"{item['name']} x{item['quantity']}",
                value=f"Price: {item['price']} tokens\nClaim value: {item.get('value', item['price'])}",
                inline=True,
            )
    embed.set_footer(text=f"Last updated • {CONFIG['images_per_row']} images per row layout available in collage mode")
    return embed
