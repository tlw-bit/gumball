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
// CONFIGURATION
// ==============================================
const CONFIG = {
  bot: {
    token: process.env.BOT_TOKEN,
    guild_id: process.env.GUILD_ID || "",
    verified_role_id: process.env.VERIFIED_ROLE_ID || "",
    admin_role_id: process.env.ADMIN_ROLE_ID || "",
    owner_role_id: process.env.OWNER_ROLE_ID || ""
  },
  channels: {
    mod_awareness: process.env.MOD_CHANNEL_ID,
    claims: process.env.CLAIMS_CHANNEL_ID,
    log: "1525289896963608668", // Your private logs channel
    stock: process.env.STOCK_CHANNEL_ID
  },
  room_link: "https://www.habbo.com/room/1234567",
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
  try { habboLinks = JSON.parse(fs.readFileSync(HABBO_LINKS_PATH, 'utf8')); }
  catch { habboLinks = {}; fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify(habboLinks, null, 2)); }
} else fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify({}, null, 2));

let STOCK = { blue: [], purple: [], green: [], lilac: [], golden: [] };
if (fs.existsSync(STOCK_PATH)) try { STOCK = JSON.parse(fs.readFileSync(STOCK_PATH, 'utf8')); } catch {}

let DATA = {
  users: {},
  deposit_requests: {},
  pending_claims: {},
  weeklyLeaderboard: { weekStart: new Date().toISOString(), users: {} }
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

function addToHistory(userId, type, details) {
  const user = ensureUser(userId);
  user.history.unshift({
    timestamp: new Date().toISOString(),
    type: type,
    details: details
  });
  if (user.history.length > 50) user.history.pop();
  saveData();
}

async function autoLinkVerified(member) {
  if (!member || !member.roles?.cache) return null;
  const hasRole = member.roles.cache.has(CONFIG.bot.verified_role_id);
  if (!hasRole) return null;
  const habboName = member.nickname?.trim() || member.user.username.trim();
  if (!habboLinks[member.id] && habboName) {
    habboLinks[member.id] = habboName;
    saveHabboLinks();
  }
  return habboLinks[member.id] || null;
}

async function sendLog(title, description, color = "#95a5a6") {
  try {
    const logChannel = await client.channels.fetch(CONFIG.channels.log).catch(() => null);
    if (!logChannel) return console.error("❌ Log channel not found");
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setTimestamp();
    await logChannel.send({ embeds: [embed] });
  } catch (err) { console.error("Log error:", err.message); }
}

async function sendDM(user, title, message, color = "#2ecc71") {
  try {
    const dmEmbed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(message)
      .setColor(color)
      .setTimestamp();
    await user.send({ embeds: [dmEmbed] });
    return true;
  } catch (err) {
    console.log(`ℹ️ Could not DM ${user.tag} — DMs likely closed`);
    return false;
  }
}

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

  await guild.commands.set([]);
  console.log("🧹 Cleared old commands");

  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Show all available commands"),
    new SlashCommandBuilder().setName("balance").setDescription("Check your token balance and linked Habbo account"),
    new SlashCommandBuilder().setName("gumball").setDescription("Play the gumball machine — costs 1 Token per spin"),
    new SlashCommandBuilder().setName("howtoplay").setDescription("View exchange rates and how to earn tokens"),
    new SlashCommandBuilder().setName("showprizes").setDescription("See all available prizes, values and stock levels"),
    new SlashCommandBuilder()
      .setName("history")
      .setDescription("View your activity history — staff can add a user to view theirs")
      .addUserOption(option =>
        option.setName("user")
          .setDescription("The user to view history for (staff only)")
          .setRequired(false)
      ),
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
    sendLog("🔄 Weekly Stats Reset", "All weekly counters have been reset", "#f39c12");
  });
});

// ==============================================
// INTERACTION HANDLING
// ==============================================
client.on("interactionCreate", async interaction => {
  const isStaff = interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild) || interaction.member?.roles?.cache?.has(CONFIG.bot.admin_role_id);

  try {
    // ------------------------------
    // MODAL SUBMISSIONS
    // ------------------------------
    if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split("_");
      const type = parts[0];
      const action = parts[1];
      const id = parseInt(parts[2]);
      const note = interaction.fields.getTextInputValue("note") || "No note provided";

      if (type === "dep") {
        const dep = DATA.deposit_requests[id];
        if (!dep) return interaction.reply({ content: "❌ Request not found", ephemeral: true });

        const user = await client.users.fetch(dep.userId).catch(() => null);
        if (!user) return interaction.reply({ content: "❌ User not found", ephemeral: true });

        if (action === "approve") {
          ensureUser(dep.userId).balance += dep.tokens;
          addToHistory(dep.userId, "Deposit Approved", `${dep.type === "coins" ? `${dep.amount} Credits` : `${dep.quantity} Furni`} | +${dep.tokens} Tokens | Note: ${note}`);
          saveData();

          await sendLog(
            "✅ Deposit Approved",
            `**User:** ${user.tag} (${dep.habbo})\n**Type:** ${dep.type === "coins" ? "Credits" : "Furni"}\n**Amount:** ${dep.type === "coins" ? `${dep.amount}c` : `${dep.quantity} items`}\n**Tokens Added:** +${dep.tokens}\n**Approved by:** ${interaction.user.tag}\n**Note:** ${note}`,
            "#2ecc71"
          );

          await sendDM(
            user,
            "✅ Deposit Approved!",
            `Hello **${dep.habbo}**!\n\nYour deposit has been approved.\n\n• **Type:** ${dep.type === "coins" ? "Credits" : "Furni"}\n• **Amount:** ${dep.type === "coins" ? `${dep.amount}c` : `${dep.quantity} items`}\n• **Tokens:** +${dep.tokens}\n• **New Balance:** ${ensureUser(dep.userId).balance}\n\n📝 **Note:** ${note}`,
            "#2ecc71"
          );

          await interaction.update({
            embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#2ecc71").setDescription(`✅ Approved by ${interaction.user.tag}\n+${dep.tokens} tokens\n📝 ${note}`)],
            components: []
          });
        }

        if (action === "deny") {
          addToHistory(dep.userId, "Deposit Denied", `${dep.type === "coins" ? `${dep.amount} Credits` : `${dep.quantity} Furni`} | Note: ${note}`);

          await sendLog(
            "❌ Deposit Denied",
            `**User:** ${user.tag} (${dep.habbo})\n**Type:** ${dep.type === "coins" ? "Credits" : "Furni"}\n**Amount:** ${dep.type === "coins" ? `${dep.amount}c` : `${dep.quantity} items`}\n**Denied by:** ${interaction.user.tag}\n**Reason:** ${note}`,
            "#e74c3c"
          );

          await sendDM(
            user,
            "❌ Deposit Denied",
            `Hello **${dep.habbo}**,\n\nYour deposit was not approved.\n\n📝 **Reason:** ${note}`,
            "#e74c3c"
          );

          await interaction.update({
            embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#e74c3c").setDescription(`❌ Denied by ${interaction.user.tag}\n📝 ${note}`)],
            components: []
          });
        }
      }

      if (type === "claim") {
        const claim = DATA.pending_claims[id];
        if (!claim) return interaction.reply({ content: "❌ Claim not found", ephemeral: true });

        const user = await client.users.fetch(claim.userId).catch(() => null);
        if (!user) return interaction.reply({ content: "❌ User not found", ephemeral: true });

        if (action === "approve") {
          addToHistory(claim.userId, "Claim Approved", `Prize: ${claim.prize} | Note: ${note}`);

          await sendLog(
            "✅ Claim Approved",
            `**User:** ${user.tag} (${claim.habbo})\n**Prize:** ${claim.prize}\n**Approved by:** ${interaction.user.tag}\n**Note:** ${note}`,
            "#f39c12"
          );

          await sendDM(
            user,
            "✅ Claim Approved",
            `Hello **${claim.habbo}**!\n\nYour claim for **${claim.prize}** has been approved.\n\n📝 **Note:** ${note}\n\nWe will send it to your Habbo room shortly.`,
            "#f39c12"
          );

          const tradedRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`claim_traded_${id}`).setLabel("✅ Traded / Sent").setStyle(ButtonStyle.Success)
          );

          await interaction.update({
            embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#f39c12").setDescription(`✅ Approved by ${interaction.user.tag}\n📝 ${note}`)],
            components: [tradedRow]
          });
        }

        if (action === "deny") {
          addToHistory(claim.userId, "Claim Denied", `Prize: ${claim.prize} | Reason: ${note}`);

          await sendLog(
            "❌ Claim Denied",
            `**User:** ${user.tag} (${claim.habbo})\n**Prize:** ${claim.prize}\n**Denied by:** ${interaction.user.tag}\n**Reason:** ${note}`,
            "#e74c3c"
          );

          await sendDM(
            user,
            "❌ Claim Denied",
            `Hello **${claim.habbo}**,\n\nYour claim for **${claim.prize}** was not approved.\n\n📝 **Reason:** ${note}`,
            "#e74c3c"
          );

          await interaction.update({
            embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor("#e74c3c").setDescription(`❌ Denied by ${interaction.user.tag}\n📝 ${note}`)],
            components: []
          });
        }
      }

      return;
    }

    // ------------------------------
    // BUTTON CLICKS
    // ------------------------------
    if (interaction.isButton()) {
      if (!isStaff) return interaction.reply({ content: "❌ Only staff can manage requests", ephemeral: true });

      const parts = interaction.customId.split("_");
      const type = parts[0];
      const action = parts[1];
      const id = parseInt(parts[2]);

      if (type === "claim" && action === "traded") {
        const claim = DATA.pending_claims[id];
        if (!claim) return interaction.reply({ content: "❌ Claim not found", ephemeral: true });

        const user = await client.users.fetch(claim.userId).catch(() => null);
        if (!user) return interaction.reply({ content: "❌ User not found", ephemeral: true });

        addToHistory(claim.userId, "Prize Sent", `Prize: ${claim.prize} | Sent by: ${interaction.user.tag}`);

        await sendLog(
          "📤 Prize Sent / Traded",
          `**User:** ${user.tag} (${claim.habbo})\n**Prize:** ${claim.prize}\n**Marked sent by:** ${interaction.user.tag}`,
          "#2ecc71"
        );

        await sendDM(
          user,
          "📤 Prize Delivered!",
          `Hello **${claim.habbo}**!\n\nYour prize **${claim.prize}** has been sent to your Habbo room.\n\nEnjoy! 🎉`,
          "#2ecc71"
        );

        await interaction.update({
          embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setDescription(`✅ Sent / Traded by ${interaction.user.tag}`)],
          components: []
        });

        delete DATA.pending_claims[id];
        saveData();
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`${type}_${action}_${id}`)
        .setTitle(`${action === "approve" ? "Approve" : "Deny"} Request`);

      const noteInput = new TextInputBuilder()
        .setCustomId("note")
        .setLabel("Reason / Note (optional)")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("e.g. Items received / Not enough credits / Out of stock...")
        .setRequired(false)
        .setMaxLength(1000);

      const row = new ActionRowBuilder().addComponents(noteInput);
      modal.addComponents(row);

      await interaction.showModal(modal);
      return;
    }

    // ------------------------------
    // SLASH COMMANDS
    // ------------------------------
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {

        // ------------------------------
        // NEW HELP COMMAND
        // ------------------------------
        case "help": {
          const embed = new EmbedBuilder()
            .setTitle("📋 Gumball Bot Commands")
            .setColor("#9b59b6")
            .setDescription("All commands are private — only you can see the result.")
            .addFields(
              {
                name: "👤 User Commands",
                value: `
\`/help\` — Show this help menu
\`/balance\` — Check your tokens and linked Habbo
\`/howtoplay\` — View rates and rules
\`/depositcoins <amount>\` — Submit credit deposit
\`/depositfurni <quantity> <items>\` — Submit furni deposit
\`/gumball\` — Play for prizes (costs 1 Token)
\`/showprizes\` — View available prizes & stock
\`/claim <prize>\` — Claim a prize you won
\`/history\` — View your own activity history
                `.trim(),
                inline: false
              }
            );

          if (isStaff) {
            embed.addFields({
              name: "🔧 Staff Commands",
              value: `
\`/history @user\` — View another user's history
\`/addtokens @user <amount>\` — Give tokens to a user
\`/removetokens @user <amount>\` — Remove tokens from a user
\`/addstock <group> <name> <amount>\` — Add prizes to stock
\`/removestock <group> <name> <amount>\` — Remove prizes from stock
                `.trim(),
              inline: false
            });
          }

          return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        case "balance": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify your account first", ephemeral: true });
          const user = ensureUser(interaction.user.id);
          return interaction.reply({
            embeds: [
              new EmbedBuilder().setTitle("💰 Your Balance")
                .setThumbnail(getAvatar(habbo))
                .addFields(
                  { name: "Linked Habbo", value: `✅ ${habbo}`, inline: true },
                  { name: "Tokens", value: `🪙 ${user.balance}`, inline: true }
                )
                .setColor("#2ecc71")
                .setTimestamp()
            ],
            ephemeral: true
          });
        }

        case "howtoplay": {
          return interaction.reply({
            embeds: [
              new EmbedBuilder().setTitle("📋 How To Play & Get Tokens")
                .setDescription(`
💱 **Exchange Rates:**
• ${CONFIG.rates.credit_per_token} Credits = 1 Token
• ${CONFIG.rates.furni_per_token} Furni = 1 Token

🎁 **Bulk Packages:**
• 15 Credits = 5 Tokens
• 25 Credits = 10 Tokens
• 50 Credits = 25 Tokens

📍 **Trading Room:** ${CONFIG.room_link}

📤 **Earn Tokens:**
• \`/depositcoins <amount>\` — Send credits
• \`/depositfurni <quantity> <items>\` — Send furni

🎮 **Play:**
• \`/gumball\` — Spin for prizes (costs 1 Token)
• \`/claim <prize name>\` — Claim what you win
                `.trim())
                .setColor("#3498db")
            ],
            ephemeral: true
          });
        }

        case "whatsnew": {
          return interaction.reply({
            embeds: [
              new EmbedBuilder().setTitle("📢 Latest Updates")
                .setDescription(`
✅ Private replies only — nothing public
✅ Auto‑link Habbo accounts
✅ Live prize values & stock levels
✅ Custom notes + DM notifications
✅ Full logs in \`#gumball-logs\`
✅ Traded/Sent button for claims
✅ Staff can view user history
✅ New \`/help\` command added
                `.trim())
                .setColor("#f39c12")
            ],
            ephemeral: true
          });
        }

        case "history": {
          const targetUser = interaction.options.getUser("user") || interaction.user;

          if (targetUser.id !== interaction.user.id && !isStaff) {
            return interaction.reply({ content: "❌ You can only view your own history.", ephemeral: true });
          }

          const userData = ensureUser(targetUser.id);
          const habboName = getHabboName(targetUser.id);

          if (!userData.history.length) {
            return interaction.reply({
              content: `📜 **History for ${targetUser.tag} (${habboName})**\n\nNo activity found yet.`,
              ephemeral: true
            });
          }

          const historyText = userData.history.map(entry => {
            const date = new Date(entry.timestamp).toLocaleString();
            return `**${date}** • **${entry.type}**\n${entry.details}\n`;
          }).join("\n");

          const embed = new EmbedBuilder()
            .setTitle(`📜 Activity History: ${targetUser.tag}`)
            .setDescription(`**Linked Habbo:** ${habboName}\n\n${historyText.slice(0, 4000)}`)
            .setColor("#9b59b6")
            .setTimestamp();

          return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        case "depositcoins": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify your account first", ephemeral: true });
          const amount = interaction.options.getInteger("amount");
          const tokens = {15:5,25:10,50:25}[amount] || Math.floor(amount / CONFIG.rates.credit_per_token);
          const depId = Date.now();
          DATA.deposit_requests[depId] = { type: "coins", userId: interaction.user.id, habbo, amount, tokens, status: "pending" };
          saveData();

          const embed = new EmbedBuilder()
            .setTitle("💸 New Credit Deposit")
            .setThumbnail(getAvatar(habbo))
            .setDescription(`**User:** ${interaction.user}\n**Habbo:** ${habbo}\n**Amount:** ${amount} Credits\n**Tokens to receive:** ${tokens}`)
            .setColor("#f39c12")
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dep_approve_${depId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dep_deny_${depId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
          );

          const modChan = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
          if (modChan) await modChan.send({ content: `${getOwnerMention()} New credit deposit`, embeds: [embed], components: [row] });
          return interaction.reply({ content: "✅ Your deposit has been sent for review.", ephemeral: true });
        }

        case "depositfurni": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify your account first", ephemeral: true });
          const quantity = interaction.options.getInteger("quantity");
          const items = interaction.options.getString("items");
          const tokens = Math.floor(quantity / CONFIG.rates.furni_per_token);
          const depId = Date.now();
          DATA.deposit_requests[depId] = { type: "furni", userId: interaction.user.id, habbo, quantity, items, tokens, status: "pending" };
          saveData();

          const embed = new EmbedBuilder()
            .setTitle("📦 New Furni Deposit")
            .setThumbnail(getAvatar(habbo))
            .setDescription(`**User:** ${interaction.user}\n**Habbo:** ${habbo}\n**Items:** ${items}\n**Quantity:** ${quantity}\n**Tokens to receive:** ${tokens}`)
            .setColor("#9b59b6")
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`dep_approve_${depId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`dep_deny_${depId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
          );

          const modChan = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
          if (modChan) await modChan.send({ content: `${getOwnerMention()} New furni deposit`, embeds: [embed], components: [row] });
          return interaction.reply({ content: "✅ Your deposit has been sent for review.", ephemeral: true });
        }

        case "claim": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify your account first", ephemeral: true });
          const prize = interaction.options.getString("prize");
          const claimId = Date.now();
          DATA.pending_claims[claimId] = { userId: interaction.user.id, habbo, prize, status: "pending" };
          saveData();

          const embed = new EmbedBuilder()
            .setTitle("🏆 New Prize Claim")
            .setThumbnail(getAvatar(habbo))
            .setDescription(`**User:** ${interaction.user}\n**Habbo:** ${habbo}\n**Prize:** ${prize}`)
            .setColor("#f1c40f")
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`claim_approve_${claimId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`claim_deny_${claimId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
          );

          const modChan = await client.channels.fetch(CONFIG.channels.mod_awareness).catch(() => null);
          if (modChan) await modChan.send({ content: `${getOwnerMention()} New prize claim`, embeds: [embed], components: [row] });
          return interaction.reply({ content: "✅ Your claim has been sent for review.", ephemeral: true });
        }

        case "gumball": {
          const habbo = await autoLinkVerified(interaction.member);
          if (!habbo) return interaction.reply({ content: "❌ Verify your account first", ephemeral: true });
          const user = ensureUser(interaction.user.id);
          if (user.balance < 1) return interaction.reply({ content: "❌ You need at least 1 Token to play.", ephemeral: true });
          user.balance -= 1; saveData();

          const group = CONFIG.rarity_groups.sort((a,b) => b.chance - a.chance).find(g => Math.random() * 100 < g.chance) || CONFIG.rarity_groups.at(-1);
          const available = STOCK[group.id]?.filter(i => i.stock > 0) || [];
          if (available.length === 0) { user.balance += 1; saveData(); return interaction.reply({ content: "😕 No prizes available right now — your token has been refunded.", ephemeral: true }); }

          const prize = available[Math.floor(Math.random() * available.length)];
          prize.stock--; saveStock();
          const tokensWon = Math.floor(Math.random() * (group.token_max - group.token_min + 1)) + group.token_min;
          user.balance += tokensWon; saveData();

          addToHistory(interaction.user.id, "Gumball Spin", `Won: ${prize.name} | +${tokensWon} Tokens`);
          await sendLog("🎰 Spin Result", `**User:** ${interaction.user.tag}\n**Prize:** ${prize.name}\n**Tokens Won:** +${tokensWon}\n**New Balance:** ${user.balance}`, group.color);

          const details = await getFurniDetails(prize.name);
          return interaction.reply({
            embeds: [
              new EmbedBuilder().setTitle("🎉 YOU WON!")
                .setAuthor({ name: habbo, iconURL: getAvatar(habbo) })
                .setThumbnail(details.icon)
                .setDescription(`**${prize.name}**\n📊 Rarity: ${group.name}\n💰 Value: ${details.price}\n🪙 Tokens: +${tokensWon}\n💳 New Balance: ${user.balance}\n\nUse \`/claim ${prize.name}\` to request your prize!`)
                .setColor(group.color)
            ],
            ephemeral: true
          });
        }

        case "showprizes": {
          const embed = new EmbedBuilder().setTitle("🎁 Available Prizes").setColor("#95a5a6").setTimestamp();
          for (const group of CONFIG.rarity_groups) {
            const items = STOCK[group.id] || [];
            if (items.length === 0) {
              embed.addFields({ name: `${group.name} Rarity`, value: "No stock available", inline: false });
              continue;
            }
            const list = items.map(i => `• ${i.name} — ${i.stock} in stock`).join("\n");
            embed.addFields({ name: `${group.name} Rarity`, value: list, inline: false });
          }
          return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        case "addtokens": {
          if (!isStaff) return interaction.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
          const target = interaction.options.getUser("user");
          const amount = interaction.options.getInteger("amount");
          ensureUser(target.id).balance += amount;
          addToHistory(target.id, "Tokens Added", `+${amount} Tokens | Added by ${interaction.user.tag}`);
          saveData();
          await sendLog("➕ Tokens Added", `**User:** ${target.tag}\n**Amount:** +${amount}\n**Added by:** ${interaction.user.tag}`, "#2ecc71");
          return interaction.reply({ content: `✅ Successfully added **${amount} tokens** to ${target}.`, ephemeral: true });
        }

        case "removetokens": {
          if (!isStaff) return interaction.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
          const target = interaction.options.getUser("user");
          const amount = interaction.options.getInteger("amount");
          ensureUser(target.id).balance = Math.max(0, ensureUser(target.id).balance - amount);
          addToHistory(target.id, "Tokens Removed", `-${amount} Tokens | Removed by ${interaction.user.tag}`);
          saveData();
          await sendLog("➖ Tokens Removed", `**User:** ${target.tag}\n**Amount:** -${amount}\n**Removed by:** ${interaction.user.tag}`, "#e74c3c");
          return interaction.reply({ content: `✅ Successfully removed **${amount} tokens** from ${target}.`, ephemeral: true });
        }

        case "addstock": {
          if (!isStaff) return interaction.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
          const group = interaction.options.getString("group").toLowerCase();
          const name = interaction.options.getString("name");
          const amount = interaction.options.getInteger("amount");
          if (!STOCK.hasOwnProperty(group)) return interaction.reply({ content: "❌ Invalid rarity group. Use: blue, purple, green, lilac, golden", ephemeral: true });
          const existing = STOCK[group].find(i => i.name.toLowerCase() === name.toLowerCase());
          existing ? existing.stock += amount : STOCK[group].push({ name, stock: amount });
          saveStock();
          await sendLog("📥 Stock Added", `**Item:** ${name}\n**Group:** ${group}\n**Quantity:** +${amount}\n**Added by:** ${interaction.user.tag}`, "#27ae60");
          return interaction.reply({ content: `✅ Successfully added **${amount}x ${name}** to ${group} stock.`, ephemeral: true });
        }

        case "removestock": {
          if (!isStaff) return interaction.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
          const group = interaction.options.getString("group").toLowerCase();
          const name = interaction.options.getString("name");
          const amount = interaction.options.getInteger("amount");
          if (!STOCK.hasOwnProperty(group)) return interaction.reply({ content: "❌ Invalid rarity group. Use: blue, purple, green, lilac, golden", ephemeral: true });
          const idx = STOCK[group].findIndex(i => i.name.toLowerCase() === name.toLowerCase());
          if (idx === -1) return interaction.reply({ content: "❌ Item not found in stock.", ephemeral: true });
          STOCK[group][idx].stock -= amount;
          if (STOCK[group][idx].stock <= 0) STOCK[group].splice(idx, 1);
          saveStock();
          await sendLog("📤 Stock Removed", `**Item:** ${name}\n**Group:** ${group}\n**Quantity:** -${amount}\n**Removed by:** ${interaction.user.tag}`, "#e67e22");
          return interaction.reply({ content: `✅ Successfully removed **${amount}x ${name}** from ${group} stock.`, ephemeral: true });
        }
      }
    }

  } catch (err) {
    console.error("❌ Error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Something went wrong. Please try again later.", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(process.env.BOT_TOKEN);
