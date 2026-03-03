const BOT_AGGREGATE_QUERY = {
  groupBy: ['botId', 'botName', 'botFlowType', 'botFlowSubType'],
  metrics: ['nBotSessions', 'nBotSessionTurns', 'tBotSession'],
};

const MAX_DETAIL_PAGE_SIZE = 250;
const TURNS_PER_BILLING_UNIT = 8;
const VOICE_BILLING_INCREMENT_SECONDS = 15;
const DETAIL_RETENTION_DAYS = 10;

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

function normalizeAggregateGroup(group) {
  if (!group) return {};

  if (Array.isArray(group)) {
    return group.reduce((acc, item) => {
      if (!item) return acc;
      if (item.dimension && item.value !== undefined) {
        acc[item.dimension] = item.value;
      } else if (item.name && item.value !== undefined) {
        acc[item.name] = item.value;
      }
      return acc;
    }, {});
  }

  return group;
}

function getMetricValue(metric) {
  if (typeof metric?.value === 'number') return metric.value;

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
      const name = metric?.metric || metric?.name;
      if (!name) continue;
      metrics[name] = (metrics[name] || 0) + getMetricValue(metric);
    }
  }

  return metrics;
}

function sumMetricsMatching(metrics, fragments) {
  return Object.entries(metrics).reduce((sum, [name, value]) => {
    if (typeof value !== 'number') return sum;
    const lower = name.toLowerCase();
    return fragments.some((fragment) => lower.includes(fragment)) ? sum + value : sum;
  }, 0);
}

function guessSessionCount(metrics) {
  const preferred = ['nBotSessions', 'nBotFlowSessions', 'nSessions', 'nSession', 'oBotFlowSessions'];

  for (const key of preferred) {
    if (typeof metrics[key] === 'number' && metrics[key] > 0) {
      return metrics[key];
    }
  }

  return sumMetricsMatching(metrics, ['session']);
}

function guessTurnCount(metrics) {
  const preferred = ['nBotSessionTurns', 'nBotFlowTurns', 'nTurns', 'tTurns', 'oBotFlowTurns'];

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

function classifyBotFlow(type) {
  const normalized = String(type || '').toLowerCase();
  if (!normalized) return null;

  if (
    normalized === 'genesysdigitalbotflow'
    || normalized === 'genesysdigitalbotflows'
    || normalized === 'digitalbot'
    || (normalized.includes('digital') && normalized.includes('bot'))
  ) {
    return 'digital';
  }

  if (
    normalized === 'bot'
    || normalized === 'genesysbotflow'
    || normalized === 'genesysdialogengine'
    || (normalized.includes('bot') && !normalized.includes('digital'))
  ) {
    return 'voice';
  }

  return null;
}

function calculateBillableUnits(turnCount) {
  if (!turnCount || turnCount <= 0) return 0;
  return Math.ceil(turnCount / TURNS_PER_BILLING_UNIT);
}

function calculateMinimumBillableUnits(sessionCount, totalTurns) {
  if (sessionCount <= 0 && totalTurns <= 0) return 0;
  return Math.max(sessionCount, Math.ceil(totalTurns / TURNS_PER_BILLING_UNIT));
}

function roundUpToIncrement(totalSeconds, incrementSeconds) {
  if (totalSeconds <= 0) return 0;
  return Math.ceil(totalSeconds / incrementSeconds) * incrementSeconds;
}

function calculateMinimumVoiceBillableSeconds(sessionCount, totalDurationMs) {
  if (sessionCount <= 0 && totalDurationMs <= 0) return 0;

  const minBySessions = sessionCount * VOICE_BILLING_INCREMENT_SECONDS;
  const totalSeconds = totalDurationMs / 1000;
  const minByDuration = roundUpToIncrement(totalSeconds, VOICE_BILLING_INCREMENT_SECONDS);
  return Math.max(minBySessions, minByDuration);
}

function roundVoiceBillableMinutes(totalSeconds) {
  return Math.round(totalSeconds / 60);
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

function buildFlowSeeds(response) {
  const rows = Array.isArray(response?.results) ? response.results : [];
  return rows
    .map((row) => {
      const group = normalizeAggregateGroup(row.group);
      const metrics = extractAggregateMetrics(row);
      const billingKind = classifyBotFlow(group.botFlowType || group.botFlowSubType);
      if (!billingKind) return null;

      const aggregateSessionCount = guessSessionCount(metrics);
      const aggregateTurnCount = guessTurnCount(metrics);
      const aggregateDurationMs = guessDurationMs(metrics);

      return {
        id: group.botId || group.botFlowId || null,
        name: group.botName || 'Unknown Bot Flow',
        flowType: group.botFlowType || null,
        flowSubType: group.botFlowSubType || null,
        billingKind,
        aggregateSessionCount,
        aggregateTurnCount,
        aggregateDurationMs,
      };
    })
    .filter(Boolean);
}

function formatNumber(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function formatTable(rows) {
  if (!rows.length) return 'No data to display.';

  const headers = Object.keys(rows[0]);
  const widths = headers.map((header) => header.length);

  for (const row of rows) {
    headers.forEach((header, index) => {
      widths[index] = Math.max(widths[index], String(row[header]).length);
    });
  }

  const renderRow = (row) => headers.map((header, index) => String(row[header]).padEnd(widths[index])).join(' | ');
  const separator = widths.map((width) => '-'.repeat(width)).join('-|-');

  return [
    renderRow(headers.reduce((acc, header) => ({ ...acc, [header]: header }), {})),
    separator,
    ...rows.map(renderRow),
  ].join('\n');
}

function extractAfterCursor(response) {
  const nextUri = response?.nextUri;
  if (!nextUri) return null;

  try {
    const url = new URL(nextUri, 'https://api.example.invalid');
    return url.searchParams.get('after');
  } catch {
    const match = nextUri.match(/[?&]after=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(`Request failed before receiving a response: ${String(error)}`);
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
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response)) return response;
  return [];
}

function extractReportingTurnSessions(response) {
  const entities = extractCollection(response);
  return entities
    .map((entity, index) => {
      const sessionId = entity?.sessionId || null;
      if (!sessionId) return null;

      const turnCount = typeof entity?.turnCount === 'number'
        ? entity.turnCount
        : typeof entity?.reportingTurnCount === 'number'
          ? entity.reportingTurnCount
          : 1;

      return {
        sessionId,
        turnCount,
        rowId: entity?.id || `${sessionId}-${index}`,
      };
    })
    .filter(Boolean);
}

function extractVoiceSessions(response) {
  const entities = extractCollection(response);
  return entities
    .map((entity, index) => {
      const start = entity?.dateCreated ? new Date(entity.dateCreated) : null;
      const end = entity?.dateCompleted ? new Date(entity.dateCompleted) : null;
      if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return null;
      }

      const durationMs = Math.max(0, end.getTime() - start.getTime());
      const billableSeconds = roundUpToIncrement(durationMs / 1000, VOICE_BILLING_INCREMENT_SECONDS);

      return {
        sessionId: entity?.id || entity?.sessionId || `session-${index}`,
        durationMs,
        billableSeconds,
      };
    })
    .filter(Boolean);
}

async function getReportingTurnDetail(environment, accessToken, botFlowId, interval) {
  const sessionUsageMap = new Map();
  let after = null;

  while (true) {
    const url = new URL(
      `${getApiBase(environment)}/api/v2/analytics/botflows/${encodeURIComponent(botFlowId)}/divisions/reportingturns`
    );
    url.searchParams.set('interval', interval);
    url.searchParams.set('pageSize', String(MAX_DETAIL_PAGE_SIZE));
    if (after) url.searchParams.set('after', after);

    const response = await getJson(url.toString(), accessToken);
    const pageSessions = extractReportingTurnSessions(response);
    for (const session of pageSessions) {
      sessionUsageMap.set(session.sessionId, (sessionUsageMap.get(session.sessionId) || 0) + session.turnCount);
    }

    after = extractAfterCursor(response);
    if (!after) break;
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

async function getVoiceSessionDetail(environment, accessToken, botFlowId, interval) {
  const sessions = [];
  let after = null;

  while (true) {
    const url = new URL(
      `${getApiBase(environment)}/api/v2/analytics/botflows/${encodeURIComponent(botFlowId)}/sessions`
    );
    url.searchParams.set('interval', interval);
    url.searchParams.set('pageSize', String(MAX_DETAIL_PAGE_SIZE));
    if (after) url.searchParams.set('after', after);

    const response = await getJson(url.toString(), accessToken);
    sessions.push(...extractVoiceSessions(response));

    after = extractAfterCursor(response);
    if (!after) break;
  }

  return {
    hasExactData: sessions.length > 0,
    sessions,
    sessionCount: sessions.length,
    totalDurationMs: sessions.reduce((sum, session) => sum + session.durationMs, 0),
    billableSeconds: sessions.reduce((sum, session) => sum + session.billableSeconds, 0),
  };
}

async function enrichFlow(environment, accessToken, seed, interval, billingMode) {
  if (seed.billingKind === 'digital') {
    const aggregateUnits = calculateMinimumBillableUnits(seed.aggregateSessionCount, seed.aggregateTurnCount);

    if (billingMode === 'recent') {
      try {
        const detail = await getReportingTurnDetail(environment, accessToken, seed.id, interval);
        if (detail.hasExactData) {
          return {
            ...seed,
            sessionCount: detail.sessionCount,
            turnCount: detail.totalTurns,
            billableUnits: detail.billableUnits,
            billableUnitsSource: 'reportingturns',
          };
        }
      } catch (error) {
        // Fall back to aggregate lower bound for this flow.
      }
    }

    return {
      ...seed,
      sessionCount: seed.aggregateSessionCount,
      turnCount: seed.aggregateTurnCount,
      billableUnits: aggregateUnits,
      billableUnitsSource: 'aggregate-lower-bound',
    };
  }

  const aggregateSeconds = calculateMinimumVoiceBillableSeconds(seed.aggregateSessionCount, seed.aggregateDurationMs);

  if (billingMode === 'recent') {
    try {
      const detail = await getVoiceSessionDetail(environment, accessToken, seed.id, interval);
      if (detail.hasExactData) {
        return {
          ...seed,
          sessionCount: detail.sessionCount,
          durationMs: detail.totalDurationMs,
          billableSeconds: detail.billableSeconds,
          billableUnitsSource: 'sessions',
        };
      }
    } catch (error) {
      // Fall back to aggregate lower bound for this flow.
    }
  }

  return {
    ...seed,
    sessionCount: seed.aggregateSessionCount,
    durationMs: seed.aggregateDurationMs,
    billableSeconds: aggregateSeconds,
    billableUnitsSource: 'aggregate-lower-bound',
  };
}

function summarizeDigitalFlows(flows) {
  const scopedFlows = flows.filter((flow) => flow.billingKind === 'digital');
  return {
    totalFlows: scopedFlows.length,
    totalSessions: scopedFlows.reduce((sum, flow) => sum + flow.sessionCount, 0),
    totalTurns: scopedFlows.reduce((sum, flow) => sum + flow.turnCount, 0),
    totalBillableUnits: scopedFlows.reduce((sum, flow) => sum + flow.billableUnits, 0),
    exactFlows: scopedFlows.filter((flow) => flow.billableUnitsSource === 'reportingturns').length,
  };
}

function summarizeVoiceFlows(flows) {
  const scopedFlows = flows.filter((flow) => flow.billingKind === 'voice');
  const totalBillableSeconds = scopedFlows.reduce((sum, flow) => sum + flow.billableSeconds, 0);
  const totalDurationMs = scopedFlows.reduce((sum, flow) => sum + flow.durationMs, 0);

  return {
    totalFlows: scopedFlows.length,
    totalSessions: scopedFlows.reduce((sum, flow) => sum + flow.sessionCount, 0),
    totalDurationMs,
    totalRuntimeMinutes: totalDurationMs / 60000,
    totalBillableSeconds,
    totalBillableMinutes: totalBillableSeconds / 60,
    billedMinutesRounded: roundVoiceBillableMinutes(totalBillableSeconds),
    exactFlows: scopedFlows.filter((flow) => flow.billableUnitsSource === 'sessions').length,
  };
}

function buildDigitalDetailRows(flows, totalBillableUnits) {
  return flows
    .filter((flow) => flow.billingKind === 'digital')
    .sort((a, b) => b.billableUnits - a.billableUnits)
    .map((flow) => ({
      flowName: flow.name,
      flowType: flow.flowType || '-',
      sessions: flow.sessionCount,
      botSessionTurns: flow.turnCount,
      billableUnits: flow.billableUnits,
      source: flow.billableUnitsSource,
      proportion: totalBillableUnits > 0 ? `${formatNumber((flow.billableUnits / totalBillableUnits) * 100)}%` : '0.00%',
    }));
}

function buildVoiceDetailRows(flows, totalBillableSeconds) {
  return flows
    .filter((flow) => flow.billingKind === 'voice')
    .sort((a, b) => b.billableSeconds - a.billableSeconds)
    .map((flow) => ({
      flowName: flow.name,
      flowType: flow.flowType || '-',
      sessions: flow.sessionCount,
      runtimeMinutes: formatNumber(flow.durationMs / 60000),
      billableMinutes: formatNumber(flow.billableSeconds / 60),
      source: flow.billableUnitsSource,
      proportion: totalBillableSeconds > 0 ? `${formatNumber((flow.billableSeconds / totalBillableSeconds) * 100)}%` : '0.00%',
    }));
}

function generateReport(interval, billingMode, flows, digitalSummary, voiceSummary) {
  const recent = billingMode === 'recent';
  let report = 'Genesys Cloud Bot Flow Cost Report (Frontend-Only)\n';
  report += `Interval: ${interval}\n`;
  report += `Generated On: ${new Date().toISOString()}\n`;
  report += `Mode: ${billingMode}\n\n`;
  report += recent
    ? 'Billing Model: Recent mode. Exact detail is used when available; aggregate lower-bound is used per flow as fallback.\n\n'
    : 'Billing Model: Historical mode. Aggregate-only lower bound.\n\n';

  report += '--- Overall Summary ---\n';
  report += `Voice Bot Flows: ${voiceSummary.totalFlows}\n`;
  report += `Voice Sessions: ${voiceSummary.totalSessions}\n`;
  report += `Voice Runtime Minutes: ${formatNumber(voiceSummary.totalRuntimeMinutes)}\n`;
  report += recent
    ? `Voice Billable Minutes [Exact Where Available]: ${formatNumber(voiceSummary.totalBillableMinutes)}\n`
    : `Voice Billable Minutes [Lower Bound]: ${formatNumber(voiceSummary.totalBillableMinutes)}\n`;
  report += `Voice Billed Minutes (Rounded): ${voiceSummary.billedMinutesRounded}\n`;
  if (recent) {
    report += `Voice Exact Flows: ${voiceSummary.exactFlows}/${voiceSummary.totalFlows}\n`;
  }
  report += `Digital Bot Flows: ${digitalSummary.totalFlows}\n`;
  report += `Digital Sessions: ${digitalSummary.totalSessions}\n`;
  report += `Digital Bot Session Turns: ${digitalSummary.totalTurns}\n`;
  report += recent
    ? `Digital Billable Units [Exact Where Available]: ${digitalSummary.totalBillableUnits}\n`
    : `Digital Billable Units [Lower Bound]: ${digitalSummary.totalBillableUnits}\n`;
  if (recent) {
    report += `Digital Exact Flows: ${digitalSummary.exactFlows}/${digitalSummary.totalFlows}\n`;
  }
  report += '\n';

  report += recent
    ? '--- Voice Flow Detail [Exact Where Available] ---\n'
    : '--- Voice Flow Detail [Lower Bound] ---\n';
  report += `${formatTable(buildVoiceDetailRows(flows, voiceSummary.totalBillableSeconds))}\n\n`;

  report += recent
    ? '--- Digital Flow Detail [Exact Where Available] ---\n'
    : '--- Digital Flow Detail [Lower Bound] ---\n';
  report += `${formatTable(buildDigitalDetailRows(flows, digitalSummary.totalBillableUnits))}\n`;

  return report;
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

  throw new Error(`Unsupported interval value "${input}". Use today, yesterday, thismonth, lastmonth, or an explicit interval.`);
}

async function runBotflowCostAggregate(options) {
  const { environment, accessToken, intervalInput } = options || {};
  if (!accessToken) {
    throw new Error('Access token is required.');
  }

  const interval = resolveInterval(intervalInput || 'yesterday');
  const billingMode = determineBillingMode(interval);
  const body = {
    interval,
    ...BOT_AGGREGATE_QUERY,
  };

  const response = await postJson(
    `${getApiBase(environment)}/api/v2/analytics/bots/aggregates/query`,
    accessToken,
    body
  );
  const seeds = buildFlowSeeds(response);
  const flows = [];

  for (const seed of seeds) {
    flows.push(await enrichFlow(environment, accessToken, seed, interval, billingMode));
  }

  const digitalSummary = summarizeDigitalFlows(flows);
  const voiceSummary = summarizeVoiceFlows(flows);
  const reportContent = generateReport(interval, billingMode, flows, digitalSummary, voiceSummary);

  return {
    interval,
    billingMode,
    reportContent,
    flows,
    summary: {
      mode: billingMode,
      digital: digitalSummary,
      voice: voiceSummary,
      totalFlows: flows.length,
    },
  };
}

export {
  runBotflowCostAggregate,
  resolveInterval,
};
