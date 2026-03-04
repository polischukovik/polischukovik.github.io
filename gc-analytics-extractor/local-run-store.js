const DB_NAME = 'gc-analytics-extractor';
const DB_VERSION = 1;
const RUNS_STORE = 'runs';
const META_STORE = 'meta';
const DEFAULT_RETENTION_DAYS = 30;
const LAST_CLEANUP_KEY = 'lastCleanupAt';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(RUNS_STORE)) {
        const runsStore = db.createObjectStore(RUNS_STORE, { keyPath: 'id' });
        runsStore.createIndex('startedAt', 'startedAt');
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
  });
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

async function withStore(storeName, mode, handler) {
  const db = await openDatabase();

  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);

      let settled = false;
      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      tx.oncomplete = () => finishResolve(undefined);
      tx.onerror = () => finishReject(tx.error || new Error('IndexedDB transaction failed.'));
      tx.onabort = () => finishReject(tx.error || new Error('IndexedDB transaction aborted.'));

      Promise.resolve(handler(store, tx, finishResolve, finishReject)).catch(finishReject);
    });
  } finally {
    db.close();
  }
}

function normalizeRunRecord(run) {
  if (!run || typeof run !== 'object') {
    throw new Error('Run record must be an object.');
  }

  const startedAt = run.startedAt || new Date().toISOString();
  const id = run.id || crypto.randomUUID();

  return {
    id: String(id),
    pipelineName: String(run.pipelineName || 'unknown'),
    status: String(run.status || 'completed'),
    providedInterval: run.providedInterval || null,
    humanReadableInterval: run.humanReadableInterval || null,
    startedAt: String(startedAt),
    durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
    reportFilename: run.reportFilename || null,
    reportContent: typeof run.reportContent === 'string' ? run.reportContent : '',
    reportData: run.reportData && typeof run.reportData === 'object' ? run.reportData : null,
    summary: run.summary && typeof run.summary === 'object' ? run.summary : null,
    metadata: run.metadata && typeof run.metadata === 'object' ? run.metadata : null,
    savedAt: new Date().toISOString(),
  };
}

function dateToMillis(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function setMetaValue(key, value) {
  await withStore(META_STORE, 'readwrite', async (store) => {
    await promisifyRequest(store.put({ key, value }));
  });
}

async function getMetaValue(key) {
  return withStore(META_STORE, 'readonly', async (store, _tx, finishResolve) => {
    const value = await promisifyRequest(store.get(key));
    finishResolve(value?.value);
  });
}

async function saveRun(run) {
  const normalized = normalizeRunRecord(run);

  await withStore(RUNS_STORE, 'readwrite', async (store) => {
    await promisifyRequest(store.put(normalized));
  });

  return normalized;
}

async function getRun(runId) {
  if (!runId) return null;

  return withStore(RUNS_STORE, 'readonly', async (store, _tx, finishResolve) => {
    const record = await promisifyRequest(store.get(String(runId)));
    finishResolve(record || null);
  });
}

async function listRuns(options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 30;

  return withStore(RUNS_STORE, 'readonly', async (store, _tx, finishResolve) => {
    const records = await promisifyRequest(store.getAll());
    records.sort((a, b) => dateToMillis(b.startedAt) - dateToMillis(a.startedAt));
    finishResolve(records.slice(0, limit));
  });
}

async function deleteRun(runId) {
  if (!runId) return;

  await withStore(RUNS_STORE, 'readwrite', async (store) => {
    await promisifyRequest(store.delete(String(runId)));
  });
}

async function clearAllRuns() {
  await withStore(RUNS_STORE, 'readwrite', async (store) => {
    await promisifyRequest(store.clear());
  });
}

async function cleanupExpiredRuns(options = {}) {
  const retentionDays = Number.isFinite(options.retentionDays)
    ? Math.max(1, options.retentionDays)
    : DEFAULT_RETENTION_DAYS;

  const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  let deletedCount = 0;

  await withStore(RUNS_STORE, 'readwrite', async (store) => {
    const records = await promisifyRequest(store.getAll());

    await Promise.all(records.map(async (record) => {
      if (dateToMillis(record.startedAt) < cutoffMs) {
        deletedCount += 1;
        await promisifyRequest(store.delete(record.id));
      }
    }));
  });

  await setMetaValue(LAST_CLEANUP_KEY, new Date().toISOString());

  return {
    retentionDays,
    deletedCount,
    lastCleanupAt: await getMetaValue(LAST_CLEANUP_KEY),
  };
}

async function ensureRetentionPolicy(options = {}) {
  const minIntervalHours = Number.isFinite(options.minIntervalHours)
    ? Math.max(1, options.minIntervalHours)
    : 12;

  const lastCleanupAt = await getMetaValue(LAST_CLEANUP_KEY);
  const lastCleanupMs = dateToMillis(lastCleanupAt);
  const minIntervalMs = minIntervalHours * 60 * 60 * 1000;

  if (lastCleanupMs && (Date.now() - lastCleanupMs) < minIntervalMs) {
    return {
      skipped: true,
      lastCleanupAt,
    };
  }

  const result = await cleanupExpiredRuns(options);
  return {
    skipped: false,
    ...result,
  };
}

export {
  DB_NAME,
  DEFAULT_RETENTION_DAYS,
  clearAllRuns,
  cleanupExpiredRuns,
  deleteRun,
  ensureRetentionPolicy,
  getRun,
  listRuns,
  normalizeRunRecord,
  saveRun,
};
