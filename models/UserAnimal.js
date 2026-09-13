const mongoose = require('mongoose');

const MAX_LEVEL = 50;

const UserAnimalSchema = new mongoose.Schema(
  {
    userId: {
      type: Number,
      required: true,
      index: true,
    },
    // Matches an `id` field inside config/animals.json → list[]
    animalId: {
      type: String,
      required: true,
    },
    level: {
      type: Number,
      default: 1,
      min: 1,
      max: MAX_LEVEL,
    },
    // Matches a key inside config/weapons.json (nullable)
    equippedWeapon: {
      type: String,
      default: null,
    },
    // Whether this animal is part of the user's active battle team
    isTeamMember: {
      type: Boolean,
      default: false,
    },
    // XP / experience stored for future expansion
    xp: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index so we can quickly query a user's full zoo
UserAnimalSchema.index({ userId: 1, animalId: 1 });

/**
 * Virtual: check if this animal is at max level.
 */
UserAnimalSchema.virtual('isMaxLevel').get(function () {
  return this.level >= MAX_LEVEL;
});

UserAnimalSchema.set('toJSON', { virtuals: true });
UserAnimalSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('UserAnimal', UserAnimalSchema);
