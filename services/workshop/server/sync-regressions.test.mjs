import test from 'node:test';

test('concurrent finance edit is eventually sent; Google deletion of an app expense is detected', async () => {
  await import('../docs/audit/sync-reproductions.mjs');
});
