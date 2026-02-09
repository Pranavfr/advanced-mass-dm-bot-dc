require('dotenv').config();
const { Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');


const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember, Partials.Reaction]
});

// --- Configuration (Safety Parameters) ---
// Delay between individual messages (Jitter)
const MIN_MSG_DELAY = 4000;
const MAX_MSG_DELAY = 9000;

// Batch Sizes
const MIN_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 35;

// Cooldown between batches
const MIN_COOLDOWN_MS = 120000; // 2 minutes
const MAX_COOLDOWN_MS = 300000; // 5 minutes

// --- State ---
let dmQueue = [];
let isProcessingQueue = false;
let isCoolingDown = false;
let currentBatchCount = 0;
let currentBatchLimit = 0;
let cooldownEndTime = 0;

let stats = {
    total: 0,
    sent: 0,
    failed: 0,
    startTime: null
};
let dashboardMessage = null;

// Command Prefix
const PREFIX = '!';



client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log(`Bot is ready to serve ${client.guilds.cache.size} guilds.`);
});

// --- Helpers ---
const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function updateDashboard(channel) {
    if (!channel) return;

    // Throttle dashboard updates to avoid rate limit if needed, 
    // but since we write once permsg (avg 6s) or per batch it should be fine.

    // Logic to fetch/edit
    if (!dashboardMessage) {
        const embed = createDashboardEmbed();
        try {
            dashboardMessage = await channel.send({ embeds: [embed] });
        } catch (e) {
            console.error("Error creating dashboard:", e);
        }
    } else {
        const embed = createDashboardEmbed();
        try {
            await dashboardMessage.edit({ embeds: [embed] });
        } catch (e) {
            // If message was deleted or fetch failed, try sending a new one
            console.error("Dashboard update failed (msg deleted?), resending...", e);
            dashboardMessage = await channel.send({ embeds: [embed] });
        }
    }
}

function createDashboardEmbed() {
    const elapsed = stats.startTime ? ((Date.now() - stats.startTime) / 1000).toFixed(0) : 0;
    const remaining = dmQueue.length;

    // Estimate ETA based on Averages
    // Avg delay ~6.5s. Batch size ~27.5. Cooldown ~3.5m (210s).
    // Time per msg = 6.5s + (210s / 27.5 messages) ≈ 6.5 + 7.6 ≈ 14s avg effective time per msg
    const avgTimePerMsg = 14;
    const etaSeconds = remaining * avgTimePerMsg;
    const etaMinutes = (etaSeconds / 60).toFixed(1);

    // Status Text
    let statusText = '🟢 Processing';
    if (isCoolingDown) {
        const cooldownRemaining = Math.max(0, ((cooldownEndTime - Date.now()) / 1000).toFixed(0));
        statusText = `❄️ Cooling Down (${cooldownRemaining}s)`;
    } else if (remaining === 0 && !isProcessingQueue) {
        statusText = '✅ Complete';
    } else if (!isProcessingQueue) {
        statusText = 'zzz Idle';
    }

    // Progress Bar
    const totalProcessed = stats.sent + stats.failed;
    const percentage = stats.total > 0 ? Math.round((totalProcessed / stats.total) * 100) : 0;
    const progressBar = createProgressBar(percentage);

    return new EmbedBuilder()
        .setTitle('📢 Advanced Mass DM Dashboard')
        .setColor(isCoolingDown ? 0x3498DB : (isProcessingQueue ? 0x00FF00 : 0xFFA500))
        .addFields(
            { name: 'Status', value: statusText, inline: true },
            { name: 'Progress', value: `${progressBar} ${percentage}%`, inline: false },
            { name: '✅ Sent', value: `${stats.sent}`, inline: true },
            { name: '❌ Failed', value: `${stats.failed}`, inline: true },
            { name: '⏳ Remaining', value: `${remaining}`, inline: true },
            { name: '⏱️ Elapsed', value: `${elapsed}s`, inline: true },
            { name: '🔮 Approx ETA', value: `~${etaMinutes} mins`, inline: true },
            { name: '📦 Current Batch', value: `${currentBatchCount}/${currentBatchLimit}`, inline: true }
        )
        .setFooter({ text: `Safety: Random Delays (${MIN_MSG_DELAY / 1000}-${MAX_MSG_DELAY / 1000}s) & Dynamic Batches` })
        .setTimestamp();
}

function createProgressBar(percent) {
    const totalBars = 15;
    const filledBars = Math.round((percent / 100) * totalBars);
    const emptyBars = totalBars - filledBars;
    return '▓'.repeat(filledBars) + '░'.repeat(emptyBars);
}

// --- Verification Logic ---
async function processQueue(channel) {
    // Stop if queue empty
    if (dmQueue.length === 0) {
        isProcessingQueue = false;
        await updateDashboard(channel);
        if (channel) channel.send('✅ **Batch processing complete.**');
        return;
    }

    isProcessingQueue = true;

    // Check Batch Limits
    if (currentBatchLimit === 0) {
        // Initialize new batch size
        currentBatchLimit = getRandomInt(MIN_BATCH_SIZE, MAX_BATCH_SIZE);
        currentBatchCount = 0;
        console.log(`[SAFETY] New Batch Started. Limit: ${currentBatchLimit}`);
    }

    if (currentBatchCount >= currentBatchLimit) {
        // Trigger Cooldown
        const cooldownTime = getRandomInt(MIN_COOLDOWN_MS, MAX_COOLDOWN_MS);
        isCoolingDown = true;
        cooldownEndTime = Date.now() + cooldownTime;

        console.log(`[SAFETY] Batch limit reached. Cooling down for ${cooldownTime / 1000}s...`);

        // Update dashboard immediately to show cooldown
        await updateDashboard(channel);

        setTimeout(() => {
            isCoolingDown = false;
            currentBatchLimit = 0; // Reset to force new batch size calc
            processQueue(channel);
        }, cooldownTime);
        return;
    }

    // Process Message
    const { member, messageContent } = dmQueue.shift();
    try {
        if (Array.isArray(messageContent)) {
            // Handle Multi-Message Payload (e.g., Embed then Link)
            for (const msg of messageContent) {
                await member.send(msg);
                // Tiny internal delay to ensure order
                await sleep(500);
            }
            // console.log(`[LOG] Sent DM (Multi-part) to ${member.user.tag}`);
        } else {
            // Handle Single Message
            await member.send(messageContent);
            const logText = typeof messageContent === 'string' ? 'Message' : 'Promo Embed';
            // console.log(`[LOG] Sent DM (${logText}) to ${member.user.tag}`);
        }
        stats.sent++;
    } catch (error) {
        // console.error(`[LOG] Failed to DM ${member.user.tag}: ${error.code}`);
        stats.failed++;
    }

    currentBatchCount++;

    // Update Dashboard
    await updateDashboard(channel);

    // Random Delay before next message
    const delay = getRandomInt(MIN_MSG_DELAY, MAX_MSG_DELAY);
    setTimeout(() => {
        processQueue(channel);
    }, delay);
}


// --- Event Handler ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // !dm_tag <@User|@Role> <Message>
    if (command === 'dm_tag') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('No Permission.');

        const target = message.mentions.members.first() || message.mentions.roles.first();
        const msgContent = args.slice(1).join(' ');

        if (!target || !msgContent) return message.reply('Usage: `!dm_tag <@UserOrRole> <Message>`');

        let membersToAdd = [];
        if (message.mentions.roles.size > 0) {
            const role = message.mentions.roles.first();
            await message.guild.members.fetch();
            role.members.forEach(m => { if (!m.user.bot) membersToAdd.push(m); });
        } else {
            const m = message.mentions.members.first();
            if (!m.user.bot) membersToAdd.push(m);
        }

        if (membersToAdd.length === 0) return message.reply('No valid human members found.');

        // Initialize / Add to Queue
        const isNewSession = dmQueue.length === 0;

        membersToAdd.forEach(m => dmQueue.push({ member: m, messageContent: msgContent }));

        // Reset stats if new session
        if (isNewSession) {
            stats = { total: membersToAdd.length, sent: 0, failed: 0, startTime: Date.now() };
            currentBatchLimit = 0; // start fresh batch logic
        } else {
            stats.total += membersToAdd.length;
        }

        message.reply(`Added ${membersToAdd.length} members to queue.`);

        if (!isProcessingQueue) {
            processQueue(message.channel);
        }
    }

    // !dm_all <Message>
    if (command === 'dm_all') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('No Permission.');

        const msgContent = args.join(' ');
        if (!msgContent) return message.reply('Usage: `!dm_all <Message>`');

        message.reply('Fetching members...');

        try {
            const members = await message.guild.members.fetch();
            let count = 0;

            // For dm_all we typically reset the queue to be safe or append? user choice.
            // Let's reset for safety to avoid accidental double-queues if user spam clicks.
            if (isProcessingQueue) return message.reply('Queue is already running! Use `!stop_queue` first if you want to restart.');

            dmQueue = [];
            stats = { total: 0, sent: 0, failed: 0, startTime: Date.now() };
            currentBatchLimit = 0;

            members.forEach(member => {
                if (!member.user.bot) {
                    dmQueue.push({ member, messageContent: msgContent });
                    count++;
                }
            });

            stats.total = count;
            message.channel.send(`**Starting Mass DM**\nTarget: ${count} Members`);
            processQueue(message.channel);

        } catch (error) {
            console.error(error);
            message.reply('Error fetching members.');
        }
    }

    // !dm_promo <Link>
    if (command === 'dm_promo') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('No Permission.');

        const link = args[0];
        if (!link) return message.reply('Usage: `!dm_promo <ServerLink>`');

        message.reply('Generating Promo Embed and fetching members...');

        const promoEmbed = new EmbedBuilder()
            .setTitle('🚀 Join the High-Octane BGMI & Esports Hub! 🦁')
            .setDescription(`
<a:announce:859988961430994975> **Join the Ultimate Team GodLike Community!**

<a:crystal:792065317341495357> **Exclusive Watchparties**
<a:crystal:792065317341495357> **Live Esports Discussions**
<a:crystal:792065317341495357> **BGMI Tournament Updates**

<a:arrow:796622384441851975> **JOIN NOW:** [Click Here](${link})
            `)
            .setImage('https://cdn.discordapp.com/attachments/1173731774480781392/1470275091999756309/ChatGPT_Image_Feb_9_2026_09_57_54_AM.png?ex=698ab3e2&is=69896262&hm=629cb432cbe61b9e4236c124520090abb71608e3935e557a46b6cfbb38ab2f37')
            .setColor(0xFFD700)
            .setFooter({ text: 'Join the action today!' });

        // Create the Big Join Button
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setLabel('🔥 JOIN SERVER NOW')
                    .setStyle(ButtonStyle.Link)
                    .setURL(link)
            );

        // Split into TWO messages: 1. Main Content (Embed+Button) 2. Invite Link (Text)
        const payload1 = {
            embeds: [promoEmbed],
            components: [row]
        };
        const payload2 = {
            content: `**You've been invited!**\n${link}`
        };

        const multiPayload = [payload1, payload2];

        try {
            const members = await message.guild.members.fetch();
            let count = 0;

            if (isProcessingQueue) return message.reply('Queue is already running! Use `!stop_queue` first if you want to restart.');

            dmQueue = [];
            stats = { total: 0, sent: 0, failed: 0, startTime: Date.now() };
            currentBatchLimit = 0;

            members.forEach(member => {
                if (!member.user.bot) {
                    dmQueue.push({ member, messageContent: multiPayload });
                    count++;
                }
            });


            stats.total = count;
            message.channel.send(`**Starting Mass Promo DM**\nTarget: ${count} Members`);
            processQueue(message.channel);

        } catch (error) {
            console.error(error);
            message.reply('Error fetching members.');
        }
    }

    // !stop_queue
    if (command === 'stop_queue') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
        dmQueue = [];
        isProcessingQueue = false;
        isCoolingDown = false;
        message.reply('🛑 Queue stopped.');
    }
});

client.login(process.env.DISCORD_TOKEN);

// --- Railway / Keep-Alive Server ---
const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is alive!');
});
server.listen(process.env.PORT || 3000);
