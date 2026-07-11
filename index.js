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
    token: process.env.BOT_TOKEN || "",
    guild_id: process.env.GUILD_ID || "",
    verified_role_id: process.env.VERIFIED_ROLE_ID || "",
    admin_role_id: process.env.ADMIN_ROLE_ID || "",
    owner_role_id: process.env.OWNER_ROLE_ID || ""
  },
  channels: {
    mod_awareness: process.env.MOD_CHANNEL_ID || "",
    claims: process.env.CLAIMS_CHANNEL_ID || "",
    log: process.env.LOG_CHANNEL_ID || "",
    stock_display: process.env.STOCK_DISPLAY_CHANNEL_ID || ""
  },
  habbo_assets_token: process.env.HABBO_ASSETS_TOKEN || "",
  habbofurni_token: process.env.HABBOFURNI_TOKEN || "",
  habboapi_key: process.env.HABBOAPI_KEY || "", // Optional: add if you get one
  room_link: "https://www.habbo.com/room/1234567",
  rates: {
    starting_tokens: 0,
    credit_per_token: 3,
    furni_per_token: 20
  },
  default_image: "https://i.imgur.com/9Z7X9QH.png",
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
const HABBO_LINKS_PATH = path.join(__dirname, 'habboLinks.json');
const STOCK_PATH = path.join(__dirname, 'stock.json');
const DATA_PATH = path.join(__dirname, 'data.json');

let habboLinks = {};
if (fs.existsSync(HABBO_LINKS_PATH)) {
  try { habboLinks = JSON.parse(fs.readFileSync(HABBO_LINKS_PATH, 'utf8')); }
  catch { habboLinks = {}; fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify(habboLinks, null, 2)); }
} else fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify({}, null, 2));

let STOCK = { blue: [], purple: [], green: [], lilac: [], golden: [] };
if (fs.existsSync(STOCK_PATH)) try { STOCK = JSON.parse(fs.readFileSync(STOCK_PATH, 'utf8')); } catch {}

let DATA = {
  users: {},
  deposit_requests: {},
  pending_claims: {},
  stock_display_message_id: null
};
if (fs.existsSync(DATA_PATH)) try { DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch {}

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

// ==============================================
// ✅ NEW FURNI LOOKUP — HABBOAPI SITE FIRST
// ==============================================
async function getFurniDetails(furniName) {
  const original = furniName.trim();
  const searchKey = normalizeName(original);

  let iconUrl = CONFIG.default_image;
  let price = "❌ No price data";
  let matchedName = original;
  let classname = null;

  // --- 1. HABBOAPI.SITE: Get Price + Classname ---
  try {
    const headers = { "Accept": "application/json" };
    if (CONFIG.habboapi_key) headers["X-Auth-Key"] = CONFIG.habboapi_key;

    const res = await fetch(`https://habboapi.site/api/market/history?name=${encodeURIComponent(original)}&hotel=com`, {
      headers,
      timeout: 6000
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        // Find best match
        let best = data.find(i => normalizeName(i.FurniName) === searchKey);
        if (!best) best = data.find(i => normalizeName(i.FurniName).includes(searchKey));
        if (!best) best = data[0];

        if (best) {
          matchedName = best.FurniName;
          classname = best.ClassName;
          if (best.marketData?.averagePrice) {
            price = `${best.marketData.averagePrice}c`;
          }
          // Get direct image from same API
          iconUrl = `https://habboapi.site/api/image/${best.ClassName}`;
        }
      }
    }
  } catch {}

  // --- 2. Fallback: Habbo Assets if no image yet ---
  if (iconUrl === CONFIG.default_image && CONFIG.habbo_assets_token) {
    try {
      const res = await fetch(`https://habboassets.com/api/search?q=${encodeURIComponent(original)}&limit=10`, {
        headers: { Authorization: `Bearer ${CONFIG.habbo_assets_token}` },
        timeout: 4000
      });
      if (res.ok) {
        const data = await res.json();
        if (data.items?.length > 0) {
          const best = data.items.find(i => normalizeName(i.name) === searchKey) || data.items[0];
          if (best) {
            iconUrl = best.image_url || best.icon_url;
            matchedName = matchedName !== original ? matchedName : best.name;
          }
        }
      }
    } catch {}
  }

  // --- 3. Fallback: FurniEye only if still no price ---
  if (price === "❌ No price data") {
    try {
      const res = await fetch(`https://www.furnieye.com/api/search?q=${encodeURIComponent(original)}&limit=10`, { timeout: 4000 });
      if (res.ok) {
        const data = await res.json();
        if (data.results?.length > 0) {
          const best = data.results.find(i => normalizeName(i.name) === searchKey) || data.results[0];
          if (best?.average_price) price = `${best.average_price}c`;
        }
      }
    } catch {}
  }

  return { icon: iconUrl, price, name: matchedName, exists: true };
}

// ==============================================
// ✅ GRID LAYOUT — MATCHES YOUR EXAMPLE
// ==============================================
async function buildStockEmbed() {
  const embed = new EmbedBuilder()
    .setTitle("🎁 Available Prizes & Stock")
    .setDescription("**Images:** HabboAPI • **Prices:** HabboAPI + FurniEye\n• Items arranged in rows of 5")
    .setColor("#23272A")
    .setTimestamp();

  for (const group of CONFIG.rarity_groups) {
    const items = STOCK[group.id].filter(i => i.stock > 0);
    if (!items.length) {
      embed.addFields({ name: group.name, value: "> No items currently in stock", inline: false });
      continue;
    }

    // Split into rows of 5 items
    for (let rowIdx = 0; rowIdx < items.length; rowIdx += 5) {
      const row = items.slice(rowIdx, rowIdx + 5);
      let rowContent = "";

      for (const item of row) {
        const details = await getFurniDetails(item.name);
        // Clean format: [image] Name | Price | Stock
        rowContent += `[🖼️](${details.icon}) **${details.name}**\n💰 ${details.price} | 📦 Stock: ${item.stock}\n\n`;
      }

      embed.addFields({
        name: rowIdx === 0 ? group.name : `${group.name} (continued)`,
        value: rowContent.trim(),
        inline: true
      });
    }
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

function ensureUser(id) {
  id = id.toString();
  if (!DATA.users[id]) DATA.users[id] = { balance: CONFIG.rates.starting_tokens, history: [] };
  return DATA.users[id];
}

function addToHistory(userId, type, details) {
  const user = ensureUser(userId);
  user.history.unshift({ timestamp: new Date().toISOString(), type, details });
  if (user.history.length > 50) user.history.pop();
  saveData();
}

async function autoLinkVerified(member) {
  if (!member || !member.roles?.cache) return null;
  const hasRole = CONFIG.bot.verified_role_id ? member.roles.cache.has(CONFIG.bot.verified_role_id) : false;
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
    const content = tagOwners && CONFIG.bot.owner_role_id ? `<@&${CONFIG.bot.owner_role_id}>` : "";
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

client.once("ready", async () => {
  console.log(`✅ Gumball Bot online as ${client.user.tag}`);
  const guild = CONFIG.bot.guild_id ? client.guilds.cache.get(CONFIG.bot.guild_id) : null;
  if (!guild) return console.error("❌ Invalid GUILD_ID");

  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Show all commands"),
    new SlashCommandBuilder().setName("balance").setDescription("Check your token balance"),
    new SlashCommandBuilder().setName("howtoplay").setDescription("Earn rates & rules"),
    new SlashCommandBuilder().setName("showprizes").setDescription("View stock, prices & images"),
    new SlashCommandBuilder().setName("gumball").setDescription("Spin for prizes (1 Token)"),
    new SlashCommandBuilder().setName("claim").setDescription("Claim your prize")
      .addStringOption(o => o.setName("prize").setDescription("Prize name").setRequired(true)),
    new SlashCommandBuilder().setName("depositcoins").setDescription("Submit credit deposit")
      .addIntegerOption(o => o.setName("amount").setDescription("Credits amount").setRequired(true)),
    new SlashCommandBuilder().setName("depositfurni").setDescription("Submit furni deposit")
      .addIntegerOption(o => o.setName("quantity").setDescription("Total items").setRequired(true))
      .addStringOption(o => o.setName("items").setDescription("List of items").setRequired(true)),
    new SlashCommandBuilder().setName("addstock").setDescription("Add items to stock")
      .addStringOption(o => o.setName("group").setDescription("blue/purple/green/lilac/golden").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Furni name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity").setRequired(true))
      .addBooleanOption(o => o.setName("force").setDescription("Add even if not found").setRequired(false))
      .addStringOption(o => o.setName("image_url").setDescription("Custom image (optional)").setRequired(false))
      .addStringOption(o => o.setName("price").setDescription("Custom price (optional)").setRequired(false)),
    new SlashCommandBuilder().setName("removestock").setDescription("Remove items from stock")
      .addStringOption(o => o.setName("group").setDescription("Rarity group").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Furni name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity").setRequired(true)),
    new SlashCommandBuilder().setName("addtokens").setDescription("Give tokens to user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Number of tokens").setRequired(true)),
    new SlashCommandBuilder().setName("removetokens").setDescription("Take tokens from user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Number of tokens").setRequired(true))
  ];

  await guild.commands.set(commands);
  console.log("✅ All commands registered");

  cron.schedule("*/5 * * * *", updateStockDisplay);
  await updateStockDisplay();
});

// ==============================================
// COMMAND HANDLERS
// ==============================================
client.on("interactionCreate", async interaction => {
  const isStaff = interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) ||
    (CONFIG.bot.admin_role_id && interaction.member?.roles?.cache?.has(CONFIG.bot.admin_role_id));

  try {
    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      switch (interaction.commandName) {
        case "help": {
          return interaction.editReply({
            content: `**📋 Commands**
**User**
\`/balance\` • \`/howtoplay\` • \`/depositcoins\` • \`/depositfurni\` • \`/gumball\` • \`/claim\` • \`/showprizes\`
**Staff**
\`/addstock\` • \`/removestock\` • \`/addtokens\` • \`/removetokens\``
          });
        }

        case "howtoplay": {
          return interaction.editReply({
            embeds: [new EmbedBuilder()
              .setTitle("📋 How To Play")
              .setDescription(`• ${CONFIG.rates.credit_per_token}c = 1 Token\n• ${CONFIG.rates.furni_per_token} Furni = 1 Token\n• Deposit to earn tokens\n• Spin & claim prizes!\nRoom: ${CONFIG.room_link}`)
              .setColor("#3498db")]
          });
        }

        case "showprizes": {
          return interaction.editReply({ embeds: [await buildStockEmbed()], flags: 0 });
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

        case "claim": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.editReply({ content: "❌ Verify first" });
          const prize = interaction.options.getString("prize").trim();

          let found = false, prizeGroup = null;
          for (const g of CONFIG.rarity_groups) {
            const item = STOCK[g.id].find(i => normalizeName(i.name) === normalizeName(prize) && i.stock > 0);
            if (item) { item.stock--; found = true; prizeGroup = g; break; }
          }

          if (!found) return interaction.editReply({ content: "❌ Not found or out of stock" });

          saveStock();
          await updateStockDisplay();
          const details = await getFurniDetails(prize);
          await sendLog("🏆 Prize Claimed", `**${habbo}** claimed **${prize}**`, "#f1c40f");
          await sendDM(interaction.user, "✅ Claim Successful", `You got **${prize}**! Staff will deliver soon.`);
          return interaction.editReply({
            embeds: [new EmbedBuilder()
              .setTitle("✅ Claim Successful")
              .setThumbnail(details.icon)
              .setDescription(`Prize: **${prize}**\nHabbo: ${habbo}`)
              .setColor("#2ecc71")]
          });
        }

        case "balance": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.editReply({ content: "❌ Verify your account first" });
          const user = ensureUser(interaction.user.id);
          return interaction.editReply({
            embeds: [new EmbedBuilder()
              .setTitle("💰 Your Balance")
              .setThumbnail(getAvatar(habbo))
              .addFields({ name: "Tokens", value: `${user.balance}` }, { name: "Habbo", value: habbo })
              .setColor("#2ecc71")]
          });
        }

        case "gumball": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.editReply({ content: "❌ Verify first" });
          const user = ensureUser(interaction.user.id);
          if (user.balance < 1) return interaction.editReply({ content: "❌ Need 1 Token to play" });
          user.balance -= 1; saveData();

          const available = CONFIG.rarity_groups.filter(g => STOCK[g.id].some(i => i.stock > 0));
          if (!available.length) { user.balance += 1; saveData(); return interaction.editReply({ content: "😕 No prizes available — token refunded" }); }

          const group = available[Math.floor(Math.random() * available.length)];
          const items = STOCK[group.id].filter(i => i.stock > 0);
          const prize = items[Math.floor(Math.random() * items.length)];
          prize.stock--; saveStock(); await updateStockDisplay();

          const details = await getFurniDetails(prize.name);
          const embed = new EmbedBuilder()
            .setTitle("🎉 YOU WON!")
            .setThumbnail(details.icon)
            .setDescription(`**${prize.name}**\nRarity: ${group.name}\nPrice: ${details.price}\nNew Balance: ${user.balance}`)
            .setColor(group.color);
          await sendDM(interaction.user, "🎉 You Won!", `You won **${prize.name}**! Use \`/claim ${prize.name}\` to receive it.`);
          return interaction.editReply({ embeds: [embed] });
        }

        case "depositcoins": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.editReply({ content: "❌ Verify first" });
          const amount = interaction.options.getInteger("amount");
          const tokens = Math.floor(amount / CONFIG.rates.credit_per_token);

          DATA.deposit_requests[interaction.user.id] = { type: "credits", amount, tokens, habbo, timestamp: new Date().toISOString() };
          saveData();

          const modEmbed = new EmbedBuilder()
            .setTitle("💸 New Credit Deposit")
            .setThumbnail(getAvatar(habbo))
            .setDescription(`**User:** ${interaction.user.tag}\n**Habbo:** ${habbo}\n**Amount:** ${amount}c\n**Tokens:** ${tokens}`)
            .setColor("#3498db");

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dep_approve_${interaction.user.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dep_deny_${interaction.user.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
          );

          const modCh = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
          if (modCh) await modCh.send({ content: `<@&${CONFIG.bot.admin_role_id}>`, embeds: [modEmbed], components: [row] });

          return interaction.editReply({ content: `✅ Deposit submitted! ${amount}c = ${tokens} Tokens.` });
        }

        case "depositfurni": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.editReply({ content: "❌ Verify first" });
          const quantity = interaction.options.getInteger("quantity");
          const items = interaction.options.getString("items");
          const tokens = Math.floor(quantity / CONFIG.rates.furni_per_token);

          DATA.deposit_requests[interaction.user.id] = { type: "furni", quantity, items, tokens, habbo, timestamp: new Date().toISOString() };
          saveData();

          const modEmbed = new EmbedBuilder()
            .setTitle("📦 New Furni Deposit")
            .setThumbnail(getAvatar(habbo))
            .setDescription(`**User:** ${interaction.user.tag}\n**Habbo:** ${habbo}\n**Items:** ${items}\n**Quantity:** ${quantity}\n**Tokens:** ${tokens}`)
            .setColor("#9b59b6");

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dep_approve_${interaction.user.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dep_deny_${interaction.user.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
          );

          const modCh = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
          if (modCh) await modCh.send({ content: `<@&${CONFIG.bot.admin_role_id}>`, embeds: [modEmbed], components: [row] });

          return interaction.editReply({ content: `✅ Deposit submitted! ${quantity} items = ${tokens} Tokens.` });
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
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
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
    console.error("❌ Error:", err);
    if (interaction.deferred) interaction.editReply({ content: "❌ Something went wrong." }).catch(() => {});
  }
});

client.login(CONFIG.bot.token);
