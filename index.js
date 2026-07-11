// Load environment variables FIRST
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
    token: process.env.BOT_TOKEN,
    guild_id: process.env.GUILD_ID || "",
    verified_role_id: process.env.VERIFIED_ROLE_ID || "",
    admin_role_id: process.env.ADMIN_ROLE_ID || "",
    owner_role_id: process.env.OWNER_ROLE_ID || "" // For tagging @Owner
  },
  channels: {
    mod_awareness: process.env.MOD_CHANNEL_ID,    // gumball-deposit
    claims: process.env.CLAIMS_CHANNEL_ID,        // gumball-claims
    log: process.env.LOG_CHANNEL_ID,              // gumball-log
    stock: process.env.STOCK_CHANNEL_ID           // gumball-stock
  },
  room_link: "https://www.habbo.com/room/1234567",
  rates: {
    starting_tokens: 0,
    credit_per_token: 3,
    furni_per_token: 20, // ✅ 20 furni = 1 token
    bulk_packages: [
      { cost: 15, tokens: 5, label: "15 Credits → 5 Tokens" },
      { cost: 25, tokens: 10, label: "25 Credits → 10 Tokens" },
      { cost: 50, tokens: 25, label: "50 Credits → 25 Tokens" }
    ]
  },
  rarity_groups: [
    { id: "blue", name: "Blue", chance: 45, credit_min: 1, credit_max: 3, token_min: 1, token_max: 2, color: "#3498db" },
    { id: "purple", name: "Purple", chance: 25, credit_min: 3, credit_max: 8, token_min: 2, token_max: 4, color: "#9b59b6" },
    { id: "green", name: "Green", chance: 15, credit_min: 8, credit_max: 20, token_min: 3, token_max: 6, color: "#2ecc71" },
    { id: "lilac", name: "Lilac", chance: 10, credit_min: 20, credit_max: 50, token_min: 5, token_max: 10, color: "#e84393" },
    { id: "golden", name: "Golden", chance: 5, credit_min: 50, credit_max: 200, token_min: 10, token_max: 25, color: "#f1c40f" }
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

let DATA = { users: {}, deposit_requests: {}, pending_claims: {}, weeklyLeaderboard: { weekStart: new Date().toISOString(), users: {} } };
if (fs.existsSync(DATA_PATH)) try { DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch {}

function saveStock() { fs.writeFileSync(STOCK_PATH, JSON.stringify(STOCK, null, 2)); }
function saveData() { fs.writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2)); }
function saveHabboLinks() { fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify(habboLinks, null, 2)); }

// ==============================================
// HELPER FUNCTIONS
// ==============================================
function getHabboName(discordId) { return habboLinks[discordId.toString()] || null; }

function getAvatar(habboName) {
  if (!habboName) return "https://www.habbo.com/habbo-imaging/avatarimage?user=Habbo&headonly=1&direction=2&size=l";
  const safe = encodeURIComponent(habboName.trim());
  return `https://www.habbo.com/habbo-imaging/avatarimage?user=${safe}&direction=2&headonly=1&size=l&gesture=std`;
}

async function getFurniDetails(furniName) {
  const safeName = furniName.toLowerCase().replace(/ /g, "_").replace(/'/g, "").replace(/&/g, "and");
  const iconUrl = `https://images.habbo.com/dcr/hof_furni/${safeName}_icon.png`;
  const searchUrl = `https://www.furnieye.com/api/search?q=${encodeURIComponent(furniName)}`;
  let avgPrice = "Estimated";

  try {
    const res = await fetch(searchUrl, { timeout: 5000 });
    if (res.ok) {
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        const match = data.results.find(item => item.name.toLowerCase() === furniName.toLowerCase()) || data.results[0];
        avgPrice = match.average_price ? `${match.average_price}c` : "Unlisted";
      }
    }
  } catch (err) {
    const group = CONFIG.rarity_groups.find(g => STOCK[g.id]?.some(i => i.name === furniName));
    avgPrice = group ? `${Math.round((group.credit_min + group.credit_max) / 2)}c` : "N/A";
  }

  return { icon: iconUrl, price: avgPrice, link: `https://www.furnieye.com/items?search=${encodeURIComponent(furniName)}` };
}

function ensureUser(id) {
  id = id.toString();
  if (!DATA.users[id]) DATA.users[id] = { balance: CONFIG.rates.starting_tokens, history: [] };
  return DATA.users[id];
}

async function autoLinkVerified(member) {
  if (!member || !member.roles?.cache) return null;
  const hasRole = member.roles.cache.has(CONFIG.bot.verified_role_id);
  if (!hasRole) return null;
  const habboName = member.nickname?.trim() || member.user.username.trim();
  if (!habboLinks[member.id] && habboName) {
    habboLinks[member.id] = habboName;
    saveHabboLinks();
    console.log(`✅ Auto-linked: ${member.user.tag} → ${habboName}`);
  }
  return habboLinks[member.id] || null;
}

async function sendLog(description, color = "#95a5a6") {
  try {
    const logChannel = await client.channels.fetch(CONFIG.channels.log).catch(() => null);
    if (!logChannel) return;
    const embed = new EmbedBuilder()
      .setTitle("📋 Gumball Bot Log")
      .setDescription(description)
      .setColor(color)
      .setTimestamp();
    await logChannel.send({ embeds: [embed] });
  } catch (err) { console.error("Log error:", err.message); }
}

async function sendStockUpdate(action, item, group, amount, user) {
  try {
    const stockChannel = await client.channels.fetch(CONFIG.channels.stock).catch(() => null);
    if (!stockChannel) return;
    const groupData = CONFIG.rarity_groups.find(g => g.id === group);
    const details = await getFurniDetails(item.name);
    const embed = new EmbedBuilder()
      .setTitle(action === "add" ? "📥 Stock Added" : "📤 Stock Removed")
      .setDescription(`
**Item:** ${item.name}
**Rarity:** ${groupData.name}
**Current Value:** ${details.price}
**New Stock Level:** ${STOCK[group].find(i => i.name.toLowerCase() === item.name.toLowerCase())?.stock || 0}
**Updated by:** ${user.tag}
      `.trim())
      .setColor(groupData.color)
      .setThumbnail(details.icon)
      .setTimestamp();
    await stockChannel.send({ embeds: [embed] });
  } catch (err) { console.error("Stock log error:", err.message); }
}

async function sendWinLog(user, habboName, prize, group, price, tokensWon) {
  try {
    const logChannel = await client.channels.fetch(CONFIG.channels.log).catch(() => null);
    if (!logChannel) return;
    const details = await getFurniDetails(prize.name);
    const embed = new EmbedBuilder()
      .setTitle("🎉 Prize Won!")
      .setAuthor({ name: habboName, iconURL: getAvatar(habboName) })
      .setThumbnail(details.icon)
      .setDescription(`
**Discord User:** ${user}
**Habbo Account:** ${habboName}
**Prize:** ${prize.name}
**Rarity Tier:** ${group.name}
**Market Value:** ${price}
**Tokens Earned:** +${tokensWon}
**Remaining Stock:** ${prize.stock}
      `.trim())
      .setColor(group.color)
      .setTimestamp();
    await logChannel.send({ embeds: [embed] });
  } catch (err) { console.error("Win log error:", err.message); }
}

// Get @Owner mention
function getOwnerMention() {
  return CONFIG.bot.owner_role_id ? `<@&${CONFIG.bot.owner_role_id}>` : "";
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

  const guild = client.guilds.cache.get(CONFIG.bot.guild_id);
  if (!guild) return console.error("❌ Could not find server — check GUILD_ID");

  await client.application.commands.set([]);
  await guild.commands.set([]);
  console.log("🧹 Cleared old commands");

  const commands = [
    new SlashCommandBuilder().setName("balance").setDescription("Check your token balance and linked Habbo account"),
    new SlashCommandBuilder().setName("gumball").setDescription("Play the gumball machine — costs 1 Token per spin"),
    new SlashCommandBuilder().setName("howtoplay").setDescription("View exchange rates and how to earn tokens"),
    new SlashCommandBuilder().setName("showprizes").setDescription("See all available prizes, values and stock levels"),
    new SlashCommandBuilder().setName("history").setDescription("View your activity history"),
    new SlashCommandBuilder().setName("whatsnew").setDescription("See latest updates and features"),
    new SlashCommandBuilder().setName("depositcoins").setDescription("Submit a credit deposit")
      .addIntegerOption(o => o.setName("amount").setDescription("Number of credits").setRequired(true)),
    new SlashCommandBuilder().setName("depositfurni").setDescription("Submit a furni deposit")
      .addIntegerOption(o => o.setName("quantity").setDescription("Total number of furni items").setRequired(true))
      .addStringOption(o => o.setName("items").setDescription("List of furni names/items").setRequired(true)),
    new SlashCommandBuilder().setName("claim").setDescription("Claim a prize you won")
      .addStringOption(o => o.setName("prize").setDescription("Name of the prize to claim").setRequired(true)),
    new SlashCommandBuilder().setName("addtokens").setDescription("Add tokens to a user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Amount of tokens").setRequired(true)),
    new SlashCommandBuilder().setName("removetokens").setDescription("Remove tokens from a user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Amount of tokens").setRequired(true)),
    new SlashCommandBuilder().setName("addstock").setDescription("Add items to prize stock")
      .addStringOption(o => o.setName("group").setDescription("Rarity: blue/purple/green/lilac/golden").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Furni name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity to add").setRequired(true)),
    new SlashCommandBuilder().setName("removestock").setDescription("Remove items from prize stock")
      .addStringOption(o => o.setName("group").setDescription("Rarity: blue/purple/green/lilac/golden").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Furni name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity to remove").setRequired(true))
  ];

  await guild.commands.set(commands);
  console.log("✅ All commands registered successfully");

  cron.schedule("0 18 * * 0", () => {
    DATA.weeklyLeaderboard = { weekStart: new Date().toISOString(), users: {} };
    saveData();
    sendLog("🔄 Weekly stats reset completed", "#f39c12");
    console.log("🔄 Weekly reset done");
  });
});

// ==============================================
// COMMAND & BUTTON HANDLING
// ==============================================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

  const isStaff = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || interaction.member.roles.cache.has(CONFIG.bot.admin_role_id);

  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {

        case "balance": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ embeds: [
            new EmbedBuilder().setTitle("💰 Your Balance")
              .setDescription("⚠️ You must be verified to use this bot.")
              .setColor("#e74c3c")
          ], flags: 64 });

          const user = ensureUser(interaction.user.id);
          return interaction.reply({ embeds: [
            new EmbedBuilder().setTitle("💰 Your Balance")
              .setThumbnail(getAvatar(habbo))
              .addFields(
                { name: "Linked Habbo", value: `✅ ${habbo}`, inline: true },
                { name: "Tokens", value: `🪙 ${user.balance}`, inline: true }
              )
              .setColor("#2ecc71")
              .setTimestamp()
          ]});
        }

        case "howtoplay": {
          const desc = `
📋 **How To Play & Get Tokens**
Earn or buy tokens, then spin the machine for prizes!

💱 **Exchange Rates**
• ${CONFIG.rates.credit_per_token} Credits = 1 Token
• ${CONFIG.rates.furni_per_token} Furni = 1 Token

🛒 **Bulk Packages**
• 15 Credits → 5 Tokens
• 25 Credits → 10 Tokens
• 50 Credits → 25 Tokens

📤 **How to Deposit**
Send your items to our room, then use:
\`/depositcoins\` or \`/depositfurni\`

📍 **Room:** ${CONFIG.room_link}

🎮 **Play**
Use \`/gumball\` — **1 Token per spin**
          `.trim();
          return interaction.reply({ embeds: [
            new EmbedBuilder().setTitle("📋 How To Play & Get Tokens")
              .setDescription(desc)
              .setColor("#3498db")
              .setTimestamp()
          ]});
        }

        case "whatsnew": {
          const updates = [
            '✅ **Auto‑Verification**: Automatically links your Habbo account',
            '✅ **Live Prices**: Pulls real‑time values from FurniEye',
            '✅ **Full Logging**: Tracks wins, deposits, and stock changes',
            '✅ **Prize Displays**: Shows item image, rarity, and remaining stock',
            '✅ **Deposit System**: Auto‑calculates tokens (20 furni = 1 token)',
            '✅ **Approval Buttons**: Working properly with avatar previews',
            '✅ **Owner Tagging**: Automatically notifies @owner for new requests',
            '✅ **Ready for Deployment**: Works on Koyeb/any host'
          ];
          const desc = updates.map(line => `• ${line}`).join("\n\n");
          return interaction.reply({ embeds: [
            new EmbedBuilder().setTitle("📢 What's New")
              .setDescription(desc)
              .setColor("#f39c12")
              .setTimestamp()
          ]});
        }

        case "depositcoins": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify your account first", flags: 64 });

          const amount = interaction.options.getInteger("amount");
          const tokens = {15:5, 25:10, 50:25}[amount] || Math.floor(amount / CONFIG.rates.credit_per_token);
          const depId = Date.now();

          DATA.deposit_requests[depId] = {
            type: "coins",
            userId: interaction.user.id,
            habbo,
            amount,
            tokens,
            status: "pending"
          };
          saveData();

          const embed = new EmbedBuilder()
            .setTitle("💸 New Credit Deposit")
            .setThumbnail(getAvatar(habbo))
            .setDescription(`
**User:** ${interaction.user}
**Habbo:** ${habbo}
**Amount:** ${amount}c
**Tokens to give:** ${tokens}
**Rate:** ${CONFIG.rates.credit_per_token}c = 1 Token
            `.trim())
            .setColor("#f39c12")
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dep_approve_${depId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dep_deny_${depId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
          );

          const modChan = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
          if (modChan) {
            await modChan.send({
              content: `${getOwnerMention()} New credit deposit request`,
              embeds: [embed],
              components: [row]
            });
          } else console.error("❌ Could not find mod/awareness channel");

          await sendLog(`💸 Deposit #${depId} submitted by ${interaction.user.tag}`, "#f39c12");
          return interaction.reply({ content: "✅ Deposit sent for review", flags: 64 });
        }

        case "depositfurni": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify your account first", flags: 64 });

          const quantity = interaction.options.getInteger("quantity");
          const items = interaction.options.getString("items");
          const tokens = Math.floor(quantity / CONFIG.rates.furni_per_token);
          const depId = Date.now();

          DATA.deposit_requests[depId] = {
            type: "furni",
            userId: interaction.user.id,
            habbo,
            quantity,
            items,
            tokens,
            status: "pending"
          };
          saveData();

          const embed = new EmbedBuilder()
            .setTitle("📦 New Furni Deposit")
            .setThumbnail(getAvatar(habbo))
            .setDescription(`
**User:** ${interaction.user}
**Habbo:** ${habbo}
**Total Furni:** ${quantity}
**Items:** ${items}
**Tokens to give:** ${tokens}
**Rate:** ${CONFIG.rates.furni_per_token} Furni = 1 Token
            `.trim())
            .setColor("#9b59b6")
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dep_approve_${depId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dep_deny_${depId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
          );

          const modChan = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
          if (modChan) {
            await modChan.send({
              content: `${getOwnerMention()} New furni deposit request`,
              embeds: [embed],
              components: [row]
            });
          } else console.error("❌ Could not find mod/awareness channel");

          await sendLog(`📦 Furni Deposit #${depId} submitted by ${interaction.user.tag} | ${quantity} items = ${tokens} tokens`, "#9b59b6");
          return interaction.reply({ content: "✅ Deposit sent for review", flags: 64 });
        }

        case "claim": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify your account first", flags: 64 });

          const prize = interaction.options.getString("prize");
          const claimId = Date.now();

          DATA.pending_claims[claimId] = {
            userId: interaction.user.id,
            habbo,
            prize,
            status: "pending"
          };
          saveData();

          const embed = new EmbedBuilder()
            .setTitle("🏆 New Prize Claim")
            .setThumbnail(getAvatar(habbo))
            .setDescription(`
**User:** ${interaction.user}
**Habbo:** ${habbo}
**Prize:** ${prize}
            `.trim())
            .setColor("#f1c40f")
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`claim_approve_${claimId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`claim_deny_${claimId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
          );

          const modChan = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
          if (modChan) {
            await modChan.send({
              content: `${getOwnerMention()} New prize claim request`,
              embeds: [embed],
              components: [row]
            });
          }

          await sendLog(`🏆 Claim #${claimId} submitted by ${interaction.user.tag} for ${prize}`, "#f1c40f");
          return interaction.reply({ content: "✅ Claim sent for review", flags: 64 });
        }

        case "gumball": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify your account first", flags: 64 });
          const user = ensureUser(interaction.user.id);
          if (user.balance < 1) return interaction.reply({ content: "❌ You need at least 1 Token to play", flags: 64 });

          user.balance -= 1;
          saveData();
          await sendLog(`🎰 ${interaction.user.tag} used 1 Token to play`, "#8e44ad");

          const group = CONFIG.rarity_groups.sort((a,b) => b.chance - a.chance).find(g => Math.random() * 100 < g.chance) || CONFIG.rarity_groups.at(-1);
          const available = STOCK[group.id]?.filter(i => i.stock > 0) || [];
          if (available.length === 0) {
            user.balance += 1;
            saveData();
            return interaction.reply({ content: "😕 No prizes in this tier — token refunded", flags: 64 });
          }

          const prize = available[Math.floor(Math.random() * available.length)];
          prize.stock--;
          saveStock();

          const tokensWon = Math.floor(Math.random() * (group.token_max - group.token_min + 1)) + group.token_min;
          user.balance += tokensWon;
          saveData();

          const furni = await getFurniDetails(prize.name);
          await sendWinLog(interaction.user, habbo, prize, group, furni.price, tokensWon);

          return interaction.reply({ embeds: [
            new EmbedBuilder().setTitle("🎉 YOU WON A PRIZE!")
              .setAuthor({ name: habbo, iconURL: getAvatar(habbo) })
              .setThumbnail(furni.icon)
              .setDescription(`
🎁 **Item:** ${prize.name}
✨ **Rarity:** ${group.name}
💵 **Current Value:** ${furni.price}
🔎 [View on FurniEye](${furni.link})

🪙 **Tokens Won:** +${tokensWon}
💰 **New Balance:** ${user.balance}

💡 Use \`/claim\` to request your prize!
              `.trim())
              .setColor(group.color)
              .setTimestamp()
          ]});
        }

        case "showprizes": {
          const embeds = [];
          for (const group of CONFIG.rarity_groups) {
            const items = STOCK[group.id]?.filter(i => i.stock > 0) || [];
            if (items.length === 0) continue;

            const list = await Promise.all(items.map(async item => {
              const d = await getFurniDetails(item.name);
              return `🖼️ **${item.name}**\n💸 **Value:** ${d.price}\n📦 **In Stock:** ${item.stock}\n🔎 [View](${d.link})\n`;
            }));

            embeds.push(new EmbedBuilder()
              .setTitle(`${group.name} Tier 🎀`)
              .setDescription(`
**Chance to win:** ${group.chance}%
**Value Range:** ${group.credit_min}–${group.credit_max}c
**Tokens Reward:** ${group.token_min}–${group.token_max}

${list.join("\n")}
              `.trim())
              .setColor(group.color)
              .setTimestamp()
            );
          }

          if (embeds.length === 0) embeds.push(new EmbedBuilder()
            .setTitle("🏆 Available Prizes")
            .setDescription("❌ No prizes currently in stock")
            .setColor("#95a5a6")
          );

          return interaction.reply({ embeds });
        }

        case "history": {
          const user = ensureUser(interaction.user.id);
          const list = user.history.length ? user.history.map(e => `• ${new Date(e.timestamp).toLocaleString()} — ${e.type}: ${e.detail}`).join("\n") : "No activity yet";
          return interaction.reply({ embeds: [
            new EmbedBuilder().setTitle("📜 Your Activity History")
              .setDescription(list)
              .setColor("#9b59b6")
              .setTimestamp()
          ], flags: 64 });
        }

        case "addtokens": {
          if (!isStaff) return interaction.reply({ content: "❌ No permission", flags: 64 });
          const target = interaction.options.getUser("user");
          const amount = interaction.options.getInteger("amount");
          ensureUser(target.id).balance += amount;
          saveData();
          await sendLog(`➕ ${interaction.user.tag} added ${amount} Tokens to ${target.tag}`, "#2ecc71");
          return interaction.reply({ content: `✅ Added ${amount} Tokens to ${target}`, flags: 64 });
        }

        case "removetokens": {
          if (!isStaff) return interaction.reply({ content: "❌ No permission", flags: 64 });
          const target = interaction.options.getUser("user");
          const amount = interaction.options.getInteger("amount");
          ensureUser(target.id).balance = Math.max(0, ensureUser(target.id).balance - amount);
          saveData();
          await sendLog(`➖ ${interaction.user.tag} removed ${amount} Tokens from ${target.tag}`, "#e74c3c");
          return interaction.reply({ content: `✅ Removed ${amount} Tokens from ${target}`, flags: 64 });
        }

        case "addstock": {
          if (!isStaff) return interaction.reply({ content: "❌ No permission", flags: 64 });
          const group = interaction.options.getString("group").toLowerCase();
          const name = interaction.options.getString("name");
          const amount = interaction.options.getInteger("amount");
          if (!STOCK.hasOwnProperty(group)) return interaction.reply({ content: "❌ Invalid rarity group", flags: 64 });

          const existing = STOCK[group].find(i => i.name.toLowerCase() === name.toLowerCase());
          if (existing) existing.stock += amount;
          else STOCK[group].push({ name, stock: amount });
          saveStock();

          await sendStockUpdate("add", { name }, group, amount, interaction.user);
          await sendLog(`📥 ${interaction.user.tag} added ${amount} × ${name} to ${group}`, "#27ae60");
          return interaction.reply({ content: `✅ Added ${amount} × ${name} to ${group} stock`, flags: 64 });
        }

        case "removestock": {
          if (!isStaff) return interaction.reply({ content: "❌ No permission", flags: 64 });
          const group = interaction.options.getString("group").toLowerCase();
          const name = interaction.options.getString("name");
          const amount = interaction.options.getInteger("amount");
          if (!STOCK.hasOwnProperty(group)) return interaction.reply({ content: "❌ Invalid rarity group", flags: 64 });

          const idx = STOCK[group].findIndex(i => i.name.toLowerCase() === name.toLowerCase());
          if (idx === -1) return interaction.reply({ content: "❌ Item not found", flags: 64 });

          STOCK[group][idx].stock -= amount;
          if (STOCK[group][idx].stock <= 0) STOCK[group].splice(idx, 1);
          saveStock();

          await sendStockUpdate("remove", { name }, group, amount, interaction.user);
          await sendLog(`📤 ${interaction.user.tag} removed ${amount} × ${name} from ${group}`, "#e67e22");
          return interaction.reply({ content: `✅ Updated stock for ${name}`, flags: 64 });
        }
      }
    }

    // ------------------------------
    // BUTTON HANDLER
    // ------------------------------
    if (interaction.isButton()) {
      if (!isStaff) return interaction.reply({ content: "❌ Only staff can manage requests", flags: 64 });

      const parts = interaction.customId.split("_");
      const action = parts[0];
      const type = parts[1];
      const id = parseInt(parts[2]);

      if (action === "dep") {
        const dep = DATA.deposit_requests[id];
        if (!dep) return interaction.reply({ content: "❌ This deposit no longer exists", flags: 64 });

        if (type === "approve") {
          ensureUser(dep.userId).balance += dep.tokens;
          saveData();
          await sendLog(`✅ Deposit #${id} APPROVED by ${interaction.user.tag} | +${dep.tokens} tokens`, "#2ecc71");
          await interaction.update({
            embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#2ecc71").setDescription(`✅ Approved by ${interaction.user.tag}\n+${dep.tokens} tokens`)],
            components: []
          });
        } else if (type === "deny") {
          await sendLog(`❌ Deposit #${id} DENIED by ${interaction.user.tag}`, "#e74c3c");
          await interaction.update({
            embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#e74c3c").setDescription(`❌ Denied by ${interaction.user.tag}`)],
            components: []
          });
        }
      }

      if (action === "claim") {
        const claim = DATA.pending_claims[id];
        if (!claim) return interaction.reply({ content: "❌ This claim no longer exists", flags: 64 });

        if (type === "approve") {
          await sendLog(`✅ Claim #${id} APPROVED by ${interaction.user.tag} | Prize: ${claim.prize}`, "#2ecc71");
          await interaction.update({
            embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#2ecc71").setDescription(`✅ Approved by ${interaction.user.tag}\nPrize will be sent to ${claim.habbo}`)],
            components: []
          });
        } else if (type === "deny") {
          await sendLog(`❌ Claim #${id} DENIED by ${interaction.user.tag}`, "#e74c3c");
          await interaction.update({
            embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#e74c3c").setDescription(`❌ Denied by ${interaction.user.tag}`)],
            components: []
          });
        }
      }
    }

  } catch (err) {
    console.error("❌ Error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Something went wrong", flags: 64 }).catch(() => {});
    }
  }
});

client.login(CONFIG.bot.token);
