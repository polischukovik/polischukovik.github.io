const BOT_AGGREGATE_QUERY = {
  groupBy: ['botId', 'botName', 'botFlowType', 'botFlowSubType'],
  metrics: ['nBotSessions', 'nBotSessionTurns', 'tBotSession'],
};

const MAX_DETAIL_PAGE_SIZE = 250;
const FLOW_LOOKUP_BATCH_SIZE = 50;
const TURNS_PER_BILLING_UNIT = 8;
const VOICE_BILLING_INCREMENT_SECONDS = 15;
const DIGITAL_BOT_BILLING_UNIT_PRICE_USD = 0;
const VOICE_BOT_PRICE_PER_MINUTE_USD = 0;
const DETAIL_RETENTION_DAYS = 10;
const CALIBRATION_ENABLED = true;
const CALIBRATION_DAYS = 7;

const divisionCache = new Map();

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

async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const requestError = new Error(`Request failed before receiving a response: ${String(error)}`);
    requestError.cause = error;
    throw requestError;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Request failed with status ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function postJson(url, accessToken, body) {
  return requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
}

async function getJson(url, accessToken) {
  return requestJson(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

function extractCollection(response) {
  if (Array.isArray(response?.entities)) return response.entities;
  if (Array.isArray(response?.results)) return response.results;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.bots)) return response.bots;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response)) return response;
  return [];
}

function normalizeAggregateGroup(group) {
  if (!group) {
    return {};
  }

  if (Array.isArray(group)) {
    return group.reduce((acc, item) => {
      if (!item) {
        return acc;
      }
      if (item.dimension && item.value !== undefined) {
        acc[item.dimension] = item.value;
        return acc;
      }
      if (item.name && item.value !== undefined) {
        acc[item.name] = item.value;
      }
      return acc;
    }, {});
  }

  return group;
}

function getMetricValue(metric) {
  if (typeof metric?.value === 'number') {
    return metric.value;
  }

  const stats = metric?.stats || {};
  const candidates = [
    stats.sum,
    stats.value,
    stats.count,
    stats.max,
    stats.min,
    metric?.sum,
    metric?.count,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number') {
      return candidate;
    }
  }

  return 0;
}

function extractAggregateMetrics(row) {
  const blocks = Array.isArray(row?.data) ? row.data : [row];
  const metrics = {};

  for (const block of blocks) {
    const blockMetrics = Array.isArray(block?.metrics) ? block.metrics : [];
    for (const metric of blockMetrics) {
      const metricName = metric?.metric || metric?.name;
      if (!metricName) {
        continue;
      }
      metrics[metricName] = (metrics[metricName] || 0) + getMetricValue(metric);
    }
  }

  return metrics;
}

function sumMetricsMatching(metrics, fragments) {
  return Object.entries(metrics).reduce((sum, [name, value]) => {
    const lowerName = name.toLowerCase();
    if (fragments.some((fragment) => lowerName.includes(fragment)) && typeof value === 'number') {
      return sum + value;
    }
    return sum;
  }, 0);
}

function guessSessionCount(metrics) {
  const preferred = [
    'nBotSessions',
    'nBotFlowSessions',
    'nSessions',
    'nSession',
    'oBotFlowSessions',
  ];

  for (const key of preferred) {
    if (typeof metrics[key] === 'number' && metrics[key] > 0) {
      return metrics[key];
    }
  }

  return sumMetricsMatching(metrics, ['session']);
}

function guessTurnCount(metrics) {
  const preferred = [
    'nBotSessionTurns',
    'nBotFlowTurns',
    'nTurns',
    'tTurns',
    'oBotFlowTurns',
  ];

  for (const key of preferred) {
    if (typeof metrics[key] === 'number' && metrics[key] > 0) {
      return metrics[key];
    }
  }

  return sumMetricsMatching(metrics, ['turn']);
}

function guessDurationMs(metrics) {
  if (typeof metrics.tBotSession === 'number' && metrics.tBotSession > 0) {
    return metrics.tBotSession;
  }

  return sumMetricsMatching(metrics, ['duration']);
}

function mergeMetricMaps(left, right) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = (merged[key] || 0) + value;
  }
  return merged;
}

function classifyBotFlow(type) {
  const normalized = String(type || '').toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === 'genesysdigitalbotflow'
    || normalized === 'genesysdigitalbotflows'
    || normalized === 'digitalbot'
    || (normalized.includes('digital') && normalized.includes('bot'))) {
    return 'digital';
  }

  if (normalized === 'bot'
    || normalized === 'genesysbotflow'
    || normalized === 'genesysdialogengine'
    || (normalized.includes('bot') && !normalized.includes('digital'))) {
    return 'voice';
  }

  return null;
}

function extractBotSeedsFromAggregates(response) {
  const rows = extractCollection(response);
  const byId = new Map();

  for (const row of rows) {
    const group = normalizeAggregateGroup(row?.group);
    const metrics = extractAggregateMetrics(row);
    const flowId = group.botFlowId || group.botId || group.flowId || group.id || null;
    if (!flowId) {
      continue;
    }

    const flowType = group.botFlowType || group.botFlowSubType || group.type || null;
    const billingKind = classifyBotFlow(flowType);
    if (!billingKind) {
      continue;
    }

    const seed = {
      id: flowId,
      name: group.botName || group.name || flowId,
      type: flowType,
      billingKind,
      aggregateSessionCount: guessSessionCount(metrics),
      aggregateTurnCount: guessTurnCount(metrics),
      aggregateDurationMs: guessDurationMs(metrics),
      aggregateMetrics: metrics,
      division: null,
    };

    if (!byId.has(flowId)) {
      byId.set(flowId, seed);
      continue;
    }

    const existing = byId.get(flowId);
    existing.aggregateSessionCount += seed.aggregateSessionCount;
    existing.aggregateTurnCount += seed.aggregateTurnCount;
    existing.aggregateDurationMs += seed.aggregateDurationMs;
    existing.aggregateMetrics = mergeMetricMaps(existing.aggregateMetrics, seed.aggregateMetrics);
    if (!existing.name && seed.name) {
      existing.name = seed.name;
    }
    if (!existing.type && seed.type) {
      existing.type = seed.type;
    }
    if (!existing.billingKind && seed.billingKind) {
      existing.billingKind = seed.billingKind;
    }
  }

  return Array.from(byId.values());
}

function extractAfterCursor(response) {
  const nextUri = response?.nextUri;
  if (!nextUri) {
    return null;
  }

  try {
    const url = new URL(nextUri, 'https://api.example.invalid');
    return url.searchParams.get('after');
  } catch {
    const match = nextUri.match(/[?&]after=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

function calculateBillableUnits(turnCount) {
  if (!turnCount || turnCount <= 0) {
    return 0;
  }

  return Math.ceil(turnCount / TURNS_PER_BILLING_UNIT);
}

function calculateMinimumBillableUnits(sessionCount, totalTurns) {
  if (sessionCount <= 0 && totalTurns <= 0) {
    return 0;
  }

  return Math.max(sessionCount || 0, calculateBillableUnits(totalTurns || 0));
}

function calculateVoiceBillableSecondsFromDurationMs(durationMs) {
  if (!durationMs || durationMs <= 0) {
    return VOICE_BILLING_INCREMENT_SECONDS;
  }

  return Math.ceil((durationMs / 1000) / VOICE_BILLING_INCREMENT_SECONDS) * VOICE_BILLING_INCREMENT_SECONDS;
}

function calculateMinimumVoiceBillableSeconds(sessionCount, totalDurationMs) {
  if (sessionCount <= 0 && totalDurationMs <= 0) {
    return 0;
  }

  const aggregateRoundedSeconds = Math.ceil((Math.max(totalDurationMs, 0) / 1000) / VOICE_BILLING_INCREMENT_SECONDS) * VOICE_BILLING_INCREMENT_SECONDS;
  const sessionFloorSeconds = Math.max(sessionCount, 0) * VOICE_BILLING_INCREMENT_SECONDS;
  return Math.max(sessionFloorSeconds, aggregateRoundedSeconds);
}

function roundVoiceBillableMinutes(totalBillableSeconds) {
  if (!totalBillableSeconds || totalBillableSeconds <= 0) {
    return 0;
  }

  return Math.round(totalBillableSeconds / 60);
}

function determineBillingMode(interval) {
  const [, end] = String(interval || '').split('/');
  const endDate = end ? new Date(end) : new Date();
  if (Number.isNaN(endDate.getTime())) {
    return 'recent';
  }

  const retentionCutoff = Date.now() - (DETAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return endDate.getTime() >= retentionCutoff ? 'recent' : 'historical';
}

function buildRecentCalibrationInterval(days) {
  const now = new Date();
  const lookbackDays = Math.max(days, 1);
  const start = new Date(now.getTime() - (lookbackDays * 24 * 60 * 60 * 1000));
  return `${start.toISOString()}/${now.toISOString()}`;
}

async function getAggregateSeedData(environment, accessToken, genesysCloudInterval) {
  const body = {
    interval: genesysCloudInterval,
    ...BOT_AGGREGATE_QUERY,
  };

  const response = await postJson(
    `${getApiBase(environment)}/api/v2/analytics/bots/aggregates/query`,
    accessToken,
    body
  );
  const flows = extractBotSeedsFromAggregates(response);
  await primeFlowDivisionCache(environment, accessToken, flows);

  if (flows.length > 0) {
    return {
      source: 'bot-aggregates',
      query: body,
      flows,
    };
  }

  throw new Error(
    'Bot aggregates query did not return usable flow seeds. Exact historical billing cannot be derived from the session endpoint alone because /analytics/botflows/{botFlowId}/sessions is also retained for only about 10 days.'
  );
}

function emptyExactDetail() {
  return {
    hasExactData: false,
    sessions: [],
    sessionCount: 0,
    totalTurns: 0,
    billableUnits: 0,
  };
}

function emptyVoiceDetail() {
  return {
    hasExactData: false,
    sessions: [],
    sessionCount: 0,
    totalDurationMs: 0,
    billableSeconds: 0,
  };
}

async function getFlowDefinition(environment, accessToken, flowId) {
  return getJson(`${getApiBase(environment)}/api/v2/flows/${encodeURIComponent(flowId)}`, accessToken);
}

async function getFlowDefinitionsBatch(environment, accessToken, flowIds) {
  if (!flowIds.length) {
    return [];
  }

  const url = new URL(`${getApiBase(environment)}/api/v2/flows`);
  url.searchParams.set('id', flowIds.join(','));
  const response = await getJson(url.toString(), accessToken);
  return extractCollection(response);
}

async function primeFlowDivisionCache(environment, accessToken, flows) {
  const idsToLoad = flows
    .map((flow) => flow?.id)
    .filter(Boolean)
    .filter((flowId) => !divisionCache.has(flowId));

  if (!idsToLoad.length) {
    return;
  }

  for (let index = 0; index < idsToLoad.length; index += FLOW_LOOKUP_BATCH_SIZE) {
    const batchIds = idsToLoad.slice(index, index + FLOW_LOOKUP_BATCH_SIZE);
    const unresolved = new Set(batchIds);

    try {
      const entities = await getFlowDefinitionsBatch(environment, accessToken, batchIds);
      for (const entity of entities) {
        if (!entity?.id) {
          continue;
        }

        const result = entity?.division
          ? {
              divisionId: entity.division.id || null,
              divisionName: entity.division.name || 'Unknown Division',
            }
          : {
              divisionId: null,
              divisionName: 'Unknown Division',
            };

        divisionCache.set(entity.id, result);
        unresolved.delete(entity.id);
      }
    } catch {
      // Fall back to individual lookups below.
    }

    for (const flowId of unresolved) {
      try {
        const entity = await getFlowDefinition(environment, accessToken, flowId);
        const result = entity?.division
          ? {
              divisionId: entity.division.id || null,
              divisionName: entity.division.name || 'Unknown Division',
            }
          : {
              divisionId: null,
              divisionName: 'Unknown Division',
            };
        divisionCache.set(flowId, result);
      } catch {
        divisionCache.set(flowId, {
          divisionId: null,
          divisionName: 'Unknown Division',
        });
      }
    }
  }
}

async function resolveFlowDivision(environment, accessToken, flow) {
  if (!flow?.id) {
    return {
      divisionId: null,
      divisionName: 'Unknown Division',
    };
  }

  if (flow?.division?.id || flow?.division?.name) {
    return {
      divisionId: flow.division.id || null,
      divisionName: flow.division.name || 'Unknown Division',
    };
  }

  if (divisionCache.has(flow.id)) {
    return divisionCache.get(flow.id);
  }

  let result = {
    divisionId: null,
    divisionName: 'Unknown Division',
  };

  try {
    const entity = await getFlowDefinition(environment, accessToken, flow.id);
    if (entity?.division) {
      result = {
        divisionId: entity.division.id || null,
        divisionName: entity.division.name || 'Unknown Division',
      };
    }
  } catch {
    result = {
      divisionId: null,
      divisionName: 'Unknown Division',
    };
  }

  divisionCache.set(flow.id, result);
  return result;
}

function getNumericTurnCount(entity) {
  const candidates = [
    entity?.turnCount,
    entity?.reportingTurnCount,
    entity?.totalTurns,
    entity?.nTurns,
    Array.isArray(entity?.turns) ? entity.turns.length : null,
    Array.isArray(entity?.reportingTurns) ? entity.reportingTurns.length : null,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && candidate > 0) {
      return candidate;
    }
  }

  return 0;
}

function extractReportingTurnSessions(response) {
  const entities = extractCollection(response);
  const sessions = [];

  for (const entity of entities) {
    if (entity?.sessionId) {
      sessions.push({
        sessionId: entity.sessionId,
        turnCount: 1,
      });
      continue;
    }

    const reportingTurns = Array.isArray(entity?.reportingTurns)
      ? entity.reportingTurns
      : Array.isArray(entity?.turns)
        ? entity.turns
        : Array.isArray(entity)
          ? entity
          : [];

    if (reportingTurns.length > 0) {
      sessions.push({
        sessionId: entity?.sessionId || entity?.id || entity?.session?.id || null,
        turnCount: reportingTurns.length,
      });
      continue;
    }

    const directTurnCount = getNumericTurnCount(entity);
    if ((entity?.sessionId || entity?.session?.id) && directTurnCount > 0) {
      sessions.push({
        sessionId: entity.sessionId || entity.session?.id || null,
        turnCount: directTurnCount,
      });
    }
  }

  return sessions;
}

async function getReportingTurnDetail(environment, accessToken, botFlowId, genesysCloudInterval) {
  const sessionUsageMap = new Map();
  let after;

  while (true) {
    const url = new URL(
      `${getApiBase(environment)}/api/v2/analytics/botflows/${encodeURIComponent(botFlowId)}/divisions/reportingturns`
    );
    url.searchParams.set('interval', genesysCloudInterval);
    url.searchParams.set('pageSize', String(MAX_DETAIL_PAGE_SIZE));
    if (after) {
      url.searchParams.set('after', after);
    }

    const response = await getJson(url.toString(), accessToken);
    const pageSessions = extractReportingTurnSessions(response);
    for (const session of pageSessions) {
      const sessionId = session.sessionId || `unknown-${botFlowId}-${sessionUsageMap.size + 1}`;
      const priorTurns = sessionUsageMap.get(sessionId) || 0;
      sessionUsageMap.set(sessionId, priorTurns + session.turnCount);
    }

    after = extractAfterCursor(response);
    if (!after) {
      break;
    }
  }

  const sessions = Array.from(sessionUsageMap.entries()).map(([sessionId, turnCount]) => ({
    sessionId,
    turnCount,
    billableUnits: calculateBillableUnits(turnCount),
  }));

  return {
    hasExactData: sessions.length > 0,
    sessions,
    sessionCount: sessions.length,
    totalTurns: sessions.reduce((sum, session) => sum + session.turnCount, 0),
    billableUnits: sessions.reduce((sum, session) => sum + session.billableUnits, 0),
  };
}

function extractVoiceSessions(response) {
  const entities = extractCollection(response);
  return entities
    .map((entity) => {
      const startedAt = Date.parse(entity?.dateCreated || '');
      const completedAt = Date.parse(entity?.dateCompleted || '');
      if (Number.isNaN(startedAt) || Number.isNaN(completedAt) || completedAt < startedAt) {
        return null;
      }

      const durationMs = Math.max(completedAt - startedAt, 0);
      const billableSeconds = calculateVoiceBillableSecondsFromDurationMs(durationMs);

      return {
        sessionId: entity?.id || entity?.sessionId || null,
        durationMs,
        durationSeconds: durationMs / 1000,
        billableSeconds,
      };
    })
    .filter(Boolean);
}

async function getVoiceSessionDetail(environment, accessToken, botFlowId, genesysCloudInterval) {
  const sessions = [];
  let after;

  while (true) {
    const url = new URL(
      `${getApiBase(environment)}/api/v2/analytics/botflows/${encodeURIComponent(botFlowId)}/sessions`
    );
    url.searchParams.set('interval', genesysCloudInterval);
    url.searchParams.set('pageSize', String(MAX_DETAIL_PAGE_SIZE));
    if (after) {
      url.searchParams.set('after', after);
    }

    const response = await getJson(url.toString(), accessToken);
    sessions.push(...extractVoiceSessions(response));

    after = extractAfterCursor(response);
    if (!after) {
      break;
    }
  }

  return {
    hasExactData: sessions.length > 0,
    sessions,
    sessionCount: sessions.length,
    totalDurationMs: sessions.reduce((sum, session) => sum + session.durationMs, 0),
    billableSeconds: sessions.reduce((sum, session) => sum + session.billableSeconds, 0),
  };
}

async function calculateDigitalFlowUsage(environment, accessToken, seed, genesysCloudInterval, options = {}) {
  const billingMode = options.billingMode || 'recent';
  const calibrationFactor = Number(options.calibrationFactor || 1);
  const division = await resolveFlowDivision(environment, accessToken, seed);
  const reportingTurnDetail = billingMode === 'recent'
    ? await getReportingTurnDetail(environment, accessToken, seed.id, genesysCloudInterval)
    : emptyExactDetail();

  let sessions = reportingTurnDetail.sessions;
  let sessionCount = reportingTurnDetail.sessionCount;
  let totalTurns = reportingTurnDetail.totalTurns;
  let exactBillableUnits = reportingTurnDetail.billableUnits;
  let minimumBillableUnits = reportingTurnDetail.billableUnits;
  let billableUnits = reportingTurnDetail.billableUnits;
  let billableUnitsSource = 'reportingturns';

  if (!reportingTurnDetail.hasExactData) {
    sessions = [];
    sessionCount = seed.aggregateSessionCount;
    totalTurns = seed.aggregateTurnCount;
    exactBillableUnits = 0;
    minimumBillableUnits = calculateMinimumBillableUnits(sessionCount, totalTurns);
    billableUnits = minimumBillableUnits;
    billableUnitsSource = minimumBillableUnits > 0 ? 'minimum-estimate' : 'aggregate-only';
  }

  const calibratedBillableUnits = billableUnitsSource === 'minimum-estimate' || billableUnitsSource === 'aggregate-only'
    ? billableUnits * calibrationFactor
    : billableUnits;

  return {
    flowId: seed.id,
    flowName: seed.name || seed.id,
    flowType: seed.type || null,
    divisionId: division.divisionId,
    divisionName: division.divisionName || 'Unknown Division',
    sessionCount,
    totalTurns,
    aggregateSessionCount: seed.aggregateSessionCount,
    aggregateTurnCount: seed.aggregateTurnCount,
    billableUnits,
    calibratedBillableUnits,
    exactBillableUnits,
    minimumBillableUnits,
    billableUnitsSource,
    estimatedCostUsd: calibratedBillableUnits * DIGITAL_BOT_BILLING_UNIT_PRICE_USD,
    sessions,
    aggregateMetrics: seed.aggregateMetrics,
  };
}

async function calculateVoiceFlowUsage(environment, accessToken, seed, genesysCloudInterval, options = {}) {
  const billingMode = options.billingMode || 'recent';
  const calibrationFactor = Number(options.calibrationFactor || 1);
  const division = await resolveFlowDivision(environment, accessToken, seed);
  const sessionDetail = billingMode === 'recent'
    ? await getVoiceSessionDetail(environment, accessToken, seed.id, genesysCloudInterval)
    : emptyVoiceDetail();

  let sessions = sessionDetail.sessions;
  let sessionCount = sessionDetail.sessionCount;
  let totalDurationMs = sessionDetail.totalDurationMs;
  let exactBillableSeconds = sessionDetail.billableSeconds;
  let minimumBillableSeconds = sessionDetail.billableSeconds;
  let billableSeconds = sessionDetail.billableSeconds;
  let calibratedBillableSeconds = sessionDetail.billableSeconds;
  let billableUnitsSource = 'sessions';

  if (!sessionDetail.hasExactData) {
    sessions = [];
    sessionCount = seed.aggregateSessionCount;
    totalDurationMs = seed.aggregateDurationMs;
    exactBillableSeconds = 0;
    minimumBillableSeconds = calculateMinimumVoiceBillableSeconds(sessionCount, totalDurationMs);
    billableSeconds = minimumBillableSeconds;
    calibratedBillableSeconds = minimumBillableSeconds * calibrationFactor;
    billableUnitsSource = minimumBillableSeconds > 0 ? 'minimum-estimate' : 'aggregate-only';
  }

  return {
    flowId: seed.id,
    flowName: seed.name || seed.id,
    flowType: seed.type || null,
    billingKind: 'voice',
    divisionId: division.divisionId,
    divisionName: division.divisionName || 'Unknown Division',
    sessionCount,
    totalDurationMs,
    aggregateSessionCount: seed.aggregateSessionCount,
    aggregateDurationMs: seed.aggregateDurationMs,
    billableSeconds,
    calibratedBillableSeconds,
    exactBillableSeconds,
    minimumBillableSeconds,
    billableUnitsSource,
    estimatedCostUsd: (calibratedBillableSeconds / 60) * VOICE_BOT_PRICE_PER_MINUTE_USD,
    sessions,
    aggregateMetrics: seed.aggregateMetrics,
  };
}

async function getSharedCalibrationSeedDataIfEnabled(environment, accessToken, billingMode, hasCalibrationCandidates = false) {
  if (!CALIBRATION_ENABLED || billingMode !== 'historical' || !hasCalibrationCandidates) {
    return {
      interval: null,
      seedData: null,
    };
  }

  const calibrationInterval = buildRecentCalibrationInterval(CALIBRATION_DAYS);

  try {
    const seedData = await getAggregateSeedData(environment, accessToken, calibrationInterval);
    return {
      interval: calibrationInterval,
      seedData,
    };
  } catch {
    return {
      interval: calibrationInterval,
      seedData: null,
    };
  }
}

async function getCalibrationDataIfEnabled(environment, accessToken, billingMode, digitalSeeds = [], calibrationSeedData = {}) {
  if (!CALIBRATION_ENABLED || billingMode !== 'historical' || digitalSeeds.length === 0) {
    return {
      applied: false,
      factor: 1,
      exactUnits: 0,
      minimumUnits: 0,
      interval: null,
    };
  }

  const calibrationInterval = calibrationSeedData.interval || buildRecentCalibrationInterval(CALIBRATION_DAYS);

  try {
    const seedData = calibrationSeedData.seedData || await getAggregateSeedData(environment, accessToken, calibrationInterval);
    const exactResults = [];
    const calibrationSeeds = seedData.flows.filter((seed) => seed.billingKind === 'digital');

    for (const seed of calibrationSeeds) {
      const result = await calculateDigitalFlowUsage(environment, accessToken, seed, calibrationInterval, {
        billingMode: 'recent',
        calibrationFactor: 1,
      });
      exactResults.push(result);
    }

    const exactUnits = exactResults.reduce((sum, item) => sum + item.exactBillableUnits, 0);
    const minimumUnits = exactResults.reduce((sum, item) => sum + item.billableUnits, 0);
    if (exactUnits > 0 && minimumUnits > 0) {
      return {
        applied: true,
        factor: exactUnits / minimumUnits,
        exactUnits,
        minimumUnits,
        interval: calibrationInterval,
      };
    }
  } catch {
    return {
      applied: false,
      factor: 1,
      exactUnits: 0,
      minimumUnits: 0,
      interval: calibrationInterval,
    };
  }

  return {
    applied: false,
    factor: 1,
    exactUnits: 0,
    minimumUnits: 0,
    interval: calibrationInterval,
  };
}

async function getVoiceCalibrationDataIfEnabled(environment, accessToken, billingMode, voiceSeeds = [], calibrationSeedData = {}) {
  if (!CALIBRATION_ENABLED || billingMode !== 'historical' || voiceSeeds.length === 0) {
    return {
      applied: false,
      factor: 1,
      exactSeconds: 0,
      minimumSeconds: 0,
      interval: null,
    };
  }

  const calibrationInterval = calibrationSeedData.interval || buildRecentCalibrationInterval(CALIBRATION_DAYS);

  try {
    const seedData = calibrationSeedData.seedData || await getAggregateSeedData(environment, accessToken, calibrationInterval);
    const calibrationSeeds = seedData.flows.filter((seed) => seed.billingKind === 'voice');
    const exactResults = [];

    for (const seed of calibrationSeeds) {
      const result = await calculateVoiceFlowUsage(environment, accessToken, seed, calibrationInterval, {
        billingMode: 'recent',
        calibrationFactor: 1,
      });
      exactResults.push(result);
    }

    const exactSeconds = exactResults.reduce((sum, item) => sum + item.exactBillableSeconds, 0);
    const minimumSeconds = calibrationSeeds.reduce(
      (sum, seed) => sum + calculateMinimumVoiceBillableSeconds(seed.aggregateSessionCount, seed.aggregateDurationMs),
      0
    );

    if (exactSeconds > 0 && minimumSeconds > 0) {
      return {
        applied: true,
        factor: exactSeconds / minimumSeconds,
        exactSeconds,
        minimumSeconds,
        interval: calibrationInterval,
      };
    }
  } catch {
    return {
      applied: false,
      factor: 1,
      exactSeconds: 0,
      minimumSeconds: 0,
      interval: calibrationInterval,
    };
  }

  return {
    applied: false,
    factor: 1,
    exactSeconds: 0,
    minimumSeconds: 0,
    interval: calibrationInterval,
  };
}

function buildSummary(flowResults) {
  const totalFlows = flowResults.length;
  const totalSessions = flowResults.reduce((sum, flow) => sum + flow.sessionCount, 0);
  const totalTurns = flowResults.reduce((sum, flow) => sum + flow.totalTurns, 0);
  const totalBillableUnits = flowResults.reduce((sum, flow) => sum + flow.billableUnits, 0);
  const calibratedBillableUnits = flowResults.reduce((sum, flow) => sum + flow.calibratedBillableUnits, 0);
  const exactBillableUnits = flowResults.reduce((sum, flow) => sum + flow.exactBillableUnits, 0);
  const estimatedBillableUnits = flowResults.reduce((sum, flow) => (
    flow.billableUnitsSource === 'minimum-estimate' || flow.billableUnitsSource === 'aggregate-only'
      ? sum + flow.billableUnits
      : sum
  ), 0);
  const exactFlows = flowResults.filter((flow) => flow.billableUnitsSource === 'reportingturns' || flow.billableUnitsSource === 'sessions').length;
  const estimatedFlows = flowResults.filter((flow) => flow.billableUnitsSource === 'minimum-estimate' || flow.billableUnitsSource === 'aggregate-only').length;
  const estimatedCostUsd = flowResults.reduce((sum, flow) => sum + flow.estimatedCostUsd, 0);

  return {
    totalFlows,
    totalSessions,
    totalTurns,
    totalBillableUnits,
    calibratedBillableUnits,
    exactBillableUnits,
    estimatedBillableUnits,
    exactFlows,
    estimatedFlows,
    estimatedCostUsd,
  };
}

function buildVoiceSummary(flowResults) {
  const totalFlows = flowResults.length;
  const totalSessions = flowResults.reduce((sum, flow) => sum + flow.sessionCount, 0);
  const totalDurationMs = flowResults.reduce((sum, flow) => sum + flow.totalDurationMs, 0);
  const minimumBillableSeconds = flowResults.reduce((sum, flow) => sum + flow.billableSeconds, 0);
  const exactBillableSeconds = flowResults.reduce((sum, flow) => sum + flow.exactBillableSeconds, 0);
  const calibratedBillableSeconds = flowResults.reduce((sum, flow) => sum + flow.calibratedBillableSeconds, 0);
  const estimatedBillableSeconds = flowResults.reduce((sum, flow) => (
    flow.billableUnitsSource === 'minimum-estimate' || flow.billableUnitsSource === 'aggregate-only'
      ? sum + flow.billableSeconds
      : sum
  ), 0);
  const estimatedCostUsd = flowResults.reduce((sum, flow) => sum + flow.estimatedCostUsd, 0);

  return {
    totalFlows,
    totalSessions,
    totalDurationMs,
    totalRuntimeMinutes: totalDurationMs / 60000,
    minimumBillableSeconds,
    minimumBillableMinutes: minimumBillableSeconds / 60,
    invoiceRoundedBillableMinutes: roundVoiceBillableMinutes(minimumBillableSeconds),
    calibratedBillableSeconds,
    calibratedBillableMinutes: calibratedBillableSeconds / 60,
    calibratedInvoiceRoundedBillableMinutes: roundVoiceBillableMinutes(calibratedBillableSeconds),
    exactBillableSeconds,
    exactBillableMinutes: exactBillableSeconds / 60,
    estimatedBillableSeconds,
    estimatedBillableMinutes: estimatedBillableSeconds / 60,
    estimatedCostUsd: roundVoiceBillableMinutes(minimumBillableSeconds) * VOICE_BOT_PRICE_PER_MINUTE_USD,
    allocationCostUsd: estimatedCostUsd,
  };
}

function aggregateByDivision(flowResults, options = {}) {
  const useCalibrated = Boolean(options.useCalibrated);
  const byDivision = flowResults.reduce((acc, flow) => {
    const divisionName = flow.divisionName || 'Unknown Division';
    if (!acc[divisionName]) {
      acc[divisionName] = {
        division: divisionName,
        flows: 0,
        sessions: 0,
        turns: 0,
        billableUnits: 0,
        calibratedBillableUnits: 0,
        exactBillableUnits: 0,
        estimatedBillableUnits: 0,
        estimatedCostUsd: 0,
      };
    }

    acc[divisionName].flows += 1;
    acc[divisionName].sessions += flow.sessionCount;
    acc[divisionName].turns += flow.totalTurns;
    acc[divisionName].billableUnits += useCalibrated ? flow.calibratedBillableUnits : flow.billableUnits;
    acc[divisionName].calibratedBillableUnits += flow.calibratedBillableUnits;
    acc[divisionName].exactBillableUnits += flow.exactBillableUnits;
    if (flow.billableUnitsSource === 'minimum-estimate' || flow.billableUnitsSource === 'aggregate-only') {
      acc[divisionName].estimatedBillableUnits += useCalibrated ? flow.calibratedBillableUnits : flow.billableUnits;
    }
    acc[divisionName].estimatedCostUsd += flow.estimatedCostUsd;
    return acc;
  }, {});

  const totalBillableUnits = Object.values(byDivision).reduce((sum, entry) => sum + entry.billableUnits, 0);

  return Object.values(byDivision)
    .map((entry) => ({
      division: entry.division,
      flows: entry.flows,
      sessions: entry.sessions,
      botSessionTurns: entry.turns,
      billableUnits: Number(entry.billableUnits.toFixed(2)),
      proportion: totalBillableUnits > 0 ? `${((entry.billableUnits / totalBillableUnits) * 100).toFixed(2)}%` : '0.00%',
      ...(DIGITAL_BOT_BILLING_UNIT_PRICE_USD > 0 ? { estimatedCostUsd: `$${entry.estimatedCostUsd.toFixed(4)}` } : {}),
    }))
    .sort((a, b) => b.billableUnits - a.billableUnits || a.division.localeCompare(b.division));
}

function formatFlowRows(flowResults, options = {}) {
  const totalBillableUnits = Number(options.totalBillableUnits || 0);
  const useCalibrated = Boolean(options.useCalibrated);
  const useExact = Boolean(options.useExact);
  const includeAggregateSessions = flowResults.some((flow) => flow.aggregateSessionCount !== flow.sessionCount);
  const includeAggregateTurns = flowResults.some((flow) => flow.aggregateTurnCount !== flow.totalTurns);
  const distinctSources = new Set(flowResults.map((flow) => flow.billableUnitsSource));
  const includeSource = distinctSources.size > 1;

  return [...flowResults]
    .sort((a, b) => selectDigitalBillableUnits(b, { useCalibrated, useExact }) - selectDigitalBillableUnits(a, { useCalibrated, useExact }) || a.flowName.localeCompare(b.flowName))
    .map((flow) => {
      const billableUnits = selectDigitalBillableUnits(flow, { useCalibrated, useExact });
      const row = {
        flowName: flow.flowName,
        division: flow.divisionName,
        sessions: flow.sessionCount,
        botSessionTurns: flow.totalTurns,
      };

      if (includeAggregateSessions) {
        row.aggregateSessions = flow.aggregateSessionCount;
      }
      if (includeAggregateTurns) {
        row.aggregateBotSessionTurns = flow.aggregateTurnCount;
      }

      row.billableUnits = useCalibrated ? billableUnits.toFixed(2) : billableUnits;
      if (includeSource) {
        row.source = flow.billableUnitsSource;
      }

      row.avgTurnsPerSession = flow.sessionCount > 0 ? (flow.totalTurns / flow.sessionCount).toFixed(2) : '0.00';
      row.proportion = totalBillableUnits > 0 ? `${((billableUnits / totalBillableUnits) * 100).toFixed(2)}%` : '0.00%';

      if (DIGITAL_BOT_BILLING_UNIT_PRICE_USD > 0) {
        row.estimatedCostUsd = `$${flow.estimatedCostUsd.toFixed(4)}`;
      }

      return row;
    });
}

function formatVoiceDivisionRows(flowResults, options = {}) {
  const useCalibrated = Boolean(options.useCalibrated);
  const byDivision = flowResults.reduce((acc, flow) => {
    const divisionName = flow.divisionName || 'Unknown Division';
    if (!acc[divisionName]) {
      acc[divisionName] = {
        division: divisionName,
        flows: 0,
        sessions: 0,
        runtimeMs: 0,
        billableSeconds: 0,
      };
    }

    acc[divisionName].flows += 1;
    acc[divisionName].sessions += flow.sessionCount;
    acc[divisionName].runtimeMs += flow.totalDurationMs;
    acc[divisionName].billableSeconds += useCalibrated ? flow.calibratedBillableSeconds : flow.billableSeconds;
    return acc;
  }, {});

  const totalBillableSeconds = Object.values(byDivision).reduce((sum, entry) => sum + entry.billableSeconds, 0);

  return Object.values(byDivision)
    .map((entry) => ({
      division: entry.division,
      flows: entry.flows,
      sessions: entry.sessions,
      runtimeMinutes: (entry.runtimeMs / 60000).toFixed(2),
      billableMinutes: (entry.billableSeconds / 60).toFixed(2),
      proportion: totalBillableSeconds > 0 ? `${((entry.billableSeconds / totalBillableSeconds) * 100).toFixed(2)}%` : '0.00%',
      ...(VOICE_BOT_PRICE_PER_MINUTE_USD > 0 ? { estimatedCostUsd: `$${((entry.billableSeconds / 60) * VOICE_BOT_PRICE_PER_MINUTE_USD).toFixed(4)}` } : {}),
    }))
    .sort((a, b) => Number.parseFloat(b.billableMinutes) - Number.parseFloat(a.billableMinutes) || a.division.localeCompare(b.division));
}

function formatVoiceFlowRows(flowResults, options = {}) {
  const totalBillableSeconds = Number(options.totalBillableSeconds || 0);
  const useCalibrated = Boolean(options.useCalibrated);
  const useExact = Boolean(options.useExact);
  const distinctSources = new Set(flowResults.map((flow) => flow.billableUnitsSource));
  const includeSource = distinctSources.size > 1;

  return [...flowResults]
    .sort((a, b) => selectVoiceBillableSeconds(b, { useCalibrated, useExact }) - selectVoiceBillableSeconds(a, { useCalibrated, useExact }) || a.flowName.localeCompare(b.flowName))
    .map((flow) => {
      const billableSeconds = selectVoiceBillableSeconds(flow, { useCalibrated, useExact });
      const row = {
        flowName: flow.flowName,
        division: flow.divisionName,
        sessions: flow.sessionCount,
        runtimeMinutes: (flow.totalDurationMs / 60000).toFixed(2),
        billableMinutes: (billableSeconds / 60).toFixed(2),
      };
      if (includeSource) {
        row.source = flow.billableUnitsSource;
      }

      row.proportion = totalBillableSeconds > 0 ? `${((billableSeconds / totalBillableSeconds) * 100).toFixed(2)}%` : '0.00%';

      if (VOICE_BOT_PRICE_PER_MINUTE_USD > 0) {
        row.estimatedCostUsd = `$${flow.estimatedCostUsd.toFixed(4)}`;
      }

      return row;
    });
}

function selectDigitalBillableUnits(flow, options = {}) {
  if (options.useExact) {
    return flow.exactBillableUnits;
  }
  if (options.useCalibrated) {
    return flow.calibratedBillableUnits;
  }
  return flow.billableUnits;
}

function selectVoiceBillableSeconds(flow, options = {}) {
  if (options.useExact) {
    return flow.exactBillableSeconds;
  }
  if (options.useCalibrated) {
    return flow.calibratedBillableSeconds;
  }
  return flow.billableSeconds;
}

function formatAggregateMetricTotals(flowResults) {
  const totals = {};

  for (const flow of flowResults) {
    for (const [metricName, value] of Object.entries(flow.aggregateMetrics || {})) {
      if (typeof value !== 'number') {
        continue;
      }
      totals[metricName] = (totals[metricName] || 0) + value;
    }
  }

  return Object.entries(totals)
    .map(([metric, value]) => ({
      metric,
      value,
    }))
    .sort((a, b) => b.value - a.value || a.metric.localeCompare(b.metric));
}

function formatSessionRows(flowResults) {
  const rows = [];

  for (const flow of flowResults) {
    for (const session of flow.sessions) {
      rows.push({
        flowName: flow.flowName,
        division: flow.divisionName,
        sessionId: session.sessionId,
        turns: session.turnCount ?? '',
        billableUnits: session.billableUnits ?? '',
      });
    }
  }

  if (!rows.length) {
    return [];
  }

  return rows.sort((a, b) => {
    const turnDelta = Number(b.turns || 0) - Number(a.turns || 0);
    if (turnDelta !== 0) {
      return turnDelta;
    }
    return a.flowName.localeCompare(b.flowName);
  });
}

function formatTable(data) {
  if (!data.length) {
    return 'No data to display.';
  }

  const headers = Object.keys(data[0]);
  const columnWidths = headers.map((header) => header.length);

  for (const row of data) {
    headers.forEach((header, index) => {
      const value = String(row[header] ?? '');
      columnWidths[index] = Math.max(columnWidths[index], value.length);
    });
  }

  const headerRow = headers.map((header, index) => header.padEnd(columnWidths[index])).join(' | ');
  const separator = headers.map((_, index) => '-'.repeat(columnWidths[index])).join('-|-');
  const dataRows = data
    .map((row) => headers.map((header, index) => String(row[header] ?? '').padEnd(columnWidths[index])).join(' | '))
    .join('\n');

  return `${headerRow}\n${separator}\n${dataRows}`;
}

function generateCombinedReport(
  digitalFlowResults,
  voiceFlowResults,
  digitalSummary,
  voiceSummary,
  aggregateSeedData,
  billingMode,
  digitalCalibration,
  voiceCalibration,
  genesysCloudInterval,
  humanReadableInterval
) {
  let reportContent = 'Genesys Cloud Bot Flow Cost Report\n';
  reportContent += `Report Interval: ${humanReadableInterval} (${genesysCloudInterval})\n`;
  reportContent += `Generated On: ${new Date().toISOString()}\n\n`;

  reportContent += 'Billing Model\n';
  reportContent += '-------------\n';
  reportContent += `- Primary discovery source: ${aggregateSeedData.source}.\n`;
  reportContent += `- Billing mode: ${billingMode}.\n`;
  reportContent += `- Digital bot billing: ceil(sessionTurns / ${TURNS_PER_BILLING_UNIT}) per session.\n`;
  reportContent += `- Voice bot billing: meter each session in ${VOICE_BILLING_INCREMENT_SECONDS}-second increments, then round the total metered minutes to the nearest whole minute.\n`;
  reportContent += '- Voice division/flow allocations use metered usage before final whole-minute invoice rounding.\n';
  if (digitalCalibration.applied) {
    reportContent += `- Digital historical estimates are scaled by calibration factor ${digitalCalibration.factor.toFixed(4)} from ${digitalCalibration.interval}.\n`;
  }
  if (voiceCalibration.applied) {
    reportContent += `- Voice historical estimates are scaled by calibration factor ${voiceCalibration.factor.toFixed(4)} from ${voiceCalibration.interval}.\n`;
  }
  reportContent += '\n';

  if (voiceFlowResults.length > 0) {
    reportContent += billingMode === 'recent'
      ? '--- Voice Billable Minutes by Division [Exact] ---\n'
      : voiceCalibration.applied
        ? '--- Voice Billable Minutes by Division [Calibrated] ---\n'
        : '--- Voice Billable Minutes by Division [Lower Bound] ---\n';
    reportContent += `${formatTable(formatVoiceDivisionRows(voiceFlowResults, {
      useCalibrated: billingMode === 'historical' && voiceCalibration.applied,
    }))}\n\n`;
  }

  if (digitalFlowResults.length > 0) {
    reportContent += billingMode === 'recent'
      ? '--- Digital Billable Units by Division [Exact] ---\n'
      : digitalCalibration.applied
        ? '--- Digital Billable Units by Division [Calibrated] ---\n'
        : '--- Digital Billable Units by Division [Lower Bound] ---\n';
    reportContent += `${formatTable(aggregateByDivision(digitalFlowResults, {
      useCalibrated: billingMode === 'historical' && digitalCalibration.applied,
    }))}\n\n`;
  }

  reportContent += '--- Overall Summary ---\n';
  reportContent += `Voice Bot Flows: ${voiceSummary.totalFlows}\n`;
  reportContent += `Digital Bot Flows: ${digitalSummary.totalFlows}\n`;
  if (billingMode === 'recent') {
    reportContent += `Voice Metered Billable Minutes [Exact]: ${voiceSummary.exactBillableMinutes.toFixed(2)}\n\n`;
  } else {
    reportContent += `Voice Billable Minutes [Lower Bound]: ${voiceSummary.minimumBillableMinutes.toFixed(2)}\n`;
    if (voiceCalibration.applied) {
      reportContent += `Voice Billable Minutes [Calibrated]: ${voiceSummary.calibratedBillableMinutes.toFixed(2)}\n`;
    }
  }
  if (billingMode === 'recent') {
    reportContent += `Digital Billable Units [Exact]: ${digitalSummary.exactBillableUnits}\n\n`;
  } else {
    reportContent += `Digital Billable Units [Lower Bound]: ${digitalSummary.totalBillableUnits}\n`;
    if (digitalCalibration.applied) {
      reportContent += `Digital Billable Units [Calibrated]: ${digitalSummary.calibratedBillableUnits.toFixed(2)}\n`;
    }
    reportContent += '\n';
  }

  reportContent += '--- Voice Summary ---\n';
  reportContent += `Total Sessions: ${voiceSummary.totalSessions}\n`;
  reportContent += `Total Runtime Minutes: ${voiceSummary.totalRuntimeMinutes.toFixed(2)}\n`;
  if (billingMode === 'recent') {
    reportContent += `Metered Billable Minutes [Exact]: ${voiceSummary.exactBillableMinutes.toFixed(2)}\n\n`;
  } else {
    reportContent += `Billable Minutes [Lower Bound]: ${voiceSummary.minimumBillableMinutes.toFixed(2)}\n`;
    if (voiceCalibration.applied) {
      reportContent += `Billable Minutes [Calibrated]: ${voiceSummary.calibratedBillableMinutes.toFixed(2)}\n`;
    }
    reportContent += '\n';
  }

  if (voiceFlowResults.length > 0) {
    reportContent += billingMode === 'recent'
      ? '--- Voice Flow Detail [Exact] ---\n'
      : voiceCalibration.applied
        ? '--- Voice Flow Detail [Calibrated] ---\n'
        : '--- Voice Flow Detail [Lower Bound] ---\n';
    reportContent += `${formatTable(formatVoiceFlowRows(voiceFlowResults, {
      totalBillableSeconds: billingMode === 'historical' && voiceCalibration.applied
        ? voiceSummary.calibratedBillableSeconds
        : billingMode === 'recent'
          ? voiceSummary.exactBillableSeconds
          : voiceSummary.minimumBillableSeconds,
      useCalibrated: billingMode === 'historical' && voiceCalibration.applied,
      useExact: billingMode === 'recent',
    }))}\n\n`;
  }

  reportContent += '--- Digital Summary ---\n';
  reportContent += `Total Sessions: ${digitalSummary.totalSessions}\n`;
  reportContent += `Total Bot Session Turns: ${digitalSummary.totalTurns}\n`;
  if (billingMode === 'recent') {
    reportContent += `Billable Units [Exact]: ${digitalSummary.exactBillableUnits}\n\n`;
  } else {
    reportContent += `Billable Units [Lower Bound]: ${digitalSummary.totalBillableUnits}\n`;
    if (digitalCalibration.applied) {
      reportContent += `Billable Units [Calibrated]: ${digitalSummary.calibratedBillableUnits.toFixed(2)}\n`;
    }
    reportContent += '\n';
  }

  if (digitalFlowResults.length > 0) {
    reportContent += billingMode === 'recent'
      ? '--- Digital Flow Detail [Exact] ---\n'
      : digitalCalibration.applied
        ? '--- Digital Flow Detail [Calibrated] ---\n'
        : '--- Digital Flow Detail [Lower Bound] ---\n';
    reportContent += `${formatTable(formatFlowRows(digitalFlowResults, {
      totalBillableUnits: billingMode === 'historical' && digitalCalibration.applied
        ? digitalSummary.calibratedBillableUnits
        : billingMode === 'recent'
          ? digitalSummary.exactBillableUnits
          : digitalSummary.totalBillableUnits,
      useCalibrated: billingMode === 'historical' && digitalCalibration.applied,
      useExact: billingMode === 'recent',
    }))}\n\n`;
    reportContent += '--- Digital Aggregate Metric Totals ---\n';
    reportContent += `${formatTable(formatAggregateMetricTotals(digitalFlowResults))}\n\n`;
    const digitalSessionRows = formatSessionRows(digitalFlowResults);
    if (digitalSessionRows.length > 0) {
      reportContent += '--- Digital Per-Session Detail ---\n';
      reportContent += `${formatTable(digitalSessionRows)}\n\n`;
    }
  }

  return reportContent;
}

function resolveInterval(input) {
  const raw = String(input || '').trim();
  const value = raw.toLowerCase();
  const now = new Date();

  const startOfUtcDay = (date) => new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0, 0, 0, 0
  ));

  if (raw.includes('/')) {
    const [left, right] = raw.split('/');
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(left) && /^\d{4}-\d{2}-\d{2}$/.test(right);
    if (isDateOnly) {
      const start = new Date(`${left}T00:00:00.000Z`);
      const endExclusive = new Date(`${right}T00:00:00.000Z`);
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
      return `${start.toISOString()}/${endExclusive.toISOString()}`;
    }
    return raw;
  }

  if (value === 'today') {
    const start = startOfUtcDay(now);
    const end = new Date(start.getTime() + (24 * 60 * 60 * 1000));
    return `${start.toISOString()}/${end.toISOString()}`;
  }

  if (value === 'yesterday') {
    const end = startOfUtcDay(now);
    const start = new Date(end.getTime() - (24 * 60 * 60 * 1000));
    return `${start.toISOString()}/${end.toISOString()}`;
  }

  if (value === 'thisweek') {
    const end = startOfUtcDay(now);
    const day = end.getUTCDay();
    const offset = day === 0 ? 6 : day - 1;
    const start = new Date(end.getTime() - (offset * 24 * 60 * 60 * 1000));
    const next = new Date(start.getTime() + (7 * 24 * 60 * 60 * 1000));
    return `${start.toISOString()}/${next.toISOString()}`;
  }

  if (value === 'lastweek') {
    const end = startOfUtcDay(now);
    const day = end.getUTCDay();
    const offset = day === 0 ? 6 : day - 1;
    const thisWeekStart = new Date(end.getTime() - (offset * 24 * 60 * 60 * 1000));
    const start = new Date(thisWeekStart.getTime() - (7 * 24 * 60 * 60 * 1000));
    return `${start.toISOString()}/${thisWeekStart.toISOString()}`;
  }

  if (value === 'thismonth') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    return `${start.toISOString()}/${end.toISOString()}`;
  }

  if (value === 'lastmonth') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    return `${start.toISOString()}/${end.toISOString()}`;
  }

  throw new Error(`Unsupported interval value "${input}". Use today, yesterday, thisweek, lastweek, thismonth, lastmonth, or an explicit interval.`);
}

function resolveHumanReadableInterval(input, resolvedInterval) {
  const raw = String(input || '').trim();
  const value = raw.toLowerCase();

  const labels = {
    today: 'Today',
    yesterday: 'Yesterday',
    thisweek: 'This Week',
    lastweek: 'Last Week',
    thismonth: 'This Month',
    lastmonth: 'Last Month',
  };

  if (labels[value]) {
    return labels[value];
  }

  return raw || resolvedInterval;
}

async function runBotflowCostAggregate({ environment, accessToken, intervalInput }) {
  if (!environment) {
    throw new Error('Genesys Cloud environment is required.');
  }
  if (!accessToken) {
    throw new Error('Access token is required.');
  }

  const interval = resolveInterval(intervalInput || 'yesterday');
  const billingMode = determineBillingMode(interval);
  const aggregateSeedData = await getAggregateSeedData(environment, accessToken, interval);
  const digitalSeeds = aggregateSeedData.flows.filter((seed) => seed.billingKind === 'digital');
  const voiceSeeds = aggregateSeedData.flows.filter((seed) => seed.billingKind === 'voice');
  const calibrationSeedData = await getSharedCalibrationSeedDataIfEnabled(
    environment,
    accessToken,
    billingMode,
    digitalSeeds.length > 0 || voiceSeeds.length > 0
  );
  const digitalCalibration = await getCalibrationDataIfEnabled(
    environment,
    accessToken,
    billingMode,
    digitalSeeds,
    calibrationSeedData
  );
  const voiceCalibration = await getVoiceCalibrationDataIfEnabled(
    environment,
    accessToken,
    billingMode,
    voiceSeeds,
    calibrationSeedData
  );

  const digitalFlowResults = [];
  const voiceFlowResults = [];

  for (const seed of digitalSeeds) {
    digitalFlowResults.push(await calculateDigitalFlowUsage(environment, accessToken, seed, interval, {
      billingMode,
      calibrationFactor: digitalCalibration.factor,
    }));
  }

  for (const seed of voiceSeeds) {
    voiceFlowResults.push(await calculateVoiceFlowUsage(environment, accessToken, seed, interval, {
      billingMode,
      calibrationFactor: voiceCalibration.factor,
    }));
  }

  const digitalSummary = buildSummary(digitalFlowResults);
  const voiceSummary = buildVoiceSummary(voiceFlowResults);
  const humanReadableInterval = resolveHumanReadableInterval(intervalInput, interval);
  const reportContent = generateCombinedReport(
    digitalFlowResults,
    voiceFlowResults,
    digitalSummary,
    voiceSummary,
    aggregateSeedData,
    billingMode,
    digitalCalibration,
    voiceCalibration,
    interval,
    humanReadableInterval
  );

  return {
    interval,
    humanReadableInterval,
    billingMode,
    reportContent,
    summary: {
      billingMode,
      digital: {
        totalFlows: digitalSummary.totalFlows,
        totalSessions: digitalSummary.totalSessions,
        totalBotSessionTurns: digitalSummary.totalTurns,
        minimumBillableUnits: digitalSummary.totalBillableUnits,
        exactBillableUnits: digitalSummary.exactBillableUnits,
        estimatedBillableUnits: digitalSummary.estimatedBillableUnits,
        calibratedBillableUnits: Number(digitalSummary.calibratedBillableUnits.toFixed(2)),
      },
      voice: {
        totalFlows: voiceSummary.totalFlows,
        totalSessions: voiceSummary.totalSessions,
        totalRuntimeMinutes: Number(voiceSummary.totalRuntimeMinutes.toFixed(2)),
        minimumBillableMinutes: Number(voiceSummary.minimumBillableMinutes.toFixed(2)),
        meteredBillableMinutes: Number(voiceSummary.minimumBillableMinutes.toFixed(2)),
        calibratedBillableMinutes: Number(voiceSummary.calibratedBillableMinutes.toFixed(2)),
        exactBillableMinutes: Number(voiceSummary.exactBillableMinutes.toFixed(2)),
        billedMinutesRounded: voiceSummary.invoiceRoundedBillableMinutes,
        calibratedBilledMinutesRounded: voiceSummary.calibratedInvoiceRoundedBillableMinutes,
        exactMeteredBillableMinutes: Number(voiceSummary.exactBillableMinutes.toFixed(2)),
        estimatedBillableMinutes: Number(voiceSummary.estimatedBillableMinutes.toFixed(2)),
        estimatedMeteredBillableMinutes: Number(voiceSummary.estimatedBillableMinutes.toFixed(2)),
      },
      aggregateSeedSource: aggregateSeedData.source,
      calibrationApplied: digitalCalibration.applied || voiceCalibration.applied,
      calibrationFactor: Number(digitalCalibration.factor.toFixed(4)),
      voiceCalibrationApplied: voiceCalibration.applied,
      voiceCalibrationFactor: Number(voiceCalibration.factor.toFixed(4)),
      billingUnitTurns: TURNS_PER_BILLING_UNIT,
      estimatedCostUsd: Number((digitalSummary.estimatedCostUsd + voiceSummary.estimatedCostUsd).toFixed(4)),
      hasConfiguredUnitPrice: false,
    },
  };
}

export {
  runBotflowCostAggregate,
  resolveInterval,
};
