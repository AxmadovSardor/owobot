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

function fmt(n) {
  return n?.toLocaleString('en-US') ?? '0';
}

function escMd(text) {
  return String(text ?? '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
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

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

const handleStart = async (ctx) => {
  const name = ctx.from.first_name || 'Hunter';
  await ctx.replyWithMarkdownV2(
    `🎉 *Welcome to OwO Bot, ${escMd(name)}\\!*\n\n` +
    `You've been given *200 coins* to start your journey\\.\n\n` +
    `📖 *Quick Commands & Shortcuts:*\n` +
    `🏹 hunt \\| owoh \\— Catch a random animal\n` +
    `🦁 zoo \\| owoz \\— View your collection\n` +
    `⬆️ levelup \\| owol \\<id\\> \\— Level up an animal\n` +
    `⚔️ battle \\| owob \\[@user\\] \\— NPC or PvP duel\n` +
    `🛒 shop \\| owos \\— Browse weapons\n` +
    `🎒 inventory \\| owoi \\— View owned weapons\n` +
    `👥 team \\| owot \\— Manage battle team\n` +
    `💰 profile \\| owop \\— View your stats\n\n` +
    `Type \`owo hunt\` or \`owoh\` to start\\!`
  );
};

const handleHelp = async (ctx) => {
  await ctx.replyWithMarkdownV2(
    `📖 *OwO Bot — Command Guide*\n\n` +
    `🏹 *hunt* \\| *owoh* \\- Catch a random animal \\(30s cooldown\\)\n` +
    `🦁 *zoo* \\| *owoz* \\- Browse your animal collection\n` +
    `⬆️ *levelup* \\| *owol* \\<id\\> \\- Level up an animal with coins\n` +
    `⚔️ *battle* \\| *owob* \\- Fight NPC opponent\n` +
    `⚔️ *battle* \\| *owob* \\@username \\- Challenge player to a PvP duel\n` +
    `🛒 *shop* \\| *owos* \\- Browse weapon shop\n` +
    `🛒 *buy* \\| *owobuy* \\<id\\> \\- Purchase a weapon\n` +
    `🎒 *inventory* \\| *owoi* \\- See owned weapons\n` +
    `⚔️ *equip* \\| *owoe* \\<animal\\> \\<weapon\\> \\- Equip weapon\n` +
    `👥 *team* \\| *owot* \\- View battle team\n` +
    `👥 *teamadd* \\| *owota* \\<id\\> \\- Add animal to team\n` +
    `👥 *teamremove* \\| *owotr* \\<id\\> \\- Remove animal from team\n` +
    `💰 *profile* \\| *owop* \\- Your coins, essence & battle stats`
  );
};

const handleProfile = async (ctx) => {
  const user = ctx.dbUser;
  const totalAnimals = await UserAnimal.countDocuments({ userId: user.userId });

  const winRate = user.totalBattles > 0
    ? ((user.wins / user.totalBattles) * 100).toFixed(1)
    : '0.0';

  await ctx.replyWithMarkdownV2(
    `👤 *${escMd(user.firstName)}'s Profile*\n\n` +
    `💰 Coins: *${fmt(user.coins)}*\n` +
    `💎 Essence: *${fmt(user.essence)}*\n` +
    `🦁 Animals: *${totalAnimals}*\n\n` +
    `🏹 Total Hunts: *${fmt(user.totalHunts)}*\n` +
    `⚔️ Battles: *${fmt(user.totalBattles)}*\n` +
    `🏆 Wins: *${fmt(user.wins)}*\n` +
    `💀 Losses: *${fmt(user.losses)}*\n` +
    `📊 Win Rate: *${escMd(winRate)}%*`
  );
};

const handleHunt = async (ctx) => {
  const user = ctx.dbUser;

  const cooldownMs = animalsConfig.huntCooldownMs ?? 30_000;
  if (user.lastHuntAt) {
    const elapsed = Date.now() - user.lastHuntAt.getTime();
    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 1000);
      return ctx.reply(`⏳ You need to wait *${remaining}s* before hunting again\\!`, {
        parse_mode: 'MarkdownV2',
      });
    }
  }

  const rolled = rollRandomAnimal();
  const rarityDef = rolled.rarityDef;

  await UserAnimal.create({
    userId: user.userId,
    animalId: rolled.id,
    level: 1,
  });

  const coinReward = animalsConfig.huntBaseRewardCoins ?? 20;
  user.coins += coinReward;
  user.totalHunts += 1;
  user.lastHuntAt = new Date();
  await user.save();

  const power = calcAnimalPower(rolled.id, 1);

  await ctx.replyWithMarkdownV2(
    `🎯 *${escMd(user.firstName)} went hunting\\!*\n\n` +
    `${rarityDef.color} *${escMd(rarityDef.label)} catch\\!*\n\n` +
    `${rolled.emoji} *${escMd(rolled.name)}*\n` +
    `⚡ Power: \`${power}\`\n` +
    `🆔 Animal ID: \`${rolled.id}\`\n\n` +
    `💰 \\+${coinReward} coins earned\\!\n` +
    `💰 Balance: \`${fmt(user.coins)}\` \`\\(owol ${escMd(rolled.id)}\\)\``
  );
};

const ZOO_PAGE_SIZE = 5;

const handleZoo = async (ctx) => {
  await sendZooPage(ctx, 0);
};

async function sendZooPage(ctx, page, editMessageId = null) {
  const userId = ctx.from.id;
  const user = ctx.dbUser || await User.findOne({ userId });
  const total = await UserAnimal.countDocuments({ userId });

  if (total === 0) {
    return ctx.reply("🦗 Your zoo is empty! Type 'owo hunt' or 'owoh' to catch animals.");
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
    const weapon = ua.equippedWeapon ? ` \\| ${getWeaponDef(ua.equippedWeapon)?.emoji ?? '🗡️'} ${escMd(getWeaponDef(ua.equippedWeapon)?.name ?? '')}` : '';

    text +=
      `${rarityDef.color} ${def.emoji} *${escMd(def.name)}*${escMd(teamTag)}\n` +
      `${escMd(bar)}\n` +
      `⚡ Power: \`${power}\`  🆔 \`${def.id}\`${escMd(weapon)}\n\n`;
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
  const user = ctx.dbUser;
  const args = getCmdArgs(ctx);
  const animalId = args[0]?.toLowerCase();

  if (!animalId) {
    return ctx.reply('❌ Usage: levelup <animal_id> or owol <animal_id>\nExample: owol cat');
  }

  const ua = await UserAnimal.findOne({ userId: user.userId, animalId });
  if (!ua) {
    return ctx.reply(`❌ You don't own a *${animalId}*. Check owoz / zoo for your animals.`, {
      parse_mode: 'Markdown',
    });
  }

  const MAX_LEVEL = 50;
  if (ua.level >= MAX_LEVEL) {
    return ctx.reply(`🏆 Your *${animalId}* is already at max level (${MAX_LEVEL})!`, {
      parse_mode: 'Markdown',
    });
  }

  const cost = calcLevelUpCost(ua.level);
  if (user.coins < cost) {
    return ctx.reply(
      `💸 Insufficient coins\\!\n` +
      `Need: \`${fmt(cost)}\` coins\n` +
      `Have: \`${fmt(user.coins)}\` coins`,
      { parse_mode: 'MarkdownV2' }
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

  await ctx.replyWithMarkdownV2(
    `⬆️ *Level Up\\!*\n\n` +
    `${def?.emoji ?? '🐾'} *${escMd(def?.name ?? animalId)}* leveled up\\!\n\n` +
    `${escMd(bar)}\n\n` +
    `⚡ Power: \`${oldPower}\` → \`${newPower}\` \\(\\+${newPower - oldPower}\\)\n` +
    `💰 Cost: \`${fmt(cost)}\` coins\n` +
    `💰 Remaining: \`${fmt(user.coins)}\` coins`
  );
};

const handleTeam = async (ctx) => {
  const user = ctx.dbUser;
  const teamAnimals = await UserAnimal.find({ userId: user.userId, isTeamMember: true });

  if (teamAnimals.length === 0) {
    return ctx.replyWithMarkdownV2(
      `👥 *${escMd(user.firstName)}'s Team is Empty*\n\n` +
      `Add animals using:\n` +
      `\`owota <animal\\_id>\`\n\n` +
      `Remove using:\n` +
      `\`owotr <animal\\_id>\`\n\n` +
      `_You can have up to ${MAX_TEAM_SIZE} members_`
    );
  }

  const { totalPower, breakdown } = calcTeamPower(teamAnimals);

  let text = `👥 *${escMd(user.firstName)}'s Battle Team* \\(${teamAnimals.length}/${MAX_TEAM_SIZE}\\)\n\n`;
  for (const b of breakdown) {
    const weapon = teamAnimals.find((a) => a.animalId === b.animalId)?.equippedWeapon;
    const weaponStr = weapon ? ` \\+ ${escMd(getWeaponDef(weapon)?.name ?? '')}` : '';
    text +=
      `${b.emoji} *${escMd(b.name)}* — Lvl ${b.level}\n` +
      `  ⚡ \`${b.rawPower}\`${escMd(weaponStr)} = \`${b.contribution}\`\n`;
  }
  text += `\n⚔️ *Total Team Power: \`${fmt(totalPower)}\`*`;

  await ctx.replyWithMarkdownV2(text);
};

const handleTeamAdd = async (ctx) => {
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

const handleBattle = async (ctx) => {
  const challenger = ctx.dbUser;
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
      return ctx.reply(`❌ User *@${targetUsername}* has not started the bot or registered yet!`, {
        parse_mode: 'Markdown',
      });
    }
  }

  const challengerTeam = await UserAnimal.find({ userId: challenger.userId, isTeamMember: true });
  if (challengerTeam.length === 0) {
    return ctx.reply('❌ You have no team members! Use owota <animal_id> to add animals to your team.');
  }

  if (targetUser) {
    if (targetUser.userId === challenger.userId) {
      return ctx.reply('❌ You cannot battle yourself! Challenge another player.');
    }

    const targetTeam = await UserAnimal.find({ userId: targetUser.userId, isTeamMember: true });
    if (targetTeam.length === 0) {
      return ctx.replyWithMarkdownV2(
        `❌ *${escMd(targetUser.firstName)}* does not have any team members set up yet\\!`
      );
    }

    const challengerPower = calcTeamPower(challengerTeam);

    const challengeText =
      `⚔️ *PvP BATTLE CHALLENGE\\!*\n\n` +
      `👤 *Challenger:* ${escMd(challenger.firstName)} \\(⚡ \`${challengerPower.totalPower}\`\\)\n` +
      `🎯 *Challenged:* ${escMd(targetUser.firstName)}\n\n` +
      `${escMd(targetUser.firstName)}, do you accept this duel\\?`;

    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback('⚔️ Accept Duel', `pvp_accept_${challenger.userId}_${targetUser.userId}`),
        Markup.button.callback('❌ Decline', `pvp_decline_${challenger.userId}_${targetUser.userId}`),
      ],
    ]);

    return ctx.replyWithMarkdownV2(challengeText, kb);
  }

  // NPC Battle
  const { totalPower, breakdown } = calcTeamPower(challengerTeam);
  const npcPower = generateNpcPower(totalPower);
  const playerWins = totalPower >= npcPower;

  challenger.totalBattles += 1;

  if (playerWins) {
    challenger.wins += 1;
    const essenceReward = Math.floor(npcPower / 50);
    const coinReward = Math.floor(npcPower / 5);
    challenger.coins += coinReward;
    challenger.essence += essenceReward;
    await challenger.save();

    let log = `⚔️ *NPC Battle Report*\n\n`;
    log += `👥 *${escMd(challenger.firstName)}'s Team:*\n`;
    for (const b of breakdown) {
      log += `  ${b.emoji} ${escMd(b.name)} \\(Lvl ${b.level}\\) ⚡ \`${b.contribution}\`\n`;
    }
    log += `\n🤖 *NPC Opponent:* ⚡ \`${npcPower}\`\n\n`;
    log += `🏆 *YOU WIN\\!*\n\n`;
    log += `Your Power: \`${totalPower}\` vs NPC: \`${npcPower}\`\n`;
    log += `📈 Power Advantage: \`+${totalPower - npcPower}\`\n\n`;
    log += `🎁 *Rewards:*\n`;
    log += `  💰 \\+${coinReward} coins\n`;
    log += `  💎 \\+${essenceReward} essence\n`;
    log += `  💰 Balance: \`${fmt(challenger.coins)}\``;

    await ctx.replyWithMarkdownV2(log);
  } else {
    const coinLoss = Math.floor(challenger.coins * 0.05);
    challenger.losses += 1;
    challenger.coins = Math.max(0, challenger.coins - coinLoss);
    await challenger.save();

    let log = `⚔️ *NPC Battle Report*\n\n`;
    log += `👥 *${escMd(challenger.firstName)}'s Team:*\n`;
    for (const b of breakdown) {
      log += `  ${b.emoji} ${escMd(b.name)} \\(Lvl ${b.level}\\) ⚡ \`${b.contribution}\`\n`;
    }
    log += `\n🤖 *NPC Opponent:* ⚡ \`${npcPower}\`\n\n`;
    log += `💀 *YOU LOST\\!*\n\n`;
    log += `Your Power: \`${totalPower}\` vs NPC: \`${npcPower}\`\n`;
    log += `📉 Power Gap: \`${npcPower - totalPower}\`\n\n`;
    log += `💸 Lost ${coinLoss} coins \\(5%\\)\n`;
    log += `💰 Balance: \`${fmt(challenger.coins)}\`\n\n`;
    log += `_Tip: Level up your animals or equip better weapons\\!_`;

    await ctx.replyWithMarkdownV2(log);
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
  if (cPower.totalPower === tPower.totalPower) {
    challengerWins = Math.random() < 0.5;
  }

  const winner = challengerWins ? challenger : target;
  const loser = challengerWins ? target : challenger;

  const coinReward = 150;
  const essenceReward = 5;
  const coinLoss = Math.floor(loser.coins * 0.05);

  winner.coins += coinReward;
  winner.essence += essenceReward;
  winner.wins += 1;
  winner.totalBattles += 1;

  loser.coins = Math.max(0, loser.coins - coinLoss);
  loser.losses += 1;
  loser.totalBattles += 1;

  await Promise.all([winner.save(), loser.save()]);

  let log = `⚔️ *PvP DUEL REPORT*\n\n`;

  log += `🔴 *${escMd(challenger.firstName)}'s Team:* ⚡ \`${cPower.totalPower}\`\n`;
  for (const b of cPower.breakdown) {
    log += `  ${b.emoji} ${escMd(b.name)} \\(Lvl ${b.level}\\) ⚡ \`${b.contribution}\`\n`;
  }

  log += `\n🔵 *${escMd(target.firstName)}'s Team:* ⚡ \`${tPower.totalPower}\`\n`;
  for (const b of tPower.breakdown) {
    log += `  ${b.emoji} ${escMd(b.name)} \\(Lvl ${b.level}\\) ⚡ \`${b.contribution}\`\n`;
  }

  log += `\n🏆 *VICTOR: ${escMd(winner.firstName)}\\!\*\n\n`;
  log += `Score: \`${cPower.totalPower}\` vs \`${tPower.totalPower}\`\n\n`;
  log += `🎁 *${escMd(winner.firstName)} Rewards:*\n`;
  log += `  💰 \\+${coinReward} coins\n`;
  log += `  💎 \\+${essenceReward} essence\n\n`;
  log += `💸 *${escMd(loser.firstName)} Penalty:*\n`;
  log += `  📉 -${coinLoss} coins \\(5%\\)`;

  await ctx.editMessageText(log, { parse_mode: 'MarkdownV2' });
});

bot.action(/^pvp_decline_(\d+)_(\d+)$/, async (ctx) => {
  const challengerId = parseInt(ctx.match[1], 10);
  const targetId = parseInt(ctx.match[2], 10);

  if (ctx.from.id !== targetId && ctx.from.id !== challengerId) {
    return ctx.answerCbQuery('⚠️ Only the challenger or challenged player can cancel!', { show_alert: true });
  }

  await ctx.answerCbQuery('Duel declined.');
  const decliner = ctx.from.id === targetId ? 'The challenged player' : 'The challenger';
  await ctx.editMessageText(`❌ *PvP Duel Cancelled* by ${decliner}.`, { parse_mode: 'Markdown' });
});

const handleShop = async (ctx) => {
  let text = `🛒 *Weapon Shop*\n\n`;

  for (const [id, w] of Object.entries(weaponsConfig)) {
    const typeLabel = w.type === 'flat_atk'
      ? `\\+${w.value} ATK`
      : `\\+${Math.round(w.value * 100)}% Multiplier`;

    text +=
      `${w.emoji} *${escMd(w.name)}*\n` +
      `  📊 ${escMd(typeLabel)}\n` +
      `  💰 Cost: \`${fmt(w.cost)}\` coins\n` +
      `  🆔 \`${id}\`\n` +
      `  _${escMd(w.description)}_\n\n`;
  }

  text += `_Buy with: \`owobuy <weapon_id>\`_`;
  await ctx.replyWithMarkdownV2(text);
};

const handleBuy = async (ctx) => {
  const user = ctx.dbUser;
  const args = getCmdArgs(ctx);
  const weaponId = args[0]?.toLowerCase();

  if (!weaponId) return ctx.reply('❌ Usage: owobuy <weapon_id> or buy <weapon_id>\nSee owos for IDs.');

  const weapon = weaponsConfig[weaponId];
  if (!weapon) return ctx.reply(`❌ Unknown weapon: \`${weaponId}\`. See owos / shop.`, { parse_mode: 'Markdown' });

  if (user.coins < weapon.cost) {
    return ctx.reply(
      `💸 Not enough coins!\nNeed: \`${fmt(weapon.cost)}\`\nHave: \`${fmt(user.coins)}\``,
      { parse_mode: 'Markdown' }
    );
  }

  user.coins -= weapon.cost;
  await user.save();
  await Inventory.addWeapon(user.userId, weaponId);

  await ctx.replyWithMarkdownV2(
    `✅ *Purchased\\!*\n\n` +
    `${weapon.emoji} *${escMd(weapon.name)}* added to your inventory\\!\n` +
    `💰 Remaining coins: \`${fmt(user.coins)}\`\n\n` +
    `_Equip with: \`owoe <animal_id> ${escMd(weaponId)}\`_`
  );
};

const handleInventory = async (ctx) => {
  const user = ctx.dbUser;
  const items = await Inventory.find({ userId: user.userId });

  if (items.length === 0) {
    return ctx.reply('🎒 Your inventory is empty! Use owos / shop to buy weapons.');
  }

  let text = `🎒 *${escMd(user.firstName)}'s Inventory*\n\n`;
  for (const item of items) {
    const w = weaponsConfig[item.weaponId];
    if (!w) continue;
    const typeLabel = w.type === 'flat_atk' ? `+${w.value} ATK` : `+${Math.round(w.value * 100)}% Mult`;
    text +=
      `${w.emoji} *${escMd(w.name)}* ×${item.quantity}\n` +
      `  📊 ${escMd(typeLabel)} 🆔 \`${item.weaponId}\`\n\n`;
  }

  text += `_Equip: \`owoe <animal_id> <weapon_id>\`_`;
  await ctx.replyWithMarkdownV2(text);
};

const handleEquip = async (ctx) => {
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
  if (!item) return ctx.reply(`❌ You don't own the weapon \`${weaponId}\`. Buy it with owos.`, { parse_mode: 'Markdown' });

  ua.equippedWeapon = weaponId;
  await ua.save();

  const def = getAnimalDef(animalId);
  const weapon = weaponsConfig[weaponId];
  const { rawPower, flatBonus, effectivePower } = calcEffectiveAnimalPower(animalId, ua.level, weaponId);

  await ctx.replyWithMarkdownV2(
    `⚔️ *Equipped\\!*\n\n` +
    `${def?.emoji ?? '🐾'} *${escMd(def?.name ?? animalId)}* now wields ${weapon.emoji} *${escMd(weapon.name)}\\!*\n\n` +
    `⚡ Base Power: \`${rawPower}\`\n` +
    `🗡️ Weapon Bonus: \`+${flatBonus}\`\n` +
    `💪 Effective Power: \`${effectivePower}\``
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

registerCommand(['start'], [], handleStart);
registerCommand(['help'], [/^owo\s+help$/i, /^owohlp$/i], handleHelp);
registerCommand(['hunt'], [/^owo\s+hunt$/i, /^owoh$/i, /^hunt$/i], handleHunt);
registerCommand(['zoo'], [/^owo\s+zoo$/i, /^owoz$/i, /^zoo$/i], handleZoo);
registerCommand(['levelup'], [/^owo\s+levelup/i, /^owol\b/i], handleLevelup);
registerCommand(['battle'], [/^owo\s+battle/i, /^owob\b/i], handleBattle);
registerCommand(['team'], [/^owo\s+team$/i, /^owot$/i], handleTeam);
registerCommand(['teamadd'], [/^owo\s+teamadd/i, /^owota\b/i], handleTeamAdd);
registerCommand(['teamremove'], [/^owo\s+teamremove/i, /^owotr\b/i], handleTeamRemove);
registerCommand(['shop'], [/^owo\s+shop$/i, /^owos$/i], handleShop);
registerCommand(['buy'], [/^owo\s+buy/i, /^owobuy\b/i], handleBuy);
registerCommand(['inventory'], [/^owo\s+inventory$/i, /^owoi$/i, /^owoinv$/i], handleInventory);
registerCommand(['equip'], [/^owo\s+equip/i, /^owoe\b/i], handleEquip);
registerCommand(['profile'], [/^owo\s+profile$/i, /^owop$/i], handleProfile);

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

app.get('/', (req, res) => res.status(200).send('🤖 OwO Bot is active and healthy!'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

(async () => {
  await connectDB();

  if (WEBHOOK_DOMAIN) {
    const SECRET_PATH = `/webhook/${bot.token}`;
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

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
})();
