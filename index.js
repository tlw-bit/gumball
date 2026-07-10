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

// Load JSON files
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
let STOCK = JSON.parse(fs.readFileSync(path.join(__dirname, 'stock.json'), 'utf8'));
let DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));

// Add weekly leaderboard storage if missing
if (!DATA.weeklyLeaderboard) {
  DATA.weeklyLeaderboard = {
    weekStart: new Date().toISOString(),
    users: {}
  };
}

// Save functions
function saveStock() {
  fs.writeFileSync(path.join(__dirname, 'stock.json'), JSON.stringify(STOCK, null, 2));
}
function saveData() {
  fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(DATA, null, 2));
}

// Helper functions
function getHabboAvatar(habboName) {
  if (!habboName) return "https://www.habbo.com/habbo-imaging/avatarimage?user=Habbo&headonly=1&size=s";
  const safe = encodeURIComponent(habboName.trim());
  return `https://www.habbo.com/habbo-imaging/avatarimage?user=${safe}&direction=2&headonly=1&size=s`;
}

function getFurniImage(name) {
  const safe = name.toLowerCase().replace(/ /g, "_").replace(/'/g, "").replace(/&/g, "and");
  return `https://images.habbo.com/dcr/hof_furni/${safe}_icon.png`;
}

// Get average value for a rarity group
function getAverageValue(groupName) {
  const group = CONFIG.rarity_groups.find(g => g.name === groupName);
  return group ? Math.round((group.credit_min + group.credit_max) / 2) : 0;
}

function ensureUser(userId) {
  userId = userId.toString();
  if (!DATA.users[userId]) {
    DATA.users[userId] = {
      balance: CONFIG.rates.starting_tokens,
      habbo_name: "",
      history: []
    };
    saveData();
  }
  return DATA.users[userId];
}

function addToHistory(userId, entry) {
  const user = ensureUser(userId);
  user.history.unshift({ timestamp: new Date().toISOString(), ...entry });
  if (user.history.length > 20) user.history.pop();
  saveData();
}

// --- Weekly Leaderboard Functions ---
function addToWeeklyStats(userId, type, value = 0) {
  const id = userId.toString();
  if (!DATA.weeklyLeaderboard.users[id]) {
    DATA.weeklyLeaderboard.users[id] = {
      tokensEarned: 0,
      wins: 0,
      totalCreditsWon: 0
    };
  }
  if (type === 'tokens') DATA.weeklyLeaderboard.users[id].tokensEarned += value;
  if (type === 'win') {
    DATA.weeklyLeaderboard.users[id].wins += 1;
    DATA.weeklyLeaderboard.users[id].totalCreditsWon += value;
  }
  saveData();
}

function resetWeeklyLeaderboard() {
  DATA.weeklyLeaderboard = {
    weekStart: new Date().toISOString(),
    users: {}
  };
  saveData();
}

async function postWeeklyLeaderboard(isFinal = false) {
  const channelId = '1463828138667544640';
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return console.log('⚠️ Weekly leaderboard channel not found');

  const users = Object.entries(DATA.weeklyLeaderboard.users);
  if (users.length === 0) {
    return channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(isFinal ? "🏆 Final Weekly Leaderboard" : "📈 Weekly Leaderboard Update")
          .setDescription("No activity recorded this week yet.")
          .setColor('#9b59b6')
          .setTimestamp()
      ]
    });
  }

  // Sort by total credit value won
  const sorted = users.sort((a, b) => b[1].totalCreditsWon - a[1].totalCreditsWon);

  let list = '';
  let rank = 1;
  for (const [userId, stats] of sorted.slice(0, 10)) {
    const userData = ensureUser(userId);
    const habboName = userData.habbo_name || "No Habbo linked";
    list += `**#${rank}** • ${habboName}\n🪙 Tokens: **${stats.tokensEarned}** | 🎉 Wins: **${stats.wins}** | 💎 Total Value: **${stats.totalCreditsWon} Credits**\n\n`;
    rank++;
  }

  const embed = new EmbedBuilder()
    .setTitle(isFinal ? "🏆 FINAL WEEKLY LEADERBOARD" : "📈 WEEKLY LEADERBOARD UPDATE")
    .setDescription(`**Week:** ${new Date(DATA.weeklyLeaderboard.weekStart).toLocaleDateString()} → ${new Date().toLocaleDateString()}\n\n${list}`)
    .setColor(isFinal ? '#f1c40f' : '#3498db')
    .setThumbnail(getHabboAvatar(sorted[0] ? ensureUser(sorted[0][0]).habbo_name : null))
    .setFooter({ text: isFinal ? "Week ended! New week starts now." : "Updates daily | Resets every Sunday 6PM" })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

// --- Scheduled Jobs ---
// Daily update every day at 18:00 (6PM)
cron.schedule('0 18 * * *', async () => {
  console.log('⏰ Posting daily leaderboard...');
  await postWeeklyLeaderboard(false);
});

// Final post + reset every Sunday at 18:00
cron.schedule('0 18 * * 0', async () => {
  console.log('⏰ Final weekly results & reset...');
  await postWeeklyLeaderboard(true);
  resetWeeklyLeaderboard();
});

// --- Bot Setup ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder().setName('sethabbo').setDescription('Link your Habbo username')
      .addStringOption(opt => opt.setName('username').setDescription('Your Habbo name').setRequired(true)),

    new SlashCommandBuilder().setName('balance').setDescription('Check your token balance'),
    new SlashCommandBuilder().setName('gumball').setDescription('Play for prizes — 1 Token per spin'),
    new SlashCommandBuilder().setName('howtoplay').setDescription('Guide & rules'),
    new SlashCommandBuilder().setName('showprizes').setDescription('View all possible prizes & values'),
    new SlashCommandBuilder().setName('history').setDescription('Your activity history'),
    new SlashCommandBuilder().setName('addstock').setDescription('Staff: Add stock'),
    new SlashCommandBuilder().setName('removestock').setDescription('Staff: Remove stock'),
    new SlashCommandBuilder().setName('depositcoins').setDescription('Send credit deposit'),
    new SlashCommandBuilder().setName('depositfurni').setDescription('Send furni deposit'),
    new SlashCommandBuilder().setName('addtokens').setDescription('Staff: Add tokens'),
    new SlashCommandBuilder().setName('removetokens').setDescription('Staff: Remove tokens')
  ];

  await client.application.commands.set(commands);
  console.log('✅ All commands registered');
});

// --- Interaction Handler ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

  const isAdmin = interaction.member.roles.cache.has(CONFIG.bot.admin_role_id) || interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
  const isSupport = interaction.member.roles.cache.has(CONFIG.bot.support_role_id);

  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {

      case 'sethabbo': {
        const habbo = interaction.options.getString('username').trim();
        const user = ensureUser(interaction.user.id);
        user.habbo_name = habbo;
        addToHistory(interaction.user.id, { type: "Profile", detail: `Linked Habbo: ${habbo}` });
        return interaction.reply({ content: `✅ Linked Habbo: **${habbo}**`, ephemeral: true });
      }

      case 'balance': {
        const user = ensureUser(interaction.user.id);
        const embed = new EmbedBuilder()
          .setTitle("💰 Your Balance")
          .setThumbnail(getHabboAvatar(user.habbo_name))
          .addFields(
            { name: "Tokens", value: `**${user.balance}**`, inline: true },
            { name: "Habbo", value: user.habbo_name || "Not linked", inline: true }
          )
          .setColor('#2ecc71');
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      case 'howtoplay': {
        const embed = new EmbedBuilder()
          .setTitle("📋 How To Play")
          .setDescription(`• Use \`/depositcoins\` or \`/depositfurni\` to get tokens\n• Use \`/gumball\` to play\n• Win furni and extra tokens\n• Leaderboard resets **every Sunday 6PM**`)
          .setColor('#3498db');
        return interaction.reply({ embeds: [embed] });
      }

      case 'showprizes': {
        const embeds = [];
        for (const group of CONFIG.rarity_groups) {
          const items = STOCK[group.id]?.filter(i => i.stock > 0) || [];
          const list = items.length ? items.map(i => `• **${i.name}** × ${i.stock}`).join("\n") : "None available";
          embeds.push(
            new EmbedBuilder()
              .setTitle(`${group.name} Prizes`)
              .setDescription(`**Chance:** ${group.chance}%\n**Value:** ${group.credit_min}–${group.credit_max} Credits\n**Avg:** ${getAverageValue(group.name)} Credits`)
              .setColor(group.color)
              .setThumbnail(items.length ? getFurniImage(items[0].name) : null)
              .addFields({ name: "Available", value: list })
          );
        }
        return interaction.reply({ embeds });
      }

      case 'history': {
        const user = ensureUser(interaction.user.id);
        if (!user.history.length) return interaction.reply({ content: "📜 No activity yet.", ephemeral: true });
        const list = user.history.map(e => `**${new Date(e.timestamp).toLocaleString()}**\n${e.type}: ${e.detail}`).join("\n\n");
        const embed = new EmbedBuilder()
          .setTitle("📜 Your History")
          .setThumbnail(getHabboAvatar(user.habbo_name))
          .setDescription(list)
          .setColor('#9b59b6');
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      case 'addstock': {
        if (!isAdmin) return interaction.reply({ content: "❌ Staff only", ephemeral: true });
        const group = interaction.options.getString('group').toLowerCase();
        const name = interaction.options.getString('name');
        const amount = interaction.options.getInteger('amount');
        if (!STOCK[group]) return interaction.reply({ content: "❌ Invalid group", ephemeral: true });
        const existing = STOCK[group].find(i => i.name.toLowerCase() === name.toLowerCase());
        existing ? existing.stock += amount : STOCK[group].push({ name, stock: amount });
        saveStock();
        return interaction.reply({ content: `✅ Added ${name} × ${amount}`, ephemeral: true });
      }

      case 'removestock': {
        if (!isAdmin) return interaction.reply({ content: "❌ Staff only", ephemeral: true });
        const group = interaction.options.getString('group').toLowerCase();
        const name = interaction.options.getString('name');
        const amount = interaction.options.getInteger('amount');
        if (!STOCK[group]) return interaction.reply({ content: "❌ Invalid group", ephemeral: true });
        const idx = STOCK[group].findIndex(i => i.name.toLowerCase() === name.toLowerCase());
        if (idx === -1) return interaction.reply({ content: "❌ Item not found", ephemeral: true });
        STOCK[group][idx].stock -= amount;
        if (STOCK[group][idx].stock <= 0) STOCK[group].splice(idx, 1);
        saveStock();
        return interaction.reply({ content: `✅ Updated stock`, ephemeral: true });
      }

      case 'depositcoins': {
        const user = ensureUser(interaction.user.id);
        if (!user.habbo_name) return interaction.reply({ content: "❌ Link Habbo first: `/sethabbo`", ephemeral: true });
        const amount = interaction.options.getInteger('amount');
        const tokens = Math.floor(amount / CONFIG.rates.base_credit_rate);
        const depositId = Date.now();

        DATA.deposit_requests = DATA.deposit_requests || {};
        DATA.deposit_requests[depositId] = { type: "coins", userId: interaction.user.id, habbo: user.habbo_name, amount, tokens, status: "pending" };
        saveData();

        addToHistory(interaction.user.id, { type: "Deposit", detail: `${amount} Credits (Pending)` });

        const embed = new EmbedBuilder()
          .setTitle("💸 New Credit Deposit")
          .setDescription(`**User:** ${interaction.user}\n**Habbo:** ${user.habbo_name}\n**Amount:** ${amount} Credits\n**Est. Tokens:** ${tokens}`)
          .setThumbnail(getHabboAvatar(user.habbo_name))
          .setColor('#f39c12');

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${depositId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${depositId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
        );

        const modChannel = client.channels.cache.get(CONFIG.channels?.mod_awareness);
        if (modChannel) await modChannel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "✅ Deposit sent for review", ephemeral: true });
      }

      case 'depositfurni': {
        const user = ensureUser(interaction.user.id);
        if (!user.habbo_name) return interaction.reply({ content: "❌ Link Habbo first: `/sethabbo`", ephemeral: true });
        const items = interaction.options.getString('items');
        const depositId = Date.now();

        DATA.deposit_requests = DATA.deposit_requests || {};
        DATA.deposit_requests[depositId] = { type: "furni", userId: interaction.user.id, habbo: user.habbo_name, items, tokens: null, status: "pending" };
        saveData();

        addToHistory(interaction.user.id, { type: "Deposit", detail: `Furni: ${items} (Pending)` });

        const embed = new EmbedBuilder()
          .setTitle("📦 New Furni Deposit")
          .setDescription(`**User:** ${interaction.user}\n**Habbo:** ${user.habbo_name}\n**Items:** ${items}`)
          .setThumbnail(getHabboAvatar(user.habbo_name))
          .setColor('#9b59b6');

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${depositId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${depositId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
        );

        const modChannel = client.channels.cache.get(CONFIG.channels?.mod_awareness);
        if (modChannel) await modChannel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: "✅ Deposit sent for review", ephemeral: true });
      }

      case 'addtokens': {
        if (!isAdmin) return interaction.reply({ content: "❌ Staff only", ephemeral: true });
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const user = ensureUser(target.id);
        user.balance += amount;
        addToWeeklyStats(target.id, 'tokens', amount);
        addToHistory(target.id, { type: "Tokens", detail: `+${amount} (Staff added)` });
        saveData();
        return interaction.reply({ content: `✅ Added ${amount} tokens to ${target}`, ephemeral: true });
      }

      case 'removetokens': {
        if (!isAdmin) return interaction.reply({ content: "❌ Staff only", ephemeral: true });
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const user = ensureUser(target.id);
        user.balance = Math.max(0, user.balance - amount);
        addToHistory(target.id, { type: "Tokens", detail: `-${amount} (Staff removed)` });
        saveData();
        return interaction.reply({ content: `✅ Removed ${amount} tokens from ${target}`, ephemeral: true });
      }

      case 'gumball': {
        const user = ensureUser(interaction.user.id);
        if (user.balance < 1) return interaction.reply({ content: "❌ Not enough tokens", ephemeral: true });
        user.balance -= 1;
        saveData();

        const group = CONFIG.rarity_groups.sort((a, b) => b.chance - a.chance).find(g => Math.random() * 100 < g.chance) || CONFIG.rarity_groups[0];
        const items = STOCK[group.id]?.filter(i => i.stock > 0) || [];
        if (!items.length) {
          user.balance += 1; saveData();
          return interaction.reply({ content: "😕 No stock available — token refunded", ephemeral: true });
        }

        const item = items[Math.floor(Math.random() * items.length)];
        item.stock -= 1; saveStock();
        const avgValue = getAverageValue(group.name);
        const wonTokens = Math.floor(Math.random() * (group.token_max - group.token_min + 1)) + group.token_min;
        user.balance += wonTokens;
        saveData();

        addToWeeklyStats(interaction.user.id, 'tokens', wonTokens);
        addToWeeklyStats(interaction.user.id, 'win', avgValue);
        addToHistory(interaction.user.id, { type: "Win", detail: `${item.name} (${group.name}) | ~${avgValue} Credits | +${wonTokens} Tokens` });

        const embed = new EmbedBuilder()
          .setTitle("🎉 YOU WON!")
          .setDescription(`**Prize:** ${item.name}\n**Value:** ~${avgValue} Credits\n**Tokens Gained:** +${wonTokens}\n**New Balance:** ${user.balance}`)
          .setThumbnail(getFurniImage(item.name))
          .setAuthor({ name: user.habbo_name || "Unknown", iconURL: getHabboAvatar(user.habbo_name) })
          .setColor(group.color);

        return interaction.reply({ embeds: [embed] });
      }
    }
  }

  // --- Button Handlers ---
  if (interaction.isButton()) {
    const parts = interaction.customId.split("_");
    const action = parts[0];
    const type = parts[1];
    const id = parseInt(parts[2]);

    if (action === "dep") {
      const deposit = DATA.deposit_requests?.[id];
      if (!deposit || (!isAdmin && !isSupport)) return interaction.reply({ content: "❌ Not allowed", ephemeral: true });

      const user = ensureUser(deposit.userId);
      const member = await client.users.fetch(deposit.userId).catch(() => null);

      if (type === "approve") {
        let tokens = deposit.tokens;
        if (deposit.type === "furni") {
          await interaction.reply({ content: "Enter token amount:", ephemeral: true });
          const filter = m => m.author.id === interaction.user.id && !isNaN(Number(m.content));
          const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 30000 }).catch(() => null);
          if (!collected) return interaction.followUp({ content: "⏱️ Timed out", ephemeral: true });
          tokens = parseInt(collected.first().content);
        }

        user.balance += tokens;
        addToWeeklyStats(deposit.userId, 'tokens', tokens);
        addToHistory(deposit.userId, { type: "Deposit", detail: `Approved: +${tokens} Tokens` });
        deposit.status = "approved";
        saveData();

        member?.send(`✅ Your deposit was approved! +${tokens} Tokens added.`).catch(() => {});
        const updated = EmbedBuilder.from(interaction.message.embeds[0]).setColor('#2ecc71').setDescription(`✅ Approved by ${interaction.user.tag}`);
        await interaction.update({ embeds: [updated], components: [] });
      }

      if (type === "deny") {
        deposit.status = "denied";
        addToHistory(deposit.userId, { type: "Deposit", detail: "Declined" });
        saveData();
        member?.send("❌ Your deposit was declined.").catch(() => {});
        const updated = EmbedBuilder.from(interaction.message.embeds[0]).setColor('#e74c3c').setDescription(`❌ Denied by ${interaction.user.tag}`);
        await interaction.update({ embeds: [updated], components: [] });
      }
    }
  }
});

// Use token from Koyeb environment variable first, fall back to config (only for local testing)
client.login(process.env.BOT_TOKEN || CONFIG.bot.token);
