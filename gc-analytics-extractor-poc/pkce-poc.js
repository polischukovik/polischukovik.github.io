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

const STORAGE_KEY = 'genesys-pkce-poc';
const PKCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

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
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function clearStoredState() {
  window.localStorage.removeItem(STORAGE_KEY);
  window.sessionStorage.removeItem(`${STORAGE_KEY}:state`);
  window.sessionStorage.removeItem(`${STORAGE_KEY}:verifier`);
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

function ensureRedirectUri() {
  if (!redirectUriInput.value.trim()) {
    redirectUriInput.value = window.location.href.split('?')[0];
  }
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

  tokenData.textContent = JSON.stringify(summarizeTokenResponse(payload), null, 2);
  setStatus('Token exchange succeeded.', 'ok');
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
  setStatus('Saved PKCE state cleared from this browser.', 'ok');
});

function boot() {
  const stored = loadStoredConfig();

  environmentInput.value = stored.environment || '';
  clientIdInput.value = stored.clientId || '';
  scopesInput.value = stored.scopes || 'analytics architect:readonly';
  redirectUriInput.value = stored.redirectUri || window.location.href.split('?')[0];

  renderCallbackState();

  if (getCallbackPayload().code) {
    setStatus('Authorization code detected. Click "Exchange Callback Code".', 'ok');
  } else {
    setStatus('Configure the OAuth client details, then start the PKCE flow.', '');
  }
}

boot();
