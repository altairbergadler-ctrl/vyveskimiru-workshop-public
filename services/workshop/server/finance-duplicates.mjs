import crypto from 'node:crypto';
import { isMeasurement } from './finance-contract.mjs';

const DAY = 86_400_000;
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ');

// These are warning candidates, never proof that a legitimate operation is a duplicate.
// Business dates also catch backdated entry; neither ledger values nor formulas change.
export function duplicateWarning(wanted, records, commandFingerprint) {
  const candidates = records.filter(record => {
    if (record.type !== wanted.type || record.amount !== wanted.amount) return false;
    const days = Math.abs(Date.parse(record.date) - Date.parse(wanted.date)) / DAY;
    if (!Number.isFinite(days) || days > 3) return false;
    if (wanted.type === 'income') {
      if (isMeasurement(wanted)) return isMeasurement(record) && normalize(record.account) === normalize(wanted.account);
      return !isMeasurement(record) && record.orderNumber === wanted.orderNumber;
    }
    if (normalize(record.category) !== normalize(wanted.category)) return false;
    if (record.counterparty && wanted.counterparty) return normalize(record.counterparty) === normalize(wanted.counterparty);
    return normalize(record.account) === normalize(wanted.account) ||
      normalize(record.description) === normalize(wanted.description) ||
      Boolean(wanted.orderNumber && record.orderNumber === wanted.orderNumber);
  }).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  if (!candidates.length) return null;
  // Acknowledgement is bound to this command AND the complete, current candidate set.
  // An intervening write/edit requires a new warning, even when only five rows are shown.
  const confirmation = crypto.createHash('sha256').update(JSON.stringify([
    commandFingerprint, candidates.map(record => [record.id, record.sheetHash]),
  ])).digest('hex');
  return {
    confirmation,
    total: candidates.length,
    matches: candidates.slice(0, 5).map(({ id, date, amount, category, description, account, orderNumber, counterparty, comment }) =>
      ({ id, date, amount, category, description, account, orderNumber, counterparty, comment })),
  };
}
