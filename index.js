require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  SlashCommandBuilder,
  MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const fetch = require('node-fetch');

// ==============================================
// CONFIGURATION
// ==============================================
const CONFIG = {
  bot: {
    token: process.env.BOT_TOKEN || "",
    guild_id: process.env.GUILD_ID || "",
    verified_role_id: process.env.VERIFIED_ROLE_ID || "",
    admin_role_id: process.env.ADMIN_ROLE_ID || ""
  },
  channels: {
    log: process.env.LOG_CHANNEL_ID || "",
    stock_display: process.env.STOCK_DISPLAY_CHANNEL_ID || ""
  },
  habbo_assets_token: process.env.HABBO_ASSETS_TOKEN || "",
  rarity_groups: [
    { id: "blue", name: "🔵 BLUE RARITY", color: "#3498db" },
    { id: "purple", name: "🟣 PURPLE RARITY", color: "#9b59b6" },
    { id: "green", name: "🟢 GREEN RARITY", color: "#2ecc71" },
    { id: "lilac", name: "💜 LILAC RARITY", color: "#e84393" },
    { id: "golden", name: "🟡 GOLDEN RARITY", color: "#f1c40f" }
  ]
};

// ==============================================
// DATA FILES
// ==============================================
const STOCK_PATH = path.join(__dirname, 'stock.json');
const DATA_PATH = path.join(__dirname, 'data.json');

let STOCK = { blue: [], purple: [], green: [], lilac: [], golden: [] };
if (fs.existsSync(STOCK_PATH)) try { STOCK = JSON.parse(fs.readFileSync(STOCK_PATH, 'utf8')); } catch {}

let DATA = { users: {}, stock_display_message_id: null };
if (fs.existsSync(DATA_PATH)) try { DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch {}

function saveStock() { fs.writeFileSync(STOCK_PATH, JSON.stringify(STOCK, null, 2)); }
function saveData() { fs.writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2)); }

// ==============================================
// HELPER: Normalize names for matching
// ==============================================
function normalizeName(str) {
  return str.trim().toLowerCase().replace(/[-_ '"]+/g, '');
}

// ==============================================
// FURNI LOOKUP — MORE FLEXIBLE LOGIC
// ==============================================
async function getFurniDetails(furniName) {
  const originalName = furniName.trim();
  const searchKey = normalizeName(originalName);

  let iconUrl = "https://i.imgur.com/9Z7X9QH.png";
  let exists = false;
  let price = "❌ No price data";
  let matchedName = originalName;

  // 1. Try Habbo Assets first
  if (CONFIG.habbo_assets_token) {
    try {
      const res = await fetch(`https://habboassets.com/api/search?q=${encodeURIComponent(originalName)}&limit=15`, {
        headers: { Authorization: `Bearer ${CONFIG.habbo_assets_token}` },
        timeout: 4000
      });
      if (res.ok) {
        const data = await res.json();
        let match = data.items?.find(i => normalizeName(i.name) === searchKey);
        if (!match) match = data.items?.find(i => normalizeName(i.name).includes(searchKey));
        if (match) {
          iconUrl = match.image_url || match.icon_url;
          matchedName = match.name;
          exists = true;
        }
      }
    } catch {}
  }

  // 2. Fallback to Habbofurni
  if (!exists) {
    const safeName = originalName.toLowerCase().replace(/ /g, "_").replace(/'/g, "").replace(/&/g, "and").replace(/-/g, "_");
    try {
      const res = await fetch(`https://habbofurni.com/api/v1/furniture/${safeName}`, { timeout: 3000 });
      if (res.ok) {
        const data = await res.json();
        if (data?.image) {
          iconUrl = data.image;
          exists = true;
        }
      }
    } catch {}
  }

  // 3. Get price from FurniEye — if we get a price, treat as "found"
  try {
    const res = await fetch(`https://www.furnieye.com/api/search?q=${encodeURIComponent(originalName)}`, { timeout: 3000 });
    if (res.ok) {
      const data = await res.json();
      let match = data.results?.find(i => normalizeName(i.name) === searchKey);
      if (!match) match = data.results?.find(i => normalizeName(i.name).includes(searchKey));
      if (match?.average_price != null) {
        price = `${match.average_price}c`;
        if (!exists) exists = true; // ✅ Price found = valid item
      }
    }
  } catch {}

  return { icon: iconUrl, price, exists, name: matchedName };
}

// ==============================================
// STOCK DISPLAY
// ==============================================
async function buildStockEmbed() {
  const embed = new EmbedBuilder()
    .setTitle("🎁 Available Prizes & Stock")
    .setDescription("Grouped by rarity • 5 items per row\n*Images: Habbo Assets • Prices: FurniEye*")
    .setColor("#7289da")
    .setTimestamp();

  for (const group of CONFIG.rarity_groups) {
    const items = STOCK[group.id].filter(i => i.stock > 0);
    if (!items.length) {
      embed.addFields({ name: group.name, value: "> No items currently in stock", inline: false });
      continue;
    }

    let content = "";
    for (let i = 0; i < items.length; i += 5) {
      const row = items.slice(i, i + 5);
      const names = [], images = [], info = [];
      for (const item of row) {
        const d = await getFurniDetails(item.name);
        names.push(d.name.padEnd(18));
        images.push(`[ ](${d.icon})`.padEnd(18));
        info.push(`${d.price} | Stock: ${item.stock}`.padEnd(22));
      }
      content += `\`\`\`${names.join(" | ")}\n${images.join(" | ")}\n${info.join(" | ")}\`\`\`\n\n`;
    }
    embed.addFields({ name: group.name, value: content.trim(), inline: false });
  }
  return embed;
}

async function updateStockDisplay() {
  if (!CONFIG.channels.stock_display) return;
  const ch = await client.channels.fetch(CONFIG.channels.stock_display).catch(() => null);
  if (!ch) return;
  const embed = await buildStockEmbed();
  try {
    if (DATA.stock_display_message_id) {
      const msg = await ch.messages.fetch(DATA.stock_display_message_id).catch(() => null);
      if (msg) return msg.edit({ embeds: [embed] });
    }
    const newMsg = await ch.send({ embeds: [embed] });
    DATA.stock_display_message_id = newMsg.id;
    saveData();
  } catch {}
}

// ==============================================
// BOT SETUP
// ==============================================
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once("clientReady", async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  const guild = client.guilds.cache.get(CONFIG.bot.guild_id);
  if (!guild) return console.error("❌ Invalid GUILD_ID");

  const commands = [
    new SlashCommandBuilder().setName("showprizes").setDescription("View live stock, prices and images"),
    new SlashCommandBuilder().setName("addstock").setDescription("Add items to stock")
      .addStringOption(o => o.setName("group").setDescription("blue / purple / green / lilac / golden").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Furni name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity to add").setRequired(true))
      .addBooleanOption(o => o.setName("force").setDescription("Add even if not found in APIs").setRequired(false)), // ✅ NEW FORCE OPTION
    new SlashCommandBuilder().setName("removestock").setDescription("Remove items from stock")
      .addStringOption(o => o.setName("group").setDescription("blue / purple / green / lilac / golden").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Furni name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity to remove").setRequired(true))
  ];
  await guild.commands.set(commands);
  console.log("✅ Commands registered");

  cron.schedule("*/5 * * * *", updateStockDisplay);
  await updateStockDisplay();
});

// ==============================================
// COMMANDS HANDLER
// ==============================================
client.on("interactionCreate", async int => {
  if (!int.isChatInputCommand()) return;
  const isStaff = int.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || 
                  (CONFIG.bot.admin_role_id && int.member.roles.cache.has(CONFIG.bot.admin_role_id));

  try {
    await int.deferReply({ flags: MessageFlags.Ephemeral });

    switch (int.commandName) {
      case "showprizes":
        return int.editReply({ embeds: [await buildStockEmbed()], flags: 0 });

      case "addstock": {
        if (!isStaff) return int.editReply({ content: "❌ You don't have permission to do this." });
        const group = int.options.getString("group").toLowerCase();
        const inputName = int.options.getString("name");
        const amount = int.options.getInteger("amount");
        const force = int.options.getBoolean("force") || false; // ✅ Read force flag

        if (!STOCK.hasOwnProperty(group))
          return int.editReply({ content: "❌ Invalid group. Use: blue / purple / green / lilac / golden" });

        const details = await getFurniDetails(inputName);

        // ✅ Allow adding if force = true OR item was found
        if (!details.exists && !force) {
          return int.editReply({ 
            content: `⚠️ **"${inputName}"** could not be found.\nUse \`force: true\` to add it anyway.` 
          });
        }

        const searchKey = normalizeName(details.name);
        const existing = STOCK[group].find(i => normalizeName(i.name) === searchKey);
        if (existing) {
          existing.stock += amount;
          existing.name = details.name;
        } else {
          STOCK[group].push({ name: details.name, stock: amount });
        }

        saveStock();
        await updateStockDisplay();
        return int.editReply({
          content: `✅ Added **${amount}x ${details.name}**\n💰 Price: ${details.price}\n${force ? "⚠️ Added manually (no API match)" : ""}`
        });
      }

      case "removestock": {
        if (!isStaff) return int.editReply({ content: "❌ You don't have permission to do this." });
        const group = int.options.getString("group").toLowerCase();
        const inputName = int.options.getString("name");
        const amount = int.options.getInteger("amount");

        const searchKey = normalizeName(inputName);
        const idx = STOCK[group].findIndex(i => normalizeName(i.name) === searchKey);
        if (idx === -1)
          return int.editReply({ content: `❌ Item **"${inputName}"** not found in stock.` });

        STOCK[group][idx].stock -= amount;
        if (STOCK[group][idx].stock <= 0) {
          STOCK[group].splice(idx, 1);
        }

        saveStock();
        await updateStockDisplay();
        return int.editReply({
          content: `✅ Removed **${amount}x ${STOCK[group][idx]?.name || inputName}**`
        });
      }
    }
  } catch (err) {
    console.error("❌ Error:", err);
    if (int.deferred) int.editReply({ content: "❌ Something went wrong." }).catch(() => {});
  }
});

client.login(CONFIG.bot.token);
