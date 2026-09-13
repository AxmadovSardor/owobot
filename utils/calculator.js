/**
 * calculator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, data-driven stat calculation utilities.
 * All formulas read from the JSON config files so they stay in sync with
 * animals.json / weapons.json without touching core logic.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const animalsConfig = require('../config/animals.json');
const weaponsConfig = require('../config/weapons.json');

// ─── Config Lookups ──────────────────────────────────────────────────────────

/**
 * Retrieve an animal definition from animals.json by its id.
 * @param {string} animalId
 * @returns {{ id, name, emoji, rarity } | undefined}
 */
function getAnimalDef(animalId) {
  return animalsConfig.list.find((a) => a.id === animalId);
}

/**
 * Retrieve a rarity definition from animals.json by rarity key.
 * @param {string} rarity e.g. "common"
 * @returns {{ dropRate, basePower, color, label } | undefined}
 */
function getRarityDef(rarity) {
  return animalsConfig.rarities[rarity];
}

/**
 * Retrieve a weapon definition from weapons.json by its key.
 * @param {string} weaponId
 * @returns {{ name, emoji, type, value, cost } | undefined}
 */
function getWeaponDef(weaponId) {
  if (!weaponId) return null;
  return weaponsConfig[weaponId] || null;
}

// ─── Core Formulas ───────────────────────────────────────────────────────────

/**
 * Calculate the base power of an animal at a given level.
 *
 * Formula:  Power = basePower × [1 + (level − 1) × 0.10]
 *
 * @param {string} animalId  - matches animals.json list[].id
 * @param {number} level     - current level (1–50)
 * @returns {number} computed power (floor)
 */
function calcAnimalPower(animalId, level) {
  const animalDef = getAnimalDef(animalId);
  if (!animalDef) throw new Error(`Unknown animal: ${animalId}`);

  const rarityDef = getRarityDef(animalDef.rarity);
  if (!rarityDef) throw new Error(`Unknown rarity: ${animalDef.rarity}`);

  const power = rarityDef.basePower * (1 + (level - 1) * 0.1);
  return Math.floor(power);
}

/**
 * Calculate a single animal's effective combat power including its weapon.
 *
 * Flat weapons  : effectivePower = animalPower + weapon.value
 * Multiplier    : stored and applied at the team level (see calcTeamPower)
 *
 * @param {string} animalId
 * @param {number} level
 * @param {string|null} equippedWeapon - weaponId or null
 * @returns {{ rawPower: number, flatBonus: number, multiplierBonus: number, effectivePower: number }}
 */
function calcEffectiveAnimalPower(animalId, level, equippedWeapon = null) {
  const rawPower = calcAnimalPower(animalId, level);
  let flatBonus = 0;
  let multiplierBonus = 0;

  if (equippedWeapon) {
    const weapon = getWeaponDef(equippedWeapon);
    if (weapon) {
      if (weapon.type === 'flat_atk') flatBonus = weapon.value;
      if (weapon.type === 'multiplier') multiplierBonus = weapon.value;
    }
  }

  // Multiplier is applied at team level; effective here only adds flat
  const effectivePower = rawPower + flatBonus;
  return { rawPower, flatBonus, multiplierBonus, effectivePower };
}

/**
 * Calculate total team power for an array of UserAnimal documents.
 *
 * Formula:
 *   teamPower = Σ(animalPower + flatWeaponBonus) × (1 + Σ multiplierBonuses)
 *
 * @param {Array<{ animalId: string, level: number, equippedWeapon: string|null }>} teamAnimals
 * @returns {{ totalPower: number, breakdown: Array }}
 */
function calcTeamPower(teamAnimals) {
  let sumBase = 0;
  let sumMultipliers = 0;
  const breakdown = [];

  for (const animal of teamAnimals) {
    const { rawPower, flatBonus, multiplierBonus, effectivePower } =
      calcEffectiveAnimalPower(animal.animalId, animal.level, animal.equippedWeapon);

    sumBase += effectivePower;
    sumMultipliers += multiplierBonus;

    const animalDef = getAnimalDef(animal.animalId);
    breakdown.push({
      animalId: animal.animalId,
      name: animalDef?.name || animal.animalId,
      emoji: animalDef?.emoji || '❓',
      level: animal.level,
      rawPower,
      flatBonus,
      multiplierBonus,
      contribution: effectivePower,
    });
  }

  const totalPower = Math.floor(sumBase * (1 + sumMultipliers));

  return { totalPower, sumMultipliers, breakdown };
}

/**
 * Calculate the coin cost to level-up an animal from its current level.
 *
 * Formula:  cost = baseLevelUpCost × (currentLevel ^ 1.5)
 *
 * @param {number} currentLevel
 * @returns {number} cost in coins (ceil)
 */
function calcLevelUpCost(currentLevel) {
  const baseCost = animalsConfig.levelUpBaseCost ?? 100;
  return Math.ceil(baseCost * Math.pow(currentLevel, 1.5));
}

/**
 * Build a visual level progress bar.
 *
 * @param {number} level    - current level
 * @param {number} maxLevel - maximum level (default 50)
 * @param {number} width    - total bar width in characters (default 10)
 * @returns {string}  e.g.  "[████░░░░░░] Lvl 12/50"
 */
function buildLevelBar(level, maxLevel = 50, width = 10) {
  const filled = Math.round((level / maxLevel) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}] Lvl ${level}/${maxLevel}`;
}

/**
 * Generate an NPC opponent power for /battle command.
 * Scales with the player's best team power to keep fights interesting.
 *
 * @param {number} playerPower
 * @returns {number}
 */
function generateNpcPower(playerPower) {
  // NPC is between 80–120% of player power with some randomness
  const variance = 0.4; // ±40%
  const factor = 0.8 + Math.random() * variance;
  return Math.floor(playerPower * factor) || 1;
}

// ─── Hunt Helper ─────────────────────────────────────────────────────────────

/**
 * Roll a random animal according to rarity drop rates in animals.json.
 * Uses weighted probability.
 *
 * @returns {{ id, name, emoji, rarity, basePower }}
 */
function rollRandomAnimal() {
  const roll = Math.random(); // 0 to 1
  let cumulative = 0;

  // Sort animals by their rarity dropRate descending so common animals are
  // checked first (performance optimization – early exit on common rolls)
  const rarityOrder = ['common', 'rare', 'epic', 'legendary', 'mythic'];

  for (const rarityKey of rarityOrder) {
    cumulative += animalsConfig.rarities[rarityKey].dropRate;
    if (roll <= cumulative) {
      // Pick a random animal of this rarity
      const pool = animalsConfig.list.filter((a) => a.rarity === rarityKey);
      const picked = pool[Math.floor(Math.random() * pool.length)];
      return {
        ...picked,
        basePower: animalsConfig.rarities[rarityKey].basePower,
        rarityDef: animalsConfig.rarities[rarityKey],
      };
    }
  }

  // Fallback: return first common animal (should never happen)
  const fallback = animalsConfig.list[0];
  return {
    ...fallback,
    basePower: animalsConfig.rarities['common'].basePower,
    rarityDef: animalsConfig.rarities['common'],
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  getAnimalDef,
  getRarityDef,
  getWeaponDef,
  calcAnimalPower,
  calcEffectiveAnimalPower,
  calcTeamPower,
  calcLevelUpCost,
  buildLevelBar,
  generateNpcPower,
  rollRandomAnimal,
};
