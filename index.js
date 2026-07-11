require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  PermissionsBitField
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
    mod_awareness: process.env.MOD_AWARENESS_CHANNEL || "",
    claims: process.env.CLAIMS_CHANNEL || "",
    log: process.env.LOG_CHANNEL || "",
    stock_display: process.env.STOCK_DISPLAY_CHANNEL || "",
    leaderboard: process.env.LEADERBOARD_CHANNEL || ""
  },
  rates: {
    starting_tokens: 0,
    credit_per_token: 3,
    furni_per_token: 20
  },
  default_image: "https://www.habboassets.com/assets/images/furniture/unknown.png",
  rarity_groups: [
    { id: "blue", name: "🔵 BLUE RARITY", color: "#3498db", weight: 53 },
    { id: "purple", name: "🟣 PURPLE RARITY", color: "#9b59b6", weight: 30 },
    { id: "green", name: "🟢 GREEN RARITY", color: "#2ecc71", weight: 10 },
    { id: "lilac", name: "🟣 LILAC RARITY", color: "#e84393", weight: 5 },
    { id: "golden", name: "🟡 GOLDEN RARITY", color: "#f1c40f", weight: 2 }
  ]
};

// ==============================================
// DATA FILES
// ==============================================
const HABBO_LINKS_PATH = path.join(__dirname, 'habboLinks.json');
const STOCK_PATH = path.join(__dirname, 'stock.json');
const DATA_PATH = path.join(__dirname, 'data.json');

let habboLinks = {};
if (fs.existsSync(HABBO_LINKS_PATH)) {
  try { habboLinks = JSON.parse(fs.readFileSync(HABBO_LINKS_PATH, 'utf8')); }
  catch { habboLinks = {}; fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify(habboLinks, null, 2)); }
} else fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify({}, null, 2));

let STOCK = { blue: [], purple: [], green: [], lilac: [], golden: [] };
if (fs.existsSync(STOCK_PATH)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(STOCK_PATH, 'utf8'));
    Object.keys(STOCK).forEach(k => STOCK[k] = Array.isArray(loaded[k]) ? loaded[k] : []);
  } catch {
    fs.writeFileSync(STOCK_PATH, JSON.stringify(STOCK, null, 2));
  }
} else fs.writeFileSync(STOCK_PATH, JSON.stringify(STOCK, null, 2));

let DATA = {
  users: {},
  deposit_requests: {},
  pending_claims: {},
  stock_display_message_id: null,
  leaderboard_message_id: null,
  weekly_stats: {}
};
if (fs.existsSync(DATA_PATH)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    DATA = { ...DATA, ...loaded };
  } catch {
    fs.writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2));
  }
} else fs.writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2));

function saveStock() { fs.writeFileSync(STOCK_PATH, JSON.stringify(STOCK, null, 2)); }
function saveData() { fs.writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2)); }
function saveHabboLinks() { fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify(habboLinks, null, 2)); }

// ==============================================
// HELPER FUNCTIONS
// ==============================================
function normalizeName(str) {
  return str.trim().toLowerCase().replace(/[-_ '".]/g, '');
}

function getHabboName(discordId) {
  return habboLinks[discordId] || "Not linked";
}

function getAvatar(habboName) {
  if (!habboName || habboName === "Not linked") return "https://www.habbo.com/webassets/images/habbo-avatar.png";
  return `https://www.habbo.com/habbo-imaging/avatarimage?user=${encodeURIComponent(habboName)}&direction=2&head_direction=2&gesture=sml&size=m`;
}

function parsePriceToCredits(priceStr) {
  if (!priceStr || priceStr === "❌ No price data") return 0;
  const num = parseInt(priceStr.replace(/[^0-9]/g, ''), 10);
  return isNaN(num) ? 0 : num;
}

async function getFurniDetails(furniName) {
  const original = furniName.trim();
  const searchKey = normalizeName(original);

  let iconUrl = CONFIG.default_image;
  let price = "❌ No price data";
  let matchedName = original;

  try {
    const res = await fetch(`https://api.habbo.com/marketplace/search?query=${encodeURIComponent(original)}&limit=1`);
    if (res.ok) {
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        const item = data.results[0];
        matchedName = item.name;
        price = `${item.price}c`;
        iconUrl = item.imageUrl || CONFIG.default_image;
      }
    }
  } catch {}

  return { icon: iconUrl, price, name: matchedName };
}

function getWeightedRarity() {
  const weights = CONFIG.rarity_groups.map(r => r.weight);
  const total = weights.reduce((a, b) => a + b, 0);
  let random = Math.random() * total;
  for (const rarity of CONFIG.rarity_groups) {
    random -= rarity.weight;
    if (random <= 0) return rarity;
  }
  return CONFIG.rarity_groups[0];
}

// ==============================================
// ✅ STOCK DISPLAY — DEFINED EARLY SO NO ERRORS
// ==============================================
async function buildStockEmbeds() {
  const embeds = [];

  for (const group of CONFIG.rarity_groups) {
    const items = STOCK[group.id].filter(i => i.stock > 0);
    const totalStock = items.reduce((sum, item) => sum + item.stock, 0);

    const embed = new EmbedBuilder()
      .setTitle(group.name)
      .setColor(group.color)
      .setDescription("**Prices:** Market Average — final value may vary due to tax/fees")
      .setTimestamp();

    if (totalStock === 0) {
      embed.setDescription(`**Prices:** Market Average — final value may vary due to tax/fees\n\n> No items currently in stock`);
    } else {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const details = await getFurniDetails(item.name);

        embed.addFields({
          name: `**${details.name}**`,
          value: `Market Avg: ${details.price}\nStock: ${item.stock}\n[⠀](${details.icon})`,
          inline: true
        });

        if ((i + 1) % 5 === 0) {
          embed.addFields({ name: "\u200B", value: "\u200B", inline: true });
        }
      }
    }

    embed.setFooter({ text: `Total in category: ${totalStock} items • Updated every 15 mins` });
    embeds.push(embed);
  }

  return embeds;
}

async function updateStockDisplay() {
  if (!CONFIG.channels.stock_display) return;
  const ch = await client.channels.fetch(CONFIG.channels.stock_display).catch(() => null);
  if (!ch) return;

  const embeds = await buildStockEmbeds();

  try {
    if (DATA.stock_display_message_id) {
      const msg = await ch.messages.fetch(DATA.stock_display_message_id).catch(() => null);
      if (msg) return msg.edit({ embeds: embeds });
    }
    const newMsg = await ch.send({ embeds: embeds });
    DATA.stock_display_message_id = newMsg.id;
    saveData();
  } catch {}
}

// ==============================================
// LEADERBOARD
// ==============================================
async function updateLeaderboard() {
  if (!CONFIG.channels.leaderboard) return;
  const ch = await client.channels.fetch(CONFIG.channels.leaderboard).catch(() => null);
  if (!ch) return;

  const sorted = Object.entries(DATA.users)
    .sort((a, b) => (b[1].tokens || 0) - (a[1].tokens || 0))
    .slice(0, 10);

  const embed = new EmbedBuilder()
    .setTitle("🏆 Top Token Holders")
    .setColor("#f1c40f")
    .setDescription(sorted.length ? sorted.map((u, i) => `**${i+1}.** <@${u[0]}> — ${u[1].tokens || 0} tokens`).join("\n") : "No users yet.")
    .setTimestamp();

  try {
    if (DATA.leaderboard_message_id) {
      const msg = await ch.messages.fetch(DATA.leaderboard_message_id).catch(() => null);
      if (msg) return msg.edit({ embeds: [embed] });
    }
    const newMsg = await ch.send({ embeds: [embed] });
    DATA.leaderboard_message_id = newMsg.id;
    saveData();
  } catch {}
}

// ==============================================
// DISCORD CLIENT
// ==============================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`✅ Connected to server: ${client.guilds.cache.first()?.name}`);

  // Register commands
  const commands = [
    new SlashCommandBuilder().setName("gumball").setDescription("Spin for a reward"),
    new SlashCommandBuilder().setName("stock").setDescription("View current stock"),
    new SlashCommandBuilder().setName("addstock").setDescription("Add item to stock")
      .addStringOption(o => o.setName("name").setDescription("Item name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Amount to add").setRequired(true))
      .addStringOption(o => o.setName("rarity").setDescription("Rarity").setRequired(true).addChoices(
        { name: "Blue", value: "blue" },
        { name: "Purple", value: "purple" },
        { name: "Green", value: "green" },
        { name: "Lilac", value: "lilac" },
        { name: "Golden", value: "golden" }
      ))
  ];

  try {
    await client.application.commands.set(commands, CONFIG.bot.guild_id);
    console.log("✅ All slash commands registered successfully");
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }

  // Run initial updates
  await updateStockDisplay();
  await updateLeaderboard();

  // Schedule updates
  cron.schedule("*/15 * * * *", updateStockDisplay);
  cron.schedule("0 * * * *", updateLeaderboard);
});

// ==============================================
// COMMAND HANDLERS
// ==============================================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  if (commandName === "stock") {
    const embeds = await buildStockEmbeds();
    return interaction.reply({ embeds: embeds, ephemeral: true });
  }

  if (commandName === "addstock") {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: "❌ You do not have permission to do this.", ephemeral: true });
    }
    const name = interaction.options.getString("name");
    const amount = interaction.options.getInteger("amount");
    const rarity = interaction.options.getString("rarity");

    const existing = STOCK[rarity].find(i => normalizeName(i.name) === normalizeName(name));
    if (existing) existing.stock += amount;
    else STOCK[rarity].push({ name, stock: amount });

    saveStock();
    await updateStockDisplay();
    return interaction.reply({ content: `✅ Added **${amount}x ${name}** to ${rarity} stock.`, ephemeral: true });
  }
});

client.login(CONFIG.bot.token);
