import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execFileSync } from "child_process";
import { GO_VENDOR } from "./providerTypes";
import type { ModelCost } from "./metadata";
import type { TransportRequestSummary } from "./streaming";
import { fetchGoUsage, mergeServerUsage, GO_USAGE_SYNC_TTL_MS, type GoUsageApiResponse } from "./goUsageSync";
import {
  GO_LIMITS,
  FIVE_HOURS_MS,
  WEEK_MS,
  GO_USAGE_LOG_KEY,
  GO_USAGE_BASELINE_KEY,
  GO_EVER_TRACKED_KEY,
  GO_SESSION_COSTS_KEY,
  GO_MAX_LOG_ENTRIES,
  GO_SESSION_IDLE_MS,
  GO_MAX_SESSIONS,
  GO_SERVER_USAGE_KEY,
  type UsageTodayYesterdaySource,
} from "./config";
import { formatCount, formatTokenCount, formatUsd, formatRelativeTime, getErrorMessage } from "./utils";

export { GO_LIMITS } from "./config";

/** Callback to resolve live model cost from the models.dev metadata cache. */
export type CostResolver = (modelId: string) => ModelCost | undefined;

// ─── Constants (values centralized in ./config) ──────────────────────────────

const STORAGE_KEY = GO_USAGE_LOG_KEY;
const BASELINE_STORAGE_KEY = GO_USAGE_BASELINE_KEY;
const EVER_TRACKED_KEY = GO_EVER_TRACKED_KEY;
const SESSION_COSTS_KEY = GO_SESSION_COSTS_KEY;
const MAX_LOG_ENTRIES = GO_MAX_LOG_ENTRIES;

// ─── Go model pricing ($/1M tokens) — bundled snapshot fallback ────────────
// This table is a static snapshot kept as a last resort. The primary source
// is the live models.dev metadata cache injected via CostResolver.

const GO_MODEL_PRICING: Record<string, ModelCost | undefined> = {
  "glm-5.1": { input: 1.4, output: 4.4, cache_read: 0.26 },
  "glm-5": { input: 1.0, output: 3.2, cache_read: 0.2 },
  "kimi-k2.6": { input: 0.95, output: 4.0, cache_read: 0.16 },
  "kimi-k2.5": { input: 0.6, output: 3.0, cache_read: 0.1 },
  "minimax-m3": { input: 0.6, output: 2.4, cache_read: 0.12 },
  "minimax-m2.7": { input: 0.3, output: 1.2, cache_read: 0.06 },
  "minimax-m2.5": { input: 0.3, output: 1.2, cache_read: 0.06 },
  "mimo-v2.5": { input: 0.14, output: 0.28, cache_read: 0.003 },
  "mimo-v2.5-pro": { input: 1.74, output: 3.48, cache_read: 0.015 },
  "mimo-v2-omni": { input: 0.14, output: 0.28, cache_read: 0.003 },
  "mimo-v2-pro": { input: 1.74, output: 3.48, cache_read: 0.015 },
  "qwen3.7-max": { input: 2.5, output: 7.5, cache_read: 0.5 },
  "qwen3.7-plus": { input: 0.4, output: 1.6, cache_read: 0.04 },
  "qwen3.6-plus": { input: 0.5, output: 3.0, cache_read: 0.05 },
  "qwen3.5-plus": { input: 0.2, output: 1.2, cache_read: 0.02 },
  "deepseek-v4-pro": { input: 1.74, output: 3.48, cache_read: 0.015 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cache_read: 0.003 },
  "hy3-preview": { input: 0.5, output: 1.5, cache_read: 0.05 },
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UsageLogEntry {
  /** Unix timestamp ms */
  timestamp: number;
  modelId: string;
  /** Estimated cost in USD */
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Chat session identifier (stable hash per conversation thread). */
  sessionId?: string;
  /** Credits for VS Code session cost (1 credit = $0.01). */
  copilotCredits?: number;
}

/** Aggregated cost for a single chat session. */
export interface SessionCostSummary {
  sessionId: string;
  cost: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  lastActivity: number;
}

export interface PeriodUsage {
  spent: number;
  limit: number;
  percent: number;
  resetsAt: Date;
}

export interface UsageSummary {
  session: PeriodUsage;
  weekly: PeriodUsage;
  monthly: PeriodUsage;
  today: UsageDaily;
  yesterday: UsageDaily;
  /** All-time usage in the CURRENT workspace (from OpenCode CLI history). */
  codebase: UsageDaily;
  hasData: boolean;
  /** When true, cost data comes from the OpenCode CLI SQLite database
      (actual billed amounts). When false, costs are estimated locally. */
  sqliteAvailable: boolean;
}

/**
 * Per-view knobs resolved live so the user can pick how usage is presented.
 * All resolvers are optional — the tracker falls back to sensible defaults.
 */
export interface GoUsageTrackerOptions {
  /** Absolute paths of the current VS Code workspace folders. */
  resolveWorkspaceFolders?: () => readonly string[];
  /** Source of the Today/Yesterday rows (default "auto"). */
  resolveTodayYesterdaySource?: () => UsageTodayYesterdaySource;
  /** Codebase window in days; 0 = forever (default). */
  resolveCodebaseWindowDays?: () => number;
  /** Day boundary for Today/Yesterday ("utc" default | "local"). */
  resolveDayBoundary?: () => "utc" | "local";
}

interface UsageBaselinePeriod {
  amount: number;
  expiresAt: number;
}

interface UsageBaseline {
  session?: UsageBaselinePeriod;
  weekly?: UsageBaselinePeriod;
  monthly?: UsageBaselinePeriod & {
    /** The user's billing anchor day (1-31) for the monthly reset. */
    anchorDay?: number;
    /** The user's billing anchor hour (0-23 UTC) for the monthly reset. */
    anchorHour?: number;
  };
}

export interface UsageBaselineTargets {
  session: number;
  weekly: number;
  monthly: number;
  /** Day of month (1-31) when monthly counter resets. Combined with monthlyAnchorHour. */
  monthlyAnchorDay?: number;
  /** Hour of day (0-23 UTC) when monthly counter resets. Combined with monthlyAnchorDay. */
  monthlyAnchorHour?: number;
}

// ─── Time window helpers ─────────────────────────────────────────────────────

function startOfUtcDay(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Start of the LOCAL day — used when `usageDayBoundary` is set to "local". */
export function startOfLocalDay(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Normalize a directory path for matching (trailing separators, Windows case). */
export function normalizeCwd(value: string): string {
  let normalized = value.replace(/[\/]+$/, "");
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/** Whether `value` starts with `prefix` followed by a path separator. */
function startsWithPathSegment(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) {
    return false;
  }
  return value.length > prefix.length && (value.charAt(prefix.length) === "/" || value.charAt(prefix.length) === "\\");
}

/**
 * Whether a CLI row's working directory belongs to the current workspace.
 * Matches when the folder equals the cwd, is a parent of it (the user opened
 * the repo root but the CLI ran in a subfolder), or the folder is a subfolder
 * of the cwd (the user opened a subfolder of the project).
 *
 * Segment-boundary matching accepts both `/` and `\` so POSIX-style paths and
 * native Windows paths (where the separator is `\`) both match on any host.
 */
export function isCwdInWorkspace(cwd: string | undefined, workspaceFolders: readonly string[]): boolean {
  if (!cwd || workspaceFolders.length === 0) {
    return false;
  }
  const rowCwd = normalizeCwd(cwd);
  for (const folder of workspaceFolders) {
    const normalized = normalizeCwd(folder);
    if (rowCwd === normalized) return true;
    if (startsWithPathSegment(rowCwd, normalized)) return true;
    if (startsWithPathSegment(normalized, rowCwd)) return true;
  }
  return false;
}

function startOfUtcWeek(nowMs: number): number {
  const d = new Date(nowMs);
  const offset = (d.getUTCDay() + 6) % 7; // Monday=0
  d.setUTCDate(d.getUTCDate() - offset);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function anchoredMonthStart(nowMs: number, anchorDay: number, anchorHour: number): number {
  const now = new Date(nowMs);
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let candidate = Date.UTC(year, month, anchorDay, anchorHour, 0, 0, 0);
  if (candidate > nowMs) {
    if (month === 0) {
      year--;
      month = 11;
    } else {
      month--;
    }
    candidate = Date.UTC(year, month, anchorDay, anchorHour, 0, 0, 0);
  }
  return candidate;
}

function anchoredMonthEnd(startMs: number, anchorDay: number, anchorHour: number): number {
  const d = new Date(startMs);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth() + 1;
  if (month > 11) {
    year++;
    month = 0;
  }
  return Date.UTC(year, month, anchorDay, anchorHour, 0, 0, 0);
}

/** Build the monthly window: manual anchor > auto-anchor from earliest row > calendar month. */
function buildMonthlyWindow(
  nowMs: number,
  baseline: UsageBaseline,
  earliestMs?: number | null,
): { monthStartMs: number; monthEndMs: number } {
  // Priority 1: user-configured anchor (set via "Set spent targets")
  const monthly = baseline.monthly;
  const monthlyAnchor = monthly?.anchorDay;
  if (monthly && monthlyAnchor && monthlyAnchor >= 1 && monthlyAnchor <= 31) {
    const hour = monthly.anchorHour ?? 0;
    const start = anchoredMonthStart(nowMs, monthlyAnchor, hour);
    const end = anchoredMonthEnd(start, monthlyAnchor, hour);
    return { monthStartMs: start, monthEndMs: end };
  }
  // Priority 2: auto-anchor from earliest SQLite row (actual billing start)
  if (earliestMs != null) {
    const d = new Date(earliestMs);
    const day = d.getUTCDate();
    const hour = d.getUTCHours();
    const start = anchoredMonthStart(nowMs, day, hour);
    const end = anchoredMonthEnd(start, day, hour);
    return { monthStartMs: start, monthEndMs: end };
  }
  // Fallback: calendar month
  const now = new Date(nowMs);
  return {
    monthStartMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    monthEndMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  };
}

/** Rolling reset: oldest entry in the current 5h window + 5h */
function nextSessionReset(entries: UsageLogEntry[], nowMs: number): Date {
  const windowStart = nowMs - FIVE_HOURS_MS;
  let oldest: number | null = null;
  for (const e of entries) {
    if (e.timestamp >= windowStart && e.timestamp < nowMs) {
      if (oldest === null || e.timestamp < oldest) oldest = e.timestamp;
    }
  }
  return new Date((oldest ?? nowMs) + FIVE_HOURS_MS);
}

// ─── Cost calculation ────────────────────────────────────────────────────────

/** Priority: caller-provided cost > live models.dev snapshot > bundled table */
export function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  externalCost?: ModelCost,
  liveCostResolver?: CostResolver,
): number {
  // Priority: caller-provided cost > live models.dev snapshot > bundled table
  const pricing = externalCost ?? liveCostResolver?.(modelId) ?? GO_MODEL_PRICING[modelId];
  if (!pricing) return 0;

  const billablePrompt = Math.max(0, promptTokens - cachedTokens);
  return (
    (billablePrompt * pricing.input) / 1_000_000 +
    (completionTokens * pricing.output) / 1_000_000 +
    (cachedTokens * (pricing.cache_read ?? pricing.input * 0.1)) / 1_000_000
  );
}

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

function readOpenCodeHistory(): HistoryRow[] | null {
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

// ─── Exported tracker class ──────────────────────────────────────────────────

export class GoUsageTracker {
  private entries: UsageLogEntry[] = [];
  /**
   * Whether this profile has ever recorded (or had cleared) local usage.
   * Kept true after a reset so the usage card shows zeroed local values
   * instead of collapsing into the first-run "no data" state.
   */
  private everTracked = false;
  private baseline: UsageBaseline = {};
  private readonly log?: (msg: string) => void;
  private costResolver?: CostResolver;
  /** Per-chat-session cost accumulator. Key = sessionId. */
  private sessionCosts = new Map<string, SessionCostSummary>();
  /** Latest server-accurate usage snapshot (account-wide meters). */
  private serverUsage: GoUsageApiResponse | undefined;
  /** Unix ms of the last successful {@link syncServerUsage} fetch. */
  private serverUsageFetchedAt = 0;
  /** In-flight sync promise per key — prevents duplicate concurrent fetches. */
  private syncInFlight: { apiKey: string; promise: Promise<boolean> } | undefined;
  private static readonly SESSION_IDLE_MS = GO_SESSION_IDLE_MS;
  private static readonly MAX_SESSIONS = GO_MAX_SESSIONS;

  constructor(
    private readonly context: vscode.ExtensionContext,
    log?: (msg: string) => void,
    costResolver?: CostResolver,
    /**
     * Per-profile storage suffix. When set, storage keys are namespaced
     * so multiple Go accounts can coexist. Empty string = legacy mode
     * (single account, shared key).
     */
    private readonly storageKeySuffix = "",
    private readonly options: GoUsageTrackerOptions = {},
  ) {
    this.log = log;
    this.costResolver = costResolver;
    if (log) {
      setHistoryReadDiagnostic(log);
    }
    this.restore();
    // Fast startup: show the last successful server snapshot immediately
    // instead of 0s until the TTL-guarded refetch lands. `serverUsageFetchedAt`
    // stays 0, so the background sync still refreshes right away.
    this.serverUsage = this.context.globalState.get<GoUsageApiResponse>(this.storageKey(GO_SERVER_USAGE_KEY));
  }

  private storageKey(base: string): string {
    return this.storageKeySuffix ? `${base}.${this.storageKeySuffix}` : base;
  }

  /**
   * Copy all data from the singleton legacy keys (without suffix) into
   * this profile's namespaced storage. Called once during the first
   * activation after a single-account user upgrades to multi-account.
   */
  migrateFromSingleton(): void {
    if (!this.storageKeySuffix) return; // i am the singleton
    const hasLegacyEntries = this.context.globalState.get<unknown[]>(STORAGE_KEY, []).length > 0;
    if (!hasLegacyEntries) return;

    this.log?.("[go-tracker] migrating legacy singleton data into profile");

    // Migrate entries
    const legacyEntries = this.context.globalState.get<UsageLogEntry[]>(STORAGE_KEY, []);
    if (Array.isArray(legacyEntries) && legacyEntries.length > 0) {
      const targetKey = this.storageKey(STORAGE_KEY);
      this.context.globalState.update(targetKey, legacyEntries);
      this.context.globalState.update(STORAGE_KEY, []);
      this.entries = legacyEntries.filter((e) => typeof e.timestamp === "number" && typeof e.cost === "number");
    }

    // Migrate baseline
    const legacyBaseline = this.context.globalState.get<UsageBaseline>(BASELINE_STORAGE_KEY, {});
    if (Object.keys(legacyBaseline).length > 0) {
      const targetBase = this.storageKey(BASELINE_STORAGE_KEY);
      this.context.globalState.update(targetBase, legacyBaseline);
      this.context.globalState.update(BASELINE_STORAGE_KEY, {});
      this.baseline = legacyBaseline;
    }

    // Migrate session costs
    const legacySessions = this.context.globalState.get<SessionCostSummary[]>(SESSION_COSTS_KEY, []);
    if (Array.isArray(legacySessions) && legacySessions.length > 0) {
      const targetSess = this.storageKey(SESSION_COSTS_KEY);
      this.context.globalState.update(targetSess, legacySessions);
      this.context.globalState.update(SESSION_COSTS_KEY, []);
      for (const s of legacySessions) {
        if (typeof s.sessionId === "string" && typeof s.cost === "number") {
          this.sessionCosts.set(s.sessionId, s);
        }
      }
    }

    this.persist();
    this.persistBaseline();
  }

  /** Record a completed Go request. externalCost is from resolved metadata if available. */
  record(summary: TransportRequestSummary, externalCost?: ModelCost): void {
    const displayNameLower = summary.providerDisplayName.toLowerCase();
    if (!displayNameLower.includes("go")) {
      this.log?.(`[go-tracker] SKIP: providerDisplayName "${summary.providerDisplayName}" does not contain "go"`);
      return;
    }

    const prompt = summary.promptTokens ?? 0;
    const completion = summary.completionTokens ?? 0;
    const cached = summary.cachedTokens ?? 0;

    if (prompt + completion === 0) {
      this.log?.(`[go-tracker] SKIP: zero tokens (prompt=${String(prompt)} completion=${String(completion)}) for model=${summary.modelId}`);
      return;
    }

    const cost = estimateCost(summary.modelId, prompt, completion, cached, externalCost, this.costResolver);
    // VS Code session cost reads usage.copilotCredits (1 credit = $0.01).
    // Compute from USD cost so the session info popover shows accurate totals.
    const copilotCredits = cost * 100;

    this.log?.(
      `[go-tracker] RECORD: model=${summary.modelId} prompt=${String(prompt)} completion=${String(completion)} cached=${String(cached)} cost=$${cost.toFixed(6)} credits=${copilotCredits.toFixed(4)}`,
    );

    this.entries.push({
      timestamp: Date.now(),
      modelId: summary.modelId,
      cost,
      promptTokens: prompt,
      completionTokens: completion,
      cachedTokens: cached,
      sessionId: summary.sessionId,
      copilotCredits,
    });
    this.markEverTracked();

    // Accumulate per-session cost
    if (summary.sessionId) {
      const existing = this.sessionCosts.get(summary.sessionId);
      if (existing) {
        existing.cost += cost;
        existing.requests++;
        existing.promptTokens += prompt;
        existing.completionTokens += completion;
        existing.lastActivity = Date.now();
      } else {
        this.sessionCosts.set(summary.sessionId, {
          sessionId: summary.sessionId,
          cost,
          requests: 1,
          promptTokens: prompt,
          completionTokens: completion,
          lastActivity: Date.now(),
        });
      }
      this.pruneSessions();
    }

    this.prune();
    this.persist();
  }

  getSummary(): UsageSummary {
    const nowMs = Date.now();
    const clamp = (v: number, limit: number) => Math.round(Math.min(100, (v / limit) * 100) * 10) / 10;

    // The CLI database is DEVICE-level usage (it has no per-key column), so
    // it is safe for the device rows (Today / Yesterday / Codebase). The
    // subscription METERS must stay account-scoped: the legacy (un-namespaced)
    // tracker derives them from the CLI rows, while per-profile trackers
    // derive them from their own tracked entries (the server-accurate meters
    // from syncServerUsage overlay them either way).
    const isPerProfile = this.storageKeySuffix.length > 0;
    const sqliteRows = readOpenCodeHistory();
    if (!isPerProfile && sqliteRows) {
      return this.serverUsage
        ? mergeServerUsage(this.buildSqliteEnrichedSummary(nowMs, sqliteRows, clamp), this.serverUsage, GO_LIMITS)
        : this.buildSqliteEnrichedSummary(nowMs, sqliteRows, clamp);
    }

    // Per-profile, or no CLI history available: meters from tracked entries,
    // device rows enriched with the CLI history when it exists.
    const base = this.buildSummaryFromTracked(nowMs, clamp);
    if (!sqliteRows) {
      return this.serverUsage ? mergeServerUsage(base, this.serverUsage, GO_LIMITS) : base;
    }
    const dayMs = this.dayStartMs(nowMs);
    const enriched: UsageSummary = {
      ...base,
      today: this.dailyUsage(sqliteRows, dayMs),
      yesterday: this.dailyUsage(sqliteRows, dayMs - 24 * 60 * 60 * 1000),
      codebase: this.codebaseUsage(sqliteRows),
      hasData: base.hasData || sqliteRows.length > 0,
      sqliteAvailable: true,
    };
    return this.serverUsage ? mergeServerUsage(enriched, this.serverUsage, GO_LIMITS) : enriched;
  }

  private dayStartMs(nowMs: number): number {
    return this.options.resolveDayBoundary?.() === "local" ? startOfLocalDay(nowMs) : startOfUtcDay(nowMs);
  }

  private todayYesterdaySource(): UsageTodayYesterdaySource {
    return this.options.resolveTodayYesterdaySource?.() ?? "auto";
  }

  /**
   * Merge the OpenCode CLI history rows and the extension-tracked entries for
   * one day window into a single total. The CLI DB records terminal usage and
   * the extension records VS Code usage — the two never overlap, so summing
   * them gives the user's real combined daily usage.
   */
  private dailyUsage(rows: HistoryRow[], dayStartMs: number): UsageDaily {
    return sumDailyUsage(rows, this.entries, dayStartMs, this.todayYesterdaySource());
  }

  /**
   * Time-series data for the usage panel: per-day totals and per-model
   * per-day rows over the last `days` days.
   */
  getUsageSeries(days: number): UsageSeries {
    const nowMs = Date.now();
    const rows = readOpenCodeHistory() ?? [];
    return buildUsageSeries(rows, this.entries, days, this.dayStartMs(nowMs), this.todayYesterdaySource());
  }

  /**
   * All-time usage in the CURRENT workspace, derived from the OpenCode CLI
   * history (`path.cwd` of each session's messages). "Forever" by default —
   * the window is controlled by `resolveCodebaseWindowDays` (0 = all history).
   */
  private codebaseUsage(rows: HistoryRow[]): UsageDaily {
    const folders = this.options.resolveWorkspaceFolders?.() ?? [];
    const windowDays = Math.max(0, this.options.resolveCodebaseWindowDays?.() ?? 0);
    const cutoffMs = windowDays > 0 ? Date.now() - windowDays * 24 * 60 * 60 * 1000 : 0;

    let cost = 0;
    let requests = 0;
    let tokens = 0;
    for (const row of rows) {
      if (cutoffMs > 0 && row.createdMs < cutoffMs) continue;
      if (!isCwdInWorkspace(row.cwd, folders)) continue;
      cost += row.cost;
      requests += 1;
      tokens += row.tokensInput + row.tokensOutput + row.tokensReasoning;
    }
    return { cost, requests, tokens };
  }

  /**
   * Fetch server-accurate account-wide usage for this profile's key and
   * cache it for {@link GO_USAGE_SYNC_TTL_MS}. Safe to call on every
   * request/status-bar refresh: the TTL guard makes it a no-op while a
   * fresh snapshot exists. Failures keep the previous snapshot (stale
   * beats nothing) and the local estimates remain the fallback.
   *
   * @returns true when a new snapshot was fetched.
   */
  async syncServerUsage(apiKey: string): Promise<boolean> {
    // Dedupe concurrent calls for the same key (startup + status-bar refresh
    // can fire at the same moment) — a single in-flight fetch is enough.
    if (this.syncInFlight && this.syncInFlight.apiKey === apiKey) {
      return this.syncInFlight.promise;
    }
    const promise = this.performServerUsageSync(apiKey);
    this.syncInFlight = { apiKey, promise };
    try {
      return await promise;
    } finally {
      if (this.syncInFlight.promise === promise) {
        this.syncInFlight = undefined;
      }
    }
  }

  private async performServerUsageSync(apiKey: string): Promise<boolean> {
    const now = Date.now();
    if (this.serverUsageFetchedAt > 0 && now - this.serverUsageFetchedAt < GO_USAGE_SYNC_TTL_MS) {
      return false;
    }
    const result = await fetchGoUsage(apiKey);
    // Pace retries after failures too — an invalid key or unreachable
    // endpoint must not hammer the API on every request.
    this.serverUsageFetchedAt = Date.now();
    if (!result.ok) {
      this.log?.(`[go-usage] Server usage sync skipped (${result.reason}); keeping local estimates.`);
      return false;
    }
    this.serverUsage = result.data;
    // Persist so the next window start can render the meters instantly.
    void this.context.globalState.update(this.storageKey(GO_SERVER_USAGE_KEY), result.data);
    this.log?.("[go-usage] Server usage synced from /zen/go/v1/usage.");
    return true;
  }

  /** Build summary from SQLite, enriched with merged today/yesterday + codebase totals. */
  private buildSqliteEnrichedSummary(nowMs: number, rows: HistoryRow[], clamp: (v: number, limit: number) => number): UsageSummary {
    const base = this.buildSummaryFromRows(nowMs, rows, clamp);

    // Today/Yesterday merge the CLI history (cost + tokens + requests) with
    // the extension's own tracked requests — the two never overlap, so the
    // sum is the user's real combined usage for the day.
    const dayMs = this.dayStartMs(nowMs);
    const yesterdayMs = dayMs - 24 * 60 * 60 * 1000;
    const today = this.dailyUsage(rows, dayMs);
    const yesterday = this.dailyUsage(rows, yesterdayMs);

    // Apply baselines on top of SQLite costs.
    const activeBaselineSession = this.getActiveBaselineAmount("session", nowMs);
    const activeBaselineWeekly = this.getActiveBaselineAmount("weekly", nowMs);
    const activeBaselineMonthly = this.getActiveBaselineAmount("monthly", nowMs);

    return {
      session: {
        ...base.session,
        spent: Math.round((base.session.spent + activeBaselineSession) * 10000) / 10000,
        percent: clamp(base.session.spent + activeBaselineSession, GO_LIMITS.session),
      },
      weekly: {
        ...base.weekly,
        spent: Math.round((base.weekly.spent + activeBaselineWeekly) * 10000) / 10000,
        percent: clamp(base.weekly.spent + activeBaselineWeekly, GO_LIMITS.weekly),
      },
      monthly: {
        ...base.monthly,
        spent: Math.round((base.monthly.spent + activeBaselineMonthly) * 10000) / 10000,
        percent: clamp(base.monthly.spent + activeBaselineMonthly, GO_LIMITS.monthly),
      },
      today,
      yesterday,
      codebase: this.codebaseUsage(rows),
      hasData: true,
      sqliteAvailable: true,
    };
  }

  /** Build summary from opencode.db rows (enrichment data from CLI history) */
  private buildSummaryFromRows(nowMs: number, rows: HistoryRow[], clamp: (v: number, limit: number) => number): UsageSummary {
    const dayMs = startOfUtcDay(nowMs);
    const yesterdayMs = dayMs - 24 * 60 * 60 * 1000;
    const weekMs = startOfUtcWeek(nowMs);
    const sessionStart = nowMs - FIVE_HOURS_MS;
    const earliest = rows.length > 0 ? Math.min(...rows.map((r) => r.createdMs)) : null;
    const { monthStartMs, monthEndMs } = buildMonthlyWindow(nowMs, this.baseline, earliest);
    const weekEnd = weekMs + WEEK_MS;

    let sessionCost = 0,
      weeklyCost = 0,
      monthlyCost = 0;
    let todayCost = 0,
      todayReq = 0;
    let yestCost = 0,
      yestReq = 0;

    for (const r of rows) {
      if (r.createdMs >= sessionStart && r.createdMs <= nowMs) sessionCost += r.cost;
      if (r.createdMs >= weekMs && r.createdMs <= nowMs) weeklyCost += r.cost;
      if (r.createdMs >= monthStartMs && r.createdMs < monthEndMs) monthlyCost += r.cost;
      if (r.createdMs >= dayMs) {
        todayCost += r.cost;
        todayReq += 1;
      } else if (r.createdMs >= yesterdayMs) {
        yestCost += r.cost;
        yestReq += 1;
      }
    }

    // Rolling 5h reset: oldest entry in window + 5h
    let oldest: number | null = null;
    for (const r of rows) {
      if (r.createdMs >= sessionStart && r.createdMs < nowMs) {
        if (oldest === null || r.createdMs < oldest) oldest = r.createdMs;
      }
    }

    // If a monthly baseline exists and is active, use its expiresAt for resetsAt.
    const monthlyResetsAt = this.baseline.monthly ? new Date(this.baseline.monthly.expiresAt) : new Date(monthEndMs);

    return {
      session: {
        spent: Math.round(sessionCost * 10000) / 10000,
        limit: GO_LIMITS.session,
        percent: clamp(sessionCost, GO_LIMITS.session),
        resetsAt: new Date((oldest ?? nowMs) + FIVE_HOURS_MS),
      },
      weekly: {
        spent: Math.round(weeklyCost * 10000) / 10000,
        limit: GO_LIMITS.weekly,
        percent: clamp(weeklyCost, GO_LIMITS.weekly),
        resetsAt: new Date(weekEnd),
      },
      monthly: {
        spent: Math.round(monthlyCost * 10000) / 10000,
        limit: GO_LIMITS.monthly,
        percent: clamp(monthlyCost, GO_LIMITS.monthly),
        resetsAt: monthlyResetsAt,
      },
      today: {
        cost: Math.round(todayCost * 10000) / 10000,
        requests: todayReq,
        tokens: 0, // not available from SQLite
      },
      yesterday: {
        cost: Math.round(yestCost * 10000) / 10000,
        requests: yestReq,
        tokens: 0,
      },
      hasData: true,
      sqliteAvailable: true,
      codebase: { cost: 0, requests: 0, tokens: 0 },
    };
  }

  /** Check if opencode.db is readable and has Go history */
  get hasSQLiteData(): boolean {
    const rows = readOpenCodeHistory();
    return rows !== null && rows.length > 0;
  }

  /** Build summary from extension-tracked entries (fallback when opencode.db unavailable) */
  private buildSummaryFromTracked(nowMs: number, clamp: (v: number, limit: number) => number): UsageSummary {
    const dayMs = this.dayStartMs(nowMs);
    const yesterdayMs = dayMs - 24 * 60 * 60 * 1000;
    const weekMs = startOfUtcWeek(nowMs);
    const { monthStartMs, monthEndMs } = buildMonthlyWindow(nowMs, this.baseline);
    const sessionStart = nowMs - FIVE_HOURS_MS;

    let trackedSessionCost = 0,
      trackedWeeklyCost = 0,
      trackedMonthlyCost = 0;
    let todayCost = 0,
      todayReq = 0,
      todayTokens = 0;
    let yestCost = 0,
      yestReq = 0,
      yestTokens = 0;

    for (const e of this.entries) {
      if (e.timestamp >= sessionStart && e.timestamp <= nowMs) trackedSessionCost += e.cost;
      if (e.timestamp >= weekMs && e.timestamp <= nowMs) trackedWeeklyCost += e.cost;
      if (e.timestamp >= monthStartMs && e.timestamp < monthEndMs) trackedMonthlyCost += e.cost;
      if (e.timestamp >= dayMs) {
        todayCost += e.cost;
        todayReq += 1;
        todayTokens += e.promptTokens + e.completionTokens;
      } else if (e.timestamp >= yesterdayMs) {
        yestCost += e.cost;
        yestReq += 1;
        yestTokens += e.promptTokens + e.completionTokens;
      }
    }

    const activeBaselineSession = this.getActiveBaselineAmount("session", nowMs);
    const activeBaselineWeekly = this.getActiveBaselineAmount("weekly", nowMs);
    const activeBaselineMonthly = this.getActiveBaselineAmount("monthly", nowMs);

    const sessionCost = trackedSessionCost + activeBaselineSession;
    const weeklyCost = trackedWeeklyCost + activeBaselineWeekly;
    const monthlyCost = trackedMonthlyCost + activeBaselineMonthly;

    const weekEnd = weekMs + WEEK_MS;

    // If a monthly baseline exists and is active, use its expiresAt for resetsAt
    // instead of the anchor-based calculation (which ignores manual targets).
    const monthlyResetsAt = this.baseline.monthly ? new Date(this.baseline.monthly.expiresAt) : new Date(monthEndMs);

    return {
      session: {
        spent: Math.round(sessionCost * 10000) / 10000,
        limit: GO_LIMITS.session,
        percent: clamp(sessionCost, GO_LIMITS.session),
        resetsAt: nextSessionReset(this.entries, nowMs),
      },
      weekly: {
        spent: Math.round(weeklyCost * 10000) / 10000,
        limit: GO_LIMITS.weekly,
        percent: clamp(weeklyCost, GO_LIMITS.weekly),
        resetsAt: new Date(weekEnd),
      },
      monthly: {
        spent: Math.round(monthlyCost * 10000) / 10000,
        limit: GO_LIMITS.monthly,
        percent: clamp(monthlyCost, GO_LIMITS.monthly),
        resetsAt: monthlyResetsAt,
      },
      today: {
        cost: Math.round(todayCost * 10000) / 10000,
        requests: todayReq,
        tokens: todayTokens,
      },
      yesterday: {
        cost: Math.round(yestCost * 10000) / 10000,
        requests: yestReq,
        tokens: yestTokens,
      },
      // Without the CLI history there is no per-directory attribution, so the
      // codebase total falls back to everything this extension has tracked
      // (it only ever runs inside the current workspace).
      codebase: {
        cost: Math.round(this.entries.reduce((total, e) => total + e.cost, 0) * 10000) / 10000,
        requests: this.entries.length,
        tokens: this.entries.reduce((total, e) => total + e.promptTokens + e.completionTokens, 0),
      },
      hasData: this.entries.length > 0 || this.everTracked,
      sqliteAvailable: false,
    };
  }

  setManualSpentTargets(targets: UsageBaselineTargets): void {
    const nowMs = Date.now();

    // ── Monthly ───────────────────────────────────────────────────────────
    // When namespaced, skip SQLite — it has no key column and would mix
    // quota from all accounts.
    const isPerProfile = this.storageKeySuffix.length > 0;
    const sqliteRows = isPerProfile ? null : readOpenCodeHistory();
    let sqliteMonthlyCost = 0;
    if (sqliteRows && sqliteRows.length > 0) {
      const earliest = Math.min(...sqliteRows.map((r) => r.createdMs));
      // Build a temporary baseline to let buildMonthlyWindow find the anchor
      const tempBaseline: UsageBaseline = { ...this.baseline };
      if (targets.monthlyAnchorDay && targets.monthlyAnchorDay >= 1 && targets.monthlyAnchorDay <= 31) {
        tempBaseline.monthly = {
          ...(tempBaseline.monthly ?? { amount: 0, expiresAt: 0 }),
          anchorDay: targets.monthlyAnchorDay,
          anchorHour: targets.monthlyAnchorHour ?? 0,
        };
      }
      const { monthStartMs, monthEndMs } = buildMonthlyWindow(nowMs, tempBaseline, earliest);
      for (const r of sqliteRows) {
        if (r.createdMs >= monthStartMs && r.createdMs < monthEndMs) {
          sqliteMonthlyCost += r.cost;
        }
      }
    }

    const currentBaselineMonthly = this.getActiveBaselineAmount("monthly", nowMs);
    // trackedMonthly = what SQLite shows for the target window + tracked entries baseline adjustment
    // When no SQLite, fall back to tracked entries for the target window
    let trackedMonthly = sqliteMonthlyCost;
    if (!sqliteRows) {
      // No SQLite: compute from tracked entries using the target window
      const tempBaseline: UsageBaseline = { ...this.baseline };
      if (targets.monthlyAnchorDay && targets.monthlyAnchorDay >= 1 && targets.monthlyAnchorDay <= 31) {
        tempBaseline.monthly = {
          ...(tempBaseline.monthly ?? { amount: 0, expiresAt: 0 }),
          anchorDay: targets.monthlyAnchorDay,
          anchorHour: targets.monthlyAnchorHour ?? 0,
        };
      }
      const { monthStartMs, monthEndMs } = buildMonthlyWindow(nowMs, tempBaseline);
      for (const e of this.entries) {
        if (e.timestamp >= monthStartMs && e.timestamp < monthEndMs) {
          trackedMonthly += e.cost;
        }
      }
    }
    // If SQLite had no rows (empty array), use summary fallback
    if (sqliteRows && sqliteRows.length === 0) {
      const summary = this.getSummary();
      trackedMonthly = Math.max(0, summary.monthly.spent - currentBaselineMonthly);
    }
    // For SQLite path, subtract the current baseline so we don't double-count
    if (sqliteRows && sqliteRows.length > 0) {
      trackedMonthly = Math.max(0, trackedMonthly - currentBaselineMonthly);
    }

    // ── Session and Weekly ────────────────────────────────────────────────
    const summary = this.getSummary();
    const currentBaselineSession = this.getActiveBaselineAmount("session", nowMs);
    const currentBaselineWeekly = this.getActiveBaselineAmount("weekly", nowMs);

    const trackedSession = Math.max(0, summary.session.spent - currentBaselineSession);
    const trackedWeekly = Math.max(0, summary.weekly.spent - currentBaselineWeekly);

    this.baseline.session = {
      amount: targets.session - trackedSession,
      expiresAt: summary.session.resetsAt.getTime(),
    };
    this.baseline.weekly = {
      amount: targets.weekly - trackedWeekly,
      expiresAt: summary.weekly.resetsAt.getTime(),
    };
    this.baseline.monthly = {
      amount: targets.monthly - trackedMonthly,
      expiresAt: summary.monthly.resetsAt.getTime(),
    };

    // Override monthly expiry if caller provided anchor day + hour.
    if (targets.monthlyAnchorDay && targets.monthlyAnchorDay >= 1 && targets.monthlyAnchorDay <= 31) {
      const hour = targets.monthlyAnchorHour ?? 0;
      const now = new Date(nowMs);
      let year = now.getUTCFullYear();
      let month = now.getUTCMonth();
      let candidate = Date.UTC(year, month, targets.monthlyAnchorDay, hour, 0, 0, 0);
      if (candidate <= nowMs) {
        // If the anchor day+hour has passed this month, next reset is next month.
        month++;
        if (month > 11) {
          year++;
          month = 0;
        }
        candidate = Date.UTC(year, month, targets.monthlyAnchorDay, hour, 0, 0, 0);
      }
      this.baseline.monthly = {
        amount: this.baseline.monthly.amount,
        expiresAt: candidate,
        anchorDay: targets.monthlyAnchorDay,
        anchorHour: hour,
      };
    }

    this.persistBaseline();
  }

  clear(): void {
    this.entries = [];
    this.baseline = {};
    this.sessionCosts.clear();
    this.persist();
    this.persistBaseline();
    // Keep the usage card alive with zeroed values instead of falling back
    // to the first-run "no data" state.
    this.markEverTracked();
  }

  /** Mark (and persist) that this profile has local usage history. */
  private markEverTracked(): void {
    if (this.everTracked) return;
    this.everTracked = true;
    void this.context.globalState.update(this.storageKey(EVER_TRACKED_KEY), true);
  }

  /** Whether a server-accurate usage snapshot is currently in effect. */
  get hasServerUsage(): boolean {
    return this.serverUsage !== undefined;
  }

  private prune(): void {
    // Tracked usage is permanent — users rely on the history for today/
    // yesterday/codebase totals, so no time-based cutoff. Only the hard
    // entry cap applies.
    this.entries = this.entries.slice(-MAX_LOG_ENTRIES);
  }

  /** Remove idle sessions and cap total count. */
  private pruneSessions(): void {
    const now = Date.now();
    const idleCutoff = now - GoUsageTracker.SESSION_IDLE_MS;
    for (const [id, s] of this.sessionCosts) {
      if (s.lastActivity < idleCutoff) {
        this.sessionCosts.delete(id);
      }
    }
    // If still over limit, remove oldest by lastActivity
    if (this.sessionCosts.size > GoUsageTracker.MAX_SESSIONS) {
      const sorted = [...this.sessionCosts.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
      const toRemove = sorted.length - GoUsageTracker.MAX_SESSIONS;
      for (let i = 0; i < toRemove; i++) {
        this.sessionCosts.delete(sorted[i][0]);
      }
    }
  }

  /** Returns the most recent chat session's cost summary. */
  getCurrentSessionCost(): SessionCostSummary | undefined {
    let latest: SessionCostSummary | undefined;
    for (const s of this.sessionCosts.values()) {
      if (!latest || s.lastActivity > latest.lastActivity) {
        latest = s;
      }
    }
    return latest;
  }

  /** Returns up to `limit` most recent session cost summaries, ordered by last activity (newest first). */
  getRecentSessionCosts(limit = 5): SessionCostSummary[] {
    return [...this.sessionCosts.values()].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, limit);
  }

  private persist(): void {
    void this.context.globalState.update(this.storageKey(STORAGE_KEY), this.entries);
    void this.context.globalState.update(this.storageKey(SESSION_COSTS_KEY), [...this.sessionCosts.values()]);
  }

  private persistBaseline(): void {
    void this.context.globalState.update(this.storageKey(BASELINE_STORAGE_KEY), this.baseline);
  }

  private getActiveBaselineAmount(period: keyof UsageBaseline, nowMs: number): number {
    const entry = this.baseline[period];
    if (!entry) return 0;
    if (entry.expiresAt <= nowMs) {
      this.baseline[period] = undefined;
      this.persistBaseline();
      return 0;
    }
    return entry.amount;
  }

  private restore(): void {
    const stored = this.context.globalState.get<UsageLogEntry[]>(this.storageKey(STORAGE_KEY), []);
    if (Array.isArray(stored)) {
      this.entries = stored.filter((e) => typeof e.timestamp === "number" && typeof e.cost === "number");
    }

    this.everTracked = this.context.globalState.get<boolean>(this.storageKey(EVER_TRACKED_KEY), this.entries.length > 0);

    const baseline = this.context.globalState.get<UsageBaseline>(this.storageKey(BASELINE_STORAGE_KEY), {});
    if (typeof baseline === "object") {
      this.baseline = baseline;
    }

    // Restore session costs from persistence
    const storedSessions = this.context.globalState.get<SessionCostSummary[]>(this.storageKey(SESSION_COSTS_KEY), []);
    if (Array.isArray(storedSessions)) {
      for (const s of storedSessions) {
        if (typeof s.sessionId === "string" && typeof s.cost === "number") {
          this.sessionCosts.set(s.sessionId, s);
        }
      }
      this.pruneSessions();
    }
  }
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function progressBar(percent: number, width = 10): string {
  const filled = Math.round((percent / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function fmtDate(d: Date): string {
  return (
    d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }) + " UTC"
  );
}

function percentColor(pct: number): string {
  if (pct >= 90) return "⛔";
  if (pct >= 75) return "🟠";
  if (pct >= 50) return "🟡";
  return "🟢";
}

/** Status bar label: e.g. "Go: 27%·62%·75%" */
export function formatGoUsageStatusBarText(summary: UsageSummary): string {
  if (!summary.hasData) return "OpenCode Go";
  const s = summary.session.percent;
  const w = summary.weekly.percent;
  const m = summary.monthly.percent;
  const warn = s >= 80 || w >= 80 || m >= 80 ? " $(warning)" : "";
  return `Go: ${String(s)}%·${String(w)}%·${String(m)}%${warn}`;
}

/** Build Quick Pick items for the usage panel */
export function buildUsageQuickPickItems(summary: UsageSummary, syncedFromServer = false, showRollingMeter = true): vscode.QuickPickItem[] {
  const now = new Date();
  const isEmpty = !summary.hasData;

  function periodItem(icon: string, label: string, period: PeriodUsage, resetLabel: string): vscode.QuickPickItem {
    const bar = progressBar(period.percent);
    const spent = formatUsd(period.spent);
    const limit = formatUsd(period.limit);
    const resets = formatRelativeTime(period.resetsAt, now);
    return {
      label: `${icon} ${label}`,
      description: `${bar} ${String(period.percent)}%`,
      detail: `${spent} / ${limit} used · resets in ${resets} (${resetLabel})`,
      alwaysShow: true,
    };
  }

  const items: vscode.QuickPickItem[] = [];

  if (isEmpty) {
    items.push({
      label: "$(info) Ready to track",
      detail: "Send a chat message to any OpenCode Go model to start tracking usage.",
      alwaysShow: true,
    });
  }

  if (syncedFromServer) {
    items.push({
      label: "$(cloud) Synced from opencode.ai",
      detail: "Session/Weekly/Monthly meters are account-wide and server-accurate.",
      alwaysShow: true,
    });
  }

  // ── Period bars ──────────────────────────────────────────────────────────
  items.push({ label: "Subscription Limits", kind: vscode.QuickPickItemKind.Separator });

  if (showRollingMeter) {
    items.push(
      periodItem(
        percentColor(summary.session.percent) + " $(clock)",
        "Session (5h rolling)",
        summary.session,
        fmtDate(summary.session.resetsAt),
      ),
    );
  }

  items.push(periodItem(percentColor(summary.weekly.percent) + " $(calendar)", "Weekly", summary.weekly, fmtDate(summary.weekly.resetsAt)));

  items.push(
    periodItem(percentColor(summary.monthly.percent) + " $(graph)", "Monthly", summary.monthly, fmtDate(summary.monthly.resetsAt)),
  );

  // ── Daily summary ────────────────────────────────────────────────────────
  items.push({ label: "Daily Summary", kind: vscode.QuickPickItemKind.Separator });

  items.push({
    label: `$(history) Today`,
    description: formatUsd(summary.today.cost),
    detail: `${formatTokenCount(summary.today.tokens)} tokens · ${formatCount(summary.today.requests)} requests`,
    alwaysShow: true,
  });

  if (summary.yesterday.requests > 0 || isEmpty) {
    items.push({
      label: `$(history) Yesterday`,
      description: formatUsd(summary.yesterday.cost),
      detail: `${formatTokenCount(summary.yesterday.tokens)} tokens · ${formatCount(summary.yesterday.requests)} requests`,
      alwaysShow: true,
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  items.push({ label: "Actions", kind: vscode.QuickPickItemKind.Separator });

  items.push({
    label: "$(link-external) Open OpenCode console",
    description: "View usage at opencode.ai",
    alwaysShow: true,
    _action: "openConsole",
  } as vscode.QuickPickItem & { _action: string });

  return items;
}

export { GO_VENDOR };
