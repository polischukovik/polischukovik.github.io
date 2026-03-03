const BOT_AGGREGATE_QUERY = {
  groupBy: ['botId', 'botName', 'botFlowType', 'botFlowSubType'],
  metrics: ['nBotSessions', 'nBotSessionTurns', 'tBotSession'],
};

const TURNS_PER_BILLING_UNIT = 8;
const VOICE_BILLING_INCREMENT_SECONDS = 15;

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

function buildFlowSeeds(response) {
  const rows = Array.isArray(response?.results) ? response.results : [];
  return rows
    .map((row) => {
      const group = normalizeAggregateGroup(row.group);
      const metrics = extractAggregateMetrics(row);
      const billingKind = classifyBotFlow(group.botFlowType || group.botFlowSubType);
      if (!billingKind) return null;

      const sessionCount = guessSessionCount(metrics);
      const turnCount = guessTurnCount(metrics);
      const durationMs = guessDurationMs(metrics);

      return {
        id: group.botId || group.botFlowId || null,
        name: group.botName || 'Unknown Bot Flow',
        flowType: group.botFlowType || null,
        flowSubType: group.botFlowSubType || null,
        billingKind,
        sessionCount,
        turnCount,
        durationMs,
      };
    })
    .filter(Boolean);
}

function summarizeFlows(flows, billingKind) {
  const scopedFlows = flows.filter((flow) => flow.billingKind === billingKind);

  if (billingKind === 'digital') {
    const totalSessions = scopedFlows.reduce((sum, flow) => sum + flow.sessionCount, 0);
    const totalTurns = scopedFlows.reduce((sum, flow) => sum + flow.turnCount, 0);
    const totalBillableUnits = scopedFlows.reduce(
      (sum, flow) => sum + calculateMinimumBillableUnits(flow.sessionCount, flow.turnCount),
      0
    );

    return {
      totalFlows: scopedFlows.length,
      totalSessions,
      totalTurns,
      totalBillableUnits,
    };
  }

  const totalSessions = scopedFlows.reduce((sum, flow) => sum + flow.sessionCount, 0);
  const totalDurationMs = scopedFlows.reduce((sum, flow) => sum + flow.durationMs, 0);
  const totalBillableSeconds = scopedFlows.reduce(
    (sum, flow) => sum + calculateMinimumVoiceBillableSeconds(flow.sessionCount, flow.durationMs),
    0
  );

  return {
    totalFlows: scopedFlows.length,
    totalSessions,
    totalDurationMs,
    totalRuntimeMinutes: totalDurationMs / 60000,
    minimumBillableSeconds: totalBillableSeconds,
    minimumBillableMinutes: totalBillableSeconds / 60,
    billedMinutesRounded: roundVoiceBillableMinutes(totalBillableSeconds),
  };
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

function buildDigitalDetailRows(flows, totalBillableUnits) {
  return flows
    .filter((flow) => flow.billingKind === 'digital')
    .sort((a, b) => calculateMinimumBillableUnits(b.sessionCount, b.turnCount) - calculateMinimumBillableUnits(a.sessionCount, a.turnCount))
    .map((flow) => {
      const billableUnits = calculateMinimumBillableUnits(flow.sessionCount, flow.turnCount);
      return {
        flowName: flow.name,
        flowType: flow.flowType || '-',
        sessions: flow.sessionCount,
        botSessionTurns: flow.turnCount,
        billableUnits,
        proportion: totalBillableUnits > 0 ? `${formatNumber((billableUnits / totalBillableUnits) * 100)}%` : '0.00%',
      };
    });
}

function buildVoiceDetailRows(flows, totalBillableSeconds) {
  return flows
    .filter((flow) => flow.billingKind === 'voice')
    .sort((a, b) => calculateMinimumVoiceBillableSeconds(b.sessionCount, b.durationMs) - calculateMinimumVoiceBillableSeconds(a.sessionCount, a.durationMs))
    .map((flow) => {
      const billableSeconds = calculateMinimumVoiceBillableSeconds(flow.sessionCount, flow.durationMs);
      const billableMinutes = billableSeconds / 60;
      return {
        flowName: flow.name,
        flowType: flow.flowType || '-',
        sessions: flow.sessionCount,
        runtimeMinutes: formatNumber(flow.durationMs / 60000),
        billableMinutes: formatNumber(billableMinutes),
        proportion: totalBillableSeconds > 0 ? `${formatNumber((billableSeconds / totalBillableSeconds) * 100)}%` : '0.00%',
      };
    });
}

function generateReport(interval, flows, digitalSummary, voiceSummary) {
  let report = 'Genesys Cloud Bot Flow Cost Report (Frontend-Only Aggregate Mode)\n';
  report += `Interval: ${interval}\n`;
  report += `Generated On: ${new Date().toISOString()}\n\n`;
  report += 'Billing Model: Aggregate-only lower bound. Exact recent-mode detail is not yet wired into this frontend shell.\n\n';

  report += '--- Overall Summary ---\n';
  report += `Voice Bot Flows: ${voiceSummary.totalFlows}\n`;
  report += `Voice Sessions: ${voiceSummary.totalSessions}\n`;
  report += `Voice Runtime Minutes: ${formatNumber(voiceSummary.totalRuntimeMinutes)}\n`;
  report += `Voice Billable Minutes [Lower Bound]: ${formatNumber(voiceSummary.minimumBillableMinutes)}\n`;
  report += `Voice Billed Minutes (Rounded): ${voiceSummary.billedMinutesRounded}\n`;
  report += `Digital Bot Flows: ${digitalSummary.totalFlows}\n`;
  report += `Digital Sessions: ${digitalSummary.totalSessions}\n`;
  report += `Digital Bot Session Turns: ${digitalSummary.totalTurns}\n`;
  report += `Digital Billable Units [Lower Bound]: ${digitalSummary.totalBillableUnits}\n\n`;

  report += '--- Voice Flow Detail [Lower Bound] ---\n';
  report += `${formatTable(buildVoiceDetailRows(flows, voiceSummary.minimumBillableSeconds))}\n\n`;

  report += '--- Digital Flow Detail [Lower Bound] ---\n';
  report += `${formatTable(buildDigitalDetailRows(flows, digitalSummary.totalBillableUnits))}\n`;

  return report;
}

function resolveInterval(input) {
  const value = String(input || '').trim().toLowerCase();
  const now = new Date();

  const startOfUtcDay = (date) => new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0, 0, 0, 0
  ));

  if (value.includes('/')) {
    const [left, right] = value.split('/');
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(left) && /^\d{4}-\d{2}-\d{2}$/.test(right);
    if (isDateOnly) {
      const start = new Date(`${left}T00:00:00.000Z`);
      const endExclusive = new Date(`${right}T00:00:00.000Z`);
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
      return `${start.toISOString()}/${endExclusive.toISOString()}`;
    }
    return value;
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

async function postJson(url, accessToken, body) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Request failed before receiving a response: ${String(error)}`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Request failed with status ${response.status}.`);
  }

  return payload;
}

async function runBotflowCostAggregate(options) {
  const { environment, accessToken, intervalInput } = options || {};
  if (!accessToken) {
    throw new Error('Access token is required.');
  }

  const interval = resolveInterval(intervalInput || 'yesterday');
  const body = {
    interval,
    ...BOT_AGGREGATE_QUERY,
  };

  const response = await postJson(
    `${getApiBase(environment)}/api/v2/analytics/bots/aggregates/query`,
    accessToken,
    body
  );
  const flows = buildFlowSeeds(response);
  const digitalSummary = summarizeFlows(flows, 'digital');
  const voiceSummary = summarizeFlows(flows, 'voice');
  const reportContent = generateReport(interval, flows, digitalSummary, voiceSummary);

  return {
    interval,
    reportContent,
    flows,
    summary: {
      mode: 'aggregate-only',
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
