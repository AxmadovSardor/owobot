const mongoose = require('mongoose');

/**
 * Inventory Model
 * Tracks which weapons a user owns and how many copies.
 * Each document = one unique weapon owned by one user.
 */
const InventorySchema = new mongoose.Schema(
  {
    userId: {
      type: Number,
      required: true,
      index: true,
    },
    // Matches a key inside config/weapons.json
    weaponId: {
      type: String,
      required: true,
    },
    quantity: {
      type: Number,
      default: 1,
      min: 1,
    },
  },
  {
    timestamps: true,
  }
);

// Each user can only own one document per weapon type (quantity tracks count)
InventorySchema.index({ userId: 1, weaponId: 1 }, { unique: true });

/**
 * Add a weapon to a user's inventory (upserts quantity).
 * @param {number} userId  - Telegram user ID
 * @param {string} weaponId - Key in weapons.json
 */
InventorySchema.statics.addWeapon = async function (userId, weaponId) {
  return this.findOneAndUpdate(
    { userId, weaponId },
    { $inc: { quantity: 1 } },
    { upsert: true, new: true }
  );
};

/**
 * Remove one copy of a weapon from inventory.
 * Returns false if the user doesn't own it.
 */
InventorySchema.statics.removeWeapon = async function (userId, weaponId) {
  const item = await this.findOne({ userId, weaponId });
  if (!item) return false;

  if (item.quantity <= 1) {
    await item.deleteOne();
  } else {
    item.quantity -= 1;
    await item.save();
  }
  return true;
};

module.exports = mongoose.model('Inventory', InventorySchema);
