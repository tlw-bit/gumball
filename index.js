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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const fetch = require('node-fetch');

// ==============================================
// CONFIGURATION — SAFE DEFAULTS ADDED
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
  room_link: "https://www.habbo.com/room/1234567",
  rates: {
    starting_tokens: 0,
    credit_per_token: 3,
    furni_per_token: 20
  },
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
function getHabboName(discordId) { return habboLinks[discordId.toString()] || "Not linked"; }

function getAvatar(habboName) {
  if (!habboName || habboName === "Not linked") return "https://www.habbo.com/habbo-imaging/avatarimage?user=Habbo&headonly=1&direction=2&size=l";
  const safe = encodeURIComponent(habboName.trim());
  return `https://www.habbo.com/habbo-imaging/avatarimage?user=${safe}&direction=2&headonly=1&size=l`;
}

async function getFurniDetails(furniName) {
  const safeName = furniName.toLowerCase()
    .replace(/ /g, "_")
    .replace(/'/g, "")
    .replace(/&/g, "and")
    .replace(/-/g, "_");

  let iconUrl = "https://i.imgur.com/9Z7X9QH.png";
  let exists = false;
  let avgPrice = "❌ No price data";

  try {
    const res = await fetch(`https://habbofurni.com/api/v1/furniture/${safeName}`, { timeout: 4000 });
    if (res.ok) {
      const data = await res.json();
      if (data && data.image) {
        iconUrl = data.image;
        exists = true;
      }
    }
  } catch (err) { /* ignore */ }

  try {
    const res = await fetch(`https://www.furnieye.com/api/search?q=${encodeURIComponent(furniName)}`, { timeout: 5000 });
    if (res.ok) {
      const data = await res.json();
      if (data.results?.length > 0) {
        const match = data.results.find(i => i.name.toLowerCase() === furniName.toLowerCase()) || data.results[0];
        if (match?.average_price != null) {
          avgPrice = `${match.average_price}c`;
          if (!exists) exists = true;
        }
      }
    }
  } catch (err) { /* ignore */ }

  return { icon: iconUrl, price: avgPrice, exists: exists };
}

async function buildStockEmbed() {
  const embed = new EmbedBuilder()
    .setTitle("🎁 Available Prizes & Stock")
    .setDescription("Grouped by rarity • Images from Habbofurni • Prices from FurniEye • 5 items per row")
    .setColor("#7289da")
    .setTimestamp();

  for (const group of CONFIG.rarity_groups) {
    const items = STOCK[group.id].filter(i => i.stock > 0);
    if (items.length === 0) {
      embed.addFields({ name: group.name, value: "> No items currently in stock", inline: false });
      continue;
    }

    let content = "";
    for (let i = 0; i < items.length; i += 5) {
      const rowItems = items.slice(i, i + 5);
      const names = [], images = [], info = [];
      for (const item of rowItems) {
        const details = await getFurniDetails(item.name);
        names.push(item.name.padEnd(18));
        images.push(`[ ](${details.icon})`.padEnd(18));
        info.push(`${details.price} | Stock: ${item.stock}`.padEnd(22));
      }
      content += `\`\`\`${names.join(" | ")}\n${images.join(" | ")}\n${info.join(" | ")}\`\`\`\n\n`;
    }
    embed.addFields({ name: group.name, value: content.trim(), inline: false });
  }
  return embed;
}

async function updateStockDisplay() {
  if (!CONFIG.channels.stock_display) return;
  const channel = await client.channels.fetch(CONFIG.channels.stock_display).catch(() => null);
  if (!channel) return;
  const embed = await buildStockEmbed();
  try {
    if (DATA.stock_display_message_id) {
      const msg = await channel.messages.fetch(DATA.stock_display_message_id).catch(() => null);
      if (msg) return await msg.edit({ embeds: [embed] });
    }
    const newMsg = await channel.send({ embeds: [embed] });
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

async function sendLog(title, description, color = "#95a5a6") {
  if (!CONFIG.channels.log) return;
  try {
    const ch = await client.channels.fetch(CONFIG.channels.log).catch(() => null);
    if (ch) await ch.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp()] });
  } catch {}
}

async function sendDM(user, title, message, color = "#2ecc71") {
  try { await user.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(message).setColor(color).setTimestamp()] }); return true; }
  catch { return false; }
}

// ==============================================
// BOT SETUP — WARNING FIXED
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
  const guild = CONFIG.bot.guild_id ? client.guilds.cache.get(CONFIG.bot.guild_id) : null;
  if (!guild) return console.error("❌ GUILD_ID missing or invalid in .env");

  // ✅ All commands have descriptions — no undefined
  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Show all available commands"),
    new SlashCommandBuilder().setName("balance").setDescription("Check your token balance & linked Habbo"),
    new SlashCommandBuilder().setName("howtoplay").setDescription("View rates, rules & how to earn tokens"),
    new SlashCommandBuilder().setName("showprizes").setDescription("View live stock, prices & images"),
    new SlashCommandBuilder().setName("gumball").setDescription("Spin the machine for prizes (costs 1 Token)"),
    new SlashCommandBuilder().setName("claim").setDescription("Claim a prize you won")
      .addStringOption(o => o.setName("prize").setDescription("Exact name of the prize").setRequired(true)),
    new SlashCommandBuilder().setName("depositcoins").setDescription("Submit credit deposit")
      .addIntegerOption(o => o.setName("amount").setDescription("Number of credits").setRequired(true)),
    new SlashCommandBuilder().setName("depositfurni").setDescription("Submit furni deposit")
      .addIntegerOption(o => o.setName("quantity").setDescription("Total items").setRequired(true))
      .addStringOption(o => o.setName("items").setDescription("List of furni names").setRequired(true)),
    new SlashCommandBuilder().setName("addstock").setDescription("Add new items to stock")
      .addStringOption(o => o.setName("group").setDescription("blue/purple/green/lilac/golden").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Exact furni name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity to add").setRequired(true)),
    new SlashCommandBuilder().setName("removestock").setDescription("Remove items from stock")
      .addStringOption(o => o.setName("group").setDescription("blue/purple/green/lilac/golden").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Exact furni name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity to remove").setRequired(true)),
    new SlashCommandBuilder().setName("addtokens").setDescription("Add tokens to a user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Number of tokens").setRequired(true)),
    new SlashCommandBuilder().setName("removetokens").setDescription("Remove tokens from a user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Number of tokens").setRequired(true))
  ];

  await guild.commands.set(commands);
  console.log("✅ All commands registered");

  cron.schedule("*/5 * * * *", updateStockDisplay);
  await updateStockDisplay();
});

// ==============================================
// INTERACTION HANDLING
// ==============================================
client.on("interactionCreate", async interaction => {
  const isStaff = interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) ||
    (CONFIG.bot.admin_role_id && interaction.member?.roles?.cache?.has(CONFIG.bot.admin_role_id));

  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {

        case "howtoplay":
          return interaction.reply({
            embeds: [new EmbedBuilder()
              .setTitle("📋 How To Play & Earn Tokens")
              .setDescription(`• ${CONFIG.rates.credit_per_token} Credits = 1 Token\n• ${CONFIG.rates.furni_per_token} Furni = 1 Token\n• Deposit coins/furni to earn tokens\n• \`/gumball\` to spin\n• \`/claim\` to receive your prize`)
              .setColor("#3498db")]
          });

        case "showprizes":
          return interaction.reply({ embeds: [await buildStockEmbed()] });

        case "addstock": {
          if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
          const group = interaction.options.getString("group").toLowerCase();
          const name = interaction.options.getString("name").trim();
          const amount = interaction.options.getInteger("amount");

          if (!STOCK.hasOwnProperty(group))
            return interaction.reply({ content: "❌ Use: blue / purple / green / lilac / golden", ephemeral: true });

          const details = await getFurniDetails(name);
          if (!details.exists)
            return interaction.reply({ content: `⚠️ **"${name}" not found — NOT added to stock.** Check spelling.`, ephemeral: true });

          const existing = STOCK[group].find(i => i.name.toLowerCase() === name.toLowerCase());
          existing ? existing.stock += amount : STOCK[group].push({ name, stock: amount });
          saveStock();
          await updateStockDisplay();
          await sendLog("✅ Stock Added", `**${name}** x${amount} → ${group}`, "#27ae60");
          return interaction.reply({ content: `✅ Added **${amount}x ${name}**\n💰 ${details.price}`, ephemeral: true });
        }

        case "removestock": {
          if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
          const group = interaction.options.getString("group").toLowerCase();
          const name = interaction.options.getString("name").trim();
          const amount = interaction.options.getInteger("amount");

          const idx = STOCK[group].findIndex(i => i.name.toLowerCase() === name.toLowerCase());
          if (idx === -1) return interaction.reply({ content: "❌ Item not found", ephemeral: true });

          STOCK[group][idx].stock -= amount;
          if (STOCK[group][idx].stock <= 0) STOCK[group].splice(idx, 1);
          saveStock();
          await updateStockDisplay();
          await sendLog("📤 Stock Removed", `**${name}** -${amount} from ${group}`, "#e67e22");
          return interaction.reply({ content: `✅ Removed **${amount}x ${name}**`, ephemeral: true });
        }

        case "claim": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify your account first", ephemeral: true });
          const prize = interaction.options.getString("prize").trim();

          let found = false;
          for (const g of CONFIG.rarity_groups) {
            const item = STOCK[g.id].find(i => i.name.toLowerCase() === prize.toLowerCase() && i.stock > 0);
            if (item) { item.stock--; found = true; break; }
          }

          if (!found) return interaction.reply({ content: "❌ Prize out of stock or misspelled", ephemeral: true });

          saveStock();
          await updateStockDisplay();
          const details = await getFurniDetails(prize);
          await sendLog("🏆 Prize Claimed", `**${habbo}** claimed **${prize}**`, "#f1c40f");
          return interaction.reply({
            embeds: [new EmbedBuilder()
              .setTitle("✅ Claim Successful")
              .setThumbnail(details.icon)
              .setDescription(`You claimed **${prize}**!\nRemaining stock: ${STOCK[Object.keys(STOCK).find(k => STOCK[k].some(i => i.name === prize))]?.find(i => i.name === prize)?.stock || 0}`)
              .setColor("#2ecc71")]
          });
        }

        case "balance": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify first", ephemeral: true });
          const user = ensureUser(interaction.user.id);
          return interaction.reply({ embeds: [new EmbedBuilder().setTitle("💰 Your Balance").setThumbnail(getAvatar(habbo)).addFields({ name: "Tokens", value: `${user.balance}` }, { name: "Habbo", value: habbo }).setColor("#2ecc71")], ephemeral: true });
        }

        case "gumball": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify first", ephemeral: true });
          const user = ensureUser(interaction.user.id);
          if (user.balance < 1) return interaction.reply({ content: "❌ Need 1 Token to play", ephemeral: true });
          user.balance -= 1; saveData();

          const available = CONFIG.rarity_groups.filter(g => STOCK[g.id].some(i => i.stock > 0));
          if (!available.length) { user.balance += 1; saveData(); return interaction.reply({ content: "😕 No prizes — token refunded", ephemeral: true }); }

          const group = available[Math.floor(Math.random() * available.length)];
          const items = STOCK[group.id].filter(i => i.stock > 0);
          const prize = items[Math.floor(Math.random() * items.length)];
          prize.stock--; saveStock(); await updateStockDisplay();

          const details = await getFurniDetails(prize.name);
          return interaction.reply({
            embeds: [new EmbedBuilder()
              .setTitle("🎉 YOU WON!")
              .setThumbnail(details.icon)
              .setDescription(`**${prize.name}**\nRarity: ${group.name}\nPrice: ${details.price}\nNew Balance: ${user.balance}`)
              .setColor(group.color)]
          });
        }

        case "addtokens": {
          if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
          const target = interaction.options.getUser("user");
          const amount = interaction.options.getInteger("amount");
          ensureUser(target.id).balance += amount;
          addToHistory(target.id, "Tokens Added", `+${amount} by ${interaction.user.tag}`);
          saveData();
          await sendLog("➕ Tokens Added", `**${target.tag}**: +${amount}`, "#2ecc71");
          return interaction.reply({ content: `✅ Added ${amount} tokens to ${target}`, ephemeral: true });
        }

        case "removetokens": {
          if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
          const target = interaction.options.getUser("user");
          const amount = interaction.options.getInteger("amount");
          ensureUser(target.id).balance = Math.max(0, ensureUser(target.id).balance - amount);
          addToHistory(target.id, "Tokens Removed", `-${amount} by ${interaction.user.tag}`);
          saveData();
          await sendLog("➖ Tokens Removed", `**${target.tag}**: -${amount}`, "#e74c3c");
          return interaction.reply({ content: `✅ Removed ${amount} tokens from ${target}`, ephemeral: true });
        }

      }
    }
  } catch (err) {
    console.error("❌ Error:", err);
    if (!interaction.replied) interaction.reply({ content: "❌ Something went wrong", ephemeral: true }).catch(() => {});
  }
});

client.login(CONFIG.bot.token);
