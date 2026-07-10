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

// --------------------------
// CONFIGURATION
// --------------------------
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
  room_link: "https://www.habbo.com/room/1234567",
  rates: {
    starting_tokens: 5,
    base_credit_rate: 5,
    furni_per_token: 3
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

// --------------------------
// LOAD EXISTING DATA FILES
// --------------------------
// ✅ READS THE SAME habboLinks.json AS YOUR OTHER BOT
const HABBO_LINKS_PATH = path.join(__dirname, 'habboLinks.json');
const STOCK_PATH = path.join(__dirname, 'stock.json');
const DATA_PATH = path.join(__dirname, 'data.json');

// Load Habbo links
let habboLinks = {};
if (fs.existsSync(HABBO_LINKS_PATH)) {
  habboLinks = JSON.parse(fs.readFileSync(HABBO_LINKS_PATH, 'utf8'));
} else {
  console.warn("⚠️ habboLinks.json not found — will create empty file");
  fs.writeFileSync(HABBO_LINKS_PATH, JSON.stringify(habboLinks, null, 2));
}

// Load stock
let STOCK = {};
if (fs.existsSync(STOCK_PATH)) {
  STOCK = JSON.parse(fs.readFileSync(STOCK_PATH, 'utf8'));
} else {
  STOCK = { blue: [], purple: [], green: [], lilac: [], golden: [] };
  fs.writeFileSync(STOCK_PATH, JSON.stringify(STOCK, null, 2));
}

// Load user/leaderboard data
let DATA = {};
if (fs.existsSync(DATA_PATH)) {
  DATA = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
} else {
  DATA = {
    users: {},
    deposit_requests: {},
    pending_claims: {},
    weeklyLeaderboard: { weekStart: new Date().toISOString(), users: {} }
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2));
}

// --------------------------
// HELPER FUNCTIONS (MATCHES YOUR OTHER BOT)
// --------------------------
function saveStock() {
  fs.writeFileSync(STOCK_PATH, JSON.stringify(STOCK, null, 2));
}

function saveData() {
  fs.writeFileSync(DATA_PATH, JSON.stringify(DATA, null, 2));
}

// ✅ SAME AS YOUR OTHER BOT
function getHabboName(discordId) {
  return habboLinks[discordId] || null;
}

// ✅ SAME AS YOUR OTHER BOT
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
  const group = CONFIG.rarity_groups.find(g => g.name === groupName);
  return group ? Math.round((group.credit_min + group.credit_max) / 2) : 0;
}

function ensureUser(userId) {
  userId = userId.toString();
  if (!DATA.users[userId]) {
    DATA.users[userId] = {
      balance: CONFIG.rates.starting_tokens,
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

function addToWeeklyStats(userId, type, value = 0) {
  const id = userId.toString();
  if (!DATA.weeklyLeaderboard.users[id]) {
    DATA.weeklyLeaderboard.users[id] = { tokensEarned: 0, wins: 0, totalCreditsWon: 0 };
  }
  if (type === 'tokens') DATA.weeklyLeaderboard.users[id].tokensEarned += value;
  if (type === 'win') {
    DATA.weeklyLeaderboard.users[id].wins += 1;
    DATA.weeklyLeaderboard.users[id].totalCreditsWon += value;
  }
  saveData();
}

function resetWeeklyLeaderboard() {
  DATA.weeklyLeaderboard = { weekStart: new Date().toISOString(), users: {} };
  saveData();
}

async function postWeeklyLeaderboard(isFinal = false) {
  const channelId = CONFIG.channels.mod_awareness;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return console.log('⚠️ Weekly leaderboard channel not found');

  const users = Object.entries(DATA.weeklyLeaderboard.users);
  if (!users.length) {
    return channel.send({
      embeds: [new EmbedBuilder()
        .setTitle(isFinal ? "🏆 Final Weekly Leaderboard" : "📈 Weekly Leaderboard Update")
        .setDescription("No activity recorded this week yet.")
        .setColor('#9b59b6')
        .setTimestamp()
      ]
    });
  }

  const sorted = users.sort((a, b) => b[1].totalCreditsWon - a[1].totalCreditsWon).slice(0, 10);
  let list = '';
  let rank = 1;
  for (const [userId, stats] of sorted) {
    const habboName = getHabboName(userId) || "Not Linked";
    list += `**#${rank}** • ${habboName}\n🪙 Tokens: **${stats.tokensEarned}** | 🎉 Wins: **${stats.wins}** | 💎 Value: **${stats.totalCreditsWon} Credits**\n\n`;
    rank++;
  }

  const topHabbo = sorted[0] ? getHabboName(sorted[0][0]) : null;
  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle(isFinal ? "🏆 FINAL WEEKLY LEADERBOARD" : "📈 WEEKLY LEADERBOARD UPDATE")
      .setDescription(`**Week:** ${new Date(DATA.weeklyLeaderboard.weekStart).toLocaleDateString()} → ${new Date().toLocaleDateString()}\n\n${list}`)
      .setColor(isFinal ? '#f1c40f' : '#3498db')
      .setThumbnail(getAvatar(topHabbo))
      .setFooter({ text: isFinal ? "Week ended! New week starts now." : "Updates daily | Resets every Sunday 6PM" })
      .setTimestamp()
    ]
  });
}

// --------------------------
// SCHEDULED TASKS
// --------------------------
cron.schedule('0 18 * * *', async () => await postWeeklyLeaderboard(false));
cron.schedule('0 18 * * 0', async () => {
  await postWeeklyLeaderboard(true);
  resetWeeklyLeaderboard();
});

// --------------------------
// BOT SETUP
// --------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', async () => {
  console.log(`✅ Gumball Bot online as ${client.user.tag}`);
  console.log(`✅ Using shared Habbo links from habboLinks.json`);

  const commands = [
    new SlashCommandBuilder().setName('balance').setDescription('Check your token balance'),
    new SlashCommandBuilder().setName('gumball').setDescription('Play the gumball machine — 1 Token per pull'),
    new SlashCommandBuilder().setName('howtoplay').setDescription('See how to play and earn tokens'),
    new SlashCommandBuilder().setName('showprizes').setDescription('View all possible prizes, values and odds'),
    new SlashCommandBuilder().setName('history').setDescription('View your activity history'),
    new SlashCommandBuilder().setName('addstock').setDescription('Staff: Add new furni to stock')
      .addStringOption(opt => opt.setName('group').setDescription('blue / purple / green / lilac / golden').setRequired(true))
      .addStringOption(opt => opt.setName('name').setDescription('Name of the furni').setRequired(true))
      .addIntegerOption(opt => opt.setName('amount').setDescription('Quantity to add').setRequired(true)),
    new SlashCommandBuilder().setName('removestock').setDescription('Staff: Remove furni from stock')
      .addStringOption(opt => opt.setName('group').setDescription('blue / purple / green / lilac / golden').setRequired(true))
      .addStringOption(opt => opt.setName('name').setDescription('Name of the furni').setRequired(true))
      .addIntegerOption(opt => opt.setName('amount').setDescription('Quantity to remove').setRequired(true)),
    new SlashCommandBuilder().setName('depositcoins').setDescription('Submit a credit deposit request')
      .addIntegerOption(opt => opt.setName('amount').setDescription('Number of credits sent').setRequired(true)),
    new SlashCommandBuilder().setName('depositfurni').setDescription('Submit a furni deposit request')
      .addStringOption(opt => opt.setName('items').setDescription('List of items you deposited').setRequired(true)),
    new SlashCommandBuilder().setName('addtokens').setDescription('Staff: Add tokens to a user')
      .addUserOption(opt => opt.setName('user').setDescription('Discord user').setRequired(true))
      .addIntegerOption(opt => opt.setName('amount').setDescription('Number of tokens').setRequired(true)),
    new SlashCommandBuilder().setName('removetokens').setDescription('Staff: Remove tokens from a user')
      .addUserOption(opt => opt.setName('user').setDescription('Discord user').setRequired(true))
      .addIntegerOption(opt => opt.setName('amount').setDescription('Number of tokens').setRequired(true))
  ];

  await client.application.commands.set(commands);
  console.log('✅ All commands registered');
});

// --------------------------
// COMMAND HANDLING
// --------------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

  const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || interaction.member.roles.cache.has(CONFIG.bot.admin_role_id);
  const isSupport = interaction.member.roles.cache.has(CONFIG.bot.support_role_id);

  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {

      case 'balance': {
        const user = ensureUser(interaction.user.id);
        const habbo = getHabboName(interaction.user.id);
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle("💰 Your Balance")
            .setThumbnail(getAvatar(habbo))
            .addFields(
              { name: "Tokens", value: `**${user.balance}**`, inline: true },
              { name: "Linked Habbo", value: habbo || "⚠️ Not verified", inline: true }
            )
            .setColor('#2ecc71')
          ],
          ephemeral: true
        });
      }

      case 'howtoplay': {
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle("📋 How To Play")
            .setDescription("Get tokens, play, and claim your prizes!")
            .setColor('#3498db')
            .addFields(
              {
                name: "🎟️ How to get Tokens",
                value: `• **Credit Deposit**: Send credits to the room chest → use \`/depositcoins\`\n• **Furni Exchange**: Send unwanted furni → use \`/depositfurni\`\n• Rates: ${CONFIG.rates.base_credit_rate}c = 1 Token | ${CONFIG.rates.furni_per_token} Furni = 1 Token\n📍 Room: ${CONFIG.room_link}`
              },
              {
                name: "🎮 Play",
                value: "Use `/gumball` — costs **1 Token** per spin. You can win furni and extra tokens!"
              },
              {
                name: "📩 Claim Prizes",
                value: "When you win, go to the claims channel and click **Request to Claim**. Staff will arrange your trade."
              }
            )
          ],
          ephemeral: true
        });
      }

      case 'showprizes': {
        const embeds = [];
        for (const group of CONFIG.rarity_groups) {
          const items = STOCK[group.id]?.filter(i => i.stock > 0) || [];
          embeds.push(new EmbedBuilder()
            .setTitle(`${group.name} Prizes`)
            .setDescription(`**Chance:** ${group.chance}%\n**Value:** ${group.credit_min}–${group.credit_max} Credits\n**Average:** ${getAverageValue(group.name)} Credits`)
            .setColor(group.color)
            .setThumbnail(items.length ? getFurniImage(items[0].name) : null)
            .addFields({ name: "Available", value: items.length ? items.map(i => `• **${i.name}** × ${i.stock}`).join("\n") : "✅ No stock available" })
          );
        }
        return interaction.reply({ embeds });
      }

      case 'history': {
        const user = ensureUser(interaction.user.id);
        if (!user.history.length) return interaction.reply({ content: "📜 No activity history found yet.", ephemeral: true });
        const historyList = user.history.map(entry => `**${new Date(entry.timestamp).toLocaleString("en-GB")}** | ${entry.type}: ${entry.detail}`).join("\n\n");
        return interaction.reply({
          embeds: [new EmbedBuilder()
            .setTitle("📜 Your Activity History")
            .setThumbnail(getAvatar(getHabboName(interaction.user.id)))
            .setDescription(historyList)
            .setColor('#9b59b6')
            .setFooter({ text: "Showing last 20 entries" })
          ],
          ephemeral: true
        });
      }

      case 'addstock': {
        if (!isAdmin) return interaction.reply({ content: "❌ Only staff can add stock.", ephemeral: true });
        const group = interaction.options.getString('group').toLowerCase();
        const name = interaction.options.getString('name');
        const amount = interaction.options.getInteger('amount');
        if (!STOCK[group]) return interaction.reply({ content: "❌ Invalid group: use blue/purple/green/lilac/golden", ephemeral: true });
        const existing = STOCK[group].find(i => i.name.toLowerCase() === name.toLowerCase());
        existing ? existing.stock += amount : STOCK[group].push({ name, stock: amount });
        saveStock();
        return interaction.reply({ content: `✅ Added **${name} × ${amount}** to ${group}`, ephemeral: true });
      }

      case 'removestock': {
        if (!isAdmin) return interaction.reply({ content: "❌ Only staff can remove stock.", ephemeral: true });
        const group = interaction.options.getString('group').toLowerCase();
        const name = interaction.options.getString('name');
        const amount = interaction.options.getInteger('amount');
        if (!STOCK[group]) return interaction.reply({ content: "❌ Invalid group", ephemeral: true });
        const idx = STOCK[group].findIndex(i => i.name.toLowerCase() === name.toLowerCase());
        if (idx === -1) return interaction.reply({ content: "❌ Item not found in stock", ephemeral: true });
        STOCK[group][idx].stock -= amount;
        if (STOCK[group][idx].stock <= 0) STOCK[group].splice(idx, 1);
        saveStock();
        return interaction.reply({ content: `✅ Updated stock for **${name}**`, ephemeral: true });
      }

      case 'depositcoins': {
        const user = ensureUser(interaction.user.id);
        const habbo = getHabboName(interaction.user.id);
        if (!habbo) return interaction.reply({ content: "❌ You must be verified first! Link your Habbo via the verification system.", ephemeral: true });
        const amount = interaction.options.getInteger('amount');
        const tokens = Math.floor(amount / CONFIG.rates.base_credit_rate);
        const depositId = Date.now();

        DATA.deposit_requests[depositId] = { type: "coins", userId: interaction.user.id, habbo, amount, tokens, status: "pending" };
        saveData();
        addToHistory(interaction.user.id, { type: "Deposit", detail: `Sent ${amount} Credits (Pending)` });

        const embed = new EmbedBuilder()
          .setTitle("💸 New Credit Deposit")
          .setDescription(`**User:** ${interaction.user}\n**Habbo:** \`${habbo}\`\n**Amount:** ${amount} Credits\n**Estimated Tokens:** ${tokens}\n**Room:** ${CONFIG.room_link}`)
          .setColor('#f39c12')
          .setThumbnail(getAvatar(habbo))
          .setFooter({ text: `Deposit ID: ${depositId}` });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${depositId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${depositId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
        );

        const modChannel = client.channels.cache.get(CONFIG.channels.mod_awareness);
        if (modChannel) await modChannel.send({ content: `<@&${CONFIG.bot.admin_role_id}> — New deposit received!`, embeds: [embed], components: [row] });
        return interaction.reply({ content: "✅ Deposit submitted! We’ll review and add tokens shortly.", ephemeral: true });
      }

      case 'depositfurni': {
        const user = ensureUser(interaction.user.id);
        const habbo = getHabboName(interaction.user.id);
        if (!habbo) return interaction.reply({ content: "❌ You must be verified first! Link your Habbo via the verification system.", ephemeral: true });
        const items = interaction.options.getString('items');
        const depositId = Date.now();

        DATA.deposit_requests[depositId] = { type: "furni", userId: interaction.user.id, habbo, items, tokens: null, status: "pending" };
        saveData();
        addToHistory(interaction.user.id, { type: "Deposit", detail: `Sent Furni: ${items} (Pending)` });

        const embed = new EmbedBuilder()
          .setTitle("📦 New Furni Deposit")
          .setDescription(`**User:** ${interaction.user}\n**Habbo:** \`${habbo}\`\n**Items:** ${items}\n**Rate:** ${CONFIG.rates.furni_per_token} = 1 Token`)
          .setColor('#9b59b6')
          .setThumbnail(getAvatar(habbo))
          .setFooter({ text: `Deposit ID: ${depositId}` });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`dep_approve_${depositId}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`dep_deny_${depositId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
        );

        const modChannel = client.channels.cache.get(CONFIG.channels.mod_awareness);
        if (modChannel) await modChannel.send({ content: `<@&${CONFIG.bot.admin_role_id}> — New furni deposit received!`, embeds: [embed], components: [row] });
        return interaction.reply({ content: "✅ Furni deposit submitted! We’ll review and add tokens shortly.", ephemeral: true });
      }

      case 'addtokens': {
        if (!isAdmin) return interaction.reply({ content: "❌ Only staff can use this command.", ephemeral: true });
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const user = ensureUser(target.id);
        user.balance += amount;
        addToWeeklyStats(target.id, 'tokens', amount);
        addToHistory(target.id, { type: "Tokens", detail: `+${amount} Tokens (Added by staff)` });
        saveData();
        return interaction.reply({ content: `✅ Added **${amount} tokens** to ${target}. New balance: ${user.balance}`, ephemeral: true });
      }

      case 'removetokens': {
        if (!isAdmin) return interaction.reply({ content: "❌ Only staff can use this command.", ephemeral: true });
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const user = ensureUser(target.id);
        user.balance = Math.max(0, user.balance - amount);
        addToHistory(target.id, { type: "Tokens", detail: `-${amount} Tokens (Removed by staff)` });
        saveData();
        return interaction.reply({ content: `✅ Removed **${amount} tokens** from ${target}. New balance: ${user.balance}`, ephemeral: true });
      }

      case 'gumball': {
        const user = ensureUser(interaction.user.id);
        const habbo = getHabboName(interaction.user.id);
        if (!habbo) return interaction.reply({ content: "❌ You must verify your Habbo account first before playing!", ephemeral: true });
        if (user.balance < 1) return interaction.reply({ content: "❌ You need at least 1 Token to play! Use `/howtoplay` to earn more.", ephemeral: true });

        user.balance -= 1;
        saveData();

        const groupsSorted = [...CONFIG.rarity_groups].sort((a, b) => b.chance - a.chance);
        const group = groupsSorted.find(g => Math.random() * 100 < g.chance) || groupsSorted[groupsSorted.length - 1];
        const items = STOCK[group.id]?.filter(i => i.stock > 0) || [];

        if (!items.length) {
          user.balance += 1;
          saveData();
          return interaction.reply({ content: "😕 No prizes available right now — your token has been refunded.", ephemeral: true });
        }

        const item = items[Math.floor(Math.random() * items.length)];
        item.stock -= 1;
        saveStock();

        const avgValue = getAverageValue(group.name);
        const wonTokens = Math.floor(Math.random() * (group.token_max - group.token_min + 1)) + group.token_min;
        user.balance += wonTokens;
        saveData();

        addToWeeklyStats(interaction.user.id, 'tokens', wonTokens);
        addToWeeklyStats(interaction.user.id, 'win', avgValue);
        addToHistory(interaction.user.id, { type: "Win", detail: `Won ${item.name} (${group.name}) | ~${avgValue} Credits | +${wonTokens} Tokens` });

        const winEmbed = new EmbedBuilder()
          .setTitle("🎉 YOU WON!")
          .setColor(group.color)
          .setThumbnail(getFurniImage(item.name))
          .setAuthor({ name: habbo, iconURL: getAvatar(habbo) })
          .addFields(
            { name: "Prize", value: `**${item.name}**`, inline: false },
            { name: "Estimated Value", value: `~${avgValue} Credits`, inline: true },
            { name: "Tokens Won", value: `+${wonTokens}`, inline: true },
            { name: "New Balance", value: `${user.balance} Tokens`, inline: true }
          );

        await interaction.reply({ embeds: [winEmbed] });

        const claimId = Date.now();
        DATA.pending_claims[claimId] = {
          userId: interaction.user.id,
          username: interaction.user.tag,
          habbo: habbo,
          item: item.name,
          value: `${avgValue} Credits`,
          group: group.name,
          status: "Pending"
        };
        saveData();

        const claimEmbed = new EmbedBuilder()
          .setTitle("📥 NEW PRIZE CLAIM")
          .setDescription(`**Status:** ⏳ Pending\n**User:** ${interaction.user}\n**Habbo:** \`${habbo}\``)
          .setColor(group.color)
          .setThumbnail(getFurniImage(item.name))
          .addFields(
            { name: "🎁 Item", value: item.name, inline: false },
            { name: "💎 Value", value: `~${avgValue} Credits`, inline: true },
            { name: "🎨 Rarity", value: group.name, inline: true }
          )
          .setFooter({ text: `Claim ID: ${claimId}` });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`claimreq_${claimId}`).setLabel("📩 Request to Claim").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`traded_${claimId}`).setLabel("✅ Mark as Traded").setStyle(ButtonStyle.Success)
        );

        const claimsChannel = client.channels.cache.get(CONFIG.channels.claims);
        if (claimsChannel) await claimsChannel.send({ embeds: [claimEmbed], components: [row] });
      }
    }
  }

  // --------------------------
  // BUTTON HANDLERS
  // --------------------------
  if (interaction.isButton()) {
    const parts = interaction.customId.split("_");
    const action = parts[0];
    const type = parts[1];
    const id = parseInt(parts[2]);

    if (action === "dep") {
      const deposit = DATA.deposit_requests?.[id];
      if (!deposit || (!isAdmin && !isSupport)) return interaction.reply({ content: "❌ You are not allowed to do this.", ephemeral: true });

      const user = ensureUser(deposit.userId);
      const member = await client.users.fetch(deposit.userId).catch(() => null);

      if (type === "approve") {
        let tokens = deposit.tokens;
        if (deposit.type === "furni") {
          await interaction.reply({ content: "Enter the total number of tokens to award:", ephemeral: true });
          try {
            const collected = await interaction.channel.awaitMessages({
              filter: m => m.author.id === interaction.user.id && !isNaN(Number(m.content)),
              max: 1,
              time: 30000,
              errors: ["time"]
            });
            tokens = parseInt(collected.first().content);
          } catch {
            return interaction.followUp({ content: "⏱️ Timed out — no input received.", ephemeral: true });
          }
        }

        user.balance += tokens;
        addToWeeklyStats(deposit.userId, 'tokens', tokens);
        addToHistory(deposit.userId, { type: "Deposit", detail: `Approved: +${tokens} Tokens` });
        deposit.status = "approved";
        deposit.processedBy = interaction.user.tag;
        saveData();

        member?.send({ content: `✅ Your deposit has been approved! **+${tokens} Tokens** added to your balance.` }).catch(() => {});

        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor('#2ecc71')
          .setDescription(`✅ **APPROVED** by ${interaction.user.tag}\n${interaction.message.embeds[0].description}`);

        await interaction.update({ embeds: [updatedEmbed], components: [] });
        return interaction.followUp({ content: `✅ Added ${tokens} tokens successfully.`, ephemeral: true });
      }

      if (type === "deny") {
        deposit.status = "denied";
        deposit.processedBy = interaction.user.tag;
        addToHistory(deposit.userId, { type: "Deposit", detail: "Declined" });
        saveData();

        member?.send({ content: `❌ Your deposit was declined. Contact staff if you have questions.` }).catch(() => {});

        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setColor('#e74c3c')
          .setDescription(`❌ **DENIED** by ${interaction.user.tag}\n${interaction.message.embeds[0].description}`);

        await interaction.update({ embeds: [updatedEmbed], components: [] });
        return interaction.followUp({ content: "✅ Deposit marked as declined.", ephemeral: true });
      }
    }

    if (action === "claimreq" || action === "traded") {
      const claim = DATA.pending_claims?.[id];
      if (!claim) return interaction.reply({ content: "❌ Claim record not found.", ephemeral: true });

      if (action === "claimreq") {
        if (interaction.user.id !== claim.userId) return interaction.reply({ content: "❌ Only the winner can request this claim.", ephemeral: true });
        claim.status = "Requested";
        addToHistory(claim.userId, { type: "Claim", detail: `Requested: ${claim.item}` });
        saveData();
        return interaction.reply({ content: "✅ Claim request sent to staff — we will contact you shortly.", ephemeral: true });
      }

      if (action === "traded") {
        if (!isAdmin && !isSupport) return interaction.reply({ content: "❌ Only staff can mark as traded.", ephemeral: true });
        claim.status = "Completed";
        addToHistory(claim.userId, { type: "Claim", detail: `Received: ${claim.item}` });
        saveData();

        const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
          .setDescription(`**Status:** ✅ COMPLETED\n**Traded by:** ${interaction.user}`);

        await interaction.update({ embeds: [updatedEmbed], components: [] });
        return interaction.reply({ content: "✅ Marked as traded successfully.", ephemeral: true });
      }
    }
  }
});

client.login(CONFIG.bot.token);
