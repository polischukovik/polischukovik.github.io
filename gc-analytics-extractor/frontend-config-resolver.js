import { parseFrontendConfigJson } from './frontend-config.js';

const CONFIG_WORKSPACE_NAME = 'gc-app-config';
const CONFIG_DOCUMENT_NAME = 'gc-analytics-extractor.json';
const CONFIG_POINTER_STORAGE_KEY = 'gc-analytics-extractor:config-pointer';

function normalizeEnvironment(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('Genesys Cloud environment is required.');
  }

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');
  return withoutProtocol.replace(/^(login|api)\./i, '');
}

function getApiBase(environment) {
  return `https://api.${normalizeEnvironment(environment)}`;
}

function loadCachedConfigPointer() {
  try {
    const raw = window.localStorage.getItem(CONFIG_POINTER_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.documentId || !parsed.workspaceId) return null;

    return parsed;
  } catch {
    return null;
  }
}

function saveCachedConfigPointer(pointer) {
  const normalized = {
    workspaceId: pointer.workspaceId,
    workspaceName: pointer.workspaceName || CONFIG_WORKSPACE_NAME,
    documentId: pointer.documentId,
    documentName: pointer.documentName || CONFIG_DOCUMENT_NAME,
    resolvedAt: pointer.resolvedAt || new Date().toISOString(),
  };

  window.localStorage.setItem(CONFIG_POINTER_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

function clearCachedConfigPointer() {
  window.localStorage.removeItem(CONFIG_POINTER_STORAGE_KEY);
}

async function fetchJsonWithBearer(url, accessToken) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload?.message || payload?.error || `Request failed with status ${response.status}.`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function fetchText(url) {
  const response = await fetch(url, { method: 'GET' });
  const text = await response.text();

  if (!response.ok) {
    const error = new Error(`Request failed with status ${response.status}.`);
    error.status = response.status;
    error.body = text;
    throw error;
  }

  return text;
}

function getWorkspaceNameMatcher() {
  return CONFIG_WORKSPACE_NAME.toLowerCase();
}

function getDocumentNameMatcher() {
  return CONFIG_DOCUMENT_NAME.toLowerCase();
}

async function discoverWorkspace(environment, accessToken) {
  const payload = await fetchJsonWithBearer(
    `${getApiBase(environment)}/api/v2/contentmanagement/workspaces`,
    accessToken
  );
  const entities = Array.isArray(payload.entities) ? payload.entities : [];
  const workspaceName = getWorkspaceNameMatcher();
  const matches = entities.filter(
    (entity) => String(entity?.name || '').toLowerCase() === workspaceName
  );

  if (matches.length === 0) {
    throw new Error(`Config workspace "${CONFIG_WORKSPACE_NAME}" was not found.`);
  }
  if (matches.length > 1) {
    throw new Error(`Config workspace "${CONFIG_WORKSPACE_NAME}" is ambiguous.`);
  }

  return matches[0];
}

async function discoverDocument(environment, accessToken, workspaceId) {
  const payload = await fetchJsonWithBearer(
    `${getApiBase(environment)}/api/v2/contentmanagement/workspaces/${encodeURIComponent(workspaceId)}/documents`,
    accessToken
  );
  const entities = Array.isArray(payload.entities) ? payload.entities : [];
  const documentName = getDocumentNameMatcher();
  const matches = entities.filter(
    (entity) => String(entity?.name || '').toLowerCase() === documentName
  );

  if (matches.length === 0) {
    throw new Error(`Config document "${CONFIG_DOCUMENT_NAME}" was not found in workspace "${CONFIG_WORKSPACE_NAME}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Config document "${CONFIG_DOCUMENT_NAME}" is ambiguous in workspace "${CONFIG_WORKSPACE_NAME}".`);
  }

  return matches[0];
}

async function discoverConfigPointer(environment, accessToken) {
  const workspace = await discoverWorkspace(environment, accessToken);
  const document = await discoverDocument(environment, accessToken, workspace.id);

  return saveCachedConfigPointer({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    documentId: document.id,
    documentName: document.name,
    resolvedAt: new Date().toISOString(),
  });
}

async function fetchConfigDocumentContent(environment, accessToken, documentId) {
  const downloadInfo = await fetchJsonWithBearer(
    `${getApiBase(environment)}/api/v2/contentmanagement/documents/${encodeURIComponent(documentId)}/content`,
    accessToken
  );
  const contentUrl = downloadInfo?.contentLocationUri;

  if (!contentUrl) {
    throw new Error('Config document content did not return a contentLocationUri.');
  }

  return fetchText(contentUrl);
}

async function loadFrontendConfig(options) {
  const { environment, accessToken, forceRediscovery = false } = options || {};

  if (!accessToken) {
    throw new Error('Access token is required.');
  }

  let pointer = forceRediscovery ? null : loadCachedConfigPointer();
  let source = pointer ? 'cache' : 'discovery';

  if (!pointer) {
    pointer = await discoverConfigPointer(environment, accessToken);
  }

  let rawJson;
  try {
    rawJson = await fetchConfigDocumentContent(environment, accessToken, pointer.documentId);
  } catch (error) {
    const shouldRetryDiscovery =
      !forceRediscovery && (error?.status === 404 || error?.status === 403 || error?.status === 400);

    if (!shouldRetryDiscovery) {
      throw error;
    }

    pointer = await discoverConfigPointer(environment, accessToken);
    source = 'rediscovery';
    rawJson = await fetchConfigDocumentContent(environment, accessToken, pointer.documentId);
  }

  const config = parseFrontendConfigJson(rawJson);

  return {
    source,
    pointer,
    config,
    rawJson,
  };
}

export {
  CONFIG_DOCUMENT_NAME,
  CONFIG_POINTER_STORAGE_KEY,
  CONFIG_WORKSPACE_NAME,
  clearCachedConfigPointer,
  discoverConfigPointer,
  loadCachedConfigPointer,
  loadFrontendConfig,
  saveCachedConfigPointer,
};
