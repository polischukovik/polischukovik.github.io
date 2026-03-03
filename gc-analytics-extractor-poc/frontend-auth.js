const AUTH_SETTINGS_KEY = 'gc-analytics-extractor:auth-settings';
const AUTH_STATE_KEY = 'gc-analytics-extractor:auth-state';
const ACCESS_TOKEN_KEY = 'gc-analytics-extractor:access-token';
const REQUIRED_SCOPES = [
  'analytics:readonly',
  'content-management:readonly',
  'architect:readonly',
  'routing:readonly',
  'users:readonly',
  'outbound:readonly',
  'authorization:readonly',
];
const DEFAULT_SCOPES = REQUIRED_SCOPES.join(' ');
const PKCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';

function loadJson(storage, key, fallback = null) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJson(storage, key, value) {
  storage.setItem(key, JSON.stringify(value));
}

function normalizeEnvironment(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');
  return withoutProtocol.replace(/^(login|api)\./i, '');
}

function normalizeScopes(value) {
  const requested = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const scopeSet = new Set(requested);

  for (const scope of REQUIRED_SCOPES) {
    scopeSet.add(scope);
  }

  return Array.from(scopeSet).join(' ');
}

function getLoginBase(environment) {
  return `https://login.${normalizeEnvironment(environment)}`;
}

function loadAuthSettings() {
  const stored = loadJson(window.localStorage, AUTH_SETTINGS_KEY, {}) || {};

  return {
    environment: stored.environment || '',
    clientId: stored.clientId || '',
    scopes: normalizeScopes(stored.scopes || DEFAULT_SCOPES),
    redirectUri: stored.redirectUri || window.location.href.split('?')[0],
  };
}

function saveAuthSettings(settings) {
  const normalized = {
    environment: normalizeEnvironment(settings.environment),
    clientId: String(settings.clientId || '').trim(),
    scopes: normalizeScopes(settings.scopes || DEFAULT_SCOPES),
    redirectUri: String(settings.redirectUri || window.location.href.split('?')[0]).trim(),
  };

  saveJson(window.localStorage, AUTH_SETTINGS_KEY, normalized);
  return normalized;
}

function clearAuthState() {
  window.sessionStorage.removeItem(AUTH_STATE_KEY);
  window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
}

function getStoredAccessToken() {
  return loadJson(window.sessionStorage, ACCESS_TOKEN_KEY, null);
}

function getAccessToken() {
  return getStoredAccessToken()?.accessToken || null;
}

function getTokenInfo() {
  return getStoredAccessToken();
}

function clearCallbackQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  window.history.replaceState({}, '', url.toString());
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

function hasCallbackPayload() {
  const payload = getCallbackPayload();
  return Boolean(payload.code || payload.error);
}

async function startPkceLogin(rawSettings) {
  const settings = saveAuthSettings(rawSettings);
  const { environment, clientId, scopes, redirectUri } = settings;

  if (!environment || !clientId || !scopes || !redirectUri) {
    throw new Error('Environment, client ID, scopes, and redirect URI are required.');
  }

  const state = randomString(48);
  const verifier = randomString(96);
  const challenge = await createPkceChallenge(verifier);

  saveJson(window.sessionStorage, AUTH_STATE_KEY, {
    state,
    verifier,
    createdAt: new Date().toISOString(),
  });

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  window.location.assign(`${getLoginBase(environment)}/oauth/authorize?${params.toString()}`);
}

async function completePkceCallback(rawSettings = null) {
  const settings = rawSettings ? saveAuthSettings(rawSettings) : loadAuthSettings();
  const { environment, clientId, redirectUri } = settings;

  const { code, state, error, errorDescription } = getCallbackPayload();
  if (error) {
    throw new Error(`OAuth error: ${error}${errorDescription ? ` - ${errorDescription}` : ''}`);
  }
  if (!code) {
    return { completed: false, reason: 'no_code' };
  }

  const storedState = loadJson(window.sessionStorage, AUTH_STATE_KEY, null);
  if (!storedState?.state || !storedState?.verifier) {
    throw new Error('Missing stored PKCE state. Start login from this browser tab first.');
  }
  if (storedState.state !== state) {
    throw new Error('OAuth state mismatch.');
  }
  if (!environment || !clientId || !redirectUri) {
    throw new Error('Environment, client ID, and redirect URI are required for token exchange.');
  }

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
      code_verifier: storedState.verifier,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error_description || payload?.message || `Token exchange failed with status ${response.status}.`);
  }

  const tokenInfo = {
    accessToken: payload.access_token,
    tokenType: payload.token_type || 'bearer',
    scope: payload.scope || settings.scopes,
    expiresIn: Number(payload.expires_in || 0),
    receivedAt: new Date().toISOString(),
  };

  saveJson(window.sessionStorage, ACCESS_TOKEN_KEY, tokenInfo);
  window.sessionStorage.removeItem(AUTH_STATE_KEY);
  clearCallbackQuery();

  return {
    completed: true,
    tokenInfo,
  };
}

export {
  AUTH_SETTINGS_KEY,
  DEFAULT_SCOPES,
  clearAuthState,
  completePkceCallback,
  getAccessToken,
  getCallbackPayload,
  getTokenInfo,
  hasCallbackPayload,
  loadAuthSettings,
  normalizeEnvironment,
  saveAuthSettings,
  startPkceLogin,
};
