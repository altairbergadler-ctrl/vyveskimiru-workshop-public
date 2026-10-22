import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultState,
  hybridDefaults,
  hybridRows,
  hybridSlice,
  hybridLeadRows,
  hybridScope,
} from '../prototypes/analytics/model.mjs';
const state = {
  ...defaultState,
  ...hybridDefaults,
  concept: 'hybrid',
  source: 'all',
};
test('Hybrid groups campaigns under their source and deduplicates shared payments at each level', () => {
  const rows = hybridRows({ ...state, hGroup: 'campaign' });
  const campaign = rows.find(
    (r) => r.key === 'campaign:avito:Вывески / локальный бизнес',
  );
  assert.equal(campaign.view.rows.length, 5);
  assert.equal(campaign.view.connected.length, 2);
  assert.equal(campaign.view.paidTotal, 12000000);
  assert.equal(hybridSlice(state).paidTotal, 20000000);
  const collapsed = hybridRows({
    ...state,
    hGroup: 'campaign',
    hClosed: ['source:avito'],
  });
  assert.ok(!collapsed.some((r) => r.key === 'ad:a1'));
  assert.ok(collapsed.some((r) => r.key === 'ad:d1'));
});
test('Hybrid sorts siblings, keeps unknown values last in both directions, and preserves parent placement', () => {
  for (const hDir of ['asc', 'desc']) {
    const rows = hybridRows({ ...state, hDir });
    const sources = rows.filter((r) => r.kind === 'source');
    assert.ok(
      sources.findIndex((r) => r.key === 'source:direct') >
        sources.findIndex((r) => r.key === 'source:avito'),
    );
    const parent = rows.findIndex((r) => r.key === 'source:avito');
    assert.equal(rows[parent + 1].key, hDir === 'asc' ? 'ad:a3' : 'ad:a1');
  }
});
test('Hybrid search changes list, aggregate and selected funnel using the same matching ads', () => {
  const filtered = { ...state, hSearch: 'буквы' };
  assert.deepEqual(
    hybridRows(filtered).map((r) => r.key),
    ['source:avito', 'ad:a2'],
  );
  assert.equal(hybridSlice(filtered).rows.length, 3);
  assert.equal(hybridSlice(filtered, 'source:avito').rows.length, 3);
  assert.equal(
    hybridSlice({ ...state, hSearch: 'несуществующее' }).metrics.spending,
    null,
  );
  assert.equal(hybridRows({ ...state, hSearch: 'несуществующее' }).length, 0);
});
test('Hybrid funnel keeps one unit, handles split orders, and excludes disputed money', () => {
  const direct = hybridSlice(state, 'source:direct');
  assert.equal(direct.connected.length, 2);
  assert.equal(hybridLeadRows(direct, 'ordered').length, 1);
  assert.equal(hybridLeadRows(direct, 'paid').length, 1);
  const unknown = hybridSlice(state, 'source:unknown');
  assert.equal(unknown.rows.length, 1);
  assert.equal(hybridLeadRows(unknown, 'paid').length, 0);
  assert.equal(unknown.paidTotal, 0);
  const ads = hybridRows({ ...state, hGroup: 'ads' });
  assert.ok(ads.some((r) => r.key === 'source:unknown'));
  assert.equal(hybridScope('campaign:other:any'), null);
});
