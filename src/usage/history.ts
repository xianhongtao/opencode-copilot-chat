import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execFileSync } from "child_process";
import type { UsageTodayYesterdaySource } from "../config";
import { getErrorMessage } from "../utils";
import type { UsageLogEntry } from "./tracker";

// ─── OpenCode SQLite history reader (same source as OpenUsage) ───────────────
// Reads from ~/.local/share/opencode/opencode.db
// SQL from https://github.com/robinebers/openusage/plugins/opencode-go/plugin.js

const OPENCODE_DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

const HISTORY_ROWS_SQL = `
  SELECT
    CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS createdMs,
    CAST(json_extract(data, '$.cost') AS REAL) AS cost,
    CAST(json_extract(data, '$.tokens.input') AS INTEGER) AS tokensInput,
    CAST(json_extract(data, '$.tokens.output') AS INTEGER) AS tokensOutput,
    CAST(json_extract(data, '$.tokens.reasoning') AS INTEGER) AS tokensReasoning,
    CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER) AS tokensCacheRead,
    json_extract(data, '$.path.cwd') AS cwd,
    json_extract(data, '$.modelID') AS modelId
  FROM message
  WHERE json_valid(data)
    AND json_extract(data, '$.providerID') = 'opencode-go'
    AND json_extract(data, '$.role') = 'assistant'
    AND json_type(data, '$.cost') IN ('integer', 'real')
`;

export interface HistoryRow {
  createdMs: number;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  /** Working directory of the session the message belongs to (OpenCode CLI data). */
  cwd?: string;
  /** Model that produced the message (OpenCode CLI data). */
  modelId?: string;
}

/** Non-negative finite integer (tokens can legitimately be 0). */
function positiveNumberish(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Sum one day window across the OpenCode CLI history rows and the extension's
 * tracked entries. The CLI records terminal usage and the extension records
 * VS Code usage — they never overlap, so the sum is the user's real combined
 * usage for the window. `source` selects which inputs participate.
 */
export function sumDailyUsage(
  rows: HistoryRow[],
  entries: UsageLogEntry[],
  dayStartMs: number,
  source: UsageTodayYesterdaySource = "auto",
): UsageDaily {
  let cost = 0;
  let requests = 0;
  let tokens = 0;

  if (source !== "extension") {
    for (const row of rows) {
      if (row.createdMs < dayStartMs) continue;
      cost += row.cost;
      requests += 1;
      tokens += row.tokensInput + row.tokensOutput + row.tokensReasoning;
    }
  }

  if (source !== "cli") {
    for (const entry of entries) {
      if (entry.timestamp < dayStartMs) continue;
      cost += entry.cost;
      requests += 1;
      tokens += entry.promptTokens + entry.completionTokens;
    }
  }

  return { cost, requests, tokens };
}

/** Per-day / per-workspace usage totals (from CLI history and/or extension tracking). */
export interface UsageDaily {
  cost: number;
  requests: number;
  tokens: number;
}

/** One day bucket of the usage chart. */
export interface UsageDayPoint {
  /** Unix ms at the START of the day (UTC or local, per the day-boundary setting). */
  dayStart: number;
  cost: number;
  tokens: number;
  requests: number;
}

/** Per-model usage for a single day (model bar chart). */
export interface ModelDayUsage {
  model: string;
  dayStart: number;
  cost: number;
  tokens: number;
  requests: number;
}

/** Time-series data for the usage panel charts. */
export interface UsageSeries {
  /** Daily totals, oldest → newest. */
  days: UsageDayPoint[];
  /** Per-model-per-day rows (only days with usage are present). */
  byModel: ModelDayUsage[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bucket CLI rows + extension entries into per-day totals and per-model
 * per-day rows over the last `days` days (the oldest bucket starts at
 * `dayStartMs - (days - 1) * DAY_MS`). Pure so it can be unit-tested.
 */
export function buildUsageSeries(
  rows: HistoryRow[],
  entries: UsageLogEntry[],
  days: number,
  dayStartMs: number,
  source: UsageTodayYesterdaySource = "auto",
): UsageSeries {
  // days > 0: the last `days` days ending at dayStartMs; days <= 0: lifetime
  // from the earliest recorded usage to today (aligned to the day grid).
  let firstDay: number;
  if (days > 0) {
    firstDay = dayStartMs - (Math.max(1, Math.floor(days)) - 1) * DAY_MS;
  } else {
    let earliest = dayStartMs;
    if (source !== "extension") {
      for (const row of rows) if (row.createdMs < earliest) earliest = row.createdMs;
    }
    if (source !== "cli") {
      for (const entry of entries) if (entry.timestamp < earliest) earliest = entry.timestamp;
    }
    firstDay = dayStartMs - Math.ceil((dayStartMs - earliest) / DAY_MS) * DAY_MS;
  }
  const bucketCount = Math.round((dayStartMs - firstDay) / DAY_MS) + 1;
  const buckets: UsageDayPoint[] = Array.from({ length: bucketCount }, (_, i) => ({
    dayStart: firstDay + i * DAY_MS,
    cost: 0,
    tokens: 0,
    requests: 0,
  }));
  const byModel = new Map<string, Map<number, ModelDayUsage>>();

  const add = (model: string | undefined, timestamp: number, cost: number, tokens: number): void => {
    const index = Math.round((timestamp - firstDay) / DAY_MS);
    if (index < 0 || index >= bucketCount) return;
    const day = buckets[index];
    day.cost += cost;
    day.tokens += tokens;
    day.requests += 1;

    const modelName = model ?? "unknown";
    let byDay = byModel.get(modelName);
    if (!byDay) {
      byDay = new Map();
      byModel.set(modelName, byDay);
    }
    const point = byDay.get(index) ?? { model: modelName, dayStart: day.dayStart, cost: 0, tokens: 0, requests: 0 };
    point.cost += cost;
    point.tokens += tokens;
    point.requests += 1;
    byDay.set(index, point);
  };

  if (source !== "extension") {
    for (const row of rows) {
      add(row.modelId, row.createdMs, row.cost, row.tokensInput + row.tokensOutput + row.tokensReasoning);
    }
  }
  if (source !== "cli") {
    for (const entry of entries) {
      add(entry.modelId, entry.timestamp, entry.cost, entry.promptTokens + entry.completionTokens);
    }
  }

  return {
    days: buckets,
    byModel: [...byModel.entries()].flatMap(([, byDay]) =>
      [...byDay.entries()].sort((left, right) => left[0] - right[0]).map(([, point]) => point),
    ),
  };
}

/**
 * The CLI database can be gigabytes large and spawning `sqlite3` is a
 * synchronous, blocking call — but the usage UI (status bar, tooltip, panel,
 * quick-pick) re-reads it on every refresh. Memoize the result for a short
 * window so a burst of refreshes pays the query cost once.
 */
const HISTORY_READ_TTL_MS = 3_000;
let historyCache: { rows: HistoryRow[] | null; fetchedAt: number } | undefined;
/** Surfaces CLI-history read failures in the usage output channel. */
let historyReadDiagnostic: ((message: string) => void) | undefined;

/** Wire the diagnostic sink (called once per tracker, last one wins). */
export function setHistoryReadDiagnostic(log: (message: string) => void): void {
  historyReadDiagnostic = log;
}

export function readOpenCodeHistory(): HistoryRow[] | null {
  const now = Date.now();
  if (historyCache && now - historyCache.fetchedAt < HISTORY_READ_TTL_MS) {
    return historyCache.rows;
  }
  const rows = readOpenCodeHistoryUncached();
  historyCache = { rows, fetchedAt: now };
  return rows;
}

function readOpenCodeHistoryUncached(): HistoryRow[] | null {
  if (!fs.existsSync(OPENCODE_DB_PATH)) {
    historyReadDiagnostic?.(`[go-usage] CLI history: database not found at ${OPENCODE_DB_PATH}`);
    return null;
  }

  // The `sqlite3` binary may be missing from the extension host's PATH (it is
  // often only available from the Android SDK, e.g. launched from a terminal),
  // so Node's built-in reader is tried first — zero external dependencies.
  const viaNode = readHistoryViaNodeSqlite();
  if (viaNode !== undefined) {
    return viaNode;
  }

  return readHistoryViaSqliteCli();
}

/** Normalize raw rows (shared by both readers). */
function normalizeHistoryRows(rows: unknown): HistoryRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is HistoryRow => {
      if (!row || typeof row !== "object") return false;
      const candidate = row as Partial<HistoryRow>;
      return (
        typeof candidate.createdMs === "number" && candidate.createdMs > 0 && typeof candidate.cost === "number" && candidate.cost >= 0
      );
    })
    .map((row) => ({
      createdMs: row.createdMs,
      cost: row.cost,
      tokensInput: positiveNumberish(row.tokensInput),
      tokensOutput: positiveNumberish(row.tokensOutput),
      tokensReasoning: positiveNumberish(row.tokensReasoning),
      tokensCacheRead: positiveNumberish(row.tokensCacheRead),
      cwd: typeof row.cwd === "string" && row.cwd.trim() ? row.cwd : undefined,
      modelId: typeof row.modelId === "string" && row.modelId.trim() ? row.modelId : undefined,
    }));
}

/**
 * Read the CLI history with Node's built-in `node:sqlite` (no binary on the
 * host PATH needed). Returns `undefined` when the module is unavailable on
 * this host so the caller can fall back to the `sqlite3` binary.
 */
function readHistoryViaNodeSqlite(): HistoryRow[] | null | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync?: new (
        path: string,
        options?: { readOnly?: boolean },
      ) => {
        prepare(sql: string): { all(): Record<string, unknown>[] };
        close(): void;
      };
    };
    if (typeof DatabaseSync !== "function") {
      return undefined;
    }
    // Transient busy/lock states (CLI checkpointing the WAL) resolve quickly.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const db = new DatabaseSync(OPENCODE_DB_PATH, { readOnly: true });
        try {
          const rows = db.prepare(HISTORY_ROWS_SQL).all();
          return rows.length > 0 ? normalizeHistoryRows(rows) : null;
        } finally {
          db.close();
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (attempt === 0) {
          historyReadDiagnostic?.(`[go-usage] node:sqlite read failed (attempt 1): ${message}. Retrying…`);
        } else {
          historyReadDiagnostic?.(`[go-usage] node:sqlite read failed: ${message}`);
        }
      }
    }
    return null;
  } catch (error) {
    historyReadDiagnostic?.(`[go-usage] node:sqlite unavailable (${getErrorMessage(error)}); falling back to the sqlite3 binary.`);
    return undefined;
  }
}

/**
 * Candidate `sqlite3` binaries: the PATH-resolved name first, then absolute
 * paths from common installs (system, Homebrew, Android SDK) — the Android
 * SDK binary is what most dev machines actually have, and it is frequently
 * missing from the extension host's PATH.
 */
function sqliteCliCandidates(): string[] {
  const home = os.homedir();
  return [
    "sqlite3",
    "/usr/bin/sqlite3",
    "/usr/local/bin/sqlite3",
    "/opt/homebrew/bin/sqlite3",
    path.join(home, "Android", "Sdk", "platform-tools", "sqlite3"),
    path.join(home, "Library", "Android", "sdk", "platform-tools", "sqlite3"),
  ];
}

function readHistoryViaSqliteCli(): HistoryRow[] | null {
  for (const binary of sqliteCliCandidates()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = execFileSync(binary, ["-readonly", "-cmd", ".timeout 5000", "-json", OPENCODE_DB_PATH, HISTORY_ROWS_SQL], {
          timeout: 10_000,
          maxBuffer: 64 * 1024 * 1024,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        const rows: unknown = JSON.parse(result);
        return Array.isArray(rows) ? normalizeHistoryRows(rows) : null;
      } catch (error) {
        const message = getErrorMessage(error);
        // ENOENT just means this candidate isn't present — try the next one.
        if (attempt === 0 && message.includes("ENOENT")) {
          break;
        }
        if (attempt === 0) {
          historyReadDiagnostic?.(`[go-usage] sqlite3 read failed (attempt 1): ${message}. Retrying…`);
        } else {
          historyReadDiagnostic?.(`[go-usage] sqlite3 read failed (${binary}): ${message}`);
        }
      }
    }
  }
  historyReadDiagnostic?.(
    "[go-usage] CLI history unavailable: no SQLite reader found (node:sqlite missing and no sqlite3 binary on PATH).",
  );
  return null;
}
