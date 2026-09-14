'use strict';

require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');

// ── Models ───────────────────────────────────────────────────────────────────
const User       = require('./models/User');
const UserAnimal = require('./models/UserAnimal');
const Inventory  = require('./models/Inventory');

// ── Config & Utils ───────────────────────────────────────────────────────────
const animalsConfig = require('./config/animals.json');
const weaponsConfig = require('./config/weapons.json');

const {
  rollRandomAnimal,
  calcAnimalPower,
  calcEffectiveAnimalPower,
  calcTeamPower,
  calcLevelUpCost,
  buildLevelBar,
  generateNpcPower,
  getAnimalDef,
  getWeaponDef,
} = require('./utils/calculator');

// ─────────────────────────────────────────────────────────────────────────────
// Environment Variable Validation
// ─────────────────────────────────────────────────────────────────────────────

if (!process.env.BOT_TOKEN) {
  console.error('❌ ERROR: BOT_TOKEN environment variable is missing!');
  process.exit(1);
}

if (!process.env.MONGO_URI) {
  console.error('❌ ERROR: MONGO_URI environment variable is missing!');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot & Express Setup
// ─────────────────────────────────────────────────────────────────────────────

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

const PORT = process.env.PORT || 3000;
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;

// ── MongoDB Connection ───────────────────────────────────────────────────────
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: process.env.DB_NAME || 'owo_bot',
    });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (ctx.from) {
    ctx.dbUser = await User.findOrCreate(ctx.from);
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TEAM_SIZE = 3;
const MAX_GEMS      = { diamond: 75, heart: 450, coin: 800 };

const MAX_DAILY_LOOTBOXES     = 3;
const MAX_DAILY_WEAPON_CRAFTS = 3;

function fmt(n) {
  return n?.toLocaleString('en-US') ?? '0';
}

function escMd(text) {
  return String(text ?? '').replace(/([_*[\]()~`>#+=|{}.!\\\-])/g, '\\$1');
}

/** Extract command arguments for both slash commands and owo text triggers */
function getCmdArgs(ctx) {
  if (!ctx.message || !ctx.message.text) return [];
  const parts = ctx.message.text.trim().split(/\s+/);
  parts[0] = parts[0].replace(/@\w+$/, '');

  if (parts[0].toLowerCase() === 'owo' && parts.length > 1) {
    return parts.slice(2);
  }
  return parts.slice(1);
}

/** Check if message is in a group/supergroup */
function isGroupChat(ctx) {
  const t = ctx.chat?.type;
  return t === 'group' || t === 'supergroup';
}

/** Guard: block group chats with a DM prompt */
async function guardDM(ctx) {
  if (isGroupChat(ctx)) {
    await ctx.reply('⚠️ This command only works in private messages\\. Send me a DM\\!', {
      parse_mode: 'MarkdownV2',
    });
    return true; // blocked
  }
  return false;
}

/** Reset daily limits if a new day has arrived */
function resetDailyLimitsIfNeeded(user) {
  const today = new Date().toISOString().slice(0, 10);
  const lastReset = user.lastDailyReset ? new Date(user.lastDailyReset).toISOString().slice(0, 10) : null;
  if (today !== lastReset) {
    user.dailyLootboxes = 0;
    user.dailyWeaponCrafts = 0;
    user.lastDailyReset = new Date();
  }
}

// ── Drop Helpers ─────────────────────────────────────────────────────────────

/** All weapon IDs as array */
const weaponIds = Object.keys(weaponsConfig);

/** Roll a random weapon drop */
function rollRandomWeapon() {
  return weaponIds[Math.floor(Math.random() * weaponIds.length)];
}

/** Roll a random lootbox */
function rollLootboxReward() {
  const roll = Math.random();
  if (roll < 0.45) {
    // Diamond gems: 1-8
    return { type: 'diamond', amount: Math.ceil(Math.random() * 8) };
  } else if (roll < 0.80) {
    // Heart gems: 10-40
    return { type: 'heart', amount: Math.floor(Math.random() * 31) + 10 };
  } else {
    // Coin gems: 20-120
    return { type: 'coin', amount: Math.floor(Math.random() * 101) + 20 };
  }
}

/** Craft a random weapon from materials (weapons cost essence) */
function craftWeapon(user) {
  const CRAFT_COST = 10;
  if (user.essence < CRAFT_COST) return null;
  return { weaponId: rollRandomWeapon(), cost: CRAFT_COST };
}

// ── Gem bar display ──────────────────────────────────────────────────────────

function buildGemBar(current, max, pip = '▓', empty = '░', width = 8) {
  const filled = Math.min(Math.round((current / max) * width), width);
  return pip.repeat(filled) + empty.repeat(width - filled);
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

const handleStart = async (ctx) => {
  const name = ctx.from.first_name || 'Hunter';

  const lines = [
    `🎉 *Welcome to OwO Bot, ${escMd(name)}\\!*`,
    ``,
    `\\| You've been given *200 coins* to start your journey\\.`,
    `\\| Hunt animals, build a team, battle opponents\\!`,
    ``,
    `📖 *Quick Commands:*`,
    `\\| 🏹 \`owo hunt\` \\| \`owoh\` — Catch a random animal`,
    `\\| 🦁 \`owo zoo\` \\| \`owoz\` — View your collection`,
    `\\| ⬆️ \`owo levelup\` \\| \`owol \\<id\\>\` — Level up`,
    `\\| ⚔️ \`owo battle\` \\| \`owob\` — NPC or PvP duel`,
    `\\| 📦 \`owo lootbox\` \\| \`owo lb\` — Open a lootbox`,
    `\\| 🔧 \`owo weaponcraft\` \\| \`owo wc\` — Craft a weapon \\(Max 3/day\\)`,
    `\\| 🎒 \`owo inventory\` \\| \`owoi\` — View owned weapons`,
    `\\| 👥 \`owo team\` \\| \`owot\` — Manage battle team`,
    `\\| 💰 \`owo profile\` \\| \`owop\` — View your stats`,
    ``,
    `_Type \`owo hunt\` or \`owoh\` to start\\!_`,
  ];

  await ctx.replyWithMarkdownV2(lines.join('\n'));
};

const handleHelp = async (ctx) => {
  if (await guardDM(ctx)) return;

  const lines = [
    `📖 *OwO Bot — Command Guide*`,
    ``,
    `\\| 🏹 *hunt* \\| *owoh* — Catch a random animal \\(Lootbox drop max 3/day\\)`,
    `\\| 🦁 *zoo* \\| *owoz* — Browse your animal collection`,
    `\\| ⬆️ *levelup* \\| *owol \\<id\\>* — Level up an animal`,
    `\\| ⚔️ *battle* \\| *owob* — Fight NPC opponent`,
    `\\| ⚔️ *battle* \\| *owob @username* — Challenge a player`,
    `\\| 📦 *lootbox* \\| *owo lb* — Open a lootbox for gems`,
    `\\| 🔧 *weaponcraft* \\| *owo wc* — Craft a weapon \\(costs 10 essence, max 3/day\\)`,
    `\\| 🎒 *inventory* \\| *owoi* — See owned weapons`,
    `\\| ⚔️ *equip* \\| *owoe \\<animal\\> \\<weapon\\>* — Equip weapon`,
    `\\| 👥 *team* \\| *owot* — View battle team`,
    `\\| 👥 *teamadd* \\| *owota \\<id\\>* — Add animal to team`,
    `\\| 👥 *teamremove* \\| *owotr \\<id\\>* — Remove animal from team`,
    `\\| 💰 *profile* \\| *owop* — Your coins, gems & battle stats`,
  ];

  await ctx.replyWithMarkdownV2(lines.join('\n'));
};

const handleProfile = async (ctx) => {
  if (await guardDM(ctx)) return;
  const user = ctx.dbUser;
  resetDailyLimitsIfNeeded(user);
  await user.save();

  const totalAnimals = await UserAnimal.countDocuments({ userId: user.userId });

  const winRate = user.totalBattles > 0
    ? ((user.wins / user.totalBattles) * 100).toFixed(1)
    : '0.0';

  const lines = [
    `👤 *${escMd(user.firstName)}'s Profile*`,
    ``,
    `\\| 💰 Coins: *${fmt(user.coins)}*`,
    `\\| 💎 Essence: *${fmt(user.essence)}*`,
    `\\| 🦁 Animals: *${totalAnimals}*`,
    `\\| 📦 Lootboxes: *${user.lootboxes ?? 0}*`,
    ``,
    `\\| 💠 Diamond Gems: \\[${user.diamondGems ?? 0}/${MAX_GEMS.diamond}\\]`,
    `\\| 💙 Heart Gems: \\[${user.heartGems ?? 0}/${MAX_GEMS.heart}\\]`,
    `\\| 🌕 Coin Gems: \\[${user.coinGems ?? 0}/${MAX_GEMS.coin}\\]`,
    ``,
    `\\| 📅 Daily Limits:`,
    `\\| 📦 Lootbox Drops Today: \\[${user.dailyLootboxes ?? 0}/${MAX_DAILY_LOOTBOXES}\\]`,
    `\\| 🔧 Weapon Crafts Today: \\[${user.dailyWeaponCrafts ?? 0}/${MAX_DAILY_WEAPON_CRAFTS}\\]`,
    ``,
    `\\| 🏹 Total Hunts: *${fmt(user.totalHunts)}*`,
    `\\| ⚔️ Battles: *${fmt(user.totalBattles)}*`,
    `\\| 🏆 Wins: *${fmt(user.wins)}*`,
    `\\| 💀 Losses: *${fmt(user.losses)}*`,
    `\\| 📊 Win Rate: *${escMd(winRate)}%*`,
  ];

  await ctx.replyWithMarkdownV2(lines.join('\n'));
};

const handleHunt = async (ctx) => {
  if (await guardDM(ctx)) return;
  const user = ctx.dbUser;
  resetDailyLimitsIfNeeded(user);

  const cooldownMs = animalsConfig.huntCooldownMs ?? 15_000;
  if (user.lastHuntAt) {
    const elapsed = Date.now() - user.lastHuntAt.getTime();
    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 1000);
      return ctx.replyWithMarkdownV2(
        `\\| ⏳ *${escMd(user.firstName)}*, hunt is on cooldown\\!\n` +
        `\\| Wait *${remaining}s* before hunting again\\.`
      );
    }
  }

  const rolled = rollRandomAnimal();
  const rarityDef = rolled.rarityDef;

  await UserAnimal.create({
    userId: user.userId,
    animalId: rolled.id,
    level: 1,
  });

  // Base coin reward — boosted by gems
  let coinReward = animalsConfig.huntBaseRewardCoins ?? 20;
  const gemBonus = Math.floor(
    (user.diamondGems ?? 0) * 0.5 +
    (user.heartGems  ?? 0) * 0.1 +
    (user.coinGems   ?? 0) * 0.05
  );
  coinReward += gemBonus;

  // XP reward
  const xpReward = Math.floor(30 + Math.random() * 70 + gemBonus * 0.3);

  user.coins += coinReward;
  user.totalHunts += 1;
  user.lastHuntAt = new Date();

  // ── Lootbox drop chance (15%) - Capped at MAX_DAILY_LOOTBOXES (3) ───────
  let lootboxDropMsg = '';
  const LB_DROP_CHANCE = 0.15;
  if ((user.dailyLootboxes ?? 0) < MAX_DAILY_LOOTBOXES && Math.random() < LB_DROP_CHANCE) {
    user.lootboxes = (user.lootboxes ?? 0) + 1;
    user.dailyLootboxes = (user.dailyLootboxes ?? 0) + 1;
    lootboxDropMsg = `\n\\| 📦 *A Lootbox dropped into your inventory\\!* \\(${user.dailyLootboxes}/${MAX_DAILY_LOOTBOXES} today\\) (\`owo lb\`)`;
  }

  await user.save();

  const power = calcAnimalPower(rolled.id, 1);

  // Gem display bars like the OwO screenshot
  const diamondBar = `${user.diamondGems ?? 0}/${MAX_GEMS.diamond}`;
  const heartBar   = `${user.heartGems   ?? 0}/${MAX_GEMS.heart}`;
  const coinBar    = `${user.coinGems    ?? 0}/${MAX_GEMS.coin}`;

  const caught = rolled.emoji;

  const lines = [
    `\\| *${escMd(user.firstName)}*, hunt is empowered by 💠 \\[${diamondBar}\\] 💙 \\[${heartBar}\\] 🌕 \\[${coinBar}\\] \\!`,
    `\\| You found: ${caught}`,
    `\\| ${rarityDef.color} *${escMd(rarityDef.label)}* — ${rolled.emoji} *${escMd(rolled.name)}*`,
    `\\| ⚡ Power: \`${power}\`  🆔 \`${rolled.id}\``,
    `\\| 💰 \\+${coinReward} coins \\| 🔮 \\+${xpReward}xp gained\\!`,
  ];

  if (lootboxDropMsg) lines.push(lootboxDropMsg);
  if (gemBonus > 0) lines.push(`\\| 💎 Gem bonus: \\+${gemBonus} extra coins from gems\\!`);

  await ctx.replyWithMarkdownV2(lines.join('\n'));
};

const ZOO_PAGE_SIZE = 5;

const handleZoo = async (ctx) => {
  if (await guardDM(ctx)) return;
  await sendZooPage(ctx, 0);
};

async function sendZooPage(ctx, page, editMessageId = null) {
  const userId = ctx.from.id;
  const user = ctx.dbUser || await User.findOne({ userId });
  const total = await UserAnimal.countDocuments({ userId });

  if (total === 0) {
    return ctx.replyWithMarkdownV2(
      `\\| 🦗 Your zoo is empty\\!\n\\| Type \`owo hunt\` to catch animals\\.`
    );
  }

  const animals = await UserAnimal.find({ userId })
    .sort({ isTeamMember: -1, level: -1 })
    .skip(page * ZOO_PAGE_SIZE)
    .limit(ZOO_PAGE_SIZE);

  const totalPages = Math.ceil(total / ZOO_PAGE_SIZE);

  let text = `🦁 *${escMd(user.firstName)}'s Zoo* \\(Page ${page + 1}/${totalPages}\\) — ${total} animals\n\n`;

  for (const ua of animals) {
    const def = getAnimalDef(ua.animalId);
    if (!def) continue;

    const rarityDef = animalsConfig.rarities[def.rarity];
    const power = calcAnimalPower(ua.animalId, ua.level);
    const bar = buildLevelBar(ua.level);
    const teamTag = ua.isTeamMember ? ' 🛡️' : '';
    const weapon = ua.equippedWeapon
      ? ` \\| ${getWeaponDef(ua.equippedWeapon)?.emoji ?? '🗡️'} ${escMd(getWeaponDef(ua.equippedWeapon)?.name ?? '')}`
      : '';

    text +=
      `${rarityDef.color} ${def.emoji} *${escMd(def.name)}*${escMd(teamTag)}\n` +
      `\\| ${escMd(bar)}\n` +
      `\\| ⚡ Power: \`${power}\`  🆔 \`${def.id}\`${escMd(weapon)}\n\n`;
  }

  const buttons = [];
  if (page > 0) buttons.push(Markup.button.callback('◀️ Prev', `zoo_${userId}_${page - 1}`));
  if (page < totalPages - 1) buttons.push(Markup.button.callback('▶️ Next', `zoo_${userId}_${page + 1}`));

  const kb = buttons.length > 0 ? Markup.inlineKeyboard([buttons]) : undefined;

  if (editMessageId) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...kb });
  } else {
    await ctx.replyWithMarkdownV2(text, kb);
  }
}

bot.action(/^zoo_(\d+)_(\d+)$/, async (ctx) => {
  const ownerUserId = parseInt(ctx.match[1], 10);
  const page = parseInt(ctx.match[2], 10);

  if (ctx.from.id !== ownerUserId) {
    return ctx.answerCbQuery('⚠️ This is not your zoo pagination!', { show_alert: true });
  }

  await ctx.answerCbQuery();
  await sendZooPage(ctx, page, ctx.callbackQuery.message.message_id);
});

const handleLevelup = async (ctx) => {
  if (await guardDM(ctx)) return;
  const user = ctx.dbUser;
  const args = getCmdArgs(ctx);
  const animalId = args[0]?.toLowerCase();

  if (!animalId) {
    return ctx.replyWithMarkdownV2(
      `\\| ❌ Usage: \`levelup \\<animal\\_id\\>\` or \`owol \\<animal\\_id\\>\`\n` +
      `\\| Example: \`owol cat\``
    );
  }

  const ua = await UserAnimal.findOne({ userId: user.userId, animalId });
  if (!ua) {
    return ctx.replyWithMarkdownV2(
      `\\| ❌ You don't own a *${escMd(animalId)}*\\.\n` +
      `\\| Check \`owoz\` / \`zoo\` for your animals\\.`
    );
  }

  const MAX_LEVEL = 50;
  if (ua.level >= MAX_LEVEL) {
    return ctx.replyWithMarkdownV2(
      `\\| 🏆 *${escMd(animalId)}* is already at max level \\(${MAX_LEVEL}\\)\\!`
    );
  }

  const cost = calcLevelUpCost(ua.level);
  if (user.coins < cost) {
    return ctx.replyWithMarkdownV2(
      `\\| 💸 Insufficient coins\\!\n` +
      `\\| Need: \`${fmt(cost)}\` coins\n` +
      `\\| Have: \`${fmt(user.coins)}\` coins`
    );
  }

  const oldLevel = ua.level;
  const oldPower = calcAnimalPower(ua.animalId, oldLevel);

  user.coins -= cost;
  ua.level += 1;

  await Promise.all([user.save(), ua.save()]);

  const newPower = calcAnimalPower(ua.animalId, ua.level);
  const def = getAnimalDef(animalId);
  const bar = buildLevelBar(ua.level);

  const lines = [
    `⬆️ *Level Up\\!*`,
    ``,
    `\\| ${def?.emoji ?? '🐾'} *${escMd(def?.name ?? animalId)}* leveled up\\!`,
    `\\| ${escMd(bar)}`,
    `\\| ⚡ Power: \`${oldPower}\` → \`${newPower}\` \\(\\+${newPower - oldPower}\\)`,
    `\\| 💰 Cost: \`${fmt(cost)}\` coins`,
    `\\| 💰 Remaining: \`${fmt(user.coins)}\` coins`,
  ];

  await ctx.replyWithMarkdownV2(lines.join('\n'));
};

const handleTeam = async (ctx) => {
  if (await guardDM(ctx)) return;
  const user = ctx.dbUser;
  const teamAnimals = await UserAnimal.find({ userId: user.userId, isTeamMember: true });

  if (teamAnimals.length === 0) {
    return ctx.replyWithMarkdownV2(
      `\\| 👥 *${escMd(user.firstName)}'s Team is Empty*\n` +
      `\\| Add animals: \`owota \\<animal\\_id\\>\`\n` +
      `\\| Remove animals: \`owotr \\<animal\\_id\\>\`\n` +
      `\\| _You can have up to ${MAX_TEAM_SIZE} members_`
    );
  }

  const { totalPower, breakdown } = calcTeamPower(teamAnimals);

  let text = `👥 *${escMd(user.firstName)}'s Battle Team* \\(${teamAnimals.length}/${MAX_TEAM_SIZE}\\)\n\n`;
  for (const b of breakdown) {
    const weapon = teamAnimals.find((a) => a.animalId === b.animalId)?.equippedWeapon;
    const weaponStr = weapon ? ` \\+ ${escMd(getWeaponDef(weapon)?.name ?? '')}` : '';
    text +=
      `\\| ${b.emoji} *${escMd(b.name)}* — Lvl ${b.level}\n` +
      `\\|   ⚡ \`${b.rawPower}\`${escMd(weaponStr)} = \`${b.contribution}\`\n`;
  }
  text += `\n\\| ⚔️ *Total Team Power: \`${fmt(totalPower)}\`*`;

  await ctx.replyWithMarkdownV2(text);
};

const handleTeamAdd = async (ctx) => {
  if (await guardDM(ctx)) return;
  const user = ctx.dbUser;
  const args = getCmdArgs(ctx);
  const animalId = args[0]?.toLowerCase();

  if (!animalId) return ctx.reply('❌ Usage: owota <animal_id> or teamadd <animal_id>');

  const currentTeam = await UserAnimal.countDocuments({ userId: user.userId, isTeamMember: true });
  if (currentTeam >= MAX_TEAM_SIZE) {
    return ctx.reply(`❌ Your team is full! (Max ${MAX_TEAM_SIZE}). Remove one first with owotr <id>`);
  }

  const ua = await UserAnimal.findOne({ userId: user.userId, animalId });
  if (!ua) return ctx.reply(`❌ You don't own a *${animalId}*.`, { parse_mode: 'Markdown' });

  if (ua.isTeamMember) return ctx.reply(`✅ *${animalId}* is already on your team.`, { parse_mode: 'Markdown' });

  ua.isTeamMember = true;
  await ua.save();

  const def = getAnimalDef(animalId);
  await ctx.reply(`✅ ${def?.emoji ?? '🐾'} *${def?.name ?? animalId}* added to your team!`, {
    parse_mode: 'Markdown',
  });
};

const handleTeamRemove = async (ctx) => {
  if (await guardDM(ctx)) return;
  const user = ctx.dbUser;
  const args = getCmdArgs(ctx);
  const animalId = args[0]?.toLowerCase();

  if (!animalId) return ctx.reply('❌ Usage: owotr <animal_id> or teamremove <animal_id>');

  const ua = await UserAnimal.findOne({ userId: user.userId, animalId, isTeamMember: true });
  if (!ua) return ctx.reply(`❌ *${animalId}* is not on your team.`, { parse_mode: 'Markdown' });

  ua.isTeamMember = false;
  await ua.save();

  const def = getAnimalDef(animalId);
  await ctx.reply(`🗑️ ${def?.emoji ?? '🐾'} *${def?.name ?? animalId}* removed from team.`, {
    parse_mode: 'Markdown',
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Battle  (NPC + PvP)
// ─────────────────────────────────────────────────────────────────────────────

const WEAPON_DROP_CHANCE = 0.10; // 10% to drop a weapon after battle

const handleBattle = async (ctx) => {
  if (await guardDM(ctx)) return;
  const challenger = ctx.dbUser;
  resetDailyLimitsIfNeeded(challenger);
  const args = getCmdArgs(ctx);

  let targetUser = null;

  if (ctx.message.reply_to_message && ctx.message.reply_to_message.from) {
    const targetFrom = ctx.message.reply_to_message.from;
    if (targetFrom.is_bot) {
      return ctx.reply('🤖 You cannot duel a bot! Choose a real player.');
    }
    targetUser = await User.findOrCreate(targetFrom);
  } else if (args.length > 0) {
    const targetUsername = args[0].replace(/^@/, '');
    targetUser = await User.findOne({ username: new RegExp('^' + targetUsername + '$', 'i') });
    if (!targetUser) {
      return ctx.replyWithMarkdownV2(
        `\\| ❌ User *@${escMd(targetUsername)}* hasn't started the bot yet\\!`
      );
    }
  }

  const challengerTeam = await UserAnimal.find({ userId: challenger.userId, isTeamMember: true });
  if (challengerTeam.length === 0) {
    return ctx.replyWithMarkdownV2(
      `\\| ❌ You have no team members\\!\n` +
      `\\| Use \`owota \\<animal\\_id\\>\` to add animals to your team\\.`
    );
  }

  if (targetUser) {
    if (targetUser.userId === challenger.userId) {
      return ctx.reply('❌ You cannot battle yourself! Challenge another player.');
    }

    const targetTeam = await UserAnimal.find({ userId: targetUser.userId, isTeamMember: true });
    if (targetTeam.length === 0) {
      return ctx.replyWithMarkdownV2(
        `\\| ❌ *${escMd(targetUser.firstName)}* has no team members set up yet\\!`
      );
    }

    const challengerPower = calcTeamPower(challengerTeam);

    const challengeText =
      `⚔️ *PvP BATTLE CHALLENGE\\!*\n\n` +
      `\\| 👤 *Challenger:* ${escMd(challenger.firstName)} \\(⚡ \`${challengerPower.totalPower}\`\\)\n` +
      `\\| 🎯 *Challenged:* ${escMd(targetUser.firstName)}\n\n` +
      `${escMd(targetUser.firstName)}, do you accept this duel\\?`;

    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback('⚔️ Accept Duel', `pvp_accept_${challenger.userId}_${targetUser.userId}`),
        Markup.button.callback('❌ Decline', `pvp_decline_${challenger.userId}_${targetUser.userId}`),
      ],
    ]);

    return ctx.replyWithMarkdownV2(challengeText, kb);
  }

  // ── NPC Battle ─────────────────────────────────────────────────────────────
  const { totalPower, breakdown } = calcTeamPower(challengerTeam);
  const npcPower = generateNpcPower(totalPower);
  const playerWins = totalPower >= npcPower;
  const turns = Math.floor(Math.random() * 6) + 2;

  challenger.totalBattles += 1;

  // Weapon drop? (Capped at MAX_DAILY_WEAPON_CRAFTS)
  let weaponDropMsg = '';
  if ((challenger.dailyWeaponCrafts ?? 0) < MAX_DAILY_WEAPON_CRAFTS && Math.random() < WEAPON_DROP_CHANCE) {
    const droppedWeaponId = rollRandomWeapon();
    const droppedWeaponDef = weaponsConfig[droppedWeaponId];
    await Inventory.addWeapon(challenger.userId, droppedWeaponId);
    challenger.dailyWeaponCrafts = (challenger.dailyWeaponCrafts ?? 0) + 1;
    weaponDropMsg =
      `\n\\| 🎁 *Weapon drop\\!* ${droppedWeaponDef.emoji} *${escMd(droppedWeaponDef.name)}* added to inventory\\! \\(${challenger.dailyWeaponCrafts}/${MAX_DAILY_WEAPON_CRAFTS} today\\)`;
  }

  if (playerWins) {
    challenger.wins += 1;
    const essenceReward = Math.floor(npcPower / 50);
    const coinReward = Math.floor(npcPower / 5);
    challenger.coins += coinReward;
    challenger.essence += essenceReward;
    await challenger.save();

    let lines = [
      `⚔️ *NPC Battle Report*`,
      ``,
      `\\| 👥 *${escMd(challenger.firstName)}'s Team:*`,
    ];
    for (const b of breakdown) {
      lines.push(`\\|   ${b.emoji} ${escMd(b.name)} \\(Lvl ${b.level}\\) ⚡ \`${b.contribution}\``);
    }
    lines.push(
      ``,
      `\\| 🤖 *NPC Opponent:* ⚡ \`${npcPower}\``,
      ``,
      `\\| 🏆 *YOU WIN in ${turns} turns\\!*`,
      `\\| Your Power: \`${totalPower}\` vs NPC: \`${npcPower}\``,
      `\\| 📈 Advantage: \`\\+${totalPower - npcPower}\``,
      ``,
      `\\| 🎁 *Rewards:*`,
      `\\|   💰 \\+${coinReward} coins`,
      `\\|   💎 \\+${essenceReward} essence`,
      `\\|   💰 Balance: \`${fmt(challenger.coins)}\``,
    );

    if (weaponDropMsg) lines.push(weaponDropMsg);

    await ctx.replyWithMarkdownV2(lines.join('\n'));
  } else {
    const coinLoss = Math.floor(challenger.coins * 0.05);
    challenger.losses += 1;
    challenger.coins = Math.max(0, challenger.coins - coinLoss);
    await challenger.save();

    let lines = [
      `⚔️ *NPC Battle Report*`,
      ``,
      `\\| 👥 *${escMd(challenger.firstName)}'s Team:*`,
    ];
    for (const b of breakdown) {
      lines.push(`\\|   ${b.emoji} ${escMd(b.name)} \\(Lvl ${b.level}\\) ⚡ \`${b.contribution}\``);
    }
    lines.push(
      ``,
      `\\| 🤖 *NPC Opponent:* ⚡ \`${npcPower}\``,
      ``,
      `\\| 💀 *YOU LOST in ${turns} turns\\!*`,
      `\\| Your Power: \`${totalPower}\` vs NPC: \`${npcPower}\``,
      `\\| 📉 Power Gap: \`${npcPower - totalPower}\``,
      ``,
      `\\| 💸 Lost ${coinLoss} coins \\(5%\\)`,
      `\\| 💰 Balance: \`${fmt(challenger.coins)}\``,
      ``,
      `\\| _Tip: Level up your animals or craft better weapons\\!_`,
    );

    if (weaponDropMsg) lines.push(weaponDropMsg);

    await ctx.replyWithMarkdownV2(lines.join('\n'));
  }
};

bot.action(/^pvp_accept_(\d+)_(\d+)$/, async (ctx) => {
  const challengerId = parseInt(ctx.match[1], 10);
  const targetId = parseInt(ctx.match[2], 10);

  if (ctx.from.id !== targetId) {
    return ctx.answerCbQuery('⚠️ Only the challenged player can accept this duel!', { show_alert: true });
  }

  await ctx.answerCbQuery('⚔️ Duel accepted! Calculating battle...');

  const [challenger, target] = await Promise.all([
    User.findOne({ userId: challengerId }),
    User.findOne({ userId: targetId }),
  ]);

  if (!challenger || !target) {
    return ctx.editMessageText('❌ Error fetching player profiles for this battle.');
  }

  resetDailyLimitsIfNeeded(challenger);
  resetDailyLimitsIfNeeded(target);

  const [cTeam, tTeam] = await Promise.all([
    UserAnimal.find({ userId: challengerId, isTeamMember: true }),
    UserAnimal.find({ userId: targetId, isTeamMember: true }),
  ]);

  if (cTeam.length === 0 || tTeam.length === 0) {
    return ctx.editMessageText('❌ One of the players no longer has an active battle team.');
  }

  const cPower = calcTeamPower(cTeam);
  const tPower = calcTeamPower(tTeam);

  let challengerWins = cPower.totalPower > tPower.totalPower;
  if (cPower.totalPower === tPower.totalPower) challengerWins = Math.random() < 0.5;

  const winner = challengerWins ? challenger : target;
  const loser  = challengerWins ? target : challenger;

  const coinReward    = 150;
  const essenceReward = 5;
  const coinLoss      = Math.floor(loser.coins * 0.05);
  const turns         = Math.floor(Math.random() * 6) + 2;

  winner.coins   += coinReward;
  winner.essence += essenceReward;
  winner.wins    += 1;
  winner.totalBattles += 1;

  loser.coins  = Math.max(0, loser.coins - coinLoss);
  loser.losses += 1;
  loser.totalBattles += 1;

  await Promise.all([winner.save(), loser.save()]);

  // Weapon drop for winner
  let weaponDropMsg = '';
  if ((winner.dailyWeaponCrafts ?? 0) < MAX_DAILY_WEAPON_CRAFTS && Math.random() < WEAPON_DROP_CHANCE) {
    const droppedWeaponId  = rollRandomWeapon();
    const droppedWeaponDef = weaponsConfig[droppedWeaponId];
    await Inventory.addWeapon(winner.userId, droppedWeaponId);
    winner.dailyWeaponCrafts = (winner.dailyWeaponCrafts ?? 0) + 1;
    await winner.save();
    weaponDropMsg = `\n\\| 🎁 *Weapon drop\\!* ${droppedWeaponDef.emoji} *${escMd(droppedWeaponDef.name)}* went to ${escMd(winner.firstName)}'s inventory\\! \\(${winner.dailyWeaponCrafts}/${MAX_DAILY_WEAPON_CRAFTS} today\\)`;
  }

  let lines = [
    `⚔️ *PvP DUEL REPORT*`,
    ``,
    `\\| 🔴 *${escMd(challenger.firstName)}'s Team:* ⚡ \`${cPower.totalPower}\``,
  ];
  for (const b of cPower.breakdown) {
    lines.push(`\\|   ${b.emoji} ${escMd(b.name)} \\(Lvl ${b.level}\\) ⚡ \`${b.contribution}\``);
  }
  lines.push(``, `\\| 🔵 *${escMd(target.firstName)}'s Team:* ⚡ \`${tPower.totalPower}\``);
  for (const b of tPower.breakdown) {
    lines.push(`\\|   ${b.emoji} ${escMd(b.name)} \\(Lvl ${b.level}\\) ⚡ \`${b.contribution}\``);
  }
  lines.push(
    ``,
    `\\| 🏆 *VICTOR: ${escMd(winner.firstName)} in ${turns} turns\\!*`,
    `\\| Score: \`${cPower.totalPower}\` vs \`${tPower.totalPower}\``,
    ``,
    `\\| 🎁 *${escMd(winner.firstName)} Rewards:*`,
    `\\|   💰 \\+${coinReward} coins`,
    `\\|   💎 \\+${essenceReward} essence`,
    ``,
    `\\| 💸 *${escMd(loser.firstName)} Penalty:*`,
    `\\|   📉 \\-${coinLoss} coins \\(5%\\)`,
  );

  if (weaponDropMsg) lines.push(weaponDropMsg);

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'MarkdownV2' });
});

bot.action(/^pvp_decline_(\d+)_(\d+)$/, async (ctx) => {
  const challengerId = parseInt(ctx.match[1], 10);
  const targetId     = parseInt(ctx.match[2], 10);

  if (ctx.from.id !== targetId && ctx.from.id !== challengerId) {
    return ctx.answerCbQuery('⚠️ Only the challenger or challenged player can cancel!', { show_alert: true });
  }

  await ctx.answerCbQuery('Duel declined.');
  const decliner = ctx.from.id === targetId ? 'The challenged player' : 'The challenger';
  await ctx.editMessageText(`❌ *PvP Duel Cancelled* by ${decliner}\\.`, { parse_mode: 'MarkdownV2' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inventory
// ─────────────────────────────────────────────────────────────────────────────

const handleInventory = async (ctx) => {
  if (await guardDM(ctx)) return;
  const user = ctx.dbUser;
  const items = await Inventory.find({ userId: user.userId });

  if (items.length === 0) {
    return ctx.replyWithMarkdownV2(
      `\\| 🎒 Your inventory is empty\\!\n` +
      `\\| Craft weapons with \`owo wc\` or get them through battle drops\\.`
    );
  }

  // Build grid like OwO: 3 per row, "051 💎 ×1  052 🗡️ ×3 ..."
  let text = `🎒 *${escMd(user.firstName)}'s Inventory*\n\n`;

  const ROW_SIZE = 3;
  for (let i = 0; i < items.length; i += ROW_SIZE) {
    const row = items.slice(i, i + ROW_SIZE);
    const cells = row.map((item) => {
      const w = weaponsConfig[item.weaponId];
      if (!w) return '';
      const idPad = item.weaponId.slice(0, 3).padStart(3, '0');
      return `${idPad} ${w.emoji} ×${item.quantity}`;
    });
    text += `\\| ${cells.join('   ')}\n`;
  }

  text += `\n\\| _Equip: \`owoe \\<animal\\_id\\> \\<weapon\\_id\\>\`_`;

  await ctx.replyWithMarkdownV2(text);
};

// ─────────────────────────────────────────────────────────────────────────────
// Equip
// ─────────────────────────────────────────────────────────────────────────────

const handleEquip = async (ctx) => {
  if (await guardDM(ctx)) return;
  const user = ctx.dbUser;
  const args = getCmdArgs(ctx);
  const animalId = args[0]?.toLowerCase();
  const weaponId = args[1]?.toLowerCase();

  if (!animalId || !weaponId) {
    return ctx.reply('❌ Usage: owoe <animal_id> <weapon_id> or equip <animal_id> <weapon_id>');
  }

  const ua = await UserAnimal.findOne({ userId: user.userId, animalId });
  if (!ua) return ctx.reply(`❌ You don't own a *${animalId}*.`, { parse_mode: 'Markdown' });

  const item = await Inventory.findOne({ userId: user.userId, weaponId });
  if (!item) return ctx.reply(`❌ You don't own the weapon \`${weaponId}\`. Craft it with owo wc or get it from battle drops.`, { parse_mode: 'Markdown' });

  ua.equippedWeapon = weaponId;
  await ua.save();

  const def    = getAnimalDef(animalId);
  const weapon = weaponsConfig[weaponId];
  const { rawPower, flatBonus, effectivePower } = calcEffectiveAnimalPower(animalId, ua.level, weaponId);

  const lines = [
    `⚔️ *Equipped\\!*`,
    ``,
    `\\| ${def?.emoji ?? '🐾'} *${escMd(def?.name ?? animalId)}* now wields ${weapon.emoji} *${escMd(weapon.name)}\\!*`,
    `\\| ⚡ Base Power: \`${rawPower}\``,
    `\\| 🗡️ Weapon Bonus: \`\\+${flatBonus}\``,
    `\\| 💪 Effective Power: \`${effectivePower}\``,
  ];

  await ctx.replyWithMarkdownV2(lines.join('\n'));
};

// ─────────────────────────────────────────────────────────────────────────────
// Lootbox  (owo lb / owo lootbox)
// ─────────────────────────────────────────────────────────────────────────────

const handleLootbox = async (ctx) => {
  if (await guardDM(ctx)) return;
  const user = ctx.dbUser;

  if ((user.lootboxes ?? 0) <= 0) {
    return ctx.replyWithMarkdownV2(
      `\\| 📦 You have *no lootboxes*\\!\n` +
      `\\| Lootboxes drop occasionally while hunting \\(Max ${MAX_DAILY_LOOTBOXES}/day\\)\\.`
    );
  }

  user.lootboxes -= 1;
  const reward = rollLootboxReward();

  // Apply gem reward (capped at MAX_GEMS)
  let gemName = '';
  let gemEmoji = '';

  if (reward.type === 'diamond') {
    user.diamondGems = Math.min((user.diamondGems ?? 0) + reward.amount, MAX_GEMS.diamond);
    gemName  = 'Diamond Gems';
    gemEmoji = '💠';
  } else if (reward.type === 'heart') {
    user.heartGems = Math.min((user.heartGems ?? 0) + reward.amount, MAX_GEMS.heart);
    gemName  = 'Heart Gems';
    gemEmoji = '💙';
  } else {
    user.coinGems = Math.min((user.coinGems ?? 0) + reward.amount, MAX_GEMS.coin);
    gemName  = 'Coin Gems';
    gemEmoji = '🌕';
  }

  await user.save();

  const diamondBar = `${user.diamondGems ?? 0}/${MAX_GEMS.diamond}`;
  const heartBar   = `${user.heartGems   ?? 0}/${MAX_GEMS.heart}`;
  const coinBar    = `${user.coinGems    ?? 0}/${MAX_GEMS.coin}`;

  const lines = [
    `📦 *Lootbox Opened\\!*`,
    ``,
    `\\| ${gemEmoji} You received *\\+${reward.amount} ${escMd(gemName)}\\!*`,
    `\\| Gems empower your hunts — the more gems, the more coins per hunt\\!`,
    ``,
    `\\| 💠 Diamond Gems: \\[${diamondBar}\\]`,
    `\\| 💙 Heart Gems: \\[${heartBar}\\]`,
    `\\| 🌕 Coin Gems: \\[${coinBar}\\]`,
    ``,
    `\\| 📦 Lootboxes remaining: *${user.lootboxes}*`,
  ];

  await ctx.replyWithMarkdownV2(lines.join('\n'));
};

// ─────────────────────────────────────────────────────────────────────────────
// Weapon Craft  (owo wc / owo weaponcraft)
// ─────────────────────────────────────────────────────────────────────────────

const handleWeaponCraft = async (ctx) => {
  if (await guardDM(ctx)) return;
  const user = ctx.dbUser;
  resetDailyLimitsIfNeeded(user);

  if ((user.dailyWeaponCrafts ?? 0) >= MAX_DAILY_WEAPON_CRAFTS) {
    return ctx.replyWithMarkdownV2(
      `\\| 🛑 *Daily Limit Reached\\!*\n` +
      `\\| You have already crafted/dropped the maximum *${MAX_DAILY_WEAPON_CRAFTS} weapons today*\\.\n` +
      `\\| Please try again tomorrow\\!`
    );
  }

  const CRAFT_COST = 10; // essence per craft

  if (user.essence < CRAFT_COST) {
    return ctx.replyWithMarkdownV2(
      `\\| 🔧 *Weapon Craft*\n` +
      `\\| You need *${CRAFT_COST} essence* to craft a weapon\\.\n` +
      `\\| You have: *${user.essence} essence*\\.\n\n` +
      `\\| Earn essence by winning battles\\!`
    );
  }

  user.essence -= CRAFT_COST;
  user.dailyWeaponCrafts = (user.dailyWeaponCrafts ?? 0) + 1;

  const weaponId  = rollRandomWeapon();
  const weaponDef = weaponsConfig[weaponId];

  await Inventory.addWeapon(user.userId, weaponId);
  await user.save();

  const typeLabel = weaponDef.type === 'flat_atk'
    ? `\\+${weaponDef.value} ATK`
    : `\\+${Math.round(weaponDef.value * 100)}% Multiplier`;

  const lines = [
    `🔧 *Weapon Crafted\\!* \\(${user.dailyWeaponCrafts}/${MAX_DAILY_WEAPON_CRAFTS} today\\)`,
    ``,
    `\\| ${weaponDef.emoji} *${escMd(weaponDef.name)}* added to your inventory\\!`,
    `\\| 📊 ${escMd(typeLabel)}`,
    `\\| _${escMd(weaponDef.description)}_`,
    ``,
    `\\| 💎 Essence used: \\-${CRAFT_COST}`,
    `\\| 💎 Remaining: *${user.essence} essence*`,
    ``,
    `\\| Equip with: \`owoe \\<animal\\_id\\> ${escMd(weaponId)}\``,
  ];

  await ctx.replyWithMarkdownV2(lines.join('\n'));
};

// ─────────────────────────────────────────────────────────────────────────────
// Shop (kept for legacy reference, but you can skip using it now)
// ─────────────────────────────────────────────────────────────────────────────

const handleShop = async (ctx) => {
  if (await guardDM(ctx)) return;

  let text = `🛒 *Weapon Shop* \\(legacy — use \`owo wc\` to craft\\!\\)\n\n`;

  for (const [id, w] of Object.entries(weaponsConfig)) {
    const typeLabel = w.type === 'flat_atk'
      ? `\\+${w.value} ATK`
      : `\\+${Math.round(w.value * 100)}% Multiplier`;

    text +=
      `\\| ${w.emoji} *${escMd(w.name)}*\n` +
      `\\|   📊 ${escMd(typeLabel)}\n` +
      `\\|   💰 Cost: \`${fmt(w.cost)}\` coins\n` +
      `\\|   🆔 \`${id}\`\n` +
      `\\|   _${escMd(w.description)}_\n\n`;
  }

  text += `_Buy with: \`owobuy \\<weapon\\_id\\>\`_`;
  await ctx.replyWithMarkdownV2(text);
};

const handleBuy = async (ctx) => {
  if (await guardDM(ctx)) return;
  const user = ctx.dbUser;
  const args = getCmdArgs(ctx);
  const weaponId = args[0]?.toLowerCase();

  if (!weaponId) return ctx.reply('❌ Usage: owobuy <weapon_id>\nSee owos for IDs.');

  const weapon = weaponsConfig[weaponId];
  if (!weapon) return ctx.reply(`❌ Unknown weapon: \`${weaponId}\`. See owos / shop.`, { parse_mode: 'Markdown' });

  if (user.coins < weapon.cost) {
    return ctx.replyWithMarkdownV2(
      `\\| 💸 Not enough coins\\!\n` +
      `\\| Need: \`${fmt(weapon.cost)}\`\n` +
      `\\| Have: \`${fmt(user.coins)}\``
    );
  }

  user.coins -= weapon.cost;
  await user.save();
  await Inventory.addWeapon(user.userId, weaponId);

  await ctx.replyWithMarkdownV2(
    `\\| ✅ *Purchased\\!*\n` +
    `\\| ${weapon.emoji} *${escMd(weapon.name)}* added to your inventory\\!\n` +
    `\\| 💰 Remaining coins: \`${fmt(user.coins)}\`\n\n` +
    `\\| _Equip with: \`owoe \\<animal\\_id\\> ${escMd(weaponId)}\`_`
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Register Slash Commands + OwO Text Triggers
// ─────────────────────────────────────────────────────────────────────────────

const registerCommand = (slashCmds, textRegexes, handler) => {
  for (const cmd of slashCmds) {
    bot.command(cmd, handler);
  }
  for (const regex of textRegexes) {
    bot.hears(regex, handler);
  }
};

// /start works everywhere (including groups)
bot.command('start', handleStart);

registerCommand(['help'],        [/^owo\s+help$/i, /^owohlp$/i],                         handleHelp);
registerCommand(['hunt'],        [/^owo\s+hunt$/i, /^owoh$/i, /^hunt$/i],                 handleHunt);
registerCommand(['zoo'],         [/^owo\s+zoo$/i,  /^owoz$/i,  /^zoo$/i],                 handleZoo);
registerCommand(['levelup'],     [/^owo\s+levelup/i, /^owol\b/i],                         handleLevelup);
registerCommand(['battle'],      [/^owo\s+battle/i,  /^owob\b/i],                         handleBattle);
registerCommand(['team'],        [/^owo\s+team$/i,   /^owot$/i],                          handleTeam);
registerCommand(['teamadd'],     [/^owo\s+teamadd/i, /^owota\b/i],                        handleTeamAdd);
registerCommand(['teamremove'],  [/^owo\s+teamremove/i, /^owotr\b/i],                     handleTeamRemove);
registerCommand(['shop'],        [/^owo\s+shop$/i,   /^owos$/i],                          handleShop);
registerCommand(['buy'],         [/^owo\s+buy/i,     /^owobuy\b/i],                       handleBuy);
registerCommand(['inventory'],   [/^owo\s+inventory$/i, /^owoi$/i, /^owoinv$/i],          handleInventory);
registerCommand(['equip'],       [/^owo\s+equip/i,   /^owoe\b/i],                         handleEquip);
registerCommand(['profile'],     [/^owo\s+profile$/i, /^owop$/i],                         handleProfile);
registerCommand(['lootbox'],     [/^owo\s+lootbox$/i, /^owo\s+lb$/i, /^owolb$/i],        handleLootbox);
registerCommand(['weaponcraft'], [/^owo\s+weaponcraft$/i, /^owo\s+wc$/i, /^owowc$/i],    handleWeaponCraft);

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`❌ Error for ${ctx.updateType}:`, err.message);
  ctx.reply('⚠️ An unexpected error occurred. Please try again.').catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// Express Server & Webhook / Polling Launch Strategy
// ─────────────────────────────────────────────────────────────────────────────

app.get('/',       (req, res) => res.status(200).send('🤖 OwO Bot is active and healthy!'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

(async () => {
  await connectDB();

  if (WEBHOOK_DOMAIN) {
    const SECRET_PATH    = `/webhook/${bot.token}`;
    const fullWebhookUrl = `${WEBHOOK_DOMAIN}${SECRET_PATH}`;

    app.use(bot.webhookCallback(SECRET_PATH));

    app.listen(PORT, async () => {
      console.log(`🌐 Express server listening on port ${PORT}`);
      await bot.telegram.setWebhook(fullWebhookUrl);
      console.log(`🔗 Webhook successfully configured at: ${fullWebhookUrl}`);
    });
  } else {
    app.listen(PORT, () => {
      console.log(`🌐 Health-check server listening on http://localhost:${PORT}`);
    });

    await bot.launch();
    console.log('🤖 OwO Bot started in Long-Polling mode');
  }

  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
})();
