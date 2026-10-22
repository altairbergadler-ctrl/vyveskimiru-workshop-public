const fields = ['date', 'amount', 'account', 'orderNumber', 'counterparty', 'comment', 'category', 'description'];
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { name: 'OrderError', code, statusCode });
const comparable = value => value == null ? '' : typeof value === 'string' ? value.trim() : value;

// Finance owns its ledger and synchronizer. Never write its sheet cells directly.
export async function editFinancialRecord(prepared, { authUrl, cookie, fetchImpl = fetch }) {
  const endpoint = new URL('/api/transactions', authUrl).href;
  async function request(method, body) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        // Fetch sets Host from the URL; the internal Origin must match that target.
        method, headers: { Cookie: cookie, Origin: new URL(endpoint).origin,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        }, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(25_000), redirect: 'error',
      });
    } catch { throw fail('FINANCE_UNAVAILABLE', 'Финансовое приложение не ответило. Обновите данные перед повторной попыткой.', 503); }
    if (!response.ok) throw fail('FINANCE_UNAVAILABLE', 'Не удалось сохранить финансовую запись. Проверьте её в разделе «Финансы».', 502);
    try { return await response.json(); }
    catch { throw fail('FINANCE_UNAVAILABLE', 'Не удалось подтвердить финансовую запись. Обновите данные.', 502); }
  }
  if (!prepared?.syncId || !['income', 'expense'].includes(prepared.type)) {
    throw fail('FINANCE_NOT_SYNCED', 'Эта запись ещё не загружена в финансовое приложение. Проверьте её в таблице.');
  }
  const { transactions } = await request('GET');
  const matches = Array.isArray(transactions) ? transactions.filter(tx => tx.id === prepared.syncId) : [];
  if (matches.length !== 1) throw fail('FINANCE_NOT_SYNCED', 'Эта запись ещё не загружена в финансовое приложение. Проверьте её в таблице.');
  const current = matches[0];
  if (current.pending || current.type !== prepared.type || current.deletedAt ||
      fields.some(key => comparable(current[key]) !== comparable(prepared.current[key]))) {
    throw fail('FINANCE_STALE', 'Финансовая запись обновилась или ещё синхронизируется. Обновите доску и повторите правку.');
  }
  if (Object.keys(prepared.changes).some(key => !fields.includes(key))) throw fail('FINANCE_FIELDS', 'Некорректные поля финансовой записи.', 400);
  const input = { id: current.id, type: current.type };
  for (const key of fields) input[key] = key in prepared.changes ? prepared.changes[key] : current[key];
  const result = await request('PATCH', input);
  if (result.syncPending) throw fail('FINANCE_PENDING', 'Правка сохранена в финансах. Синхронизация с таблицей ещё идёт — обновите доску чуть позже.');
  if (result.transaction?.id !== current.id || result.transaction.type !== input.type ||
      fields.some(key => comparable(result.transaction[key]) !== comparable(input[key]))) {
    throw fail('FINANCE_UNCONFIRMED', 'Не удалось подтвердить сохранение финансовой записи. Обновите доску.');
  }
  return result.transaction;
}
