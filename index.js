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
// CONFIGURATION
// ==============================================
const CONFIG = {
  bot: {
    token: process.env.BOT_TOKEN,
    admin_role_id: process.env.ADMIN_ROLE_ID,
    support_role_id: process.env.SUPPORT_ROLE_ID,
    owner_id: process.env.OWNER_ID
  },
  channels: {
    mod_awareness: process.env.MOD_CHANNEL_ID,
    claims: process.env.CLAIMS_CHANNEL_ID
  },
  // 👇 UPDATE THIS WITH YOUR REAL ROOM LINK
  room_link: "https://www.habbo.com/room/1234567",

  // 👇 NEW EXCHANGE & PURCHASE RATES
  rates: {
    starting_tokens: 0,
    credit_per_token: 3,
    furni_per_token: 20,
    bulk_packages: [
      { cost: 15, tokens: 5, label: "15 Credits → 5 Tokens" },
      { cost: 25, tokens: 10, label: "25 Credits → 10 Tokens" },
      { cost: 50, tokens: 25, label: "50 Credits → 25 Tokens" }
    ]
  },

  rarity_groups: [
    {
      id: "blue",
      name: "Blue",
      chance: 45,
      credit_min: 1,
      credit_max: 3,
      token_min: 1,
      token_max: 2,
      color: "#3498db"
    },
    {
      id: "purple",
      name: "Purple",
      chance: 25,
      credit_min: 3,
      credit_max: 8,
      token_min: 2,
      token_max: 4,
      color: "#9b59b6"
    },
    {
      id: "green",
      name: "Green",
      chance: 15,
      credit_min: 8,
      credit_max: 20,
      token_min: 3,
      token_max: 6,
      color: "#2ecc71"
    },
    {
      id: "lilac",
      name: "Lilac",
      chance: 10,
      credit_min: 20,
      credit_max: 50,
      token_min: 5,
      token_max: 10,
      color: "#e84393"
    },
    {
      id: "golden",
      name: "Golden",
      chance: 5,
      credit_min: 50,
      credit_max: 200,
      token_min: 10,
      token_max: 25,
      color: "#f1c40f"
    }
  ]
};

// ==============================================
// DATA LOADING
// ==============================================
const HABBO_LINKS_PATH = path.join(__dirname, 'habboLinks.json');
const STOCK_PATH = path.join(__dirname, 'stock.json');
const DATA_PATH = path.join(__dirname, 'data.json');

let habboLinks = {};
if (fs.existsSync(HABBO_LINKS_PATH)) {
  habboLinks = JSON.parse(fs.readFileSync(HABBO_LINKS_PATH, 'utf8'));
  console.log(`✅ Loaded ${Object.keys(habboLinks).length} Habbo links`);
} else {
  fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify({}, null, 2));
}

let STOCK = fs.existsSync(STOCK_PATH) ? JSON.parse(fs.readFileSync(STOCK_PATH, 'utf8')) : { blue: [], purple: [], green: [], lilac: [], golden: [] };
let DATA = fs.existsSync(DATA_PATH) ? JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) : { users: {}, deposit_requests: {}, pending_claims: {}, weeklyLeaderboard: { weekStart: new Date().toISOString(), users: {} } };

function saveStock() { fs.writeFileSync(STOCK_PATH, JSON.stringify(STOCK, null, 2)); }
function saveData() { fs.writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2)); }

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
  if (!DATA.weeklyLeaderboard.users[id]) DATA.weeklyLeaderboard.users[id] = { tokensEarned: 0, wins: 0, totalCreditsWon: 0 };
  if (type === "tokens") DATA.weeklyLeaderboard.users[id].tokensEarned += val;
  if (type === "win") DATA.weeklyLeaderboard.users[id].totalCreditsWon += val;
  saveData();
}

async function postWeeklyLeaderboard(isFinal = false) {
  const ch = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
  if (!ch) return;
  const sorted = Object.entries(DATA.weeklyLeaderboard.users)
    .sort((a, b) => b[1].totalCreditsWon - a[1].totalCreditsWon)
    .slice(0, 10);
  const list = sorted.map(([id, d], i) => `**#${i+1}** • ${getHabboName(id) || "Unlinked"}\n🪙 ${d.tokensEarned} Tokens | 🎉 ${d.wins} Wins | 💎 ${d.totalCreditsWon}c`).join("\n\n") || "No activity yet.";
  await ch.send({
    embeds: [new EmbedBuilder()
      .setTitle(isFinal ? "🏆 FINAL WEEKLY LEADERBOARD" : "📈 WEEKLY LEADERBOARD")
      .setDescription(list)
      .setColor(isFinal ? "#f1c40f" : "#3498db")
      .setTimestamp()
    ]
  });
}

// ==============================================
// BOT SETUP
// ==============================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once("ready", async () => {
  console.log(`✅ Gumball Bot online as ${client.user.tag}`);
  await client.application.commands.set([
    new SlashCommandBuilder().setName("balance").setDescription("Check your token balance"),
    new SlashCommandBuilder().setName("gumball").setDescription("Play — costs 1 Token"),
    new SlashCommandBuilder().setName("howtoplay").setDescription("View rates & how to get tokens"),
    new SlashCommandBuilder().setName("showprizes").setDescription("View all prizes & odds"),
    new SlashCommandBuilder().setName("history").setDescription("Your activity history"),
    new SlashCommandBuilder().setName("depositcoins").setDescription("Submit credit deposit"),
    new SlashCommandBuilder().setName("depositfurni").setDescription("Submit furni deposit"),
    new SlashCommandBuilder().setName("addtokens").setDescription("Staff: Add tokens")
      .addUserOption(o => o.setName("user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setRequired(true)),
    new SlashCommandBuilder().setName("removetokens").setDescription("Staff: Remove tokens")
      .addUserOption(o => o.setName("user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setRequired(true)),
    new SlashCommandBuilder().setName("addstock").setDescription("Staff: Add stock")
      .addStringOption(o => o.setName("group").setRequired(true))
      .addStringOption(o => o.setName("name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setRequired(true)),
    new SlashCommandBuilder().setName("removestock").setDescription("Staff: Remove stock")
      .addStringOption(o => o.setName("group").setRequired(true))
      .addStringOption(o => o.setName("name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setRequired(true))
  ]);
  cron.schedule("0 18 * * *", () => postWeeklyLeaderboard(false));
  cron.schedule("0 18 * * 0", () => { postWeeklyLeaderboard(true); DATA.weeklyLeaderboard = { weekStart: new Date().toISOString(), users: {} }; saveData(); });
});

// ==============================================
// COMMANDS
// ==============================================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
  const isStaff = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || interaction.member.roles.cache.has(CONFIG.bot.admin_role_id);

  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {

      case "balance": {
        const user = ensureUser(interaction.user.id);
        const habbo = getHabboName(interaction.user.id);
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle("💰 Your Balance")
            .setThumbnail(getAvatar(habbo))
            .addFields(
              { name: "Tokens", value: `**${user.balance}**`, inline: true },
              { name: "Linked Habbo", value: habbo ? `✅ **${habbo}**` : "⚠️ Not Verified", inline: true }
            )
            .setColor("#2ecc71")
          ],
          ephemeral: true
        });
      }

      case "howtoplay": {
        const baseRates = `• **Base Rate**: ${CONFIG.rates.credit_per_token} Credits = 1 Token\n• **Furni Rate**: ${CONFIG.rates.furni_per_token} Furni = 1 Token`;
        const bulkRates = CONFIG.rates.bulk_packages.map(p => `• **${p.label}**`).join("\n");
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle("📋 How To Play & Get Tokens")
            .setDescription("Earn or buy tokens, then play for prizes!")
            .setColor("#3498db")
            .addFields(
              { name: "💱 Exchange Rates", value: baseRates, inline: false },
              { name: "🛒 Bulk Purchase Deals", value: bulkRates, inline: false },
              { name: "📤 How to Deposit", value: `• Send credits/furni to the room\n• Use \`/depositcoins\` or \`/depositfurni\`\n📍 Room: ${CONFIG.room_link}`, inline: false },
              { name: "🎮 Play", value: "Use `/gumball` — **1 Token per spin**", inline: false }
            )
          ]
        });
      }

      case "depositcoins": {
        const habbo = getHabboName(interaction.user.id);
        if (!habbo) return interaction.reply({ content: "❌ Verify first!", ephemeral: true });
        const amount = interaction.options.getInteger("amount");
        const tokens = Math.floor(amount / CONFIG.rates.credit_per_token);
        const bulkMatch = CONFIG.rates.bulk_packages.find(p => p.cost === amount);
        const finalTokens = bulkMatch ? bulkMatch.tokens : tokens;

        const depId = Date.now();
        DATA.deposit_requests[depId] = { type: "coins", userId: interaction.user.id, habbo, amount, tokens: finalTokens, status: "pending" };
        saveData();

        const embed = new EmbedBuilder()
          .setTitle("💸 New Credit Deposit")
          .setDescription(`**User:** ${interaction.user}\n**Habbo:** \`${habbo}\`\n**Sent:** ${amount} Credits\n**Estimated Tokens:** ${finalTokens}\n**Room:** ${CONFIG.room_link}`)
          .setColor("#f39c12")
          .setThumbnail(getAvatar(habbo))
          .setFooter({ text: `ID: ${depId}` });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${depId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${depId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
        );

        const ch = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
        if (ch) ch.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "✅ Deposit submitted!", ephemeral: true });
      }

      case "depositfurni": {
        const habbo = getHabboName(interaction.user.id);
        if (!habbo) return interaction.reply({ content: "❌ Verify first!", ephemeral: true });
        const items = interaction.options.getString("items");
        const depId = Date.now();
        DATA.deposit_requests[depId] = { type: "furni", userId: interaction.user.id, habbo, items, tokens: null, status: "pending" };
        saveData();

        const embed = new EmbedBuilder()
          .setTitle("📦 Furni Deposit")
          .setDescription(`**User:** ${interaction.user}\n**Habbo:** \`${habbo}\`\n**Items:** ${items}\n**Rate: ${CONFIG.rates.furni_per_token} = 1 Token**`)
          .setColor("#9b59b6")
          .setThumbnail(getAvatar(habbo));

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${depId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${depId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
        );

        const ch = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
        if (ch) ch.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "✅ Furni deposit submitted!", ephemeral: true });
      }

      case "gumball": {
        const user = ensureUser(interaction.user.id);
        const habbo = getHabboName(interaction.user.id);
        if (!habbo) return interaction.reply({ content: "❌ Verify first!", ephemeral: true });
        if (user.balance < 1) return interaction.reply({ content: "❌ Need at least 1 Token!", ephemeral: true });

        user.balance -= 1;
        saveData();

        const group = CONFIG.rarity_groups.sort((a, b) => b.chance - a.chance).find(g => Math.random() * 100 < g.chance) || CONFIG.rarity_groups[4];
        const items = STOCK[group.id]?.filter(i => i.stock > 0) || [];
        if (!items.length) { user.balance += 1; saveData(); return interaction.reply({ content: "😕 No stock — token refunded", ephemeral: true }); }

        const prize = items[Math.floor(Math.random() * items.length)];
        prize.stock--;
        saveStock();

        const avgVal = getAverageValue(group.name);
        const wonTokens = Math.floor(Math.random() * (group.token_max - group.token_min + 1)) + group.token_min;
        user.balance += wonTokens;
        saveData();

        addToHistory(interaction.user.id, { type: "Win", detail: `${prize.name} | +${wonTokens} Tokens` });
        addToWeeklyStats(interaction.user.id, "tokens", wonTokens);
        addToWeeklyStats(interaction.user.id, "win", avgVal);

        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle("🎉 YOU WON!")
            .setColor(group.color)
            .setThumbnail(getFurniImage(prize.name))
            .setAuthor({ name: habbo, iconURL: getAvatar(habbo) })
            .addFields(
              { name: "Prize", value: `**${prize.name}**`, inline: false },
              { name: "Value", value: `~${avgVal}c`, inline: true },
              { name: "Tokens Won", value: `+${wonTokens}`, inline: true },
              { name: "New Balance", value: `${user.balance}`, inline: true }
            )
          ]
        });
      }

      case "addtokens": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
        const target = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        const user = ensureUser(target.id);
        user.balance += amount;
        addToHistory(target.id, { type: "Tokens", detail: `+${amount} (Staff)` });
        saveData();
        return interaction.reply({ content: `✅ Added **${amount} tokens** to ${target}`, ephemeral: false });
      }

      case "removetokens": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
        const target = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        const user = ensureUser(target.id);
        user.balance = Math.max(0, user.balance - amount);
        addToHistory(target.id, { type: "Tokens", detail: `-${amount} (Staff)` });
        saveData();
        return interaction.reply({ content: `✅ Removed **${amount} tokens** from ${target}`, ephemeral: false });
      }

      case "showprizes": {
        const embeds = CONFIG.rarity_groups.map(g =>
          new EmbedBuilder()
            .setTitle(`${g.name} Prizes`)
            .setDescription(`**Chance:** ${g.chance}%\n**Value:** ${g.credit_min}–${g.credit_max}c`)
            .setColor(g.color)
            .addFields({ name: "In Stock", value: STOCK[g.id]?.length ? STOCK[g.id].map(i => `• ${i.name} × ${i.stock}`).join("\n") : "None" })
        );
        return interaction.reply({ embeds });
      }

      case "history": {
        const user = ensureUser(interaction.user.id);
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle("📜 Your History")
            .setThumbnail(getAvatar(getHabboName(interaction.user.id)))
            .setDescription(user.history.map(e => `• ${new Date(e.timestamp).toLocaleString()} | ${e.type}: ${e.detail}`).join("\n") || "No history")
          ],
          ephemeral: true
        });
      }

      case "addstock": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
        const g = interaction.options.getString("group").toLowerCase();
        const name = interaction.options.getString("name");
        const amt = interaction.options.getInteger("amount");
        if (!STOCK[g]) return interaction.reply({ content: "❌ Group: blue/purple/green/lilac/golden", ephemeral: true });
        const existing = STOCK[g].find(i => i.name.toLowerCase() === name.toLowerCase());
        existing ? existing.stock += amt : STOCK[g].push({ name, stock: amt });
        saveStock();
        return interaction.reply({ content: `✅ Added **${name} × ${amt}**`, ephemeral: true });
      }

      case "removestock": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", ephemeral: true });
        const g = interaction.options.getString("group").toLowerCase();
        const name = interaction.options.getString("name");
        const amt = interaction.options.getInteger("amount");
        const idx = STOCK[g]?.findIndex(i => i.name.toLowerCase() === name.toLowerCase());
        if (idx === -1) return interaction.reply({ content: "❌ Item not found", ephemeral: true });
        STOCK[g][idx].stock -= amt;
        if (STOCK[g][idx].stock <= 0) STOCK[g].splice(idx, 1);
        saveStock();
        return interaction.reply({ content: `✅ Updated stock`, ephemeral: true });
      }
    }
  }

  // BUTTON HANDLING
  if (interaction.isButton()) {
    const [action, type, id] = interaction.customId.split("_");
    const dep = DATA.deposit_requests?.[parseInt(id)];
    if (!dep || !isStaff) return interaction.reply({ content: "❌ Invalid", ephemeral: true });

    if (action === "dep") {
      const user = ensureUser(dep.userId);
      if (type === "approve") {
        user.balance += dep.tokens;
        addToHistory(dep.userId, { type: "Deposit", detail: `Approved: +${dep.tokens} Tokens` });
        dep.status = "approved";
        saveData();
        await interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#2ecc71").setDescription(`✅ Approved by ${interaction.user.tag}`)], components: [] });
        return interaction.followUp({ content: `✅ Added ${dep.tokens} tokens`, ephemeral: true });
      }
      if (type === "deny") {
        dep.status = "denied";
        saveData();
        await interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#e74c3c").setDescription(`❌ Denied by ${interaction.user.tag}`)], components: [] });
        return interaction.followUp({ content: "✅ Deposit denied", ephemeral: true });
      }
    }
  }
});

client.login(CONFIG.bot.token);
