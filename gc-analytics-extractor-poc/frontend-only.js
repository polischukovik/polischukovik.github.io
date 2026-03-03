import {
  DEFAULT_SCOPES,
  clearAuthState,
  completePkceCallback,
  getAccessToken,
  getCallbackPayload,
  getTokenInfo,
  hasCallbackPayload,
  loadAuthSettings,
  saveAuthSettings,
  startPkceLogin,
} from './frontend-auth.js';
import {
  CONFIG_DOCUMENT_NAME,
  CONFIG_WORKSPACE_NAME,
  clearCachedConfigPointer,
  loadCachedConfigPointer,
  loadFrontendConfig,
} from './frontend-config-resolver.js';
import { runBotflowCostAggregate } from './frontend-botflow.js';
import {
  DEFAULT_RETENTION_DAYS,
  clearAllRuns,
  ensureRetentionPolicy,
  getRun,
  listRuns,
  saveRun,
} from './local-run-store.js';

const authForm = document.getElementById('auth-form');
const environmentInput = document.getElementById('environment');
const clientIdInput = document.getElementById('client-id');
const scopesInput = document.getElementById('scopes');
const redirectUriInput = document.getElementById('redirect-uri');
const signOutButton = document.getElementById('sign-out-button');
const authStatus = document.getElementById('auth-status');
const refreshSystemButton = document.getElementById('refresh-system-button');
const systemStatus = document.getElementById('system-status');
const resolveConfigButton = document.getElementById('resolve-config-button');
const clearConfigPointerButton = document.getElementById('clear-config-pointer-button');
const configStatus = document.getElementById('config-status');
const configOutput = document.getElementById('config-output');
const pipelineForm = document.getElementById('pipeline-form');
const pipelineNameSelect = document.getElementById('pipeline-name');
const pipelineIntervalInput = document.getElementById('pipeline-interval');
const pipelineStatus = document.getElementById('pipeline-status');
const saveSnapshotButton = document.getElementById('save-snapshot-button');
const cleanupRunsButton = document.getElementById('cleanup-runs-button');
const clearRunsButton = document.getElementById('clear-runs-button');
const runsStatus = document.getElementById('runs-status');
const runsBody = document.getElementById('runs-body');
const reportMeta = document.getElementById('report-meta');
const reportOutput = document.getElementById('report-output');

let resolvedConfig = null;

function setStatus(element, message, type = '') {
  element.textContent = message;
  element.className = `status ${type}`.trim();
}

function formatTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function getAuthSettingsFromForm() {
  return {
    environment: environmentInput.value.trim(),
    clientId: clientIdInput.value.trim(),
    scopes: scopesInput.value.trim() || DEFAULT_SCOPES,
    redirectUri: redirectUriInput.value.trim() || window.location.href.split('?')[0],
  };
}

function applyAuthSettingsToForm() {
  const settings = loadAuthSettings();
  environmentInput.value = settings.environment || '';
  clientIdInput.value = settings.clientId || '';
  scopesInput.value = settings.scopes || DEFAULT_SCOPES;
  redirectUriInput.value = settings.redirectUri || window.location.href.split('?')[0];
}

function renderSystemStatus() {
  const tokenInfo = getTokenInfo();
  const callbackPayload = getCallbackPayload();
  const cachedPointer = loadCachedConfigPointer();

  systemStatus.textContent = JSON.stringify({
    authenticated: Boolean(tokenInfo?.accessToken),
    tokenInfo,
    hasCallbackPayload: hasCallbackPayload(),
    callbackPayload: hasCallbackPayload() ? callbackPayload : null,
    configWorkspace: CONFIG_WORKSPACE_NAME,
    configDocument: CONFIG_DOCUMENT_NAME,
    cachedConfigPointer: cachedPointer,
    localRetentionDays: DEFAULT_RETENTION_DAYS,
  }, null, 2);
}

function renderRunsTable(runs) {
  runsBody.innerHTML = '';

  if (!runs.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6">No local runs saved yet.</td>';
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
    reportMeta.textContent = '';
    reportOutput.textContent = 'Run not found.';
    return;
  }

  reportMeta.textContent = `${run.pipelineName} • ${run.status} • ${formatTime(run.startedAt)}`;
  reportOutput.textContent = JSON.stringify(run, null, 2);
}

async function resolveConfig() {
  const accessToken = getAccessToken();
  const { environment } = getAuthSettingsFromForm();

  if (!accessToken) {
    throw new Error('Sign in first before resolving config.');
  }

  setStatus(configStatus, 'Resolving config...', '');
  resolvedConfig = await loadFrontendConfig({ environment, accessToken });
  configOutput.textContent = JSON.stringify({
    source: resolvedConfig.source,
    pointer: resolvedConfig.pointer,
    config: resolvedConfig.config,
  }, null, 2);
  setStatus(configStatus, `Config resolved via ${resolvedConfig.source}.`, 'ok');
  renderSystemStatus();
}

function clearResolvedConfig() {
  resolvedConfig = null;
  configOutput.textContent = 'No config loaded yet.';
}

async function saveSessionSnapshot() {
  const tokenInfo = getTokenInfo();
  const settings = getAuthSettingsFromForm();
  const snapshot = await saveRun({
    pipelineName: 'frontend-shell',
    status: tokenInfo?.accessToken ? 'completed' : 'failed',
    providedInterval: 'n/a',
    humanReadableInterval: 'Session Snapshot',
    durationMs: 0,
    reportFilename: null,
    reportContent: JSON.stringify({
      savedAt: new Date().toISOString(),
      authConfigured: Boolean(settings.environment && settings.clientId),
      authenticated: Boolean(tokenInfo?.accessToken),
      configResolved: Boolean(resolvedConfig),
      configPointer: loadCachedConfigPointer(),
      configSummary: resolvedConfig?.config || null,
    }, null, 2),
    summary: {
      authenticated: Boolean(tokenInfo?.accessToken),
      configResolved: Boolean(resolvedConfig),
    },
    metadata: {
      source: 'frontend-only-shell',
    },
  });

  await refreshRuns();
  await viewRun(snapshot.id);
  setStatus(runsStatus, `Saved local snapshot ${snapshot.id}.`, 'ok');
}

async function runPipeline() {
  const accessToken = getAccessToken();
  const { environment } = getAuthSettingsFromForm();
  if (!accessToken) {
    throw new Error('Sign in first before running a pipeline.');
  }

  const pipelineName = pipelineNameSelect.value;
  const intervalInput = pipelineIntervalInput.value.trim() || 'yesterday';

  if (pipelineName !== 'botflowCost') {
    throw new Error(`Unsupported frontend pipeline "${pipelineName}".`);
  }

  const runId = window.crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const pendingRun = await saveRun({
    id: runId,
    pipelineName: 'botflowCost',
    status: 'running',
    providedInterval: intervalInput,
    humanReadableInterval: intervalInput,
    startedAt,
    durationMs: null,
    reportFilename: null,
    reportContent: 'Running botflowCost in the browser...',
    summary: null,
    metadata: {
      source: 'frontend-only-shell',
      mode: 'pending',
    },
  });

  await refreshRuns();
  await viewRun(pendingRun.id);
  reportMeta.textContent = `Local Run ${pendingRun.id} • botflowCost`;
  reportOutput.textContent = pendingRun.reportContent;
  setStatus(pipelineStatus, 'Running botflowCost in the browser...', '');

  try {
    const result = await runBotflowCostAggregate({
      environment,
      accessToken,
      intervalInput,
    });

    const completedRun = await saveRun({
      id: runId,
      pipelineName: 'botflowCost',
      status: 'completed',
      providedInterval: intervalInput,
      humanReadableInterval: result.interval,
      startedAt,
      durationMs: Date.now() - new Date(startedAt).getTime(),
      reportFilename: null,
      reportContent: result.reportContent,
      summary: result.summary,
      metadata: {
        source: 'frontend-only-shell',
        mode: result.billingMode,
      },
    });

    await refreshRuns();
    await viewRun(completedRun.id);

    reportMeta.textContent = `Local Run ${completedRun.id} • botflowCost`;
    reportOutput.textContent = result.reportContent;
    setStatus(pipelineStatus, `botflowCost completed in ${result.billingMode} mode and was saved locally.`, 'ok');
    setStatus(runsStatus, `Saved botflowCost run ${completedRun.id}.`, 'ok');
  } catch (error) {
    const failedRun = await saveRun({
      id: runId,
      pipelineName: 'botflowCost',
      status: 'failed',
      providedInterval: intervalInput,
      humanReadableInterval: intervalInput,
      startedAt,
      durationMs: Date.now() - new Date(startedAt).getTime(),
      reportFilename: null,
      reportContent: `Pipeline failed:\n${error.message}`,
      summary: null,
      metadata: {
        source: 'frontend-only-shell',
        mode: 'failed',
      },
    });

    await refreshRuns();
    await viewRun(failedRun.id);
    reportMeta.textContent = `Local Run ${failedRun.id} • botflowCost`;
    reportOutput.textContent = `Pipeline failed:\n${error.message}`;
    setStatus(runsStatus, `Saved failed botflowCost run ${failedRun.id}.`, 'error');
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
  reportMeta.textContent = '';
  reportOutput.textContent = 'Local Last Runs cleared.';
  setStatus(runsStatus, 'All local runs cleared.', 'ok');
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    saveAuthSettings(getAuthSettingsFromForm());
    setStatus(authStatus, 'Redirecting to Genesys login...', 'ok');
    await startPkceLogin(getAuthSettingsFromForm());
  } catch (error) {
    setStatus(authStatus, error.message, 'error');
  }
});

signOutButton.addEventListener('click', () => {
  clearAuthState();
  clearCachedConfigPointer();
  clearResolvedConfig();
  renderSystemStatus();
  setStatus(authStatus, 'Signed out locally. Browser token and config pointer cleared.', 'ok');
  setStatus(configStatus, '', '');
});

refreshSystemButton.addEventListener('click', async () => {
  try {
    renderSystemStatus();
    await refreshRuns();
    setStatus(authStatus, 'System state refreshed.', 'ok');
  } catch (error) {
    setStatus(authStatus, error.message, 'error');
  }
});

resolveConfigButton.addEventListener('click', async () => {
  try {
    await resolveConfig();
  } catch (error) {
    setStatus(configStatus, error.message, 'error');
  }
});

clearConfigPointerButton.addEventListener('click', () => {
  clearCachedConfigPointer();
  clearResolvedConfig();
  renderSystemStatus();
  setStatus(configStatus, 'Cached config pointer cleared.', 'ok');
});

saveSnapshotButton.addEventListener('click', async () => {
  try {
    await saveSessionSnapshot();
  } catch (error) {
    setStatus(runsStatus, error.message, 'error');
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
  applyAuthSettingsToForm();
  renderSystemStatus();
  await ensureRetentionPolicy({ retentionDays: DEFAULT_RETENTION_DAYS });
  await refreshRuns();

  if (hasCallbackPayload()) {
    try {
      setStatus(authStatus, 'Completing PKCE callback...', '');
      const result = await completePkceCallback(getAuthSettingsFromForm());
      if (result.completed) {
        setStatus(authStatus, 'Authenticated successfully.', 'ok');
      }
    } catch (error) {
      setStatus(authStatus, error.message, 'error');
    }
  } else if (getAccessToken()) {
    setStatus(authStatus, 'Authenticated. Browser token is present.', 'ok');
  } else {
    setStatus(authStatus, 'Configure the OAuth client and sign in.', '');
  }

  renderSystemStatus();

  if (getAccessToken() && loadCachedConfigPointer()) {
    setStatus(configStatus, 'Cached config pointer found. Click "Resolve Config" to load the document.', 'ok');
  }

  setStatus(pipelineStatus, 'Ready to run browser botflowCost.', '');
}

boot().catch((error) => {
  setStatus(authStatus, error.message, 'error');
  renderSystemStatus();
});
