// Technical command journal. Google remains the stock ledger.
export class WarehouseReceipts {
  constructor(db) {
    this.db = db;
    db.pragma('synchronous = FULL');
    db.exec(`CREATE TABLE IF NOT EXISTS warehouse_refills (
      request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, movement TEXT NOT NULL,
      target_row INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('submitted','confirmed','rejected')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  }
  get(id) { return this.db.prepare('SELECT * FROM warehouse_refills WHERE request_id=?').get(id); }
  pending() { return this.db.prepare("SELECT request_id, created_at FROM warehouse_refills WHERE state='submitted'").all(); }
  pendingIssues() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_commands'").get()) return [];
    return this.db.prepare("SELECT request_id FROM finance_commands WHERE state='submitted' AND json_type(input_json,'$.warehouseMovement')='object'").all();
  }
  submit(id, payload, movement, row) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      if (this.pending().length) throw new Error('WAREHOUSE_RECEIPT_BUSY');
      this.db.prepare('INSERT INTO warehouse_refills VALUES(?,?,?,?,?,?,?)')
        .run(id, JSON.stringify(payload), JSON.stringify(movement), row, 'submitted', now, now);
    }).immediate();
    return this.get(id);
  }
  settle(id, state) {
    if (!['confirmed', 'rejected'].includes(state)) throw new Error('INVALID_RECEIPT_STATE');
    this.db.prepare("UPDATE warehouse_refills SET state=?,updated_at=? WHERE request_id=? AND state='submitted'")
      .run(state, new Date().toISOString(), id);
  }
}
