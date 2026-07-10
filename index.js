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
// CONFIG — USING YOUR EXACT IDs
// ==============================================
const CONFIG = {
  bot: {
    token: process.env.BOT_TOKEN,
    guild_id: "1456735416156819578",
    verified_role_id: "1457138449340694672",
    admin_role_id: process.env.ADMIN_ROLE_ID
  },
  channels: {
    mod_awareness: process.env.MOD_CHANNEL_ID,
    claims: process.env.CLAIMS_CHANNEL_ID
  },
  room_link: "https://www.habbo.com/room/1234567", // Replace with your room link
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
  try {
    habboLinks = JSON.parse(fs.readFileSync(HABBO_LINKS_PATH, 'utf8'));
  } catch {
    habboLinks = {};
    fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify(habboLinks, null, 2));
  }
} else {
  fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify({}, null, 2));
}

let STOCK = { blue: [], purple: [], green: [], lilac: [], golden: [] };
if (fs.existsSync(STOCK_PATH)) try { STOCK = JSON.parse(fs.readFileSync(STOCK_PATH, 'utf8')); } catch {}

let DATA = { users: {}, deposit_requests: {}, pending_claims: {}, weeklyLeaderboard: { weekStart: new Date().toISOString(), users: {} } };
if (fs.existsSync(DATA_PATH)) try { DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); } catch {}

function saveStock() { fs.writeFileSync(STOCK_PATH, JSON.stringify(STOCK, null, 2)); }
function saveData() { fs.writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2)); }
function saveHabboLinks() { fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify(habboLinks, null, 2)); }

// ==============================================
// HELPERS
// ==============================================
function getHabboName(discordId) { return habboLinks[discordId.toString()] || null; }
function getAvatar(habboName) {
  if (!habboName) return "https://www.habbo.com/habbo-imaging/avatarimage?user=Habbo&headonly=1&size=s";
  const safe = encodeURIComponent(habboName.trim());
  return `https://www.habbo.com/habbo-imaging/avatarimage?user=${safe}&direction=2&headonly=1&size=s`;
}
function getFurniImage(name) {
  const safe = name.toLowerCase().replace(/ /g, "_").replace(/'/g, "").replace(/&/g, "and");
  return `https://images.habbo.com/dcr/hof_furni/${safe}_icon.png`;
}
function getAverageValue(g) { return g ? Math.round((g.credit_min + g.credit_max) / 2) : 0; }
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
  return habboName;
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

  // Clear old commands
  await client.application.commands.set([]);
  console.log("🧹 Cleared old commands");

  // Register fresh commands
  const commands = [
    new SlashCommandBuilder().setName("balance").setDescription("Check your token balance and linked Habbo"),
    new SlashCommandBuilder().setName("gumball").setDescription("Play the gumball machine — costs 1 Token"),
    new SlashCommandBuilder().setName("howtoplay").setDescription("View exchange rates and rules"),
    new SlashCommandBuilder().setName("showprizes").setDescription("See all available prizes and odds"),
    new SlashCommandBuilder().setName("history").setDescription("View your activity history"),
    new SlashCommandBuilder().setName("depositcoins").setDescription("Submit credit deposit")
      .addIntegerOption(o => o.setName("amount").setDescription("Credits sent").setRequired(true)),
    new SlashCommandBuilder().setName("depositfurni").setDescription("Submit furni deposit")
      .addStringOption(o => o.setName("items").setDescription("List of items").setRequired(true)),
    new SlashCommandBuilder().setName("addtokens").setDescription("STAFF: Add tokens")
      .addUserOption(o => o.setName("user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setRequired(true)),
    new SlashCommandBuilder().setName("removetokens").setDescription("STAFF: Remove tokens")
      .addUserOption(o => o.setName("user").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setRequired(true)),
    new SlashCommandBuilder().setName("addstock").setDescription("STAFF: Add prizes")
      .addStringOption(o => o.setName("group").setDescription("blue/purple/green/lilac/golden").setRequired(true))
      .addStringOption(o => o.setName("name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setRequired(true)),
    new SlashCommandBuilder().setName("removestock").setDescription("STAFF: Remove prizes")
      .addStringOption(o => o.setName("group").setRequired(true))
      .addStringOption(o => o.setName("name").setRequired(true))
      .addIntegerOption(o => o.setName("amount").setRequired(true))
  ];

  await client.application.commands.set(commands);
  console.log("✅ All commands registered successfully");

  // Weekly reset
  cron.schedule("0 18 * * 0", () => {
    DATA.weeklyLeaderboard = { weekStart: new Date().toISOString(), users: {} };
    saveData();
  });
});

// ==============================================
// COMMAND HANDLING
// ==============================================
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
  const isStaff = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || interaction.member.roles.cache.has(CONFIG.bot.admin_role_id);

  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {

      case "balance": {
        const habbo = await autoLinkVerified(interaction.member);
        if (!habbo) {
          return interaction.reply({
            embeds: [new EmbedBuilder()
              .setTitle("💰 Your Balance")
              .addFields({ name: "Linked Habbo", value: "⚠️ Not Verified", inline: true })
              .setColor("#e74c3c")],
            flags: 64
          });
        }
        const user = ensureUser(interaction.user.id);
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle("💰 Your Balance")
            .setThumbnail(getAvatar(habbo))
            .addFields(
              { name: "Tokens", value: `**${user.balance}**`, inline: true },
              { name: "Linked Habbo", value: `✅ **${habbo}**`, inline: true }
            )
            .setColor("#2ecc71")],
          flags: 64
        });
      }

      case "howtoplay": {
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle("📋 How To Play")
            .setDescription(`• **3 Credits = 1 Token**\n• **20 Furni = 1 Token**\n• 15c = 5 Tokens\n• 25c = 10 Tokens\n• 50c = 25 Tokens\n\n📍 Room: ${CONFIG.room_link}`)
            .setColor("#3498db")],
          flags: 64
        });
      }

      case "depositcoins": {
        const habbo = await autoLinkVerified(interaction.member);
        if (!habbo) return interaction.reply({ content: "❌ You must be verified first!", flags: 64 });
        const amount = interaction.options.getInteger("amount");
        const tokens = {15:5, 25:10, 50:25}[amount] || Math.floor(amount / CONFIG.rates.credit_per_token);
        const depId = Date.now();
        DATA.deposit_requests[depId] = { type: "coins", userId: interaction.user.id, habbo, amount, tokens, status: "pending" };
        saveData();
        const embed = new EmbedBuilder()
          .setTitle("💸 New Credit Deposit")
          .setDescription(`**User:** ${interaction.user}\n**Habbo:** ${habbo}\n**Amount:** ${amount}c\n**Tokens:** ${tokens}`)
          .setColor("#f39c12");
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${depId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${depId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
        );
        const ch = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
        if (ch) ch.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "✅ Deposit submitted for approval.", flags: 64 });
      }

      case "depositfurni": {
        const habbo = await autoLinkVerified(interaction.member);
        if (!habbo) return interaction.reply({ content: "❌ You must be verified first!", flags: 64 });
        const items = interaction.options.getString("items");
        const depId = Date.now();
        DATA.deposit_requests[depId] = { type: "furni", userId: interaction.user.id, habbo, items, tokens: null, status: "pending" };
        saveData();
        const embed = new EmbedBuilder()
          .setTitle("📦 New Furni Deposit")
          .setDescription(`**User:** ${interaction.user}\n**Habbo:** ${habbo}\n**Items:** ${items}\n**Rate:** ${CONFIG.rates.furni_per_token} = 1 Token`)
          .setColor("#9b59b6");
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${depId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${depId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
        );
        const ch = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
        if (ch) ch.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "✅ Furni deposit submitted for approval.", flags: 64 });
      }

      case "gumball": {
        const habbo = await autoLinkVerified(interaction.member);
        if (!habbo) return interaction.reply({ content: "❌ You must be verified first!", flags: 64 });
        const user = ensureUser(interaction.user.id);
        if (user.balance < 1) return interaction.reply({ content: "❌ You need at least 1 Token to play!", flags: 64 });
        user.balance -= 1;
        saveData();
        const group = CONFIG.rarity_groups.sort((a,b) => b.chance - a.chance).find(g => Math.random() * 100 < g.chance) || CONFIG.rarity_groups[4];
        const items = STOCK[group.id]?.filter(i => i.stock > 0) || [];
        if (!items.length) {
          user.balance += 1;
          saveData();
          return interaction.reply({ content: "😕 No prizes available — token refunded.", flags: 64 });
        }
        const prize = items[Math.floor(Math.random() * items.length)];
        prize.stock--;
        saveStock();
        const avgVal = getAverageValue(group);
        const wonTokens = Math.floor(Math.random() * (group.token_max - group.token_min + 1)) + group.token_min;
        user.balance += wonTokens;
        saveData();
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle("🎉 YOU WON!")
            .setThumbnail(getFurniImage(prize.name))
            .setAuthor({ name: habbo, iconURL: getAvatar(habbo) })
            .addFields(
              { name: "Prize", value: `**${prize.name}**`, inline: false },
              { name: "Estimated Value", value: `~${avgVal} Credits`, inline: true },
              { name: "Tokens Won", value: `+${wonTokens}`, inline: true },
              { name: "New Balance", value: `${user.balance}`, inline: true }
            )
            .setColor(group.color)],
          flags: 64
        });
      }

      case "addtokens": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", flags: 64 });
        const target = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        ensureUser(target.id).balance += amount;
        saveData();
        return interaction.reply({ content: `✅ Added ${amount} tokens to ${target}`, flags: 64 });
      }

      case "removetokens": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", flags: 64 });
        const target = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");
        ensureUser(target.id).balance = Math.max(0, ensureUser(target.id).balance - amount);
        saveData();
        return interaction.reply({ content: `✅ Removed ${amount} tokens from ${target}`, flags: 64 });
      }

      case "showprizes": {
        const embeds = CONFIG.rarity_groups.map(g => new EmbedBuilder()
          .setTitle(`${g.name} Prizes`)
          .setDescription(`**Chance:** ${g.chance}%\n**Value:** ${g.credit_min}–${g.credit_max} Credits`)
          .setColor(g.color)
          .addFields({ name: "In Stock", value: STOCK[g.id]?.filter(i => i.stock > 0).map(i => `• ${i.name} × ${i.stock}`).join("\n") || "None" })
        );
        return interaction.reply({ embeds, flags: 64 });
      }

      case "history": {
        const user = ensureUser(interaction.user.id);
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle("📜 Your Activity History")
            .setDescription(user.history.length ? user.history.map(e => `• ${new Date(e.timestamp).toLocaleString()} — ${e.type}: ${e.detail}`).join("\n") : "No activity yet")],
          flags: 64
        });
      }

      case "addstock": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", flags: 64 });
        const group = interaction.options.getString("group").toLowerCase();
        const name = interaction.options.getString("name");
        const amount = interaction.options.getInteger("amount");
        if (!STOCK.hasOwnProperty(group)) return interaction.reply({ content: "❌ Invalid group — use blue/purple/green/lilac/golden", flags: 64 });
        const existing = STOCK[group].find(i => i.name.toLowerCase() === name.toLowerCase());
        existing ? existing.stock += amount : STOCK[group].push({ name, stock: amount });
        saveStock();
        return interaction.reply({ content: `✅ Added **${name} × ${amount}** to ${group} stock`, flags: 64 });
      }

      case "removestock": {
        if (!isStaff) return interaction.reply({ content: "❌ No permission", flags: 64 });
        const group = interaction.options.getString("group").toLowerCase();
        const name = interaction.options.getString("name");
        const amount = interaction.options.getInteger("amount");
        if (!STOCK.hasOwnProperty(group)) return interaction.reply({ content: "❌ Invalid group", flags: 64 });
        const idx = STOCK[group].findIndex(i => i.name.toLowerCase() === name.toLowerCase());
        if (idx === -1) return interaction.reply({ content: "❌ Item not found", flags: 64 });
        STOCK[group][idx].stock -= amount;
        if (STOCK[group][idx].stock <= 0) STOCK[group].splice(idx, 1);
        saveStock();
        return interaction.reply({ content: `✅ Updated stock for **${name}**`, flags: 64 });
      }
    }
  }

  // Button handling
  if (interaction.isButton()) {
    const [action, type, idStr] = interaction.customId.split("_");
    const id = parseInt(idStr);
    const dep = DATA.deposit_requests?.[id];
    if (!dep || !isStaff) return interaction.reply({ content: "❌ Invalid action", flags: 64 });
    if (type === "approve") {
      const user = ensureUser(dep.userId);
      user.balance += dep.tokens;
      saveData();
      await interaction.update({
        embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#2ecc71").setDescription(`✅ Approved by ${interaction.user.tag}`)],
        components: []
      });
    } else if (type === "deny") {
      await interaction.update({
        embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#e74c3c").setDescription(`❌ Denied by ${interaction.user.tag}`)],
        components: []
      });
    }
  }
});

client.login(CONFIG.bot.token);
