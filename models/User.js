const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    userId: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    username: {
      type: String,
      default: null,
    },
    firstName: {
      type: String,
      default: 'Hunter',
    },
    coins: {
      type: Number,
      default: 200, // Starting coins
      min: 0,
    },
    essence: {
      type: Number,
      default: 0, // Premium currency earned through battles / achievements
      min: 0,
    },
    totalHunts: {
      type: Number,
      default: 0,
    },
    totalBattles: {
      type: Number,
      default: 0,
    },
    wins: {
      type: Number,
      default: 0,
    },
    losses: {
      type: Number,
      default: 0,
    },
    lastHuntAt: {
      type: Date,
      default: null,
    },
    // Gems from lootboxes — empower hunts
    diamondGems: {
      type: Number,
      default: 0,
      min: 0,
    },
    heartGems: {
      type: Number,
      default: 0,
      min: 0,
    },
    coinGems: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Lootboxes waiting to be opened (stored in inventory, but count here too)
    lootboxes: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Daily limit tracking
    dailyLootboxes: {
      type: Number,
      default: 0,
      min: 0,
    },
    dailyWeaponCrafts: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastDailyReset: {
      type: Date,
      default: null,
    },
    // Active team: up to 3 animal ObjectIds (references UserAnimal)
    team: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'UserAnimal',
      default: [],
      validate: {
        validator: (v) => v.length <= 3,
        message: 'Team cannot have more than 3 animals.',
      },
    },
  },
  {
    timestamps: true,
  }
);

/**
 * Find or create a user profile by Telegram userId.
 * @param {object} from - Telegram `ctx.from` object
 */
UserSchema.statics.findOrCreate = async function (from) {
  let user = await this.findOne({ userId: from.id });
  if (!user) {
    user = await this.create({
      userId: from.id,
      username: from.username || null,
      firstName: from.first_name || 'Hunter',
    });
  } else {
    // Keep name/username in sync
    user.username = from.username || user.username;
    user.firstName = from.first_name || user.firstName;
    await user.save();
  }
  return user;
};

module.exports = mongoose.model('User', UserSchema);
