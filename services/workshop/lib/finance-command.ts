// Keep the same identity while retrying an unchanged form after a lost response.
// Only an unconfirmed command is kept, within this browser tab's session.
const pendingCommands = new Map<string, { signature: string; id: string }>();
export function financeCommandId(operation: string, payload: unknown): string {
  const key = `finance-command:${operation}`;
  const signature = JSON.stringify(payload);
  const inMemory = pendingCommands.get(key);
  if (inMemory?.signature === signature) return inMemory.id;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null') as { signature: string; id: string } | null;
    if (saved?.signature === signature) return saved.id;
  } catch { /* Browser storage can be unavailable. */ }
  const id = crypto.randomUUID();
  pendingCommands.set(key, { id, signature });
  try { sessionStorage.setItem(key, JSON.stringify({ id, signature })); } catch { /* Memory/network behavior remains available. */ }
  return id;
}

export function confirmFinanceCommand(operation: string) {
  pendingCommands.delete(`finance-command:${operation}`);
  try { sessionStorage.removeItem(`finance-command:${operation}`); } catch { /* Storage is optional. */ }
}
