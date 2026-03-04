import {
  clearAuthState,
  completePkceCallback,
  getAccessToken,
  getCallbackPayload,
  getTokenInfo,
  hasCallbackPayload,
  saveAuthSettings,
  startPkceLogin,
} from './frontend-auth.js';
import { AUTH_BOOTSTRAP_SETTINGS } from './auth-bootstrap.js';
import { APP_BUILD_ID } from './frontend-build.js';
import {
  CONFIG_DOCUMENT_NAME,
  CONFIG_WORKSPACE_NAME,
  loadCachedConfigPointer,
  loadFrontendConfig,
} from './frontend-config-resolver.js';
import { runBotflowCostAggregate } from './frontend-botflow.js';
import { runSmsCost } from './frontend-sms.js';
import {
  DEFAULT_RETENTION_DAYS,
  clearAllRuns,
  ensureRetentionPolicy,
  getRun,
  listRuns,
  saveRun,
} from './local-run-store.js';

const buildVersion = document.getElementById('build-version');
const authenticatedUser = document.getElementById('authenticated-user');
const signOutButton = document.getElementById('sign-out-button');
const authStatus = document.getElementById('auth-status');
const pipelineForm = document.getElementById('pipeline-form');
const pipelineNameSelect = document.getElementById('pipeline-name');
const pipelineIntervalPresetSelect = document.getElementById('pipeline-interval-preset');
const pipelineIntervalInput = document.getElementById('pipeline-interval');
const pipelineStatus = document.getElementById('pipeline-status');
const cleanupRunsButton = document.getElementById('cleanup-runs-button');
const clearRunsButton = document.getElementById('clear-runs-button');
const runsStatus = document.getElementById('runs-status');
const runsBody = document.getElementById('runs-body');
const reportMeta = document.getElementById('report-meta');
const downloadReportButton = document.getElementById('download-report-button');
const reportStructured = document.getElementById('report-structured');
const rawReportDetails = document.getElementById('raw-report-details');
const reportOutput = document.getElementById('report-output');

let resolvedConfig = null;
let currentReportFilename = null;

const INTERVAL_PRESET_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  thisweek: 'This Week',
  lastweek: 'Last Week',
  thismonth: 'This Month',
  lastmonth: 'Last Month',
};

function setStatus(element, message, type = '') {
  if (!element) {
    return;
  }
  element.textContent = message;
  element.className = `status ${type}`.trim();
}

function formatTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatDuration(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function buildReportFilename({ pipelineName, status, startedAt }) {
  const pipelinePart = sanitizeFilenamePart(pipelineName || 'report');
  const statusPart = sanitizeFilenamePart(status || 'completed');
  const timestampPart = String(startedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  return `${pipelinePart}_${statusPart}_${timestampPart}.txt`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStructuredTable(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<p class="small">No data to display.</p>';
  }

  const headers = Object.keys(rows[0]);
  const headerHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  const bodyHtml = rows.map((row) => (
    `<tr>${headers.map((header) => `<td>${escapeHtml(row[header])}</td>`).join('')}</tr>`
  )).join('');

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>${headerHtml}</tr>
        </thead>
        <tbody>
          ${bodyHtml}
        </tbody>
      </table>
    </div>
  `;
}

function renderReportDetailsSection(title, rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    return '';
  }

  const openAttr = options.open ? ' open' : '';
  return `
    <details class="report-details"${openAttr}>
      <summary>${escapeHtml(title)}</summary>
      ${renderStructuredTable(rows)}
    </details>
  `;
}

function renderBotflowStructuredReport(reportData) {
  if (!reportData || reportData.type !== 'botflowCost' || !reportStructured) {
    return false;
  }

  const highlightsHtml = Array.isArray(reportData.highlights)
    ? reportData.highlights.map((item) => `
        <div class="kpi-card">
          <p class="kpi-label">${escapeHtml(item.label)}</p>
          <p class="kpi-value">${escapeHtml(item.value)}</p>
        </div>
      `).join('')
    : '';

  const html = `
    ${highlightsHtml ? `<section class="kpi-grid">${highlightsHtml}</section>` : ''}
    ${renderReportDetailsSection(reportData.voice?.divisionTitle, reportData.voice?.divisionRows || [], { open: true })}
    ${renderReportDetailsSection(reportData.digital?.divisionTitle, reportData.digital?.divisionRows || [], { open: true })}
  `;

  reportStructured.innerHTML = html;
  return true;
}

function clearStructuredReport() {
  if (reportStructured) {
    reportStructured.innerHTML = '';
  }
}

function setReportView({ meta = '', content = '', filename = null, reportData = null, rawExpanded = true }) {
  reportMeta.textContent = meta;
  reportOutput.textContent = content;
  currentReportFilename = filename;

  const hasStructuredReport = renderBotflowStructuredReport(reportData);
  if (!hasStructuredReport) {
    clearStructuredReport();
  }

  if (rawReportDetails) {
    rawReportDetails.open = rawExpanded;
  }

  if (downloadReportButton) {
    downloadReportButton.disabled = !content;
  }
}

function getAuthSettings() {
  return saveAuthSettings({
    ...AUTH_BOOTSTRAP_SETTINGS,
    redirectUri: window.location.href.split('?')[0],
  });
}

function syncIntervalInputVisibility() {
  if (!pipelineIntervalPresetSelect || !pipelineIntervalInput) {
    return;
  }

  const isCustom = pipelineIntervalPresetSelect.value === 'custom';
  pipelineIntervalInput.classList.toggle('hidden', !isCustom);
  pipelineIntervalInput.required = isCustom;

  if (!isCustom) {
    pipelineIntervalInput.value = '';
  }
}

function getSelectedIntervalConfig() {
  const preset = pipelineIntervalPresetSelect?.value || 'yesterday';
  if (preset !== 'custom') {
    return {
      intervalInput: preset,
      humanReadableInterval: INTERVAL_PRESET_LABELS[preset] || preset,
    };
  }

  const customValue = pipelineIntervalInput?.value.trim() || '';
  if (!customValue) {
    throw new Error('Custom time frame is required.');
  }

  return {
    intervalInput: customValue,
    humanReadableInterval: customValue,
  };
}

async function loadAuthenticatedUser() {
  if (!authenticatedUser) {
    return;
  }

  const accessToken = getAccessToken();
  if (!accessToken) {
    authenticatedUser.textContent = '';
    return;
  }

  const { environment } = getAuthSettings();

  try {
    const response = await fetch(`https://api.${environment}/api/v2/users/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload?.message || `Failed to load user profile (${response.status}).`);
    }

    const name = payload?.name
      || [payload?.firstName, payload?.lastName].filter(Boolean).join(' ')
      || payload?.email
      || payload?.username
      || '';

    authenticatedUser.textContent = name ? `Signed in as ${name}` : '';
    console.info('[Portal User]', {
      id: payload?.id || null,
      name: payload?.name || name || null,
      email: payload?.email || null,
    });
  } catch (error) {
    authenticatedUser.textContent = '';
    console.warn('[Portal User] Failed to load authenticated user.', error);
  }
}

function logSystemStatus(reason) {
  const tokenInfo = getTokenInfo();
  const callbackPayload = getCallbackPayload();
  const cachedPointer = loadCachedConfigPointer();
  const safeTokenInfo = tokenInfo ? {
    tokenType: tokenInfo.tokenType,
    scope: tokenInfo.scope,
    expiresIn: tokenInfo.expiresIn,
    receivedAt: tokenInfo.receivedAt,
  } : null;
  const safeCallbackPayload = hasCallbackPayload() ? {
    hasCode: Boolean(callbackPayload.code),
    state: callbackPayload.state,
    error: callbackPayload.error,
    errorDescription: callbackPayload.errorDescription,
  } : null;

  console.info('[Portal Status]', {
    reason,
    buildId: APP_BUILD_ID,
    authenticated: Boolean(tokenInfo?.accessToken),
    tokenInfo: safeTokenInfo,
    hasCallbackPayload: hasCallbackPayload(),
    callbackPayload: safeCallbackPayload,
    configWorkspace: CONFIG_WORKSPACE_NAME,
    configDocument: CONFIG_DOCUMENT_NAME,
    cachedConfigPointer: cachedPointer,
    localRetentionDays: DEFAULT_RETENTION_DAYS,
  });
}

function renderRunsTable(runs) {
  runsBody.innerHTML = '';

  if (!runs.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="7">No local runs saved yet.</td>';
    runsBody.appendChild(tr);
    return;
  }

  runs.forEach((run) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${run.id}</td>
      <td>${run.pipelineName}</td>
      <td><span class="status-pill status-${String(run.status).toLowerCase()}">${run.status}</span></td>
      <td>${run.humanReadableInterval || run.providedInterval || '-'}</td>
      <td>${formatTime(run.startedAt)}</td>
      <td>${formatDuration(run.durationMs)}</td>
      <td><button type="button" class="action-btn" data-run-id="${run.id}">View</button></td>
    `;
    runsBody.appendChild(tr);
  });
}

async function refreshRuns() {
  const runs = await listRuns({ limit: 30 });
  renderRunsTable(runs);
  return runs;
}

async function viewRun(runId) {
  const run = await getRun(runId);
  if (!run) {
    setReportView({
      content: 'Run not found.',
      rawExpanded: true,
    });
    return;
  }

  setReportView({
    meta: `${run.pipelineName} • ${run.status} • ${formatTime(run.startedAt)} • ${run.humanReadableInterval || run.providedInterval || '-'}`,
    content: run.reportContent || 'No cached report content.',
    filename: run.reportFilename || buildReportFilename(run),
    reportData: run.reportData,
    rawExpanded: !run.reportData,
  });
}

async function resolveConfig() {
  const accessToken = getAccessToken();
  const { environment } = getAuthSettings();

  if (!accessToken) {
    throw new Error('Sign in first before resolving config.');
  }

  resolvedConfig = await loadFrontendConfig({ environment, accessToken });
  const configDetails = {
    source: resolvedConfig.source,
    pointer: resolvedConfig.pointer,
    config: resolvedConfig.config,
  };
  console.info('[Portal Config]', configDetails);
  logSystemStatus('config-resolved');
  return resolvedConfig;
}

function clearResolvedConfig() {
  resolvedConfig = null;
}

async function runPipeline() {
  const accessToken = getAccessToken();
  const { environment } = getAuthSettings();
  if (!accessToken) {
    throw new Error('Sign in first before running a pipeline.');
  }

  const pipelineName = pipelineNameSelect.value;
  const selectedInterval = getSelectedIntervalConfig();
  const intervalInput = selectedInterval.intervalInput;

  const runId = window.crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const pendingRun = await saveRun({
    id: runId,
    pipelineName,
    status: 'running',
    providedInterval: intervalInput,
    humanReadableInterval: selectedInterval.humanReadableInterval,
    startedAt,
    durationMs: null,
    reportFilename: null,
    reportContent: `Running ${pipelineName} in the browser...`,
    reportData: null,
    summary: null,
    metadata: {
      source: 'browser-shell',
      mode: 'pending',
    },
  });

  await refreshRuns();
  await viewRun(pendingRun.id);
  setStatus(pipelineStatus, `Running ${pipelineName} in the browser...`, '');

  try {
    let result;

    if (pipelineName === 'botflowCost') {
      result = await runBotflowCostAggregate({
        environment,
        accessToken,
        intervalInput,
      });
    } else if (pipelineName === 'smsCost') {
      if (!resolvedConfig) {
        await resolveConfig();
      }

      result = await runSmsCost({
        environment,
        accessToken,
        intervalInput,
        frontendConfig: resolvedConfig?.config || null,
      });
    } else {
      throw new Error(`Unsupported frontend pipeline "${pipelineName}".`);
    }

    const completedRun = await saveRun({
      id: runId,
      pipelineName,
      status: 'completed',
      providedInterval: intervalInput,
      humanReadableInterval: result.humanReadableInterval,
      startedAt,
      durationMs: Date.now() - new Date(startedAt).getTime(),
      reportFilename: buildReportFilename({
        pipelineName,
        status: 'completed',
        startedAt,
      }),
      reportContent: result.reportContent,
      reportData: result.reportData || null,
      summary: result.summary,
      metadata: {
        source: 'browser-shell',
        mode: result.billingMode || 'frontend',
      },
    });

    await refreshRuns();
    await viewRun(completedRun.id);
    const modeSuffix = result.billingMode ? ` in ${result.billingMode} mode` : '';
    setStatus(pipelineStatus, `${pipelineName} completed${modeSuffix} and was saved locally.`, 'ok');
    setStatus(runsStatus, `Saved ${pipelineName} run ${completedRun.id}.`, 'ok');
  } catch (error) {
    const failedRun = await saveRun({
      id: runId,
      pipelineName,
      status: 'failed',
      providedInterval: intervalInput,
      humanReadableInterval: intervalInput,
      startedAt,
      durationMs: Date.now() - new Date(startedAt).getTime(),
      reportFilename: buildReportFilename({
        pipelineName,
        status: 'failed',
        startedAt,
      }),
      reportContent: `Pipeline failed:\n${error.message}`,
      reportData: null,
      summary: null,
      metadata: {
        source: 'browser-shell',
        mode: 'failed',
      },
    });

    await refreshRuns();
    await viewRun(failedRun.id);
    setStatus(runsStatus, `Saved failed ${pipelineName} run ${failedRun.id}.`, 'error');
    throw error;
  }
}

async function cleanupRuns() {
  const result = await ensureRetentionPolicy({
    retentionDays: DEFAULT_RETENTION_DAYS,
    minIntervalHours: 0,
  });
  await refreshRuns();
  setStatus(runsStatus, `TTL cleanup complete. Deleted ${result.deletedCount || 0} run(s).`, 'ok');
}

async function clearRuns() {
  await clearAllRuns();
  await refreshRuns();
  setReportView({
    content: 'Local Last Runs cleared.',
    reportData: null,
    rawExpanded: true,
  });
  setStatus(runsStatus, 'All local runs cleared.', 'ok');
}

function downloadCurrentReport() {
  const content = reportOutput.textContent || '';
  if (!content) {
    setStatus(runsStatus, 'No report content available to download.', 'error');
    return;
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const downloadUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = currentReportFilename || buildReportFilename({
    pipelineName: 'report',
    status: 'download',
    startedAt: new Date().toISOString(),
  });
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(downloadUrl);
  setStatus(runsStatus, `Downloaded ${link.download}.`, 'ok');
}

signOutButton.addEventListener('click', async () => {
  clearAuthState();
  clearResolvedConfig();
  if (authenticatedUser) {
    authenticatedUser.textContent = '';
  }
  logSystemStatus('reauthenticate');
  setStatus(authStatus, 'Redirecting to Genesys login...', '');
  try {
    await startPkceLogin(getAuthSettings());
  } catch (error) {
    setStatus(authStatus, error.message, 'error');
  }
});

cleanupRunsButton.addEventListener('click', async () => {
  try {
    await cleanupRuns();
  } catch (error) {
    setStatus(runsStatus, error.message, 'error');
  }
});

clearRunsButton.addEventListener('click', async () => {
  try {
    await clearRuns();
  } catch (error) {
    setStatus(runsStatus, error.message, 'error');
  }
});

if (downloadReportButton) {
  downloadReportButton.addEventListener('click', () => {
    downloadCurrentReport();
  });
}

if (pipelineIntervalPresetSelect) {
  pipelineIntervalPresetSelect.addEventListener('change', () => {
    syncIntervalInputVisibility();
  });
}

pipelineForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    await runPipeline();
  } catch (error) {
    setStatus(pipelineStatus, error.message, 'error');
  }
});

runsBody.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const runId = target.dataset.runId;
  if (!runId) return;

  try {
    await viewRun(runId);
    setStatus(runsStatus, `Loaded local run ${runId}.`, 'ok');
  } catch (error) {
    setStatus(runsStatus, error.message, 'error');
  }
});

async function boot() {
  if (buildVersion) {
    buildVersion.textContent = `Build: ${APP_BUILD_ID}`;
  }
  if (downloadReportButton) {
    downloadReportButton.disabled = true;
  }
  syncIntervalInputVisibility();
  getAuthSettings();
  logSystemStatus('boot-start');
  await ensureRetentionPolicy({ retentionDays: DEFAULT_RETENTION_DAYS });
  await refreshRuns();

  if (hasCallbackPayload()) {
    try {
      setStatus(authStatus, 'Completing PKCE callback...', '');
      const result = await completePkceCallback(getAuthSettings());
      if (result.completed) {
        setStatus(authStatus, 'Authenticated successfully.', 'ok');
        logSystemStatus('callback-complete');
      }
    } catch (error) {
      setStatus(authStatus, error.message, 'error');
      logSystemStatus('callback-error');
    }
  } else if (getAccessToken()) {
    setStatus(authStatus, 'Authenticated. Browser token is present.', 'ok');
    logSystemStatus('token-present');
  } else {
    setStatus(authStatus, 'Redirecting to Genesys login...', '');
    logSystemStatus('auto-login');
    await startPkceLogin(getAuthSettings());
    return;
  }

  await loadAuthenticatedUser();

  if (getAccessToken() && loadCachedConfigPointer()) {
    console.info('[Portal Config]', {
      message: 'Cached config pointer found.',
      cachedConfigPointer: loadCachedConfigPointer(),
    });
  }

  setStatus(pipelineStatus, 'Ready to run browser pipelines.', '');
}

boot().catch((error) => {
  setStatus(authStatus, error.message, 'error');
  logSystemStatus('boot-error');
});
