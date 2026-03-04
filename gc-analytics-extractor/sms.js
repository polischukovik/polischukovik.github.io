import {
  MRP_PRICING_USD,
  countryTypeToRateClass,
  numberToDivisionMap,
  INBOUND_SMS_PRICING_USD,
  OUTBOUND_SMS_PRICING_USD,
  countryTypeToRateClassInbound,
  countryTypeToRateClassOutbound,
} from './sms-config.js';
import { mergeSmsCostConfig } from './config.js';

const entityCache = new Map();

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

async function getJson(url, accessToken) {
  return requestJson(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
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

function extractCollection(response) {
  if (Array.isArray(response?.entities)) return response.entities;
  if (Array.isArray(response?.results)) return response.results;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.conversations)) return response.conversations;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response)) return response;
  return [];
}

async function getEntity(environment, accessToken, entityType, entityId) {
  switch (entityType) {
    case 'flow':
      return getJson(`${getApiBase(environment)}/api/v2/flows/${encodeURIComponent(entityId)}`, accessToken);
    case 'queue':
      return getJson(`${getApiBase(environment)}/api/v2/routing/queues/${encodeURIComponent(entityId)}`, accessToken);
    case 'user':
      return getJson(`${getApiBase(environment)}/api/v2/users/${encodeURIComponent(entityId)}`, accessToken);
    case 'campaign':
      return getJson(`${getApiBase(environment)}/api/v2/outbound/campaigns/${encodeURIComponent(entityId)}`, accessToken);
    case 'division':
      return getJson(`${getApiBase(environment)}/api/v2/authorization/divisions/${encodeURIComponent(entityId)}`, accessToken);
    default:
      return null;
  }
}

async function getDivisionDetails(environment, accessToken, entityType, entityId) {
  if (!entityId) {
    return { divisionId: null, divisionName: null, entity: null, entityName: null };
  }

  const cacheKey = `${entityType}-${entityId}`;
  if (entityCache.has(cacheKey)) {
    return entityCache.get(cacheKey);
  }

  let division = { divisionId: null, divisionName: null };
  let entity = null;

  try {
    entity = await getEntity(environment, accessToken, entityType, entityId);
    if (entity) {
      if (entityType === 'division') {
        division = {
          divisionId: entity.id,
          divisionName: entity.name,
        };
      } else if (entity.division) {
        division = {
          divisionId: entity.division.id,
          divisionName: entity.division.name,
        };
      }
    }
  } catch {
    division = { divisionId: null, divisionName: null };
    entity = null;
  }

  const result = {
    divisionId: division.divisionId,
    divisionName: division.divisionName,
    entityName: entity ? entity.name : null,
    entity,
  };
  entityCache.set(cacheKey, result);
  return result;
}

async function getProvisionedNumbers(environment, accessToken) {
  const provisionedNumbersMap = {};
  let pageNumber = 1;
  const pageSize = 100;

  while (true) {
    const url = new URL(`${getApiBase(environment)}/api/v2/routing/sms/phonenumbers`);
    url.searchParams.set('pageNumber', String(pageNumber));
    url.searchParams.set('pageSize', String(pageSize));
    const data = await getJson(url.toString(), accessToken);

    const entities = extractCollection(data);
    if (entities.length > 0) {
      for (const number of entities) {
        let numberType = String(number.phoneNumberType || '').toLowerCase();
        if (numberType === 'mobile') numberType = 'local';
        provisionedNumbersMap[number.phoneNumber] = {
          ...number,
          phoneNumberType: numberType,
        };
      }
    }

    if (!data.nextUri) {
      break;
    }
    pageNumber += 1;
  }

  return provisionedNumbersMap;
}

async function calculateMrpCosts(provisionedNumbers, smsConfig) {
  let totalProvisionedNumbers = 0;
  let overallTotalMrp = 0;
  const numbersDetails = [];
  let inactiveNumbersCount = 0;
  const aggregatedMrp = {};
  const divisionMrpAttribution = {};
  const effectiveNumberToDivisionMap = smsConfig.numberToDivisionMap || {};

  for (const phoneNumber in provisionedNumbers) {
    const number = provisionedNumbers[phoneNumber];
    if (number.phoneNumberStatus !== 'active') {
      inactiveNumbersCount += 1;
      continue;
    }

    totalProvisionedNumbers += 1;

    const countryCode = number.countryCode;
    const numberType = number.phoneNumberType;

    let rateClass = 'A';
    if (countryTypeToRateClass[countryCode]) {
      rateClass = countryTypeToRateClass[countryCode][numberType?.toLowerCase()] || countryTypeToRateClass[countryCode].default;
    }

    const mrpPerNumber = MRP_PRICING_USD[rateClass] || 0;
    overallTotalMrp += mrpPerNumber;

    const attributedDivisionName = effectiveNumberToDivisionMap[phoneNumber] || 'Unknown Division';

    if (!divisionMrpAttribution[attributedDivisionName]) {
      divisionMrpAttribution[attributedDivisionName] = {
        divisionName: attributedDivisionName,
        totalMrp: 0,
      };
    }
    divisionMrpAttribution[attributedDivisionName].totalMrp += mrpPerNumber;

    numbersDetails.push({
      phoneNumber,
      country: countryCode,
      type: numberType,
      rateClass,
      mrp: mrpPerNumber.toFixed(2),
      divisionName: attributedDivisionName,
    });

    if (!aggregatedMrp[rateClass]) {
      aggregatedMrp[rateClass] = {
        rateClass,
        PhoneNumbers: 0,
        ratePerNumber: mrpPerNumber.toFixed(2),
        totalForRateClass: 0,
      };
    }
    aggregatedMrp[rateClass].PhoneNumbers += 1;
    aggregatedMrp[rateClass].totalForRateClass += mrpPerNumber;
  }

  return {
    totalProvisionedNumbers,
    overallTotalMrp,
    numbersDetails,
    inactiveNumbersCount,
    aggregatedMrp,
    divisionMrpAttribution,
  };
}

async function calculatePerMessageCosts(environment, accessToken, provisionedNumbersMap, genesysCloudInterval) {
  let pageNumber = 1;
  let hasMore = true;
  const inboundResults = [];
  const outboundResults = [];

  const requestBody = {
    order: 'asc',
    orderBy: 'conversationStart',
    paging: { pageSize: 100, pageNumber: 1 },
    interval: genesysCloudInterval,
    segmentFilters: [{ type: 'or', predicates: [{ dimension: 'messageType', value: 'sms' }] }],
  };

  while (hasMore) {
    requestBody.paging.pageNumber = pageNumber;
    const data = await postJson(
      `${getApiBase(environment)}/api/v2/analytics/conversations/details/query`,
      accessToken,
      requestBody
    );

    const conversations = Array.isArray(data.conversations) ? data.conversations : [];

    for (const conversation of conversations) {
      for (const participant of conversation.participants || []) {
        for (const session of participant.sessions || []) {
          if (session.mediaType === 'message' && session.messageType === 'sms') {
            let messageCount = 0;
            let messageSegmentCount = 0;
            const messageDirection = participant.purpose === 'customer' ? 'inbound' : 'outbound';

            if (session.metrics) {
              for (const metric of session.metrics) {
                if (metric.name === 'oMessageCount') messageCount = metric.value;
                else if (metric.name === 'oMessageSegmentCount') messageSegmentCount = metric.value;
              }
            }

            if (messageCount > 0) {
              const resultEntry = {
                conversationId: conversation.conversationId,
                participantPurpose: participant.purpose,
                address: messageDirection === 'inbound' ? session.addressTo : session.addressFrom,
                messageDirection,
                messageCount,
                messageSegmentCount,
                participantName: null,
                rateClass: 'N/A',
                rate: 0,
                totalCost: 0,
              };

              const numberDetails = provisionedNumbersMap[resultEntry.address];
              if (numberDetails) {
                const { countryCode, phoneNumberType } = numberDetails;
                let rateClass;
                let rate;

                if (resultEntry.messageDirection === 'inbound') {
                  const rateClassMapping = countryTypeToRateClassInbound[countryCode];
                  rateClass = (rateClassMapping && rateClassMapping[phoneNumberType]) || 'UNKNOWN';
                  rate = INBOUND_SMS_PRICING_USD[rateClass] !== undefined ? INBOUND_SMS_PRICING_USD[rateClass] : 0;
                } else {
                  const rateClassMapping = countryTypeToRateClassOutbound[countryCode];
                  rateClass = (rateClassMapping && rateClassMapping[phoneNumberType]) || 'UNKNOWN';
                  rate = OUTBOUND_SMS_PRICING_USD[rateClass] !== undefined ? OUTBOUND_SMS_PRICING_USD[rateClass] : 0;
                }

                resultEntry.rateClass = rateClass;
                resultEntry.rate = rate;
                resultEntry.totalCost = resultEntry.messageSegmentCount * rate;
              }

              if (participant.purpose === 'workflow' && session.flow) {
                resultEntry.flowName = session.flow.flowName;
                resultEntry.flowType = session.flow.flowType;
                resultEntry.flowId = session.flow.flowId;
              }

              let entityId = null;
              let entityType = null;

              switch (participant.purpose) {
                case 'workflow':
                  if (session.flow) {
                    entityId = session.flow.flowId;
                    entityType = 'flow';
                  }
                  break;
                case 'acd':
                  if (session.segments && session.segments.length > 0 && session.segments[0].queueId) {
                    entityId = session.segments[0].queueId;
                    entityType = 'queue';
                  }
                  break;
                case 'agent':
                  if (participant.userId) {
                    entityId = participant.userId;
                    entityType = 'user';
                  }
                  break;
                case 'campaign':
                  if (session.outboundCampaignId) {
                    entityId = session.outboundCampaignId;
                    entityType = 'campaign';
                    resultEntry.campaignId = session.outboundCampaignId;
                  }
                  break;
                case 'api':
                  if (conversation.divisionIds && conversation.divisionIds.length > 0) {
                    entityId = conversation.divisionIds[0];
                    entityType = 'division';
                    resultEntry.participantName = 'API';
                  }
                  break;
                default:
                  break;
              }

              if (entityId && entityType) {
                const divisionDetails = await getDivisionDetails(environment, accessToken, entityType, entityId);
                resultEntry.divisionId = divisionDetails.divisionId;
                resultEntry.divisionName = divisionDetails.divisionName;
                if (divisionDetails.entityName && !resultEntry.participantName) {
                  resultEntry.participantName = divisionDetails.entityName;
                }
              } else {
                resultEntry.divisionId = null;
                resultEntry.divisionName = null;
              }

              if (messageDirection === 'inbound') inboundResults.push(resultEntry);
              else outboundResults.push(resultEntry);
            }
          }
        }
      }
    }

    if (data.totalHits > pageNumber * requestBody.paging.pageSize) {
      pageNumber += 1;
    } else {
      hasMore = false;
    }
  }

  const totalInboundSegments = inboundResults.reduce((sum, r) => sum + r.messageSegmentCount, 0);
  const totalOutboundSegments = outboundResults.reduce((sum, r) => sum + r.messageSegmentCount, 0);
  const totalInboundCost = inboundResults.reduce((sum, r) => sum + r.totalCost, 0);
  const totalOutboundCost = outboundResults.reduce((sum, r) => sum + r.totalCost, 0);

  return {
    inboundResults,
    outboundResults,
    totalInboundSegments,
    totalOutboundSegments,
    totalInboundCost,
    totalOutboundCost,
  };
}

function aggregateByNumberAndDivision(data, smsConfig) {
  const effectiveNumberToDivisionMap = smsConfig.numberToDivisionMap || {};
  const messagesByNumber = data.reduce((acc, record) => {
    const addressKey = record.address;
    const attributedDivisionName = effectiveNumberToDivisionMap[addressKey] || 'Unknown Division';
    const key = `${addressKey}-${attributedDivisionName}`;
    if (!acc[key]) {
      acc[key] = {
        address: addressKey,
        divisionName: attributedDivisionName,
        rateClass: record.rateClass,
        rate: record.rate,
        totalSegments: 0,
        totalCost: 0,
      };
    }
    acc[key].totalSegments += record.messageSegmentCount;
    acc[key].totalCost += record.totalCost;
    return acc;
  }, {});

  return Object.values(messagesByNumber).map((dataRow) => ({
    address: dataRow.address,
    division: dataRow.divisionName,
    rateClass: dataRow.rateClass,
    rate: dataRow.rate,
    totalSegments: dataRow.totalSegments,
    totalCost: `$${dataRow.totalCost.toFixed(4)}`,
  })).sort((a, b) => b.totalSegments - a.totalSegments);
}

function aggregateByEmitterAndDivision(data) {
  const messagesByEmitter = data.reduce((acc, record) => {
    const emitterIdentifier = record.flowName || record.participantName || record.campaignId || 'N/A';
    const key = `${record.participantPurpose}-${record.divisionName || 'N/A'}-${emitterIdentifier}`;
    if (!acc[key]) {
      acc[key] = {
        participantPurpose: record.participantPurpose,
        emitterName: emitterIdentifier,
        divisionName: record.divisionName || 'N/A',
        totalSegments: 0,
        totalCost: 0,
      };
    }
    acc[key].totalSegments += record.messageSegmentCount;
    acc[key].totalCost += record.totalCost;
    return acc;
  }, {});

  return Object.values(messagesByEmitter).map((dataRow) => ({
    purpose: dataRow.participantPurpose,
    emitter: dataRow.emitterName,
    division: dataRow.divisionName,
    totalSegments: dataRow.totalSegments,
    totalCost: `$${dataRow.totalCost.toFixed(4)}`,
  })).sort((a, b) => b.totalSegments - a.totalSegments);
}

function aggregateByDivisionAndPurpose(data) {
  const messagesByDivisionAndPurpose = data.reduce((acc, record) => {
    const key = `${record.divisionName || 'N/A'}-${record.participantPurpose}`;
    if (!acc[key]) {
      acc[key] = {
        division: record.divisionName || 'N/A',
        purpose: record.participantPurpose,
        totalSegments: 0,
        totalCost: 0,
      };
    }
    acc[key].totalSegments += record.messageSegmentCount;
    acc[key].totalCost += record.totalCost;
    return acc;
  }, {});

  return Object.values(messagesByDivisionAndPurpose).map((dataRow) => ({
    division: dataRow.division,
    purpose: dataRow.purpose,
    totalSegments: dataRow.totalSegments,
    totalCost: `$${dataRow.totalCost.toFixed(4)}`,
  })).sort((a, b) => b.totalSegments - a.totalSegments);
}

function aggregateMessagesByRateClass(data, totalCostForProportion) {
  const messagesByRateClass = data.reduce((acc, record) => {
    const rateClass = record.rateClass || 'N/A';
    if (!acc[rateClass]) {
      acc[rateClass] = {
        rateClass,
        totalSegments: 0,
        totalCost: 0,
      };
    }
    acc[rateClass].totalSegments += record.messageSegmentCount;
    acc[rateClass].totalCost += record.totalCost;
    return acc;
  }, {});

  return Object.values(messagesByRateClass).map((dataRow) => ({
    ...dataRow,
    totalCost: `$${dataRow.totalCost.toFixed(4)}`,
    proportion: totalCostForProportion > 0 ? `${((dataRow.totalCost / totalCostForProportion) * 100).toFixed(2)}%` : '0.00%',
  })).sort((a, b) => a.rateClass.localeCompare(b.rateClass));
}

function aggregateMessagesByDivision(data, totalCostForProportion, smsConfig) {
  const effectiveNumberToDivisionMap = smsConfig.numberToDivisionMap || {};
  const messagesByDivision = data.reduce((acc, record) => {
    const attributedDivisionName = effectiveNumberToDivisionMap[record.address] || 'Unknown Division';
    if (!acc[attributedDivisionName]) {
      acc[attributedDivisionName] = {
        division: attributedDivisionName,
        totalSegments: 0,
        totalCost: 0,
      };
    }
    acc[attributedDivisionName].totalSegments += record.messageSegmentCount;
    acc[attributedDivisionName].totalCost += record.totalCost;
    return acc;
  }, {});

  return Object.values(messagesByDivision).map((dataRow) => ({
    ...dataRow,
    totalCost: `$${dataRow.totalCost.toFixed(4)}`,
    proportion: totalCostForProportion > 0 ? `${((dataRow.totalCost / totalCostForProportion) * 100).toFixed(2)}%` : '0.00%',
  })).sort((a, b) => a.division.localeCompare(b.division));
}

function formatTable(data) {
  if (data.length === 0) return 'No data to display.';
  const headers = Object.keys(data[0]);
  const columnWidths = headers.map((header) => header.length);
  data.forEach((row) => {
    headers.forEach((header, i) => {
      const value = String(row[header] || '');
      columnWidths[i] = Math.max(columnWidths[i], value.length);
    });
  });
  const headerRow = headers.map((header, i) => header.padEnd(columnWidths[i])).join(' | ');
  const separator = headers.map((_, i) => '-'.repeat(columnWidths[i])).join('-|-');
  const dataRows = data.map((row) =>
    headers.map((header, i) => String(row[header] || '').padEnd(columnWidths[i])).join(' | ')
  ).join('\n');
  return `${headerRow}\n${separator}\n${dataRows}`;
}

function generateReport(mrpResults, messageResults, genesysCloudInterval, humanReadableInterval, smsConfig) {
  let reportContent = 'Genesys Cloud Combined SMS Cost Report\n';
  reportContent += `Report Interval: ${humanReadableInterval} (${genesysCloudInterval})\n`;
  reportContent += `Generated On: ${new Date().toISOString()}\n\n`;

  const grandTotal = mrpResults.overallTotalMrp + messageResults.totalInboundCost + messageResults.totalOutboundCost;
  reportContent += '--- Overall Summary ---\n';
  reportContent += `Total Monthly Recurring Price (MRP): $${mrpResults.overallTotalMrp.toFixed(2)}\n`;
  reportContent += `Total Inbound Message Cost: $${messageResults.totalInboundCost.toFixed(4)}\n`;
  reportContent += `Total Outbound Message Cost: $${messageResults.totalOutboundCost.toFixed(4)}\n`;
  reportContent += `Grand Total: $${grandTotal.toFixed(4)}\n\n`;

  reportContent += '--- Monthly Recurring Price (MRP) Attributed by Division ---\n';
  const divisionMrpTableData = Object.values(mrpResults.divisionMrpAttribution).map((dataRow) => ({
    division: dataRow.divisionName,
    totalMrp: `$${dataRow.totalMrp.toFixed(2)}`,
    proportion: mrpResults.overallTotalMrp > 0 ? `${((dataRow.totalMrp / mrpResults.overallTotalMrp) * 100).toFixed(2)}%` : '0.00%',
  })).sort((a, b) => a.division.localeCompare(b.division));
  reportContent += `${formatTable(divisionMrpTableData)}\n\n`;

  const inboundByDivision = aggregateMessagesByDivision(messageResults.inboundResults, messageResults.totalInboundCost, smsConfig);
  reportContent += '--- Inbound Per-Message Cost by Division ---\n';
  reportContent += `${formatTable(inboundByDivision)}\n\n`;

  const outboundByDivision = aggregateMessagesByDivision(messageResults.outboundResults, messageResults.totalOutboundCost, smsConfig);
  reportContent += '--- Outbound Per-Message Cost by Division ---\n';
  reportContent += `${formatTable(outboundByDivision)}\n\n`;

  reportContent += '--- Monthly Recurring Price (MRP) Aggregated by Rate Class ---\n';
  const aggregatedTableData = Object.values(mrpResults.aggregatedMrp).map((dataRow) => ({
    rateClass: dataRow.rateClass,
    PhoneNumbers: dataRow.PhoneNumbers,
    ratePerNumber: `$${dataRow.ratePerNumber}`,
    totalForRateClass: `$${dataRow.totalForRateClass.toFixed(2)}`,
  })).sort((a, b) => a.rateClass.localeCompare(b.rateClass));
  reportContent += `${formatTable(aggregatedTableData)}\n\n`;

  const inboundByRateClass = aggregateMessagesByRateClass(messageResults.inboundResults, messageResults.totalInboundCost);
  reportContent += '--- Inbound SMS - Aggregated by Rate Class ---\n';
  reportContent += `${formatTable(inboundByRateClass)}\n\n`;

  const outboundByRateClass = aggregateMessagesByRateClass(messageResults.outboundResults, messageResults.totalOutboundCost);
  reportContent += '--- Outbound SMS - Aggregated by Rate Class ---\n';
  reportContent += `${formatTable(outboundByRateClass)}\n\n`;

  reportContent += '--- Provisioned SMS Numbers Details ---\n';
  const numbersDetailsForTable = mrpResults.numbersDetails.map(({ divisionId, ...rest }) => rest);
  numbersDetailsForTable.sort((a, b) => {
    if (a.divisionName !== b.divisionName) return a.divisionName.localeCompare(b.divisionName);
    if (a.rateClass !== b.rateClass) return a.rateClass.localeCompare(b.rateClass);
    if (a.country !== b.country) return a.country.localeCompare(b.country);
    return a.phoneNumber.localeCompare(b.phoneNumber);
  });
  reportContent += `${formatTable(numbersDetailsForTable)}\n\n`;

  const inboundByNumber = aggregateByNumberAndDivision(messageResults.inboundResults, smsConfig);
  reportContent += '--- Inbound SMS - Aggregated by Number and Division (addressTo) ---\n';
  reportContent += `${formatTable(inboundByNumber)}\n\n`;

  const outboundByNumber = aggregateByNumberAndDivision(messageResults.outboundResults, smsConfig);
  reportContent += '--- Outbound SMS - Aggregated by Number and Division (addressFrom) ---\n';
  reportContent += `${formatTable(outboundByNumber)}\n\n`;

  const outboundByEmitter = aggregateByEmitterAndDivision(messageResults.outboundResults);
  reportContent += '--- Outbound SMS - Aggregated by Emitter and Division ---\n';
  reportContent += `${formatTable(outboundByEmitter)}\n\n`;

  const outboundByDivisionAndPurpose = aggregateByDivisionAndPurpose(messageResults.outboundResults);
  reportContent += '--- Outbound SMS - Aggregated by Division and Purpose ---\n';
  reportContent += `${formatTable(outboundByDivisionAndPurpose)}\n\n`;

  reportContent += '--- All Detailed SMS Records ---\n';
  reportContent += 'Division for each record is determined based on the participant\'s purpose:\n';
  reportContent += '- **Workflow**: Division of the associated Flow.\n';
  reportContent += '- **ACD**: Division of the associated Queue.\n';
  reportContent += '- **Agent**: Division of the associated User.\n';
  reportContent += '- **Campaign**: Division of the associated Outbound Campaign.\n';
  reportContent += '- **API**: Division of the Conversation itself (first division ID if multiple).\n';
  reportContent += '---------------------------------\n\n';
  const allResults = [...messageResults.inboundResults, ...messageResults.outboundResults];
  allResults.sort((a, b) => {
    if (a.conversationId !== b.conversationId) {
      return a.conversationId.localeCompare(b.conversationId);
    }
    return a.participantPurpose.localeCompare(b.participantPurpose);
  });
  reportContent += `${formatTable(allResults)}\n\n`;

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

async function runSmsCost({ environment, accessToken, intervalInput, frontendConfig }) {
  if (!environment) {
    throw new Error('Genesys Cloud environment is required.');
  }
  if (!accessToken) {
    throw new Error('Access token is required.');
  }

  const interval = resolveInterval(intervalInput || 'yesterday');
  const humanReadableInterval = resolveHumanReadableInterval(intervalInput, interval);
  const smsConfig = mergeSmsCostConfig({
    numberToDivisionMap,
  }, frontendConfig);

  const provisionedNumbers = await getProvisionedNumbers(environment, accessToken);
  const [mrpResults, messageResults] = await Promise.all([
    calculateMrpCosts(provisionedNumbers, smsConfig),
    calculatePerMessageCosts(environment, accessToken, provisionedNumbers, interval),
  ]);

  const reportContent = generateReport(mrpResults, messageResults, interval, humanReadableInterval, smsConfig);
  const grandTotal = mrpResults.overallTotalMrp + messageResults.totalInboundCost + messageResults.totalOutboundCost;

  return {
    interval,
    humanReadableInterval,
    reportContent,
    summary: {
      totalMrp: Number(mrpResults.overallTotalMrp.toFixed(2)),
      totalInboundCost: Number(messageResults.totalInboundCost.toFixed(4)),
      totalOutboundCost: Number(messageResults.totalOutboundCost.toFixed(4)),
      grandTotal: Number(grandTotal.toFixed(4)),
      totalProvisionedNumbers: mrpResults.totalProvisionedNumbers,
      inactiveNumbersCount: mrpResults.inactiveNumbersCount,
      totalInboundSegments: messageResults.totalInboundSegments,
      totalOutboundSegments: messageResults.totalOutboundSegments,
    },
  };
}

export {
  runSmsCost,
};
