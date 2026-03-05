import {
  clearAuthState,
  completePkceCallback,
  getAccessToken,
  getCallbackPayload,
  getTokenInfo,
  hasCallbackPayload,
  saveAuthSettings,
  startPkceLogin,
} from './auth.js';
import { AUTH_BOOTSTRAP_SETTINGS } from './auth-bootstrap.js';
import { APP_BUILD_ID } from './build.js';
import {
  CONFIG_DOCUMENT_NAME,
  CONFIG_WORKSPACE_NAME,
  loadCachedConfigPointer,
  loadFrontendConfig,
} from './config-resolver.js';
import { runBotflowCostAggregate } from './botflow.js';
import { runSmsCost } from './sms.js';
import {
  DEFAULT_RETENTION_DAYS,
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
const pipelineCustomRange = document.getElementById('pipeline-custom-range');
const pipelineStartDateInput = document.getElementById('pipeline-start-date');
const pipelineEndDateInput = document.getElementById('pipeline-end-date');
const pipelineStatus = document.getElementById('pipeline-status');
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

function formatDateOnly(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value || '');
  }
  return parsed.toISOString().slice(0, 10);
}

function formatDateRangeFromInterval(intervalValue) {
  const interval = String(intervalValue || '');
  if (!interval.includes('/')) {
    return interval;
  }

  const [startRaw, endRaw] = interval.split('/');
  const start = new Date(startRaw);
  const endExclusive = new Date(endRaw);

  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime())) {
    return interval;
  }

  const endInclusive = new Date(endExclusive.getTime());
  endInclusive.setUTCDate(endInclusive.getUTCDate() - 1);
  return `${formatDateOnly(start)} to ${formatDateOnly(endInclusive)}`;
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

function renderHighlights(highlights) {
  if (!Array.isArray(highlights) || !highlights.length) {
    return '';
  }

  const renderKpiValue = (value) => {
    const raw = String(value ?? '');
    const match = raw.match(/^([^0-9+\-]*)([-+]?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?)([^0-9]*)$/);
    if (!match) {
      return escapeHtml(raw);
    }

    const prefix = match[1] || '';
    const numericRaw = (match[2] || '').replace(/,/g, '');
    const suffix = match[3] || '';

    if (/[0-9]/.test(suffix)) {
      return escapeHtml(raw);
    }

    const numericValue = Number(numericRaw);
    if (Number.isNaN(numericValue)) {
      return escapeHtml(raw);
    }

    const fixed = numericValue.toFixed(2);
    const [integerPart, decimalPart = '00'] = fixed.split('.');
    return `${escapeHtml(`${prefix}${integerPart}`)}<span class="kpi-decimals">.${escapeHtml(decimalPart)}</span>${escapeHtml(suffix)}`;
  };

  return `
    <section class="kpi-grid">
      ${highlights.map((item) => `
        <div class="kpi-card">
          <p class="kpi-label">${escapeHtml(item.label)}</p>
          <p class="kpi-value">${renderKpiValue(item.value)}</p>
        </div>
      `).join('')}
    </section>
  `;
}

function renderBotflowStructuredReport(reportData) {
  if (!reportData || reportData.type !== 'botflowCost' || !reportStructured) {
    return false;
  }

  const html = `
    ${renderHighlights(reportData.highlights)}
    ${renderReportDetailsSection(reportData.voice?.divisionTitle, reportData.voice?.divisionRows || [], { open: true })}
    ${renderReportDetailsSection(reportData.digital?.divisionTitle, reportData.digital?.divisionRows || [], { open: true })}
  `;

  reportStructured.innerHTML = html;
  return true;
}

function renderSmsStructuredReport(reportData) {
  if (!reportData || reportData.type !== 'smsCost' || !reportStructured) {
    return false;
  }

  const primarySections = Array.isArray(reportData.primarySections) ? reportData.primarySections : [];
  let primarySectionsHtml = '';
  if (primarySections.length >= 3) {
    const [leftSection, ...rightSections] = primarySections;
    primarySectionsHtml = `
      <section class="sms-primary-layout">
        <div class="sms-primary-left">
          ${renderReportDetailsSection(leftSection?.title, leftSection?.rows || [], { open: true })}
        </div>
        <div class="sms-primary-right">
          ${rightSections.map((section) => renderReportDetailsSection(section?.title, section?.rows || [], { open: true })).join('')}
        </div>
      </section>
    `;
  } else {
    primarySectionsHtml = primarySections
      .map((section) => renderReportDetailsSection(section?.title, section?.rows || [], { open: true }))
      .join('');
  }

  const html = `
    ${renderHighlights(reportData.highlights)}
    ${primarySectionsHtml}
  `;

  reportStructured.innerHTML = html;
  return true;
}

function renderStructuredReport(reportData) {
  if (renderBotflowStructuredReport(reportData)) {
    return true;
  }
  if (renderSmsStructuredReport(reportData)) {
    return true;
  }
  return false;
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

  const hasStructuredReport = renderStructuredReport(reportData);
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

function buildReportMeta(run) {
  const timeFrame = run?.metadata?.reportDateRange
    || (run?.reportData?.interval ? formatDateRangeFromInterval(run.reportData.interval) : '')
    || run?.humanReadableInterval
    || run?.providedInterval
    || '-';

  return `${run.pipelineName} • ${run.status} • ${timeFrame} • ${formatTime(run.startedAt)}`;
}

function getAuthSettings() {
  return saveAuthSettings({
    ...AUTH_BOOTSTRAP_SETTINGS,
    redirectUri: window.location.href.split('?')[0],
  });
}

function syncIntervalInputVisibility() {
  if (!pipelineIntervalPresetSelect || !pipelineCustomRange || !pipelineStartDateInput || !pipelineEndDateInput) {
    return;
  }

  const isCustom = pipelineIntervalPresetSelect.value === 'custom';
  pipelineCustomRange.classList.toggle('hidden', !isCustom);
  pipelineStartDateInput.required = isCustom;
  pipelineEndDateInput.required = isCustom;

  if (!isCustom) {
    pipelineStartDateInput.value = '';
    pipelineEndDateInput.value = '';
  }
}

function getSelectedIntervalConfig() {
  const preset = pipelineIntervalPresetSelect?.value || 'yesterday';
  if (preset !== 'custom') {
    const now = new Date();
    const startOfUtcDay = (date) => new Date(Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0, 0, 0, 0
    ));
    let start;
    let endExclusive;

    if (preset === 'today') {
      start = startOfUtcDay(now);
      endExclusive = new Date(start.getTime() + (24 * 60 * 60 * 1000));
    } else if (preset === 'yesterday') {
      endExclusive = startOfUtcDay(now);
      start = new Date(endExclusive.getTime() - (24 * 60 * 60 * 1000));
    } else if (preset === 'thisweek') {
      endExclusive = startOfUtcDay(now);
      const day = endExclusive.getUTCDay();
      const offset = day === 0 ? 6 : day - 1;
      start = new Date(endExclusive.getTime() - (offset * 24 * 60 * 60 * 1000));
      endExclusive = new Date(start.getTime() + (7 * 24 * 60 * 60 * 1000));
    } else if (preset === 'lastweek') {
      const todayStart = startOfUtcDay(now);
      const day = todayStart.getUTCDay();
      const offset = day === 0 ? 6 : day - 1;
      const thisWeekStart = new Date(todayStart.getTime() - (offset * 24 * 60 * 60 * 1000));
      start = new Date(thisWeekStart.getTime() - (7 * 24 * 60 * 60 * 1000));
      endExclusive = thisWeekStart;
    } else if (preset === 'thismonth') {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
      endExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    } else if (preset === 'lastmonth') {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0));
      endExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    } else {
      throw new Error(`Unsupported time frame "${preset}".`);
    }

    return {
      intervalInput: preset,
      humanReadableInterval: INTERVAL_PRESET_LABELS[preset] || preset,
      reportDateRange: formatDateRangeFromInterval(`${start.toISOString()}/${endExclusive.toISOString()}`),
    };
  }

  const startDate = pipelineStartDateInput?.value || '';
  const endDate = pipelineEndDateInput?.value || '';
  if (!startDate || !endDate) {
    throw new Error('Custom start and end dates are required.');
  }
  if (startDate > endDate) {
    throw new Error('Custom start date must be on or before the end date.');
  }

  return {
    intervalInput: `${startDate}/${endDate}`,
    humanReadableInterval: `${startDate} to ${endDate}`,
    reportDateRange: `${startDate} to ${endDate}`,
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
    tr.innerHTML = '<td colspan="6">No local runs saved yet.</td>';
    runsBody.appendChild(tr);
    return;
  }

  runs.forEach((run) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
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
    meta: buildReportMeta(run),
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
    humanReadableInterval: selectedInterval.reportDateRange,
    startedAt,
    durationMs: null,
    reportFilename: null,
    reportContent: `Running ${pipelineName} in the browser...`,
    reportData: null,
    summary: null,
    metadata: {
      source: 'browser-shell',
      mode: 'pending',
      reportDateRange: selectedInterval.reportDateRange,
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
      humanReadableInterval: formatDateRangeFromInterval(result.interval),
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
        reportDateRange: formatDateRangeFromInterval(result.interval),
        resolvedInterval: result.interval,
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
        reportDateRange: selectedInterval.reportDateRange,
      },
    });

    await refreshRuns();
    await viewRun(failedRun.id);
    setStatus(runsStatus, `Saved failed ${pipelineName} run ${failedRun.id}.`, 'error');
    throw error;
  }
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
  setStatus(authStatus, '', '');
  try {
    await startPkceLogin(getAuthSettings());
  } catch (error) {
    setStatus(authStatus, error.message, 'error');
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
      const result = await completePkceCallback(getAuthSettings());
      if (result.completed) {
        setStatus(authStatus, '', '');
        logSystemStatus('callback-complete');
      }
    } catch (error) {
      setStatus(authStatus, error.message, 'error');
      logSystemStatus('callback-error');
    }
  } else if (getAccessToken()) {
    setStatus(authStatus, '', '');
    logSystemStatus('token-present');
  } else {
    setStatus(authStatus, '', '');
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
