require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  PermissionsBitField,
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
  habbo_assets_token: process.env.HABBO_ASSETS_TOKEN?.trim() || "",
  habboapi_key: process.env.HABBOAPI_KEY?.trim() || "",
  room_link: "https://www.habbo.com/room/1234567",
  rates: {
    starting_tokens: 0,
    credit_per_token: 3,
    furni_per_token: 20
  },
  default_image: "https://www.habboassets.com/assets/images/furniture/unknown.png",
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

function getHabboName(discordId) { return habboLinks[discordId.toString()] || "Not linked"; }

function getAvatar(habboName) {
  if (!habboName || habboName === "Not linked") return "https://www.habbo.com/habbo-imaging/avatarimage?user=Habbo&headonly=1&direction=2&size=l";
  const safe = encodeURIComponent(habboName.trim());
  return `https://www.habbo.com/habbo-imaging/avatarimage?user=${safe}&direction=2&headonly=1&size=l`;
}

function parsePriceToCredits(priceStr) {
  if (!priceStr || priceStr === "❌ No price data") return 0;
  const num = parseInt(priceStr.replace(/[^0-9]/g, ''), 10);
  return isNaN(num) ? 0 : num;
}

// ==============================================
// FURNI DETAILS — FIXED IMAGE URLS
// ==============================================
async function getFurniDetails(furniName) {
  const original = furniName.trim();
  const searchKey = normalizeName(original);

  let iconUrl = CONFIG.default_image;
  let price = "❌ No price data";
  let matchedName = original;

  // 1. HabboAssets (direct medium image URL)
  if (CONFIG.habbo_assets_token) {
    try {
      const res = await fetch(`https://www.habboassets.com/api/search?q=${encodeURIComponent(original)}&limit=5`, {
        headers: { Authorization: `Bearer ${CONFIG.habbo_assets_token}` },
        timeout: 4000
      });
      if (res.ok) {
        const data = await res.json();
        if (data.items?.length > 0) {
          const best = data.items.find(i => normalizeName(i.name) === searchKey) || data.items[0];
          if (best) {
            matchedName = best.name;
            iconUrl = best.medium_url || best.image_url || best.icon_url || iconUrl;
          }
        }
      }
    } catch {}
  }

  // 2. HabboAPI fallback — direct PNG URL
  try {
    const headers = { "Accept": "application/json" };
    if (CONFIG.habboapi_key) headers["X-Auth-Key"] = CONFIG.habboapi_key;

    const res = await fetch(`https://habboapi.site/api/market/history?name=${encodeURIComponent(original)}&hotel=com`, {
      headers, timeout: 4000
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const best = data.find(i => normalizeName(i.FurniName) === searchKey) ||
                     data.find(i => normalizeName(i.FurniName).includes(searchKey)) || data[0];
        if (best) {
          matchedName = best.FurniName;
          if (best.marketData?.averagePrice) price = `${best.marketData.averagePrice}c`;
          if (iconUrl === CONFIG.default_image) {
            iconUrl = `https://images.habboapi.site/furni/${best.ClassName}.png`;
          }
        }
      }
    }
  } catch {}

  // 3. FurniEye fallback price
  if (price === "❌ No price data") {
    try {
      const res = await fetch(`https://www.furnieye.com/api/search?q=${encodeURIComponent(original)}&limit=5`, { timeout: 3000 });
      if (res.ok) {
        const data = await res.json();
        if (data.results?.length > 0) {
          const best = data.results.find(i => normalizeName(i.name) === searchKey) || data.results[0];
          if (best?.average_price) price = `${best.average_price}c`;
        }
      }
    } catch {}
  }

  return { icon: iconUrl, price, name: matchedName };
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

  let spinsList = bySpins.map(([id, data], i) => `${i+1}. <@${id}> — ${data.spins} spins`).join("\n") || "No spins yet this week";
  let valueList = byValue.map(([id, data], i) => `${i+1}. <@${id}> — ${data.totalValue}c won`).join("\n") || "No prizes won yet this week";

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
// STOCK DISPLAY — IMAGES ACTUALLY SHOWING
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
      embed.setDescription("**Prices:** Market Average — final value may vary due to tax/fees\n\n> No items currently in stock");
    } else {
      // Add items in rows of 5
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const details = await getFurniDetails(item.name);

        // Layout: Name first, then image, then price + stock
        embed.addFields({
          name: `**${details.name}**`,
          value: `Market Avg: ${details.price} | Stock: ${item.stock}`,
          inline: true
        });

        // Set the image as a small inline thumbnail for this field
        embed.setThumbnail(details.icon);

        // New row after every 5 items
        if ((i + 1) % 5 === 0) {
          embed.addFields({ name: "\u200B", value: "\u200B", inline: true });
        }
      }

      embed.setFooter({ text: `Total in category: ${totalStock} items • Updated every 15 mins` });
    }

    embeds.push(embed);
  }

  return embeds;
}

// ==============================================
// OTHER HELPERS
// ==============================================
async function autoLinkVerified(member) {
  if (!member || !member.roles?.cache) return null;
  const hasRole = CONFIG.verified_role_id ? member.roles.cache.has(CONFIG.verified_role_id) : false;
  if (!hasRole) return null;
  const habboName = member.nickname?.trim() || member.user.username.trim();
  if (!habboLinks[member.id] && habboName) { habboLinks[member.id] = habboName; saveHabboLinks(); }
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
  try { await user.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(message).setColor(color).setTimestamp()] }); return true; }
  catch { return false; }
}

// ==============================================
// BOT SETUP & COMMANDS
// ==============================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ✅ Fixed: Use clientReady instead of ready
client.once("clientReady", async () => {
  console.log(`✅ Gumball Bot online as ${client.user.tag}`);
  console.log(`🔍 Loaded GUILD_ID: "${CONFIG.bot.guild_id}"`);

  if (!CONFIG.bot.guild_id || !/^\d+$/.test(CONFIG.bot.guild_id)) {
    console.error("❌ GUILD_ID is empty or invalid — check your .env file!");
    return;
  }

  const guild = client.guilds.cache.get(CONFIG.bot.guild_id);
  if (!guild) {
    console.error("❌ Could not find server — make sure the bot is invited and the ID is correct!");
    return;
  }

  console.log(`✅ Connected to server: ${guild.name} (${guild.id})`);

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
      .addStringOption(o => o.setName("image_url").setDescription("Custom image (optional)").setRequired(false))
      .addStringOption(o => o.setName("price").setDescription("Custom price (optional)").setRequired(false)),
    new SlashCommandBuilder().setName("removestock").setDescription("Remove items from stock")
      .addStringOption(o => o.setName("group").setDescription("Rarity group").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Furni name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity to remove").setRequired(true)),
    new SlashCommandBuilder().setName("addtokens").setDescription("Give tokens to user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Number of tokens").setRequired(true)),
    new SlashCommandBuilder().setName("removetokens").setDescription("Take tokens from user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Number of tokens").setRequired(true)),
    new SlashCommandBuilder().setName("history").setDescription("[STAFF] View user history and profit percentage")
      .addUserOption(o => o.setName("user").setDescription("User to check").setRequired(true)),
    new SlashCommandBuilder().setName("resetleaderboard").setDescription("[STAFF] Manually reset the weekly leaderboard")
  ];

  try {
    await guild.commands.set(commands);
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
// COMMAND HANDLERS
// ==============================================
client.on("interactionCreate", async interaction => {
  const isStaff = interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) ||
    (CONFIG.bot.admin_role_id && interaction.member?.roles?.cache?.has(CONFIG.bot.admin_role_id));

  try {
    if (interaction.isChatInputCommand()) {
      const isPublic = ["showprizes", "howtoplay", "help", "balance", "gumball", "claim", "depositcoins", "depositfurni"].includes(interaction.commandName);
      await Promise.race([
        interaction.deferReply({ flags: isPublic ? 0 : MessageFlags.Ephemeral }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Defer timeout")), 2500))
      ]);

      switch (interaction.commandName) {
        case "help": {
          return interaction.editReply({
            content: `**📋 Commands**
**User**
\`/balance\` • \`/howtoplay\` • \`/depositcoins\` • \`/depositfurni\` • \`/gumball\` • \`/claim\` • \`/showprizes\`
**Staff**
\`/addstock\` • \`/removestock\` • \`/addtokens\` • \`/removetokens\` • \`/history\` • \`/resetleaderboard\``
          });
        }

        case "howtoplay": {
          return interaction.editReply({
            embeds: [new EmbedBuilder()
              .setTitle("📋 How To Play")
              .setDescription(`• ${CONFIG.rates.credit_per_token} Credits = 1 Token\n• ${CONFIG.rates.furni_per_token} Furni = 1 Token\n• Deposit to earn tokens\n• Use 1 Token to spin and win prizes!`)
              .setColor("#3498db")]
          });
        }

        case "showprizes": {
          const embeds = await buildStockEmbeds();
          return interaction.editReply({ embeds: embeds });
        }

        case "history": {
          if (!isStaff) return interaction.editReply({ content: "❌ No permission" });
          const target = interaction.options.getUser("user");
          const userData = ensureUser(target.id);
          const habbo = getHabboName(target.id);

          const spentValue = userData.lifetime_spent * CONFIG.rates.credit_per_token;
          const profitPercent = spentValue > 0 ? ((userData.lifetime_won_value / spentValue) * 100).toFixed(1) : "N/A";

          const embed = new EmbedBuilder()
            .setTitle(`📊 History & Stats — ${target.tag}`)
            .setThumbnail(getAvatar(habbo))
            .addFields(
              { name: "Habbo Name", value: habbo, inline: true },
              { name: "Total Spins", value: `${userData.lifetime_spins}`, inline: true },
              { name: "Tokens Spent", value: `${userData.lifetime_spent}`, inline: true },
              { name: "Total Spent Value", value: `${spentValue}c`, inline: true },
              { name: "Total Won Value", value: `${userData.lifetime_won_value}c`, inline: true },
              { name: "Profit %", value: profitPercent === "N/A" ? "N/A" : `${profitPercent}%`, inline: true }
            )
            .setColor("#9b59b6")
            .setTimestamp();

          return interaction.editReply({ embeds: [embed] });
        }

        case "resetleaderboard": {
          if (!isStaff) return interaction.editReply({ content: "❌ No permission" });
          resetWeeklyStats();
          return interaction.editReply({ content: "✅ Weekly leaderboard and stats have been reset manually." });
        }

        case "addstock": {
          if (!isStaff) return interaction.editReply({ content: "❌ No permission" });
          const group = interaction.options.getString("group").toLowerCase();
          const inputName = interaction.options.getString("name").trim();
          const amount = interaction.options.getInteger("amount");
          const force = interaction.options.getBoolean("force") || false;
          const customImage = interaction.options.getString("image_url")?.trim();
          const customPrice = interaction.options.getString("price")?.trim();

          if (!STOCK.hasOwnProperty(group))
            return interaction.editReply({ content: "❌ Use: blue / purple / green / lilac / golden" });

          const details = await getFurniDetails(inputName);
          if (!force && details.icon === CONFIG.default_image && details.price === "❌ No price data")
            return interaction.editReply({ content: `⚠️ **"${inputName}"** not found. Use \`force: true\`.` });

          if (customImage) details.icon = customImage;
          if (customPrice) details.price = customPrice;

          const searchKey = normalizeName(details.name);
          const existing = STOCK[group].find(i => normalizeName(i.name) === searchKey);
          if (existing) {
            existing.stock += amount;
            existing.name = details.name;
            if (customImage) existing.icon = customImage;
            if (customPrice) existing.price = customPrice;
          } else {
            STOCK[group].push({ name: details.name, stock: amount, icon: details.icon, price: details.price });
          }

          saveStock();
          await updateStockDisplay();
          await sendLog("✅ Stock Added", `**${details.name}** x${amount} → ${group}`, "#27ae60");
          return interaction.editReply({ content: `✅ Added **${amount}x ${details.name}**\n💰 ${details.price}` });
        }

        case "removestock": {
          if (!isStaff) return interaction.editReply({ content: "❌ No permission" });
          const group = interaction.options.getString("group").toLowerCase();
          const name = interaction.options.getString("name").trim();
          const amount = interaction.options.getInteger("amount");

          const idx = STOCK[group].findIndex(i => normalizeName(i.name) === normalizeName(name));
          if (idx === -1) return interaction.editReply({ content: "❌ Item not found" });

          STOCK[group][idx].stock -= amount;
          if (STOCK[group][idx].stock <= 0) STOCK[group].splice(idx, 1);
          saveStock();
          await updateStockDisplay();
          await sendLog("📤 Stock Removed", `**${name}** -${amount} from ${group}`, "#e67e22");
          return interaction.editReply({ content: `✅ Removed **${amount}x ${name}**` });
        }

        case "gumball": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.editReply({ content: "❌ Verify your account first" });
          const user = ensureUser(interaction.user.id);
          if (user.balance < 1) return interaction.editReply({ content: "❌ You need at least 1 Token to spin" });

          user.balance -= 1;
          user.lifetime_spins += 1;
          user.lifetime_spent += 1;
          saveData();

          const drawnGroup = getWeightedRarity();
          if (!drawnGroup) {
            user.balance += 1;
            user.lifetime_spins -= 1;
            user.lifetime_spent -= 1;
            saveData();
            return interaction.editReply({ content: "😕 No prizes available right now — your token has been refunded" });
          }

          const rollingEmojis = ["🔵", "🟣", "🟢", "💜", "🟡"];
          let rollMsg = await interaction.editReply({ content: `🎰 **SPINNING...**\n${rollingEmojis.join(" ")}` });

          for (let i = 0; i < 3; i++) {
            await new Promise(resolve => setTimeout(resolve, 350));
            rollingEmojis.unshift(rollingEmojis.pop());
            await rollMsg.edit({ content: `🎰 **SPINNING...**\n${rollingEmojis.join(" ")}` }).catch(() => {});
          }

          const itemsInGroup = STOCK[drawnGroup.id].filter(i => i.stock > 0);
          const prize = itemsInGroup[Math.floor(Math.random() * itemsInGroup.length)];
          prize.stock -= 1;
          saveStock();
          await updateStockDisplay();

          const details = await getFurniDetails(prize.name);
          const prizeValue = parsePriceToCredits(details.price);
          user.lifetime_won_value += prizeValue;
          updateWeeklyStats(interaction.user.id, 1, prizeValue);
          saveData();
          updateLeaderboard();

          DATA.pending_claims[interaction.user.id] = {
            prize: prize.name,
            habbo: habbo,
            timestamp: new Date().toISOString()
          };
          saveData();

          const winEmbed = new EmbedBuilder()
            .setTitle("🎉 YOU WON!")
            .setThumbnail(details.icon)
            .setDescription(`**Category:** ${drawnGroup.name}\n**Item:** ${details.name}\n**Market Value:** ${details.price}\n\nUse \`/claim prize:${prize.name}\` to receive your prize!`)
            .setColor(drawnGroup.color)
            .setTimestamp();

          await rollMsg.edit({ content: null, embeds: [winEmbed] });

          await sendLog("🎰 Gumball Win",
            `**User:** ${interaction.user.tag}\n**Habbo:** ${habbo}\n**Category:** ${drawnGroup.name}\n**Prize:** ${prize.name}\n**Value:** ${details.price}\n**Remaining Stock:** ${prize.stock}`,
            drawnGroup.color, true
          );

          await sendDM(interaction.user, "🎉 You Won a Prize!", `Congratulations! You won **${prize.name}** (${details.price}) from the ${drawnGroup.name} category. Use \`/claim\` to get it delivered.`);
          return;
        }

        case "claim": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.editReply({ content: "❌ Verify your account first" });
          const requestedPrize = interaction.options.getString("prize").trim();

          const pending = DATA.pending_claims[interaction.user.id];
          if (!pending || normalizeName(pending.prize) !== normalizeName(requestedPrize)) {
            return interaction.editReply({ content: "❌ You haven't won this prize yet — spin the gumball first!" });
          }

          delete DATA.pending_claims[interaction.user.id];
          saveData();

          const details = await getFurniDetails(pending.prize);
          const confirmEmbed = new EmbedBuilder()
            .setTitle("✅ Claim Registered")
            .setThumbnail(details.icon)
            .setDescription(`**Prize:** ${pending.prize}\n**Habbo:** ${habbo}\n\nA staff member will deliver this shortly.`)
            .setColor("#2ecc71");

          const claimsCh = await client.channels.fetch(CONFIG.channels.claims).catch(() => null);
          if (claimsCh) {
            await claimsCh.send({
              content: `<@&${CONFIG.bot.admin_role_id}> New claim to deliver!`,
              embeds: [confirmEmbed]
            });
          }

          await sendLog("✅ Prize Claimed", `**${habbo}** claimed **${pending.prize}**`, "#2ecc71");
          await sendDM(interaction.user, "✅ Claim Confirmed", `Your prize **${pending.prize}** is being processed.`);
          return interaction.editReply({ embeds: [confirmEmbed] });
        }

        case "balance": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.editReply({ content: "❌ Verify your account first" });
          const user = ensureUser(interaction.user.id);
          return interaction.editReply({
            embeds: [new EmbedBuilder()
              .setTitle("💰 Your Token Balance")
              .setThumbnail(getAvatar(habbo))
              .addFields({ name: "Tokens", value: `${user.balance}` })
              .setColor("#2ecc71")]
          });
        }

        case "depositcoins": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.editReply({ content: "❌ Verify your account first" });
          const amount = interaction.options.getInteger("amount");
          const tokens = Math.floor(amount / CONFIG.rates.credit_per_token);

          DATA.deposit_requests[interaction.user.id] = { type: "credits", amount, tokens, habbo, timestamp: new Date().toISOString() };
          saveData();

          const modEmbed = new EmbedBuilder()
            .setTitle("💸 New Credit Deposit")
            .setThumbnail(getAvatar(habbo))
            .setDescription(`**User:** ${interaction.user.tag}\n**Habbo:** ${habbo}\n**Amount:** ${amount}c\n**Tokens to give:** ${tokens}`)
            .setColor("#3498db");

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dep_approve_${interaction.user.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dep_deny_${interaction.user.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
          );

          const modCh = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
          if (modCh) await modCh.send({ content: `<@&${CONFIG.bot.admin_role_id}>`, embeds: [modEmbed], components: [row] });

          return interaction.editReply({ content: `✅ Deposit submitted! You will receive ${tokens} tokens once approved.` });
        }

        case "depositfurni": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.editReply({ content: "❌ Verify your account first" });
          const quantity = interaction.options.getInteger("quantity");
          const items = interaction.options.getString("items");
          const tokens = Math.floor(quantity / CONFIG.rates.furni_per_token);

          DATA.deposit_requests[interaction.user.id] = { type: "furni", quantity, items, tokens, habbo, timestamp: new Date().toISOString() };
          saveData();

          const modEmbed = new EmbedBuilder()
            .setTitle("📦 New Furni Deposit")
            .setThumbnail(getAvatar(habbo))
            .setDescription(`**User:** ${interaction.user.tag}\n**Habbo:** ${habbo}\n**Items:** ${items}\n**Quantity:** ${quantity}\n**Tokens to give:** ${tokens}`)
            .setColor("#9b59b6");

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dep_approve_${interaction.user.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dep_deny_${interaction.user.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
          );

          const modCh = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
          if (modCh) await modCh.send({ content: `<@&${CONFIG.bot.admin_role_id}>`, embeds: [modEmbed], components: [row] });

          return interaction.editReply({ content: `✅ Deposit submitted! You will receive ${tokens} tokens once approved.` });
        }

        case "addtokens": {
          if (!isStaff) return interaction.editReply({ content: "❌ No permission" });
          const target = interaction.options.getUser("user");
          const amount = interaction.options.getInteger("amount");
          ensureUser(target.id).balance += amount;
          addToHistory(target.id, "Tokens Added", `+${amount} by ${interaction.user.tag}`);
          saveData();
          await sendLog("➕ Tokens Added", `**${target.tag}**: +${amount}`, "#2ecc71");
          await sendDM(target, "✅ Tokens Added", `You received **${amount} Tokens**!`);
          return interaction.editReply({ content: `✅ Added ${amount} tokens to ${target}` });
        }

        case "removetokens": {
          if (!isStaff) return interaction.editReply({ content: "❌ No permission" });
          const target = interaction.options.getUser("user");
          const amount = interaction.options.getInteger("amount");
          ensureUser(target.id).balance = Math.max(0, ensureUser(target.id).balance - amount);
          addToHistory(target.id, "Tokens Removed", `-${amount} by ${interaction.user.tag}`);
          saveData();
          await sendLog("➖ Tokens Removed", `**${target.tag}**: -${amount}`, "#e74c3c");
          await sendDM(target, "⚠️ Tokens Removed", `**${amount} Tokens** were taken from your balance.`);
          return interaction.editReply({ content: `✅ Removed ${amount} tokens from ${target}` });
        }
      }
    }

    if (interaction.isButton()) {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !isStaff)
        return interaction.reply({ content: "❌ No permission", flags: MessageFlags.Ephemeral });

      const [action, type, userId] = interaction.customId.split("_");
      const req = DATA.deposit_requests[userId];
      if (!req) return interaction.reply({ content: "❌ Request not found", flags: MessageFlags.Ephemeral });

      if (action === "dep" && type === "approve") {
        ensureUser(userId).balance += req.tokens;
        delete DATA.deposit_requests[userId];
        saveData();
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) await sendDM(user, "✅ Deposit Approved", `Your ${req.type} deposit was approved! You received **${req.tokens} Tokens**.`);
        await sendLog("✅ Deposit Approved", `**${req.habbo}** → ${req.tokens} Tokens`, "#2ecc71");
        return interaction.update({ content: `✅ Approved → ${req.tokens} Tokens given`, embeds: [], components: [] });
      }

      if (action === "dep" && type === "deny") {
        delete DATA.deposit_requests[userId];
        saveData();
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) await sendDM(user, "❌ Deposit Denied", `Your ${req.type} deposit was denied.`);
        await sendLog("❌ Deposit Denied", `**${req.habbo}** deposit rejected`, "#e74c3c");
        return interaction.update({ content: `❌ Denied`, embeds: [], components: [] });
      }
    }
  } catch (err) {
    if (err.message === "Defer timeout") return;
    console.error("❌ Error:", err);
    if (interaction.deferred) interaction.editReply({ content: "❌ Something went wrong." }).catch(() => {});
  }
});

client.login(CONFIG.bot.token);
