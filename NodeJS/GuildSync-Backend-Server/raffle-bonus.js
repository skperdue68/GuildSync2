export const DEFAULT_BONUS_TIERS = {
  biweekly: '120:20,120:10,72:5,24:0',
  monthly: '168:40,168:20,168:10,144:5,24:0'
};

export function selectBonusPolicy(policies, type, purchaseTimestamp) {
  let selected = null;
  for (const policy of policies) {
    if (policy.type === type && policy.effectiveFrom <= purchaseTimestamp &&
        (!selected || policy.effectiveFrom >= selected.effectiveFrom)) {
      selected = policy;
    }
  }
  return selected;
}

export function selectRafflePolicy(policies, type, salesEnd, now = Math.floor(Date.now() / 1000)) {
  return selectBonusPolicy(policies, type, Math.min(now, salesEnd - 1));
}

export function selectRaffleBonusSettings(policies, overrides, type, salesEnd, now = Math.floor(Date.now() / 1000)) {
  return overrides.find((item) => item.type === type && item.salesEnd === salesEnd) ||
    selectRafflePolicy(policies, type, salesEnd, now);
}

export function parseBonusTiers(value) {
  const parts = String(value || '').split(',');
  if (!parts.length || parts.length > 12) throw new Error('Bonus tiers require 1–12 periods.');
  const tiers = parts.map((part) => {
    const match = /^\s*(\d+)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!match) throw new Error('Bonus tiers must use hours:percent, separated by commas.');
    const hours = Number(match[1]);
    const percent = Number(match[2]);
    if (!Number.isSafeInteger(hours) || hours <= 0) throw new Error('Bonus tier hours must be positive hours.');
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('Bonus tier percent must be between 0 and 100.');
    return { hours, percent };
  });
  if (tiers.at(-1).percent !== 0) throw new Error('The final bonus tier must have zero bonus.');
  if (tiers.some((tier, index) => index && tier.percent > tiers[index - 1].percent)) {
    throw new Error('Bonus percentages must not increase over time.');
  }
  return tiers;
}

export function calculateRaffleBonus({ purchasedTickets, purchaseTimestamp, salesStart, salesEnd, tiers, enabled = true }) {
  const paid = Math.max(0, Math.floor(Number(purchasedTickets) || 0));
  const purchase = Number(purchaseTimestamp);
  if (!Number.isFinite(purchase) || purchase < salesStart || purchase >= salesEnd) {
    return { purchasedTickets: paid, bonusPercent: 0, bonusTickets: 0, totalTickets: 0 };
  }
  const totalHours = tiers.reduce((sum, tier) => sum + tier.hours, 0);
  const elapsed = Math.max(0, (purchase - (salesEnd - totalHours * 3600)) / 3600);
  const tier = selectBonusTier(tiers, elapsed);
  const percent = tier.percent;
  const bonusTickets = enabled ? Math.floor(paid * percent / 100) : 0;
  return { purchasedTickets: paid, bonusPercent: enabled ? percent : 0, bonusTickets, totalTickets: paid + bonusTickets,
    ...(enabled && percent > 0 ? { bonusExpiresAt: Math.min(salesEnd, salesEnd - totalHours * 3600 + tier.endsAtHours * 3600) } : {}) };
}

// Which bonus period a purchase falls in: the tiers run back to back from the start
// of the bonus window, so elapsed hours pick one by its cumulative boundaries.
function selectBonusTier(tiers, elapsedHours) {
  let start = 0;
  for (let index = 0; index < tiers.length; index += 1) {
    const end = start + tiers[index].hours;
    if (elapsedHours < end) {
      return { index, percent: tiers[index].percent, startsAtHours: start, endsAtHours: end };
    }
    start = end;
  }
  return { index: tiers.length, percent: 0, startsAtHours: start, endsAtHours: start };
}

// The next better period above the one a purchase landed in. Receipts quote its
// percentage and its deadline (the last moment that percentage was available) and
// say how many extra tickets it would have paid; isHighestTier is false when an even
// better percentage came before that deadline.
export function nextRaffleBonus({ purchasedTickets, purchaseTimestamp, salesStart, salesEnd, tiers, enabled = true }) {
  const paid = Math.max(0, Math.floor(Number(purchasedTickets) || 0));
  const none = { purchasedTickets: paid, bonusPercent: 0, bonusTickets: 0, expiresAt: null, isHighestTier: true };
  const purchase = Number(purchaseTimestamp);
  if (!enabled || !Number.isFinite(purchase) || purchase < salesStart || purchase >= salesEnd) return none;
  const totalHours = tiers.reduce((sum, tier) => sum + tier.hours, 0);
  const elapsed = Math.max(0, (purchase - (salesEnd - totalHours * 3600)) / 3600);
  const current = selectBonusTier(tiers, elapsed);
  if (current.index <= 0) return none;
  const target = tiers[current.index - 1];
  return {
    purchasedTickets: paid,
    bonusPercent: target.percent,
    bonusTickets: Math.floor(paid * target.percent / 100),
    expiresAt: Math.min(salesEnd, salesEnd - totalHours * 3600 + current.startsAtHours * 3600),
    isHighestTier: current.index === 1
  };
}
