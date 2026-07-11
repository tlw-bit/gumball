require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  AttachmentBuilder
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
    token: process.env.BOT_TOKEN?.trim() || "",
    guild_id: process.env.GUILD_ID?.trim() || "",
    verified_role_id: process.env.VERIFIED_ROLE_ID?.trim() || "",
    admin_role_id: process.env.ADMIN_ROLE_ID?.trim() || "",
    owner_role_id: process.env.OWNER_ROLE_ID?.trim() || ""
  },
  channels: {
    mod_awareness: process.env.MOD_CHANNEL_ID?.trim() || "",
    claims: process.env.CLAIMS_CHANNEL_ID?.trim() || "",
    log: process.env.LOG_CHANNEL_ID?.trim() || "",
    stock_display: process.env.STOCK_DISPLAY_CHANNEL_ID?.trim() || "",
    leaderboard: process.env.LEADERBOARD_CHANNEL_ID?.trim() || ""
  },
  habboapi_key: process.env.HABBOAPI_KEY?.trim() || "",
  room_link: "https://www.habbo.com/room/1234567",
  rates: {
    starting_tokens: 0,
    credit_per_token: 3,
    furni_per_token: 20
  },
  default_image: "https://images.habboapi.site/furni/unknown.png",
  rarity_groups: [
    { id: "blue",   name: "🔵 BLUE RARITY",   color: "#3498db", weight: 53 },
    { id: "purple", name: "🟣 PURPLE RARITY", color: "#9b59b6", weight: 30 },
    { id: "green",  name: "🟢 GREEN RARITY",  color: "#2ecc71", weight: 10 },
    { id: "lilac",  name: "💜 LILAC RARITY",  color: "#e84393", weight: 5  },
    { id: "golden", name: "🟡 GOLDEN RARITY", color: "#f1c40f", weight: 2  }
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

function capitalizeWords(str) {
  return str.replace(/\b\w/g, char => char.toUpperCase());
}

function getHabboName(discordId) {
  return habboLinks[discordId.toString()] || "Not linked";
}

function parsePriceToCredits(priceStr) {
  if (!priceStr || priceStr === "❌ No price data") return 0;
  const num = parseInt(priceStr.replace(/\D/g, ''), 10);
  return isNaN(num) ? 0 : num;
}

// ==============================================
// FURNI DETAILS — API IMAGES
// ==============================================
async function getFurniDetails(furniName) {
  const original = furniName.trim();
  const searchKey = normalizeName(original);

  const saved = Object.values(STOCK).flat().find(i => normalizeName(i.name) === searchKey);
  if (saved) return {
    name: saved.name,
    icon: saved.icon || CONFIG.default_image,
    price: saved.price || "❌ No price data"
  };

  try {
    const res = await fetch(`https://habboapi.site/api/market/history?name=${encodeURIComponent(original)}&hotel=com`, { timeout: 2500 });
    if (res.ok) {
      const data = await res.json();
      const match = data.find(i => normalizeName(i.FurniName) === searchKey) || data[0];
      if (match) {
        return {
          name: match.FurniName,
          icon: `https://images.habboapi.site/furni/${match.ClassName}.png`,
          price: match.marketData?.averagePrice ? `${match.marketData.averagePrice}c` : "❌ No price data"
        };
      }
    }
  } catch {}

  return { name: original, icon: CONFIG.default_image, price: "❌ No price data" };
}

// ==============================================
// IMAGE ATTACHMENT HELPER
// ==============================================
async function getImageAttachment(imageUrl, filename) {
  try {
    const res = await fetch(imageUrl, { timeout: 2500 });
    if (!res.ok) throw new Error("Failed to fetch");
    const buffer = await res.arrayBuffer();
    return new AttachmentBuilder(Buffer.from(buffer), { name: filename });
  } catch {
    const res = await fetch(CONFIG.default_image, { timeout: 2500 });
    const buffer = await res.arrayBuffer();
    return new AttachmentBuilder(Buffer.from(buffer), { name: filename });
  }
}

// ==============================================
// WEIGHTED RARITY SELECTION
// ==============================================
function getWeightedRarity() {
  const available = CONFIG.rarity_groups.filter(g => STOCK[g.id].some(i => i.stock > 0));
  if (available.length === 0) return null;
  const totalWeight = available.reduce((sum, g) => sum + g.weight, 0);
  const random = Math.random() * totalWeight;
  let cumulative = 0;
  for (const group of available) {
    cumulative += group.weight;
    if (random < cumulative) return group;
  }
  return available[available.length - 1];
}

// ==============================================
// USER & HISTORY HELPERS
// ==============================================
function ensureUser(id) {
  id = id.toString();
  if (!DATA.users[id]) {
    DATA.users[id] = {
      balance: CONFIG.rates.starting_tokens,
      history: [],
      lifetime_spins: 0,
      lifetime_spent: 0,
      lifetime_won_value: 0
    };
  }
  return DATA.users[id];
}

function addToHistory(userId, type, details) {
  const user = ensureUser(userId);
  user.history.unshift({ timestamp: new Date().toISOString(), type, details });
  if (user.history.length > 50) user.history.pop();
  saveData();
}

function updateWeeklyStats(userId, spinCount = 0, valueWon = 0) {
  const id = userId.toString();
  if (!DATA.weekly_stats[id]) DATA.weekly_stats[id] = { spins: 0, totalValue: 0 };
  DATA.weekly_stats[id].spins += spinCount;
  DATA.weekly_stats[id].totalValue += valueWon;
  saveData();
}

function resetWeeklyStats() {
  DATA.weekly_stats = {};
  saveData();
  updateLeaderboard();
  sendLog("🔄 Weekly Reset", "All Gumball weekly stats and leaderboard have been reset.", "#f39c12");
}

// ==============================================
// LEADERBOARD
// ==============================================
async function updateLeaderboard() {
  if (!CONFIG.channels.leaderboard) return;
  const ch = await client.channels.fetch(CONFIG.channels.leaderboard).catch(() => null);
  if (!ch) return;

  const entries = Object.entries(DATA.weekly_stats);
  const bySpins = [...entries].sort((a, b) => b[1].spins - a[1].spins).slice(0, 10);
  const byValue = [...entries].sort((a, b) => b[1].totalValue - a[1].totalValue).slice(0, 10);

  const embed = new EmbedBuilder()
    .setTitle("🏆 Weekly Gumball Leaderboard")
    .setDescription(`Resets every **Sunday at 6PM**\nLast updated: ${new Date().toLocaleString()}`)
    .setColor("#f1c40f")
    .setTimestamp();

  const spinsList = bySpins.map(([id, data], i) => `${i+1}. <@${id}> — ${data.spins} spins`).join("\n") || "No spins yet this week";
  const valueList = byValue.map(([id, data], i) => `${i+1}. <@${id}> — ${data.totalValue}c won`).join("\n") || "No prizes won yet this week";

  embed.addFields(
    { name: "🎰 Most Spins", value: spinsList, inline: true },
    { name: "💰 Highest Value Won", value: valueList, inline: true }
  );

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
// STOCK DISPLAY — ALL IMAGES PER RARITY
// ==============================================
async function buildSingleRarityDisplay(rarityId) {
  const group = CONFIG.rarity_groups.find(g => g.id === rarityId);
  if (!group) return { embed: null, attachments: [] };

  const items = STOCK[group.id].filter(i => i.stock > 0);
  const totalStock = items.reduce((sum, item) => sum + item.stock, 0);

  const embed = new EmbedBuilder()
    .setTitle(group.name)
    .setColor(group.color)
    .setTimestamp()
    .setFooter({ text: `Total items: ${totalStock} • Updated every 15 mins` });

  if (totalStock === 0) {
    embed.setDescription("**Prices:** Market Average\n\n> No items currently in stock");
    return { embed, attachments: [] };
  }

  let desc = "**Prices:** Market Average\n\n";
  const attachments = [];

  for (let i = 0; i < items.length; i++) {
    const details = await getFurniDetails(items[i].name);
    desc += `**${capitalizeWords(details.name)}**\n• Price: ${details.price}\n• Stock: ${items[i].stock}\n\n`;
    attachments.push(await getImageAttachment(details.icon, `item_${i}_${Date.now()}.png`));
  }

  embed.setDescription(desc.trim());
  return { embed, attachments };
}

async function buildRaritySelectMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("rarity_select")
      .setPlaceholder("Select a rarity to view stock")
      .addOptions(CONFIG.rarity_groups.map(g => ({
        label: g.name.replace(/^[🔵🟣🟢💜🟡] /, ""),
        value: g.id,
        emoji: g.name.split(" ")[0]
      })))
  );
}

async function updateStockDisplay() {
  if (!CONFIG.channels.stock_display) return;
  const ch = await client.channels.fetch(CONFIG.channels.stock_display).catch(() => null);
  if (!ch) return;

  const { embed, attachments } = await buildSingleRarityDisplay("blue");
  const menu = await buildRaritySelectMenu();

  try {
    if (DATA.stock_display_message_id) {
      const msg = await ch.messages.fetch(DATA.stock_display_message_id).catch(() => null);
      if (msg) return msg.edit({ embeds: [embed], files: attachments, components: [menu] });
    }
    const newMsg = await ch.send({ embeds: [embed], files: attachments, components: [menu] });
    DATA.stock_display_message_id = newMsg.id;
    saveData();
  } catch {}
}

// ==============================================
// OTHER HELPERS
// ==============================================
async function autoLinkVerified(member) {
  if (!member || !member.roles?.cache) return null;
  const hasRole = CONFIG.verified_role_id ? member.roles.cache.has(CONFIG.verified_role_id) : false;
  if (!hasRole) return null;
  const habboName = member.nickname?.trim() || member.user.username.trim();
  if (!habboLinks[member.id] && habboName) {
    habboLinks[member.id] = habboName;
    saveHabboLinks();
  }
  return habboLinks[member.id] || null;
}

async function sendLog(title, description, color = "#95a5a6", tagOwners = false) {
  if (!CONFIG.channels.log) return;
  try {
    const ch = await client.channels.fetch(CONFIG.channels.log).catch(() => null);
    if (!ch) return;
    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
    const content = tagOwners && CONFIG.owner_role_id ? `<@&${CONFIG.owner_role_id}>` : "";
    await ch.send({ content, embeds: [embed] });
  } catch {}
}

async function sendDM(user, title, message, color = "#2ecc71") {
  try {
    await user.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(message).setColor(color).setTimestamp()] });
    return true;
  } catch {
    return false;
  }
}

// ==============================================
// BOT SETUP
// ==============================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", async () => {
  console.log(`✅ Gumball Bot online as ${client.user.tag}`);
  console.log(`✅ Connected to server`);

  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Show all commands"),
    new SlashCommandBuilder().setName("balance").setDescription("Check your token balance"),
    new SlashCommandBuilder().setName("howtoplay").setDescription("Earn rates & rules"),
    new SlashCommandBuilder().setName("showprizes").setDescription("View available prizes and stock levels"),
    new SlashCommandBuilder().setName("gumball").setDescription("Spin the machine for prizes (costs 1 Token)"),
    new SlashCommandBuilder().setName("claim").setDescription("Claim a prize you won")
      .addStringOption(o => o.setName("prize").setDescription("Exact name of the prize").setRequired(true)),
    new SlashCommandBuilder().setName("depositcoins").setDescription("Submit credit deposit")
      .addIntegerOption(o => o.setName("amount").setDescription("Number of credits").setRequired(true)),
    new SlashCommandBuilder().setName("depositfurni").setDescription("Submit furni deposit")
      .addIntegerOption(o => o.setName("quantity").setDescription("Total items").setRequired(true))
      .addStringOption(o => o.setName("items").setDescription("List of furni names").setRequired(true)),
    new SlashCommandBuilder().setName("addstock").setDescription("Add items to stock")
      .addStringOption(o => o.setName("group").setDescription("blue/purple/green/lilac/golden").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Exact furni name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity to add").setRequired(true))
      .addBooleanOption(o => o.setName("force").setDescription("Add even if not found").setRequired(false))
      .addStringOption(o => o.setName("price").setDescription("Custom price (optional)").setRequired(false))
      .addStringOption(o => o.setName("image_url").setDescription("Custom image (optional)").setRequired(false)),
    new SlashCommandBuilder().setName("removestock").setDescription("Remove items from stock")
      .addStringOption(o => o.setName("group").setDescription("blue/purple/green/lilac/golden").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Furni name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity to remove").setRequired(true)),
    new SlashCommandBuilder().setName("addtokens").setDescription("Give tokens to a user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Number of tokens").setRequired(true)),
    new SlashCommandBuilder().setName("removetokens").setDescription("Take tokens from a user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Number of tokens").setRequired(true)),
    new SlashCommandBuilder().setName("history").setDescription("[STAFF] View user history and stats")
      .addUserOption(o => o.setName("user").setDescription("User to check").setRequired(true)),
    new SlashCommandBuilder().setName("resetleaderboard").setDescription("[STAFF] Manually reset the weekly leaderboard")
  ];

  try {
    await client.application.commands.set(commands, CONFIG.bot.guild_id);
    console.log("✅ All slash commands registered successfully");
  } catch (err) {
    console.error("❌ Failed to register commands:", err.message);
  }

  cron.schedule("*/15 * * * *", updateStockDisplay);
  cron.schedule("0 18 * * 0", resetWeeklyStats);
  await updateStockDisplay();
  await updateLeaderboard();
});

// ==============================================
// INTERACTION HANDLERS
// ==============================================
client.on("interactionCreate", async interaction => {
  try {
    // Handle rarity dropdown
    if (interaction.isStringSelectMenu() && interaction.customId === "rarity_select") {
      await interaction.deferUpdate();
      const { embed, attachments } = await buildSingleRarityDisplay(interaction.values[0]);
      if (!embed) return interaction.followUp({ content: "❌ Rarity not found", flags: MessageFlags.Ephemeral });
      return interaction.editReply({ embeds: [embed], files: attachments, components: [await buildRaritySelectMenu()] });
    }

    if (!interaction.isChatInputCommand()) return;

    const isStaff = interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) ||
      (CONFIG.bot.admin_role_id && interaction.member?.roles?.cache?.has(CONFIG.bot.admin_role_id));

    await interaction.deferReply({ flags: isStaff ? MessageFlags.Ephemeral : 0 });

    switch (interaction.commandName) {
      case "help": {
        return interaction.editReply({
          content: `**📋 Available Commands**
**User Commands**
\`/balance\` — Check your token balance
\`/howtoplay\` — See how to earn & play
\`/showprizes\` — View all items in stock
\`/gumball\` — Spin for a prize (costs 1 Token)
\`/claim\` — Claim your won prize

**Staff Commands**
\`/addstock\` — Add items to inventory
\`/removestock\` — Remove items from inventory
\`/addtokens\` — Give tokens to a user
\`/removetokens\` — Remove tokens from a user
\`/history\` — View user activity & stats
\`/resetleaderboard\` — Reset weekly leaderboard`
        });
      }

      case "howtoplay": {
        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle("📋 How To Play & Earn")
            .setDescription(`
**Rates:**
• ${CONFIG.rates.credit_per_token} Credits = 1 Token
• ${CONFIG.rates.furni_per_token} Common Furni = 1 Token

**How to earn:**
• Deposit credits or items to receive tokens
• Use tokens to spin the Gumball machine
• Win rare & valuable items instantly!

**Rarity Odds:**
🔵 Blue: 53% | 🟣 Purple: 30% | 🟢 Green: 10% | 💜 Lilac: 5% | 🟡 Golden: 2%
            `)
            .setColor("#3498db")
            .setTimestamp()]
        });
      }

      case "showprizes": {
        const { embed, attachments } = await buildSingleRarityDisplay("blue");
        const menu = await buildRaritySelectMenu();
        return interaction.editReply({ embeds: [embed], files: attachments, components: [menu] });
      }

      case "balance": {
        const user = ensureUser(interaction.user.id);
        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setTitle("💰 Your Balance")
            .setDescription(`You currently have: **${user.balance} Tokens**`)
            .setColor("#2ecc71")
            .setTimestamp()]
        });
      }

      case "history": {
        if (!isStaff) return interaction.editReply({ content: "❌ You do not have permission to use this command." });
        const target = interaction.options.getUser("user");
        const userData = ensureUser(target.id);
        const habbo = getHabboName(target.id);

        const spentValue = userData.lifetime_spent * CONFIG.rates.credit_per_token;
        const profitPercent = spentValue > 0 ? ((userData.lifetime_won_value / spentValue) * 100).toFixed(1) : "N/A";

        const embed = new EmbedBuilder()
          .setTitle(`📊 Stats for ${target.tag}`)
          .addFields(
            { name: "Habbo Name", value: habbo, inline: true },
            { name: "Current Balance", value: `${userData.balance} Tokens`, inline: true },
            { name: "Total Spins", value: `${userData.lifetime_spins}`, inline: true },
            { name: "Total Spent", value: `${spentValue}c`, inline: true },
            { name: "Total Won", value: `${userData.lifetime_won_value}c`, inline: true },
            { name: "Profit %", value: `${profitPercent}%`, inline: true }
          )
          .setColor("#9b59b6")
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      case "resetleaderboard": {
        if (!isStaff) return interaction.editReply({ content: "❌ You do not have permission to use this command." });
        resetWeeklyStats();
        return interaction.editReply({ content: "✅ Weekly leaderboard and stats have been reset." });
      }

      case "addstock": {
        if (!isStaff) return interaction.editReply({ content: "❌ You do not have permission to use this command." });
        const group = interaction.options.getString("group").toLowerCase();
        const inputName = interaction.options.getString("name").trim();
        const amount = interaction.options.getInteger("amount");
        const force = interaction.options.getBoolean("force") || false;
        const customPrice = interaction.options.getString("price");
        const customImage = interaction.options.getString("image_url");

        if (!STOCK.hasOwnProperty(group))
          return interaction.editReply({ content: "❌ Invalid group. Use: `blue`, `purple`, `green`, `lilac`, `golden`" });

        const details = await getFurniDetails(inputName);
        if (!force && details.icon === CONFIG.default_image && details.price === "❌ No price data")
          return interaction.editReply({ content: `⚠️ **"${inputName}"** was not found in our database. Use \`force: true\` to add it manually.` });

        if (customPrice) details.price = customPrice;
        if (customImage) details.icon = customImage;

        const searchKey = normalizeName(details.name);
        const existing = STOCK[group].find(i => normalizeName(i.name) === searchKey);
        if (existing) {
          existing.stock += amount;
          existing.price = details.price;
          existing.icon = details.icon;
        } else {
          STOCK[group].push({ name: details.name, stock: amount, price: details.price, icon: details.icon });
        }

        saveStock();
        await updateStockDisplay();
        await sendLog("✅ Stock Added", `**${interaction.user.tag}** added **${amount}x ${capitalizeWords(details.name)}** to ${group.toUpperCase()}`, "#27ae60");
        return interaction.editReply({ content: `✅ Successfully added **${amount}x ${capitalizeWords(details.name)}** to stock.` });
      }

      case "removestock": {
        if (!isStaff) return interaction.editReply({ content: "❌ You do not have permission to use this command." });
        const group = interaction.options.getString("group").toLowerCase();
        const inputName = interaction.options.getString("name").trim();
        const amount = interaction.options.getInteger("amount");

        if (!STOCK.hasOwnProperty(group))
          return interaction.editReply({ content: "❌ Invalid group. Use: `blue`, `purple`, `green`, `lilac`, `golden`" });

        const searchKey = normalizeName(inputName);
        const idx = STOCK[group].findIndex(i => normalizeName(i.name) === searchKey);
        if (idx === -1) return interaction.editReply({ content: "❌ Item not found in stock." });

        STOCK[group][idx].stock -= amount;
        const itemName = capitalizeWords(STOCK[group][idx].name);
        if (STOCK[group][idx].stock <= 0) STOCK[group].splice(idx, 1);

        saveStock();
        await updateStockDisplay();
        await sendLog("📤 Stock Removed", `**${interaction.user.tag}** removed **${amount}x ${itemName}** from ${group.toUpperCase()}`, "#e67e22");
        return interaction.editReply({ content: `✅ Removed **${amount}x ${itemName}** from stock.` });
      }

      case "addtokens": {
        if (!isStaff) return interaction.editReply({ content: "❌ You do not have permission to use this command." });
        const target = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");

        ensureUser(target.id).balance += amount;
        saveData();
        addToHistory(target.id, "Tokens Added", `+${amount} by ${interaction.user.tag}`);
        await sendLog("➕ Tokens Added", `**${interaction.user.tag}** gave **${amount} Tokens** to ${target.tag}`, "#27ae60");
        return interaction.editReply({ content: `✅ Added **${amount} Tokens** to ${target}.` });
      }

      case "removetokens": {
        if (!isStaff) return interaction.editReply({ content: "❌ You do not have permission to use this command." });
        const target = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");

        const user = ensureUser(target.id);
        const removed = Math.min(amount, user.balance);
        user.balance -= removed;
        saveData();
        addToHistory(target.id, "Tokens Removed", `-${removed} by ${interaction.user.tag}`);
        await sendLog("➖ Tokens Removed", `**${interaction.user.tag}** took **${removed} Tokens** from ${target.tag}`, "#e74c3c");
        return interaction.editReply({ content: `✅ Removed **${removed} Tokens** from ${target}.` });
      }

      case "gumball": {
        const habbo = await autoLinkVerified(interaction.member);
        if (!habbo) return interaction.editReply({ content: "❌ Please link your Habbo name first (set it as your nickname or profile name)." });

        const user = ensureUser(interaction.user.id);
        if (user.balance < 1) return interaction.editReply({ content: "❌ You need at least **1 Token** to spin." });

        user.balance -= 1;
        user.lifetime_spins += 1;
        user.lifetime_spent += 1;
        saveData();

        const drawnGroup = getWeightedRarity();
        if (!drawnGroup) {
          user.balance += 1;
          saveData();
          return interaction.editReply({ content: "😕 No items available right now. Your token has been refunded." });
        }

        const itemsInGroup = STOCK[drawnGroup.id].filter(i => i.stock > 0);
        const prize = itemsInGroup[Math.floor(Math.random() * itemsInGroup.length)];
        prize.stock -= 1;

        const prizeDetails = await getFurniDetails(prize.name);
        const prizeAttachment = await getImageAttachment(prizeDetails.icon, `prize_${Date.now()}.png`);
        const prizeValue = parsePriceToCredits(prizeDetails.price);
        user.lifetime_won_value += prizeValue;
        updateWeeklyStats(interaction.user.id, 1, prizeValue);
        saveStock();
        saveData();
        await updateStockDisplay();

        DATA.pending_claims[interaction.user.id] = {
          prize: prizeDetails.name,
          habbo: habbo,
          timestamp: new Date().toISOString()
        };
        saveData();

        const winEmbed = new EmbedBuilder()
          .setTitle("🎉 YOU WON!")
          .setThumbnail(`attachment://${prizeAttachment.name}`)
          .setDescription(`
**Rarity:** ${drawnGroup.name}
**Item:** ${capitalizeWords(prizeDetails.name)}
**Value:** ${prizeDetails.price}

Run \`/claim\` to get your item delivered!
          `)
          .setColor(drawnGroup.color)
          .setTimestamp();

        await sendLog("🎰 Gumball Spin", `**${interaction.user.tag}** spun and won **${prizeDetails.name}** (${drawnGroup.name})`, drawnGroup.color, true);
        return interaction.editReply({ embeds: [winEmbed], files: [prizeAttachment] });
      }

      case "claim": {
        const habbo = await autoLinkVerified(interaction.member);
        if (!habbo) return interaction.editReply({ content: "❌ Please link your Habbo name first." });

        const pending = DATA.pending_claims[interaction.user.id];
        if (!pending) return interaction.editReply({ content: "❌ No pending prize found. Spin first with `/gumball`." });

        delete DATA.pending_claims[interaction.user.id];
        saveData();

        const prizeDetails = await getFurniDetails(pending.prize);
        const prizeAttachment = await getImageAttachment(prizeDetails.icon, `claim_${Date.now()}.png`);

        const confirmEmbed = new EmbedBuilder()
          .setTitle("✅ Claim Registered")
          .setDescription(`
**Prize:** ${capitalizeWords(pending.prize)}
**Habbo Name:** ${pending.habbo}

A staff member will deliver this to you shortly.
          `)
          .setColor("#2ecc71")
          .setTimestamp();

        // ✅ STAFF CLAIM NOTIFICATION — NOW WITH IMAGE
        const claimsEmbed = new EmbedBuilder()
          .setTitle("📦 New Claim Request")
          .setThumbnail(`attachment://${prizeAttachment.name}`)
          .setDescription(`
**User:** ${interaction.user.tag}
**Habbo:** ${pending.habbo}
**Prize:** ${capitalizeWords(pending.prize)}
**Value:** ${prizeDetails.price}
          `)
          .setColor("#f39c12")
          .setTimestamp();

        const claimsCh = await client.channels.fetch(CONFIG.channels.claims).catch(() => null);
        if (claimsCh) await claimsCh.send({ embeds: [claimsEmbed], files: [prizeAttachment] });

        await sendLog("📥 Prize Claimed", `**${interaction.user.tag}** claimed **${pending.prize}**`, "#27ae60");
        return interaction.editReply({ embeds: [confirmEmbed] });
      }

      case "depositcoins": {
        const habbo = await autoLinkVerified(interaction.member);
        if (!habbo) return interaction.editReply({ content: "❌ Please link your Habbo name first." });

        const amount = interaction.options.getInteger("amount");
        const tokens = Math.floor(amount / CONFIG.rates.credit_per_token);
        if (tokens < 1) return interaction.editReply({ content: `❌ Minimum deposit is ${CONFIG.rates.credit_per_token} credits = 1 Token.` });

        DATA.deposit_requests[interaction.user.id] = {
          type: "credits",
          amount: amount,
          tokens: tokens,
          habbo: habbo,
          timestamp: new Date().toISOString()
        };
        saveData();

        const requestEmbed = new EmbedBuilder()
          .setTitle("💸 New Credit Deposit")
          .addFields(
            { name: "User", value: interaction.user.tag, inline: true },
            { name: "Habbo", value: habbo, inline: true },
            { name: "Amount", value: `${amount}c`, inline: true },
            { name: "Reward", value: `${tokens} Tokens`, inline: true }
          )
          .setColor("#3498db")
          .setTimestamp();

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${interaction.user.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${interaction.user.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
        );

        const modCh = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
        if (modCh) await modCh.send({ embeds: [requestEmbed], components: [buttons] });

        return interaction.editReply({ content: `✅ Your deposit request for **${amount}c** (${tokens} Tokens) has been submitted.` });
      }

      case "depositfurni": {
        const habbo = await autoLinkVerified(interaction.member);
        if (!habbo) return interaction.editReply({ content: "❌ Please link your Habbo name first." });

        const quantity = interaction.options.getInteger("quantity");
        const items = interaction.options.getString("items");
        const tokens = Math.floor(quantity / CONFIG.rates.furni_per_token);
        if (tokens < 1) return interaction.editReply({ content: `❌ Minimum deposit is ${CONFIG.rates.furni_per_token} items = 1 Token.` });

        DATA.deposit_requests[interaction.user.id] = {
          type: "furni",
          amount: quantity,
          tokens: tokens,
          habbo: habbo,
          items: items,
          timestamp: new Date().toISOString()
        };
        saveData();

        const requestEmbed = new EmbedBuilder()
          .setTitle("📦 New Furni Deposit")
          .addFields(
            { name: "User", value: interaction.user.tag, inline: true },
            { name: "Habbo", value: habbo, inline: true },
            { name: "Items", value: items, inline: false },
            { name: "Quantity", value: `${quantity} items`, inline: true },
            { name: "Reward", value: `${tokens} Tokens`, inline: true }
          )
          .setColor("#9b59b6")
          .setTimestamp();

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${interaction.user.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${interaction.user.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
        );

        const modCh = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
        if (modCh) await modCh.send({ embeds: [requestEmbed], components: [buttons] });

        return interaction.editReply({ content: `✅ Your furni deposit request has been submitted.` });
      }
    }

  } catch (err) {
    console.error("❌ Error:", err);
    if (interaction.deferred) interaction.editReply({ content: "❌ Something went wrong. Please try again." }).catch(() => {});
  }
});

// ==============================================
// DEPOSIT BUTTON HANDLERS
// ==============================================
client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;

  const isStaff = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    (CONFIG.bot.admin_role_id && interaction.member.roles.cache.has(CONFIG.bot.admin_role_id));

  if (!isStaff) return interaction.reply({ content: "❌ Only staff can process this.", flags: MessageFlags.Ephemeral });

  const [action, type, userId] = interaction.customId.split("_");
  const req = DATA.deposit_requests[userId];
  if (!req) return interaction.reply({ content: "❌ Request not found or already processed.", flags: MessageFlags.Ephemeral });

  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return interaction.reply({ content: "❌ User not found.", flags: MessageFlags.Ephemeral });

  if (action === "dep" && type === "approve") {
    ensureUser(userId).balance += req.tokens;
    delete DATA.deposit_requests[userId];
    saveData();

    await interaction.update({
      content: `✅ **APPROVED** by ${interaction.user.tag}`,
      embeds: interaction.message.embeds,
      components: []
    });

    await sendDM(user, "✅ Deposit Approved", `Your deposit has been approved! You received **${req.tokens} Tokens**.`);
    await sendLog("✅ Deposit Approved", `**${interaction.user.tag}** approved deposit from ${user.tag} — ${req.tokens} Tokens added`, "#27ae60");
  }

  if (action === "dep" && type === "deny") {
    delete DATA.deposit_requests[userId];
    saveData();

    await interaction.update({
      content: `❌ **DENIED** by ${interaction.user.tag}`,
      embeds: interaction.message.embeds,
      components: []
    });

    await sendDM(user, "❌ Deposit Denied", "Your deposit request was not approved. Please check the requirements and try again.");
    await sendLog("❌ Deposit Denied", `**${interaction.user.tag}** denied deposit from ${user.tag}`, "#e74c3c");
  }
});

client.login(CONFIG.bot.token);
