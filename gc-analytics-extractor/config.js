const SUPPORTED_SCHEMA_VERSION = 1;

const EMPTY_FRONTEND_CONFIG = Object.freeze({
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  pipelines: {
    smsCost: {
      numberToDivisionMap: {},
    },
  },
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertStringRecord(value, path) {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be an object.`);
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error(`${path} contains an invalid key.`);
    }
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${path}.${key} must be a non-empty string.`);
    }
  }
}

function normalizeFrontendConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    throw new Error('Config root must be an object.');
  }

  const schemaVersion = rawConfig.schemaVersion;
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported config schemaVersion ${JSON.stringify(schemaVersion)}. Expected ${SUPPORTED_SCHEMA_VERSION}.`
    );
  }

  const pipelines = rawConfig.pipelines;
  if (!isPlainObject(pipelines)) {
    throw new Error('Config.pipelines must be an object.');
  }

  const smsCost = pipelines.smsCost || {};
  if (!isPlainObject(smsCost)) {
    throw new Error('Config.pipelines.smsCost must be an object when provided.');
  }

  const numberToDivisionMap = smsCost.numberToDivisionMap || {};
  assertStringRecord(numberToDivisionMap, 'Config.pipelines.smsCost.numberToDivisionMap');

  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    pipelines: {
      smsCost: {
        numberToDivisionMap: { ...numberToDivisionMap },
      },
    },
  };
}

function parseFrontendConfigJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Config is not valid JSON: ${error.message}`);
  }

  return normalizeFrontendConfig(parsed);
}

function getSmsCostOverrides(frontendConfig) {
  const normalized = frontendConfig
    ? normalizeFrontendConfig(frontendConfig)
    : EMPTY_FRONTEND_CONFIG;

  return {
    numberToDivisionMap: {
      ...normalized.pipelines.smsCost.numberToDivisionMap,
    },
  };
}

function mergeSmsCostConfig(staticConfig, frontendConfig) {
  const overrides = getSmsCostOverrides(frontendConfig);

  return {
    ...staticConfig,
    numberToDivisionMap: {
      ...(staticConfig?.numberToDivisionMap || {}),
      ...overrides.numberToDivisionMap,
    },
  };
}

export {
  EMPTY_FRONTEND_CONFIG,
  SUPPORTED_SCHEMA_VERSION,
  getSmsCostOverrides,
  mergeSmsCostConfig,
  normalizeFrontendConfig,
  parseFrontendConfigJson,
};
