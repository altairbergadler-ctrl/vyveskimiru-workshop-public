import { MEASUREMENT_CATEGORY, hasMeasurementMarker } from './finance-contract.mjs';

export function validTransaction(input) {
  const type = input.type === 'income' || input.type === 'expense' ? input.type : null;
  const amount = Number(input.amount);
  const date = String(input.date ?? '');
  const orderNumber = input.orderNumber ? String(input.orderNumber).trim() : null;
  const categoryInput = String(input.category ?? '').trim();
  const descriptionInput = String(input.description ?? '').trim();
  const account = String(input.account ?? '').trim();
  const category = type === 'income' ? (categoryInput || 'Оплата по заказу') : categoryInput;
  const measurement = type === 'income' && category === MEASUREMENT_CATEGORY;
  const description = measurement ? MEASUREMENT_CATEGORY : type === 'income'
    ? (descriptionInput || `Оплата по заказу №${orderNumber ?? ''}`)
    : descriptionInput;
  if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !account ||
      (type === 'income' && !measurement && !orderNumber) ||
      (measurement && (orderNumber || String(input.counterparty ?? '').trim())) ||
      (type === 'income' && !measurement && hasMeasurementMarker(String(input.comment ?? '').trim())) ||
      (type === 'expense' && (!category || !description)) ||
      !Number.isInteger(amount) || amount <= 0) return null;
  const cashInRegister = type === 'income';
  return {
    type, date, category, description, amount, account, cashInRegister,
    orderNumber,
    counterparty: input.counterparty ? String(input.counterparty).trim() : null,
    comment: input.comment ? String(input.comment).trim() : null,
  };
}
