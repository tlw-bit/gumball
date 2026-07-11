import os

CONFIG = {
    "token": os.getenv("DISCORD_BOT_TOKEN", "PUT_BOT_TOKEN_HERE"),
    "guild_id": 0,
    "verified_role_id": 0,
    "staff_role_ids": [0],
    "stock_channel_id": 0,
    "log_channel_id": 0,
    "deposit_log_channel_id": 0,
    "leaderboard_channel_id": 0,
    "credits_per_token": 50,
    "furni_per_token": 1,
    "images_per_row": 5,
    "stock_update_minutes": 15,
    "default_image": "https://images.habbo.com/c_images/catalogue/icons/placeholder_icon.png",
    "placeholder_image": "https://via.placeholder.com/128x128.png?text=%20",
    "rarities": {
        "blue": {"label": "Blue", "colour": 0x3498DB, "chance": 50.0},
        "purple": {"label": "Purple", "colour": 0x9B59B6, "chance": 25.0},
        "green": {"label": "Green", "colour": 0x2ECC71, "chance": 15.0},
        "lilac": {"label": "Lilac", "colour": 0xC8A2C8, "chance": 8.0},
        "golden": {"label": "Golden", "colour": 0xF1C40F, "chance": 2.0},
    },
}

DATA_FILE = "data.json"
STOCK_FILE = "stock.json"
LINKS_FILE = "habboLinks.json"
