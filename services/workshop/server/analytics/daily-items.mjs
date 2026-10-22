import crypto from 'node:crypto';
import { AvitoError } from '../avito.mjs';

// Uses the existing deep-import queue and item snapshots. No second scheduler,
// provider client, units contract or business writer. Missing item rows stay unknown.
export function dailyItemsView(deep, input, itemId = null) {
  const period = deep.period(input),
    db = deep.db(),
    account = deep.base.namespace();
  const snapshots = db
    .prepare(`SELECT date_from,loaded_at,payload FROM ad_snapshots
    WHERE rowid IN (SELECT MAX(rowid) FROM ad_snapshots WHERE account=? AND kind='items'
      AND date_from=date_to AND date_from>=? AND date_from<=? GROUP BY date_from)`)
    .all(account, period.dateFrom, period.dateTo);
  const stored = new Map(snapshots.map((s) => [s.date_from, s]));
  const expected =
    (Date.parse(period.dateTo) - Date.parse(period.dateFrom)) / 86400000 + 1;
  const days = Array.from({ length: expected }, (_, i) => {
    const date = new Date(Date.parse(period.dateFrom) + i * 86400000)
      .toISOString()
      .slice(0, 10);
    const snapshot = stored.get(date),
      report = snapshot ? JSON.parse(snapshot.payload) : null;
    const groups = report?.groups;
    const complete = Boolean(
      report?.grouping === 'item' &&
      report.dateFrom === date &&
      report.dateTo === date &&
      report.pagination?.complete &&
      report.pagination.offset === 0 &&
      report.pagination.nextOffset === null &&
      Array.isArray(groups) &&
      // An explicitly complete total=0 report is a received day, not a gap.
      // Missing per-item rows below still remain unknown rather than zero.
      groups.length === report.pagination.total &&
      new Set(groups.map((g) => g.sourceGroupId)).size === groups.length &&
      groups.every((g) => Number.isSafeInteger(g.metrics?.spending)),
    );
    const item = itemId
      ? groups?.find((g) => g.sourceGroupId === itemId)
      : null;
    return {
      date,
      complete,
      loadedAt: snapshot?.loaded_at ?? null,
      // Never derive daily item spend by distributing a monthly total or contacts.
      spend:
        complete && item?.metrics?.spending != null
          ? item.metrics.spending / 100
          : null,
      views: complete ? (item?.metrics?.views ?? null) : null,
      contacts: complete ? (item?.metrics?.contacts ?? null) : null,
    };
  });
  const run = db
    .prepare(`SELECT r.* FROM ad_runs r WHERE r.account=? AND r.date_from=? AND r.date_to=?
    AND EXISTS(SELECT 1 FROM ad_steps s WHERE s.run_id=r.id AND s.kind='daily_items') ORDER BY r.created_at DESC LIMIT 1`)
    .get(account, period.dateFrom, period.dateTo);
  const counts = run
    ? db
        .prepare(`SELECT COUNT(*) total,SUM(state='done') done,SUM(state='failed') failed
    FROM ad_steps WHERE run_id=?`)
        .get(run.id)
    : null;
  return {
    expectedDays: expected,
    completeDays: days.filter((d) => d.complete).length,
    sourceTimezone: 'unverified',
    days,
    job: run ? { id: run.id, state: run.state, ...counts } : null,
  };
}

export function startDailyItems(deep, input) {
  if (
    !input ||
    Object.keys(input).some(
      (k) => !['dateFrom', 'dateTo', 'refresh'].includes(k),
    ) ||
    (input.refresh !== undefined && typeof input.refresh !== 'boolean')
  )
    throw new AvitoError('invalid', 400);
  if (!deep.client.status().enabled) throw new AvitoError('disabled', 409);
  const period = deep.period({
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
  });
  const db = deep.db(),
    account = deep.base.namespace();
  return db.transaction(() => {
    const view = dailyItemsView(deep, {
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
    });
    if (view.job && ['queued', 'running'].includes(view.job.state))
      return { jobId: view.job.id, existing: true };
    const todo = view.days.filter(
      (d) =>
        input.refresh ||
        !d.complete ||
        d.date === new Date(deep.now()).toISOString().slice(0, 10),
    );
    if (!todo.length) return { cached: true, days: view.completeDays };
    if (
      db
        .prepare(
          "SELECT count(*) n FROM ad_runs WHERE account=? AND state IN ('queued','running')",
        )
        .get(account).n >= 3
    )
      throw new AvitoError('rate_limit', 429, 65);
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO ad_runs(id,account,date_from,date_to,created_at,state,automatic) VALUES(?,?,?,?,?,'queued',0)",
    ).run(
      id,
      account,
      period.dateFrom,
      period.dateTo,
      new Date(deep.now()).toISOString(),
    );
    for (const day of todo)
      deep.addStep(id, 'daily_items', {
        dateFrom: day.date,
        dateTo: day.date,
        offset: 0,
      });
    deep.wake(0);
    return { jobId: id, days: todo.length };
  })();
}

export function cancelDailyItems(deep, input) {
  if (
    !input ||
    Object.keys(input).some((k) => k !== 'jobId') ||
    typeof input.jobId !== 'string'
  )
    throw new AvitoError('invalid', 400);
  const db = deep.db();
  return db.transaction(() => {
    const run = db
      .prepare(`SELECT r.id FROM ad_runs r WHERE r.id=? AND r.account=? AND
      EXISTS(SELECT 1 FROM ad_steps s WHERE s.run_id=r.id AND s.kind='daily_items')`)
      .get(input.jobId, deep.base.namespace());
    if (!run) throw new AvitoError('invalid', 404);
    db.prepare(
      "UPDATE ad_runs SET state='cancelled',finished_at=? WHERE id=? AND state IN ('queued','running')",
    ).run(new Date(deep.now()).toISOString(), run.id);
    db.prepare(
      "UPDATE ad_steps SET state='cancelled' WHERE run_id=? AND state IN ('queued','running')",
    ).run(run.id);
    return { cancelled: true };
  })();
}
