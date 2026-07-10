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

// ==============================================
// CONFIGURATION — MATCH THESE TO YOUR SETUP
// ==============================================
const CONFIG = {
  bot: {
    token: process.env.BOT_TOKEN,
    admin_role_id: process.env.ADMIN_ROLE_ID,
    support_role_id: process.env.SUPPORT_ROLE_ID,
    verified_role_id: process.env.VERIFIED_ROLE_ID, // ← MUST MATCH YOUR VERIFY BOT
    guild_id: process.env.GUILD_ID
  },
  channels: {
    mod_awareness: process.env.MOD_CHANNEL_ID,
    claims: process.env.CLAIMS_CHANNEL_ID
  },
  room_link: "https://www.habbo.com/room/1234567", // Replace with your real room

  rates: {
    starting_tokens: 0,
    credit_per_token: 3,          // 3 Credits = 1 Token
    furni_per_token: 20,          // 20 Furni = 1 Token
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
// DATA FILES — SAME LOCATION AS VERIFY BOT
// ==============================================
const HABBO_LINKS_PATH = path.join(__dirname, 'habboLinks.json');
const STOCK_PATH = path.join(__dirname, 'stock.json');
const DATA_PATH = path.join(__dirname, 'data.json');

let habboLinks = {};
if (fs.existsSync(HABBO_LINKS_PATH)) {
  try {
    habboLinks = JSON.parse(fs.readFileSync(HABBO_LINKS_PATH, 'utf8'));
    console.log(`✅ Loaded ${Object.keys(habboLinks).length} Habbo links from habboLinks.json`);
  } catch (err) {
    console.warn("⚠️ habboLinks.json invalid, starting empty:", err.message);
    habboLinks = {};
    fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify({}, null, 2));
  }
} else {
  console.warn("⚠️ habboLinks.json not found — creating new file");
  fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify({}, null, 2));
}

let STOCK = { blue: [], purple: [], green: [], lilac: [], golden: [] };
if (fs.existsSync(STOCK_PATH)) {
  try {
    STOCK = JSON.parse(fs.readFileSync(STOCK_PATH, 'utf8'));
    const totalFurni = Object.values(STOCK).flat().reduce((sum, item) => sum + item.stock, 0);
    console.log(`✅ Furni stock loaded: ${totalFurni} items available`);
  } catch {
    console.warn("⚠️ stock.json invalid, using empty stock");
  }
}

let DATA = { users: {}, deposit_requests: {}, pending_claims: {}, weeklyLeaderboard: { weekStart: new Date().toISOString(), users: {} } };
if (fs.existsSync(DATA_PATH)) {
  try {
    DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    console.log(`✅ User data loaded: ${Object.keys(DATA.users).length} accounts`);
  } catch {
    console.warn("⚠️ data.json invalid, starting fresh");
  }
}

function saveStock() { fs.writeFileSync(STOCK_PATH, JSON.stringify(STOCK, null, 2)); }
function saveData() { fs.writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2)); }
function saveHabboLinks() { fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify(habboLinks, null, 2)); }

// ==============================================
// HELPER FUNCTIONS
// ==============================================
function getHabboName(discordId) {
  return habboLinks[discordId.toString()] || null;
}

function getAvatar(habboName) {
  if (!habboName) return "https://www.habbo.com/habbo-imaging/avatarimage?user=Habbo&headonly=1&size=s";
  const safe = encodeURIComponent(habboName.trim());
  return `https://www.habbo.com/habbo-imaging/avatarimage?user=${safe}&direction=2&headonly=1&size=s`;
}

function getFurniImage(name) {
  const safe = name.toLowerCase().replace(/ /g, "_").replace(/'/g, "").replace(/&/g, "and");
  return `https://images.habbo.com/dcr/hof_furni/${safe}_icon.png`;
}

function getAverageValue(groupName) {
  const g = CONFIG.rarity_groups.find(r => r.name === groupName);
  return g ? Math.round((g.credit_min + g.credit_max) / 2) : 0;
}

function ensureUser(userId) {
  userId = userId.toString();
  if (!DATA.users[userId]) {
    DATA.users[userId] = { balance: CONFIG.rates.starting_tokens, history: [] };
    saveData();
  }
  return DATA.users[userId];
}

function addToHistory(userId, entry) {
  const u = ensureUser(userId);
  u.history.unshift({ timestamp: new Date().toISOString(), ...entry });
  if (u.history.length > 20) u.history.pop();
  saveData();
}

function addToWeeklyStats(userId, type, val = 0) {
  const id = userId.toString();
  if (!DATA.weeklyLeaderboard.users[id]) {
    DATA.weeklyLeaderboard.users[id] = { tokensEarned: 0, wins: 0, totalCreditsWon: 0 };
  }
  if (type === "tokens") DATA.weeklyLeaderboard.users[id].tokensEarned += val;
  if (type === "win") {
    DATA.weeklyLeaderboard.users[id].wins += 1;
    DATA.weeklyLeaderboard.users[id].totalCreditsWon += val;
  }
  saveData();
}

async function postWeeklyLeaderboard(isFinal = false) {
  const ch = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
  if (!ch) return;
  const sorted = Object.entries(DATA.weeklyLeaderboard.users)
    .sort((a, b) => b[1].totalCreditsWon - a[1].totalCreditsWon)
    .slice(0, 10);
  const list = sorted.map(([id, d], i) =>
    `**#${i+1}** • ${getHabboName(id) || "Unlinked"}\n🪙 Tokens: ${d.tokensEarned} | 🎉 Wins: ${d.wins} | 💎 **Total: ${d.totalCreditsWon} Credits**`
  ).join("\n\n") || "No activity recorded this week yet.";
  await ch.send({ embeds: [new EmbedBuilder()
    .setTitle(isFinal ? "🏆 FINAL WEEKLY LEADERBOARD" : "📈 WEEKLY LEADERBOARD UPDATE")
    .setDescription(list)
    .setColor(isFinal ? "#f1c40f" : "#3498db")
    .setTimestamp()
  ]});
}

// ==============================================
// AUTO‑LINK ALL VERIFIED USERS (matches your verify bot)
// ==============================================
async function autoLinkVerifiedUsers() {
  console.log('🔍 Auto‑linking existing verified users...');
  const guild = client.guilds.cache.get(CONFIG.bot.guild_id);
  if (!guild) return console.log("⚠️ Guild not found — check GUILD_ID");

  const verifiedRole = await guild.roles.fetch(CONFIG.bot.verified_role_id).catch(() => null);
  if (!verifiedRole) return console.log("⚠️ Verified role not found — check VERIFIED_ROLE_ID");

  const members = await guild.members.fetch({ force: true });
  let added = 0;

  for (const [memberId, member] of members) {
    if (member.roles.cache.has(verifiedRole.id) && !habboLinks[memberId]) {
      const habboName = member.nickname?.trim() || member.user.username.trim();
      if (habboName && /^[A-Za-z0-9 _-]{3,30}$/.test(habboName)) {
        habboLinks[memberId] = habboName;
        added++;
      }
    }
  }

  if (added > 0) {
    saveHabboLinks();
    console.log(`✅ Auto‑linked ${added} verified users! Total linked: ${Object.keys(habboLinks).length}`);
  } else {
    console.log(`✅ All verified users already linked — total: ${Object.keys(habboLinks).length}`);
  }
}

// ==============================================
// BOT SETUP
// ==============================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once("ready", async () => {
  console.log(`✅ Gumball Bot online as ${client.user.tag}`);

  // Run auto‑link
  await autoLinkVerifiedUsers();

  // Clear old commands first
  await client.application.commands.set([]);
  console.log("🧹 Cleared old commands");

  // Register fresh commands
  const commands = [
    new SlashCommandBuilder().setName("balance").setDescription("Check your token balance and linked Habbo account"),
    new SlashCommandBuilder().setName("gumball").setDescription("Play the gumball machine — costs 1 Token per spin"),
    new SlashCommandBuilder().setName("howtoplay").setDescription("View exchange rates, deposit info and how to play"),
    new SlashCommandBuilder().setName("showprizes").setDescription("See all available prizes, their values and chances"),
    new SlashCommandBuilder().setName("history").setDescription("View your recent activity and transaction history"),
    new SlashCommandBuilder().setName("depositcoins").setDescription("Submit a credit deposit to receive tokens")
      .addIntegerOption(o => o.setName("amount").setDescription("Number of credits sent").setRequired(true)),
    new SlashCommandBuilder().setName("depositfurni").setDescription("Submit a furni deposit to receive tokens")
      .addStringOption(o => o.setName("items").setDescription("List of items you deposited").setRequired(true)),
    new SlashCommandBuilder().setName("addtokens").setDescription("Staff only: Add tokens to a user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Number of tokens").setRequired(true)),
    new SlashCommandBuilder().setName("removetokens").setDescription("Staff only: Remove tokens from a user")
      .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Number of tokens").setRequired(true)),
    new SlashCommandBuilder().setName("addstock").setDescription("Staff only: Add prizes to stock")
      .addStringOption(o => o.setName("group").setDescription("blue / purple / green / lilac / golden").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Name of the furni").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity to add").setRequired(true)),
    new SlashCommandBuilder().setName("removestock").setDescription("Staff only: Remove prizes from stock")
      .addStringOption(o => o.setName("group").setDescription("blue / purple / green / lilac / golden").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Name of the furni").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setDescription("Quantity to remove").setRequired(true))
  ];

  await client.application.commands.set(commands);
  console.log("✅ All commands freshly registered");

  // Weekly leaderboard schedule
  cron.schedule("0 18 * * *", () => postWeeklyLeaderboard(false));
  cron.schedule("0 18 * * 0", () => { postWeeklyLeaderboard(true); DATA.weeklyLeaderboard = { weekStart: new Date().toISOString(), users: {} }; saveData(); });
});

// ==============================================
// COMMAND & BUTTON HANDLING
// ==============================================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
  const isStaff = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || interaction.member.roles.cache.has(CONFIG.bot.admin_role_id);

  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {

      case "balance": {
        const user = ensureUser(interaction.user.id);
        const habbo = getHabboName(interaction.user.id);
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle("💰 Your Balance")
          .setThumbnail(getAvatar(habbo))
          .addFields(
            { name: "Tokens", value: `**${user.balance}**`, inline: true },
            { name: "Linked Habbo", value: habbo ? `✅ **${habbo}**` : "⚠️ Not Verified", inline: true }
          )
          .setColor("#2ecc71")
        ], ephemeral: true });
      }

      case "howtoplay": {
        const baseRates = `• **Base Rate**: ${CONFIG.rates.credit_per_token} Credits = 1 Token\n• **Furni Rate**: ${CONFIG.rates.furni_per_token} Furni = 1 Token`;
        const bulkRates = CONFIG.rates.bulk_packages.map(p => `• **${p.label}**`).join("\n");
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle("📋 How To Play & Get Tokens")
          .setDescription("Earn or buy tokens, then play for prizes!")
          .setColor("#3498db")
          .addFields(
            { name: "💱 Exchange Rates", value: baseRates },
            { name: "🛒 Bulk Deals", value: bulkRates },
            { name: "📤 Deposit", value: `Send items to room → use \`/depositcoins\` or \`/depositfurni\`\n📍 ${CONFIG.room_link}` },
            { name: "🎮 Play", value: "`/gumball` → **1 Token per spin**" }
          )
        ]});
      }

      case "depositcoins": {
        const habbo = getHabboName(interaction.user.id);
        if (!habbo) {
          if (interaction.member.roles.cache.has(CONFIG.bot.verified_role_id)) {
            const habboName = interaction.member.nickname?.trim() || interaction.user.username.trim();
            habboLinks[interaction.user.id] = habboName;
            saveHabboLinks();
            return interaction.reply({ content: `✅ Auto‑linked your account: **${habboName}** — run the command again!`, ephemeral: true });
          }
          return interaction.reply({ content: "❌ You must be verified first!", ephemeral: true });
        }
        const amount = interaction.options.getInteger("amount");
        const bulk = CONFIG.rates.bulk_packages.find(p => p.cost === amount);
        const tokens = bulk ? bulk.tokens : Math.floor(amount / CONFIG.rates.credit_per_token);
        const depId = Date.now();
        DATA.deposit_requests[depId] = { type: "coins", userId: interaction.user.id, habbo, amount, tokens, status: "pending" };
        saveData();

        const embed = new EmbedBuilder()
          .setTitle("💸 New Credit Deposit")
          .setDescription(`**User:** ${interaction.user}\n**Habbo:** \`${habbo}\`\n**Sent:** ${amount}c\n**Tokens:** ${tokens}\n📍 ${CONFIG.room_link}`)
          .setColor("#f39c12")
          .setThumbnail(getAvatar(habbo));

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${depId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${depId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
        );

        const ch = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
        if (ch) ch.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "✅ Deposit submitted! Awaiting approval.", ephemeral: true });
      }

      case "depositfurni": {
        const habbo = getHabboName(interaction.user.id);
        if (!habbo) {
          if (interaction.member.roles.cache.has(CONFIG.bot.verified_role_id)) {
            const habboName = interaction.member.nickname?.trim() || interaction.user.username.trim();
            habboLinks[interaction.user.id] = habboName;
            saveHabboLinks();
            return interaction.reply({ content: `✅ Auto‑linked your account: **${habboName}** — run the command again!`, ephemeral: true });
          }
          return interaction.reply({ content: "❌ You must be verified first!", ephemeral: true });
        }
        const items = interaction.options.getString("items");
        const depId = Date.now();
        DATA.deposit_requests[depId] = { type: "furni", userId: interaction.user.id, habbo, items, tokens: null, status: "pending" };
        saveData();

        const embed = new EmbedBuilder()
          .setTitle("📦 Furni Deposit")
          .setDescription(`**User:** ${interaction.user}\n**Habbo:** \`${habbo}\`\n**Items:** ${items}\n**Rate:** ${CONFIG.rates.furni_per_token} = 1 Token`)
          .setColor("#9b59b6")
          .setThumbnail(getAvatar(habbo));

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${depId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${depId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
        );

        const ch = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
        if (ch) ch.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "✅ Furni deposit submitted! Awaiting approval.", ephemeral: true });
      }

      case "gumball": {
        const user = ensureUser(interaction.user.id);
        const habbo = getHabboName(interaction.user.id);
        if (!habbo) {
          if (interaction.member.roles.cache.has(CONFIG.bot.verified_role_id)) {
            const habboName = interaction.member.nickname?.trim() || interaction.user.username.trim();
            habboLinks[interaction.user.id] = habboName;
            saveHabboLinks();
            return interaction.reply({ content: `✅ Auto‑linked your account: **${habboName}** — spin again!`, ephemeral: true });
          }
          return interaction.reply({ content: "❌ You must be verified first!", ephemeral: true });
        }
        if (user.balance < 1) return interaction.reply({ content: "❌ You need at least 1 Token to play!", ephemeral: true });

        user.balance -= 1;
        saveData();

        const group = CONFIG.rarity_groups.sort((a, b) => b.chance - a.chance).find(g => Math.random() * 100 < g.chance) || CONFIG.rarity_groups[4];
        const items = STOCK[group.id]?.filter(i => i.stock > 0) || [];
        if (!items.length) { user.balance += 1; saveData(); return interaction.reply({ content: "😕 No prizes available — token refunded.", ephemeral: true }); }

        const prize = items[Math.floor(Math.random() * items.length)];
        prize.stock--;
        saveStock();

        const avgVal = getAverageValue(group.name);
        const wonTokens = Math.floor(Math.random() * (group.token_max - group.token_min + 1)) + group.token_min;
        user.balance += wonTokens;
        saveData();

        addToHistory(interaction.user.id, { type: "Win", detail: `${prize.name} | ~${avgVal}c | +${wonTokens} Tokens` });
        addToWeeklyStats(interaction.user.id, "tokens", wonTokens);
        addToWeeklyStats(interaction.user.id, "win", avgVal);

        const winEmbed = new EmbedBuilder()
          .setTitle("🎉 YOU WON!")
          .setColor(group.color)
          .setThumbnail(getFurniImage(prize.name))
          .setAuthor({ name: habbo, iconURL: getAvatar(habbo) })
          .addFields(
            { name: "Prize", value: `**${prize.name}**`, inline: false },
            { name: "Estimated Value", value: `~${avgVal} Credits`, inline: true },
            { name: "Tokens Won", value: `+${wonTokens}`, inline: true },
            { name: "New Balance", value: `${user.balance}`, inline: true }
          );

        await interaction.reply({ embeds: [winEmbed] });

        const claimId = Date.now();
        DATA.pending_claims[claimId] = { userId: interaction.user.id, habbo, item: prize.name, value: `${avgVal}c`, group: group.name, status: "Pending" };
        saveData();

        const claimEmbed = new EmbedBuilder()
          .setTitle("📥 NEW PRIZE CLAIM")
          .setDescription(`**User:** ${interaction.user}\n**Habbo:** \`${habbo}\`\n**Status:** ⏳ Pending`)
          .setColor(group.color)
          .setThumbnail(getFurniImage(prize.name))
          .addFields(
            { name: "Item", value: prize.name, inline: true },
            { name: "Value", value: `~${avgVal}c`, inline: true },
            { name: "Rarity", value: group.name, inline: true }
          );

        const claimRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`claimreq_${claimId}`).setLabel("📩 Request to Claim").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`traded_${claimId}`).setLabel("✅ Mark as Traded").setStyle(ButtonStyle.Success)
        );

        const claimCh = await client.channels.fetch(CONFIG.channels.claims).catch(() => null);
        if (claimCh) claimCh.send({ embeds: [claimEmbed], components: [claimRow] });
        break;
      }

      case "addtokens": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
        const target = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        const user = ensureUser(target.id);
        user.balance += amount;
        addToHistory(target.id, { type: "Tokens", detail: `+${amount} (Staff)` });
        saveData();
        return interaction.reply({ content: `✅ Added ${amount} tokens to ${target}`, ephemeral: false });
      }

      case "removetokens": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
        const target = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        const user = ensureUser(target.id);
        user.balance = Math.max(0, user.balance - amount);
        addToHistory(target.id, { type: "Tokens", detail: `-${amount} (Staff)` });
        saveData();
        return interaction.reply({ content: `✅ Removed ${amount} tokens from ${target}`, ephemeral: false });
      }

      case "showprizes": {
        const embeds = CONFIG.rarity_groups.map(g => {
          const items = STOCK[g.id]?.filter(i => i.stock > 0) || [];
          return new EmbedBuilder()
            .setTitle(`${g.name} Prizes`)
            .setDescription(`**Chance:** ${g.chance}%\n**Value:** ${g.credit_min}–${g.credit_max}c`)
            .setColor(g.color)
            .setThumbnail(items.length ? getFurniImage(items[0].name) : null)
            .addFields({ name: "In Stock", value: items.length ? items.map(i => `• ${i.name} × ${i.stock}`).join("\n") : "None" });
        });
        return interaction.reply({ embeds });
      }

      case "history": {
        const user = ensureUser(interaction.user.id);
        const habbo = getHabboName(interaction.user.id);
        return interaction.reply({ embeds: [new EmbedBuilder()
          .setTitle("📜 Your Activity History")
          .setThumbnail(getAvatar(habbo))
          .setDescription(user.history.length ? user.history.map(e => `• ${new Date(e.timestamp).toLocaleString()} — ${e.type}: ${e.detail}`).join("\n") : "No activity yet")
        ], ephemeral: true });
      }

      case "addstock": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
        const g = interaction.options.getString("group").toLowerCase();
        const name = interaction.options.getString("name");
        const amt = interaction.options.getInteger("amount");
        if (!STOCK.hasOwnProperty(g)) return interaction.reply({ content: "❌ Invalid group — use blue/purple/green/lilac/golden", ephemeral: true });
        const existing = STOCK[g].find(i => i.name.toLowerCase() === name.toLowerCase());
        existing ? existing.stock += amt : STOCK[g].push({ name, stock: amt });
        saveStock();
        return interaction.reply({ content: `✅ Added **${name} × ${amt}** to ${g} stock`, ephemeral: true });
      }

      case "removestock": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
        const g = interaction.options.getString("group").toLowerCase();
        const name = interaction.options.getString("name");
        const amt = interaction.options.getInteger("amount");
        if (!STOCK.hasOwnProperty(g)) return interaction.reply({ content: "❌ Invalid group", ephemeral: true });
        const idx = STOCK[g].findIndex(i => i.name.toLowerCase() === name.toLowerCase());
        if (idx === -1) return interaction.reply({ content: "❌ Item not found", ephemeral: true });
        STOCK[g][idx].stock -= amt;
        if (STOCK[g][idx].stock <= 0) STOCK[g].splice(idx, 1);
        saveStock();
        return interaction.reply({ content: `✅ Updated stock for **${name}**`, ephemeral: true });
      }
    }
  }

  // BUTTON HANDLERS
  if (interaction.isButton()) {
    const [action, type, idStr] = interaction.customId.split("_");
    const id = parseInt(idStr);

    if (action === "dep") {
      const dep = DATA.deposit_requests?.[id];
      if (!dep || !isStaff) return interaction.reply({ content: "❌ Invalid action", ephemeral: true });
      const user = ensureUser(dep.userId);
      const member = await client.users.fetch(dep.userId).catch(() => null);

      if (type === "approve") {
        if (dep.type === "furni") {
          await interaction.reply({ content: "Enter total tokens to award:", ephemeral: true });
          try {
            const res = await interaction.channel.awaitMessages({ filter: m => m.author.id === interaction.user.id && !isNaN(+m.content), max: 1, time: 30000, errors: ["time"] });
            dep.tokens = parseInt(res.first().content);
          } catch { return interaction.followUp({ content: "⏱️ Timed out", ephemeral: true }); }
        }
        user.balance += dep.tokens;
        addToHistory(dep.userId, { type: "Deposit", detail: `Approved +${dep.tokens}` });
        dep.status = "approved";
        saveData();
        member?.send({ content: `✅ Deposit approved! +${dep.tokens} Tokens` }).catch(() => {});
        await interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#2ecc71").setDescription(`✅ Approved by ${interaction.user.tag}`)], components: [] });
        return interaction.followUp({ content: "✅ Tokens added", ephemeral: true });
      }

      if (type === "deny") {
        dep.status = "denied";
        saveData();
        member?.send({ content: "❌ Deposit denied" }).catch(() => {});
        await interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#e74c3c").setDescription(`❌ Denied by ${interaction.user.tag}`)], components: [] });
        return interaction.followUp({ content: "✅ Deposit marked as denied", ephemeral: true });
      }
    }

    if (action === "claimreq" || action === "traded") {
      const claim = DATA.pending_claims?.[id];
      if (!claim) return interaction.reply({ content: "❌ Claim not found", ephemeral: true });

      if (action === "claimreq") {
        if (interaction.user.id !== claim.userId) return interaction.reply({ content: "❌ Only the winner can request this", ephemeral: true });
        claim.status = "Requested";
        saveData();
        return interaction.reply({ content: "✅ Claim sent to staff", ephemeral: true });
      }

      if (action === "traded") {
        if (!isStaff) return interaction.reply({ content: "❌ Staff only", ephemeral: true });
        claim.status = "Completed";
        saveData();
        await interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setDescription(`**Status:** ✅ COMPLETED\nTraded by: ${interaction.user}`)], components: [] });
        return interaction.reply({ content: "✅ Marked as traded", ephemeral: true });
      }
    }
  }
});

client.login(CONFIG.bot.token);
