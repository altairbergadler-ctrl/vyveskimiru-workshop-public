import { pathToFileURL } from 'node:url';
const internalBase = process.env.DIAGNOSTICS_INTERNAL_URL || 'http://127.0.0.1:3000';
const publicBase = process.env.DIAGNOSTICS_PUBLIC_URL || 'https://vm-app.ru';

async function readJson(url) {
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() };
}

async function readText(url) {
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.text() };
}

export function evaluateDiagnostics({ internalHealth, publicHealth, page, serviceWorker, manifest, now = Date.now() }) {
  const issues = [];
  const sync = internalHealth.body?.sync ?? {};
  if (internalHealth.body?.productionPending) issues.push('unconfirmed_production_command');
  if (internalHealth.status !== 200) issues.push(`internal_health_http_${internalHealth.status}`);
  if (publicHealth.status !== 200) issues.push(`public_health_http_${publicHealth.status}`);
  if (internalHealth.body?.version !== publicHealth.body?.version) issues.push('release_version_mismatch');
  if (internalHealth.body?.status && internalHealth.body.status !== 'ok') issues.push('workshop_degraded');
  for (const [name, check] of Object.entries(internalHealth.body?.checks || {})) if (!check.ok) issues.push(`module_${name}_failed`);
  if (!sync.configured) issues.push('sheet_sync_not_configured');
  if (Number(sync.pending || 0) > 0) issues.push(`sheet_sync_pending_${sync.pending}`);
  if (Number(sync.conflicts || 0) > 0) issues.push(`sheet_sync_conflicts_${sync.conflicts}`);
  if (Number(sync.invalidRows || 0) > 0) issues.push(`sheet_invalid_rows_${sync.invalidRows}`);
  if (sync.last_error) issues.push('sheet_sync_last_error');
  const lastSuccess = Date.parse(sync.last_success_at || '');
  if (!Number.isFinite(lastSuccess) || now - lastSuccess > 5 * 60_000) issues.push('sheet_sync_stale');
  if (page.status !== 200 || !page.body.includes('Финансы · Наружная реклама')) issues.push('pwa_shell_unavailable');
  if (serviceWorker.status !== 200 || !serviceWorker.body.includes('finance-vps-')) issues.push('pwa_service_worker_unavailable');
  if (manifest.status !== 200 || !manifest.body.includes('Финансы')) issues.push('pwa_manifest_unavailable');
  return {
    ok: issues.length === 0,
    checkedAt: new Date(now).toISOString(),
    version: internalHealth.body?.version ?? null,
    sync: {
      configured: Boolean(sync.configured),
      pending: Number(sync.pending || 0),
      conflicts: Number(sync.conflicts || 0),
      conflictHistory: Number(sync.conflictHistory || 0),
      invalidRows: Number(sync.invalidRows || 0),
      lastSuccessAt: sync.last_success_at || null,
      hasLastError: Boolean(sync.last_error),
    },
    pwa: {
      publicHealthStatus: publicHealth.status,
      pageStatus: page.status,
      serviceWorkerStatus: serviceWorker.status,
      manifestStatus: manifest.status,
    },
    issues,
  };
}

export async function runLiveDiagnostics() {
  const [internalHealth, publicHealth, page, serviceWorker, manifest] = await Promise.all([
    readJson(`${internalBase}/api/health`),
    readJson(`${publicBase}/api/health`),
    readText(`${publicBase}/`),
    readText(`${publicBase}/sw.js`),
    readText(`${publicBase}/manifest.webmanifest`),
  ]);
  return evaluateDiagnostics({ internalHealth, publicHealth, page, serviceWorker, manifest });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runLiveDiagnostics();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      checkedAt: new Date().toISOString(),
      issues: ['diagnostics_unavailable'],
      error: error?.name === 'TimeoutError' ? 'timeout' : 'request_failed',
    }, null, 2));
    process.exitCode = 1;
  }
}
