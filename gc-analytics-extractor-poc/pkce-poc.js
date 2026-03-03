const form = document.getElementById('pkce-form');
const environmentInput = document.getElementById('environment');
const clientIdInput = document.getElementById('client-id');
const scopesInput = document.getElementById('scopes');
const redirectUriInput = document.getElementById('redirect-uri');
const exchangeButton = document.getElementById('exchange-button');
const clearButton = document.getElementById('clear-button');
const statusLine = document.getElementById('pkce-status');
const callbackMeta = document.getElementById('callback-meta');
const callbackData = document.getElementById('callback-data');
const tokenData = document.getElementById('token-data');
const probeBotAggregatesButton = document.getElementById('probe-bot-aggregates-button');
const apiProbeStatus = document.getElementById('api-probe-status');
const apiProbeData = document.getElementById('api-probe-data');
const botFlowIdInput = document.getElementById('bot-flow-id');
const probeIntervalInput = document.getElementById('probe-interval');
const probeReportingTurnsButton = document.getElementById('probe-reportingturns-button');
const probeSessionsButton = document.getElementById('probe-sessions-button');
const detailProbeStatus = document.getElementById('detail-probe-status');
const detailProbeData = document.getElementById('detail-probe-data');
const configWorkspaceIdInput = document.getElementById('config-workspace-id');
const configWorkspaceNameInput = document.getElementById('config-workspace-name');
const configDocumentIdInput = document.getElementById('config-document-id');
const configDocumentNameInput = document.getElementById('config-document-name');
const probeWorkspacesButton = document.getElementById('probe-workspaces-button');
const probeDocumentsButton = document.getElementById('probe-documents-button');
const probeConfigDocumentButton = document.getElementById('probe-config-document-button');
const configProbeStatus = document.getElementById('config-probe-status');
const configProbeData = document.getElementById('config-probe-data');

const STORAGE_KEY = 'genesys-pkce-poc';
const PKCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const ACCESS_TOKEN_STORAGE_KEY = `${STORAGE_KEY}:accessToken`;

function loadStoredConfig() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveStoredConfig() {
  const payload = {
    environment: environmentInput.value.trim(),
    clientId: clientIdInput.value.trim(),
    scopes: scopesInput.value.trim(),
    redirectUri: redirectUriInput.value.trim(),
    botFlowId: botFlowIdInput.value.trim(),
    probeInterval: probeIntervalInput.value.trim(),
    configWorkspaceId: configWorkspaceIdInput.value.trim(),
    configWorkspaceName: configWorkspaceNameInput.value.trim(),
    configDocumentId: configDocumentIdInput.value.trim(),
    configDocumentName: configDocumentNameInput.value.trim(),
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function clearStoredState() {
  window.localStorage.removeItem(STORAGE_KEY);
  window.sessionStorage.removeItem(`${STORAGE_KEY}:state`);
  window.sessionStorage.removeItem(`${STORAGE_KEY}:verifier`);
  window.sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
}

function setStatus(message, type = '') {
  statusLine.textContent = message;
  statusLine.className = `status ${type}`.trim();
}

function normalizeEnvironment(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');
  return withoutProtocol.replace(/^(login|api)\./i, '');
}

function getLoginBase(environment) {
  return `https://login.${normalizeEnvironment(environment)}`;
}

function getApiBase(environment) {
  return `https://api.${normalizeEnvironment(environment)}`;
}

function ensureRedirectUri() {
  if (!redirectUriInput.value.trim()) {
    redirectUriInput.value = window.location.href.split('?')[0];
  }
}

function setApiProbeStatus(message, type = '') {
  apiProbeStatus.textContent = message;
  apiProbeStatus.className = `status ${type}`.trim();
}

function setDetailProbeStatus(message, type = '') {
  detailProbeStatus.textContent = message;
  detailProbeStatus.className = `status ${type}`.trim();
}

function setConfigProbeStatus(message, type = '') {
  configProbeStatus.textContent = message;
  configProbeStatus.className = `status ${type}`.trim();
}

function getStoredAccessToken() {
  return window.sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
}

function setStoredAccessToken(accessToken) {
  if (!accessToken) return;
  window.sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, accessToken);
}

function randomString(length = 64) {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => PKCE_ALPHABET[value % PKCE_ALPHABET.length]).join('');
}

function toBase64Url(bytes) {
  let binary = '';
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256(input) {
  const encoded = new TextEncoder().encode(input);
  const digest = await window.crypto.subtle.digest('SHA-256', encoded);
  return new Uint8Array(digest);
}

async function createPkceChallenge(verifier) {
  return toBase64Url(await sha256(verifier));
}

function getCallbackPayload() {
  const url = new URL(window.location.href);
  return {
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    error: url.searchParams.get('error'),
    errorDescription: url.searchParams.get('error_description'),
  };
}

function renderCallbackState() {
  const payload = getCallbackPayload();
  const hasCallbackData = payload.code || payload.error;

  callbackMeta.textContent = hasCallbackData ? 'Callback parameters found in current URL.' : '';
  callbackData.textContent = JSON.stringify(payload, null, 2);
}

function summarizeTokenResponse(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const summarized = { ...data };

  if (typeof summarized.access_token === 'string') {
    summarized.access_token = `${summarized.access_token.slice(0, 12)}...${summarized.access_token.slice(-6)}`;
  }

  if (typeof summarized.refresh_token === 'string') {
    summarized.refresh_token = '[present]';
  }

  return summarized;
}

function getYesterdayUtcInterval() {
  const now = new Date();
  const end = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0
  ));
  const start = new Date(end.getTime() - (24 * 60 * 60 * 1000));
  return `${start.toISOString()}/${end.toISOString()}`;
}

function buildBotAggregatesProbeBody() {
  return {
    interval: getProbeInterval(),
    groupBy: ['botId', 'botName', 'botFlowType', 'botFlowSubType'],
    metrics: ['nBotSessions', 'nBotSessionTurns', 'tBotSession'],
  };
}

function getProbeInterval() {
  const configured = probeIntervalInput.value.trim();
  if (configured) {
    return configured;
  }
  const interval = getYesterdayUtcInterval();
  probeIntervalInput.value = interval;
  return interval;
}

function ensureDetailProbeInputs() {
  const accessToken = getStoredAccessToken();
  if (!accessToken) {
    throw new Error('No access token is stored in this tab. Complete token exchange first.');
  }

  const environment = normalizeEnvironment(environmentInput.value);
  if (!environment) {
    throw new Error('Genesys Cloud environment is required.');
  }

  const botFlowId = botFlowIdInput.value.trim();
  if (!botFlowId) {
    throw new Error('Bot Flow ID is required for detail probes.');
  }

  const interval = getProbeInterval();
  saveStoredConfig();

  return { accessToken, environment, botFlowId, interval };
}

function ensureBaseApiAccess() {
  const accessToken = getStoredAccessToken();
  if (!accessToken) {
    throw new Error('No access token is stored in this tab. Complete token exchange first.');
  }

  const environment = normalizeEnvironment(environmentInput.value);
  if (!environment) {
    throw new Error('Genesys Cloud environment is required.');
  }

  saveStoredConfig();
  return { accessToken, environment };
}

async function fetchJsonWithBearer(url, accessToken) {
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    throw new Error(`Request failed before receiving a response: ${String(error)}`);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.message || payload?.error || `Request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return payload;
}

async function redirectToGenesysLogin() {
  ensureRedirectUri();
  saveStoredConfig();

  const environment = normalizeEnvironment(environmentInput.value);
  const clientId = clientIdInput.value.trim();
  const scopes = scopesInput.value.trim();
  const redirectUri = redirectUriInput.value.trim();

  if (!environment || !clientId || !scopes || !redirectUri) {
    throw new Error('Environment, client id, scopes, and redirect URI are required.');
  }

  const state = randomString(48);
  const verifier = randomString(96);
  const challenge = await createPkceChallenge(verifier);

  window.sessionStorage.setItem(`${STORAGE_KEY}:state`, state);
  window.sessionStorage.setItem(`${STORAGE_KEY}:verifier`, verifier);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  setStatus('Redirecting to Genesys login...', 'ok');
  window.location.assign(`${getLoginBase(environment)}/oauth/authorize?${params.toString()}`);
}

async function exchangeCallbackCode() {
  ensureRedirectUri();
  saveStoredConfig();

  const { code, state, error, errorDescription } = getCallbackPayload();
  if (error) {
    throw new Error(`OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ''}`);
  }
  if (!code) {
    throw new Error('No authorization code is present in the current URL.');
  }

  const expectedState = window.sessionStorage.getItem(`${STORAGE_KEY}:state`);
  const verifier = window.sessionStorage.getItem(`${STORAGE_KEY}:verifier`);
  if (!expectedState || !verifier) {
    throw new Error('Missing stored PKCE state. Start the login flow from this browser tab first.');
  }
  if (state !== expectedState) {
    throw new Error('OAuth state mismatch.');
  }

  const environment = normalizeEnvironment(environmentInput.value);
  const clientId = clientIdInput.value.trim();
  const redirectUri = redirectUriInput.value.trim();
  if (!environment || !clientId || !redirectUri) {
    throw new Error('Environment, client id, and redirect URI are required for token exchange.');
  }

  setStatus('Exchanging authorization code for tokens...', '');

  const response = await fetch(`${getLoginBase(environment)}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    tokenData.textContent = JSON.stringify(payload, null, 2);
    throw new Error(`Token exchange failed with status ${response.status}.`);
  }

  setStoredAccessToken(payload.access_token);
  tokenData.textContent = JSON.stringify(summarizeTokenResponse(payload), null, 2);
  setStatus('Token exchange succeeded.', 'ok');
}

async function probeBotAggregates() {
  const accessToken = getStoredAccessToken();
  if (!accessToken) {
    throw new Error('No access token is stored in this tab. Complete token exchange first.');
  }

  const environment = normalizeEnvironment(environmentInput.value);
  if (!environment) {
    throw new Error('Genesys Cloud environment is required.');
  }

  const body = buildBotAggregatesProbeBody();
  setApiProbeStatus('Calling Genesys analytics API from the browser...', '');

  let response;
  try {
    response = await fetch(`${getApiBase(environment)}/api/v2/analytics/bots/aggregates/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    apiProbeData.textContent = JSON.stringify({
      request: body,
      error: String(error),
      note: 'A browser-level network/CORS failure prevents reading the response.',
    }, null, 2);
    throw new Error('Bot aggregates probe failed before receiving a response. This is usually a CORS or network issue.');
  }

  const payload = await response.json().catch(() => ({}));
  const results = Array.isArray(payload.results) ? payload.results : [];
  const sample = results[0] || null;

  apiProbeData.textContent = JSON.stringify({
    request: body,
    responseStatus: response.status,
    resultCount: results.length,
    sampleGroup: sample?.group || null,
    sampleData: sample?.data || null,
    rawKeys: Object.keys(payload),
  }, null, 2);

  if (!response.ok) {
    throw new Error(`Bot aggregates probe failed with status ${response.status}.`);
  }

  setApiProbeStatus('Bot aggregates probe succeeded.', 'ok');
}

async function probeBotFlowDetail(kind) {
  const { accessToken, environment, botFlowId, interval } = ensureDetailProbeInputs();
  const endpoint = kind === 'reportingturns'
    ? `/api/v2/analytics/botflows/${encodeURIComponent(botFlowId)}/divisions/reportingturns`
    : `/api/v2/analytics/botflows/${encodeURIComponent(botFlowId)}/sessions`;
  const url = new URL(`${getApiBase(environment)}${endpoint}`);
  url.searchParams.set('interval', interval);

  setDetailProbeStatus(`Calling ${kind} from the browser...`, '');

  let response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    detailProbeData.textContent = JSON.stringify({
      endpoint: url.toString(),
      error: String(error),
      note: 'A browser-level network/CORS failure prevents reading the response.',
    }, null, 2);
    throw new Error(`${kind} probe failed before receiving a response. This is usually a CORS or network issue.`);
  }

  const payload = await response.json().catch(() => ({}));
  const entities = Array.isArray(payload.entities) ? payload.entities : [];
  const sample = entities[0] || null;

  detailProbeData.textContent = JSON.stringify({
    kind,
    endpoint: url.toString(),
    responseStatus: response.status,
    entityCount: entities.length,
    sampleKeys: sample ? Object.keys(sample) : [],
    sampleEntity: sample,
    rawKeys: Object.keys(payload),
  }, null, 2);

  if (!response.ok) {
    throw new Error(`${kind} probe failed with status ${response.status}.`);
  }

  setDetailProbeStatus(`${kind} probe succeeded.`, 'ok');
}

async function listWorkspaces() {
  const { accessToken, environment } = ensureBaseApiAccess();
  setConfigProbeStatus('Listing workspaces...', '');

  const payload = await fetchJsonWithBearer(
    `${getApiBase(environment)}/api/v2/contentmanagement/workspaces`,
    accessToken
  );
  const entities = Array.isArray(payload.entities) ? payload.entities : [];
  const workspaceName = configWorkspaceNameInput.value.trim().toLowerCase();
  const matchedWorkspace = workspaceName
    ? entities.find((entity) => String(entity?.name || '').toLowerCase() === workspaceName)
    : null;

  if (matchedWorkspace?.id) {
    configWorkspaceIdInput.value = matchedWorkspace.id;
  }

  configProbeData.textContent = JSON.stringify({
    responseStatus: 200,
    workspaceCount: entities.length,
    matchedWorkspace: matchedWorkspace || null,
    sampleWorkspaces: entities.slice(0, 10).map((entity) => ({
      id: entity?.id || null,
      name: entity?.name || null,
      description: entity?.description || null,
    })),
  }, null, 2);

  setConfigProbeStatus('Workspace listing succeeded.', 'ok');
}

async function listWorkspaceDocuments() {
  const { accessToken, environment } = ensureBaseApiAccess();
  const workspaceId = configWorkspaceIdInput.value.trim();
  if (!workspaceId) {
    throw new Error('Workspace ID is required to list workspace documents.');
  }

  setConfigProbeStatus('Listing documents in the selected workspace...', '');

  const payload = await fetchJsonWithBearer(
    `${getApiBase(environment)}/api/v2/contentmanagement/workspaces/${encodeURIComponent(workspaceId)}/documents`,
    accessToken
  );
  const entities = Array.isArray(payload.entities) ? payload.entities : [];
  const documentName = configDocumentNameInput.value.trim().toLowerCase();
  const matchedDocument = documentName
    ? entities.find((entity) => String(entity?.name || '').toLowerCase() === documentName)
    : null;

  if (matchedDocument?.id) {
    configDocumentIdInput.value = matchedDocument.id;
  }

  configProbeData.textContent = JSON.stringify({
    responseStatus: 200,
    workspaceId,
    documentCount: entities.length,
    matchedDocument: matchedDocument || null,
    sampleDocuments: entities.slice(0, 10).map((entity) => ({
      id: entity?.id || null,
      name: entity?.name || null,
      contentType: entity?.contentType || null,
      dateModified: entity?.dateModified || null,
    })),
  }, null, 2);

  setConfigProbeStatus('Workspace document listing succeeded.', 'ok');
}

async function loadConfigDocument() {
  const { accessToken, environment } = ensureBaseApiAccess();
  const documentId = configDocumentIdInput.value.trim();
  if (!documentId) {
    throw new Error('Document ID is required to load document content.');
  }

  setConfigProbeStatus('Loading config document metadata...', '');

  const downloadInfo = await fetchJsonWithBearer(
    `${getApiBase(environment)}/api/v2/contentmanagement/documents/${encodeURIComponent(documentId)}/content`,
    accessToken
  );
  const contentUrl = downloadInfo?.contentLocationUri;

  if (!contentUrl) {
    configProbeData.textContent = JSON.stringify(downloadInfo, null, 2);
    throw new Error('Document content did not return a contentLocationUri.');
  }

  setConfigProbeStatus('Fetching config document content...', '');

  let rawText;
  try {
    const contentResponse = await fetch(contentUrl, { method: 'GET' });
    rawText = await contentResponse.text();
    if (!contentResponse.ok) {
      throw new Error(`Document content download failed with status ${contentResponse.status}.`);
    }
  } catch (error) {
    configProbeData.textContent = JSON.stringify({
      contentLocationUri: contentUrl,
      error: String(error),
    }, null, 2);
    throw new Error('Failed to download document content from contentLocationUri.');
  }

  let parsedJson = null;
  let parseError = null;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (error) {
    parseError = String(error);
  }

  configProbeData.textContent = JSON.stringify({
    responseStatus: 200,
    documentId,
    contentLocationUri: contentUrl,
    isJson: Boolean(parsedJson),
    parseError,
    parsedJson,
    rawPreview: rawText.slice(0, 2000),
  }, null, 2);

  if (!parsedJson) {
    throw new Error('Document content was fetched, but it is not valid JSON.');
  }

  setConfigProbeStatus('Config document loaded successfully.', 'ok');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    await redirectToGenesysLogin();
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

exchangeButton.addEventListener('click', async () => {
  try {
    await exchangeCallbackCode();
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

clearButton.addEventListener('click', () => {
  clearStoredState();
  tokenData.textContent = 'Local PKCE state cleared.';
  apiProbeData.textContent = 'No API probe attempted yet.';
  detailProbeData.textContent = 'No detail probe attempted yet.';
  configProbeData.textContent = 'No config probe attempted yet.';
  setApiProbeStatus('', '');
  setDetailProbeStatus('', '');
  setConfigProbeStatus('', '');
  setStatus('Saved PKCE state cleared from this browser.', 'ok');
});

probeBotAggregatesButton.addEventListener('click', async () => {
  try {
    await probeBotAggregates();
  } catch (error) {
    setApiProbeStatus(error.message, 'error');
  }
});

probeReportingTurnsButton.addEventListener('click', async () => {
  try {
    await probeBotFlowDetail('reportingturns');
  } catch (error) {
    setDetailProbeStatus(error.message, 'error');
  }
});

probeSessionsButton.addEventListener('click', async () => {
  try {
    await probeBotFlowDetail('sessions');
  } catch (error) {
    setDetailProbeStatus(error.message, 'error');
  }
});

probeWorkspacesButton.addEventListener('click', async () => {
  try {
    await listWorkspaces();
  } catch (error) {
    setConfigProbeStatus(error.message, 'error');
  }
});

probeDocumentsButton.addEventListener('click', async () => {
  try {
    await listWorkspaceDocuments();
  } catch (error) {
    setConfigProbeStatus(error.message, 'error');
  }
});

probeConfigDocumentButton.addEventListener('click', async () => {
  try {
    await loadConfigDocument();
  } catch (error) {
    setConfigProbeStatus(error.message, 'error');
  }
});

function boot() {
  const stored = loadStoredConfig();

  environmentInput.value = stored.environment || '';
  clientIdInput.value = stored.clientId || '';
  scopesInput.value = stored.scopes || 'analytics architect:readonly';
  redirectUriInput.value = stored.redirectUri || window.location.href.split('?')[0];
  botFlowIdInput.value = stored.botFlowId || '';
  probeIntervalInput.value = stored.probeInterval || getYesterdayUtcInterval();
  configWorkspaceIdInput.value = stored.configWorkspaceId || '';
  configWorkspaceNameInput.value = stored.configWorkspaceName || '';
  configDocumentIdInput.value = stored.configDocumentId || '';
  configDocumentNameInput.value = stored.configDocumentName || '';

  renderCallbackState();

  if (getCallbackPayload().code) {
    setStatus('Authorization code detected. Click "Exchange Callback Code".', 'ok');
  } else {
    setStatus('Configure the OAuth client details, then start the PKCE flow.', '');
  }

  if (getStoredAccessToken()) {
    setApiProbeStatus('Access token is present in this tab. You can run the API probe.', 'ok');
  }
}

boot();
