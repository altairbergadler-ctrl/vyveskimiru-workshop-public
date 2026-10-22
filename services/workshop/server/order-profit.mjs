// Temporary owner-approved margin, before advertising. Keep source costs/formulas
// untouched so the future cost-accounting release can replace this policy once.
export const PROFIT_BASIS = 'estimated_margin_50';
export function estimatedOrderProfit(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const minor = Math.round(amount * 100);
  if (!Number.isSafeInteger(minor) || Math.abs(minor / 100 - amount) > 0.000001)
    return null;
  // Round half a kopeck away from zero, including a negative adjustment.
  return (Math.sign(minor) * Math.round(Math.abs(minor) / 2)) / 100;
}
