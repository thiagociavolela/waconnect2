import fs from "fs/promises";
import path from "path";
import { APP_TIMEZONE, appDateTimeToMysql, mysqlAppToIso, nowApp } from "./timezone";

export type TrackedEndpointKey =
  | "check_number"
  | "send_text"
  | "send_media"
  | "send_contact"
  | "send_narration"
  | "attendance_create"
  | "attendance_list"
  | "attendance_messages"
  | "attendance_media"
  | "attendance_notes_list"
  | "attendance_note_create"
  | "attendance_reply"
  | "attendance_schedule"
  | "attendance_assign"
  | "attendance_status"
  | "attendance_read"
  | "attendance_tags_update"
  | "attendance_agents_summary"
  | "attendance_stats";

export type EndpointStatsPeriod = "today" | "7d" | "30d" | "all";

export interface EndpointMetric {
  key: TrackedEndpointKey;
  method: "POST" | "GET";
  path: string;
  label: string;
  total: number;
  success: number;
  clientError: number;
  serverError: number;
  lastCalledAt: string | null;
}

export interface EndpointStatsSummary {
  timezone: string;
  period: EndpointStatsPeriod;
  totalRequests: number;
  totalSuccess: number;
  totalClientError: number;
  totalServerError: number;
  lastActivityAt: string | null;
  endpoints: EndpointMetric[];
}

interface StatsFileShape {
  endpoints: Record<TrackedEndpointKey, PersistedEndpointStats>;
}

interface PersistedEndpointStats {
  overall: PersistedEndpointMetric;
  daily: Record<string, PersistedEndpointMetric>;
}

interface PersistedEndpointMetric {
  total: number;
  success: number;
  clientError: number;
  serverError: number;
  lastCalledAt: string | null;
}

type LegacyStatsFileShape = {
  endpoints?: Record<TrackedEndpointKey, PersistedEndpointMetric>;
};

const TRACKED_ENDPOINTS: Array<Pick<EndpointMetric, "key" | "method" | "path" | "label">> = [
  { key: "check_number", method: "POST", path: "/api/check-number", label: "Verificar numero" },
  { key: "send_text", method: "POST", path: "/api/send/text", label: "Enviar texto" },
  { key: "send_media", method: "POST", path: "/api/send/media", label: "Enviar midia" },
  { key: "send_contact", method: "POST", path: "/api/send/contact", label: "Enviar contato" },
  { key: "send_narration", method: "POST", path: "/api/send/narration", label: "Enviar narracao" },
  { key: "attendance_create", method: "POST", path: "/api/attendance/conversations", label: "Criar conversa de atendimento" },
  { key: "attendance_list", method: "GET", path: "/api/attendance/conversations", label: "Listar conversas de atendimento" },
  { key: "attendance_messages", method: "GET", path: "/api/attendance/conversations/:id/messages", label: "Listar mensagens do atendimento" },
  { key: "attendance_media", method: "POST", path: "/api/attendance/conversations/:id/media", label: "Enviar midia no atendimento" },
  { key: "attendance_notes_list", method: "GET", path: "/api/attendance/conversations/:id/notes", label: "Listar notas do atendimento" },
  { key: "attendance_note_create", method: "POST", path: "/api/attendance/conversations/:id/notes", label: "Criar nota do atendimento" },
  { key: "attendance_reply", method: "POST", path: "/api/attendance/conversations/:id/reply", label: "Responder atendimento" },
  { key: "attendance_schedule", method: "POST", path: "/api/attendance/conversations/:id/schedule", label: "Agendar mensagem no atendimento" },
  { key: "attendance_assign", method: "POST", path: "/api/attendance/conversations/:id/assign", label: "Atribuir atendimento" },
  { key: "attendance_status", method: "POST", path: "/api/attendance/conversations/:id/status", label: "Atualizar status do atendimento" },
  { key: "attendance_read", method: "POST", path: "/api/attendance/conversations/:id/read", label: "Marcar atendimento como lido" },
  { key: "attendance_tags_update", method: "POST", path: "/api/attendance/conversations/:id/tags", label: "Atualizar tags do atendimento" },
  { key: "attendance_agents_summary", method: "GET", path: "/api/attendance/agents/summary", label: "Resumo por atendente" },
  { key: "attendance_stats", method: "GET", path: "/api/attendance/stats", label: "Estatisticas do atendimento" }
];

const DAILY_RETENTION_DAYS = 90;

function createEmptyMetric(): PersistedEndpointMetric {
  return {
    total: 0,
    success: 0,
    clientError: 0,
    serverError: 0,
    lastCalledAt: null
  };
}

function createEmptyEndpointStats(): PersistedEndpointStats {
  return {
    overall: createEmptyMetric(),
    daily: {}
  };
}

export class ApiStatsService {
  private readonly statsFilePath = path.join(process.cwd(), "data", "api-endpoint-stats.json");
  private readonly stats = new Map<TrackedEndpointKey, PersistedEndpointStats>();
  private writeScheduled = false;
  private shuttingDown = false;
  private ready: Promise<void>;

  constructor() {
    for (const endpoint of TRACKED_ENDPOINTS) {
      this.stats.set(endpoint.key, createEmptyEndpointStats());
    }
    this.ready = this.load();
    this.registerProcessHooks();
  }

  async track(key: TrackedEndpointKey, statusCode: number) {
    await this.ready;

    const endpointStats = this.stats.get(key);
    if (!endpointStats) return;

    const now = nowApp();
    const bucketKey = now.toFormat("yyyy-MM-dd");
    const calledAt = mysqlAppToIso(appDateTimeToMysql(now));
    const dayBucket = endpointStats.daily[bucketKey] ?? createEmptyMetric();

    bumpMetric(endpointStats.overall, statusCode, calledAt);
    bumpMetric(dayBucket, statusCode, calledAt);

    endpointStats.daily[bucketKey] = dayBucket;
    this.pruneDailyBuckets(endpointStats, now);
    this.scheduleWrite();
  }

  async getSummary(period: EndpointStatsPeriod = "all"): Promise<EndpointStatsSummary> {
    await this.ready;

    const endpoints = TRACKED_ENDPOINTS.map((endpoint) => {
      const stats = this.stats.get(endpoint.key) ?? createEmptyEndpointStats();
      const metric = this.selectMetricForPeriod(stats, period);
      return {
        ...endpoint,
        ...metric
      };
    });

    const activityList = endpoints
      .map((item) => item.lastCalledAt)
      .filter((item): item is string => Boolean(item))
      .sort();

    return {
      timezone: APP_TIMEZONE,
      period,
      totalRequests: endpoints.reduce((sum, item) => sum + item.total, 0),
      totalSuccess: endpoints.reduce((sum, item) => sum + item.success, 0),
      totalClientError: endpoints.reduce((sum, item) => sum + item.clientError, 0),
      totalServerError: endpoints.reduce((sum, item) => sum + item.serverError, 0),
      lastActivityAt: activityList.length ? activityList[activityList.length - 1] ?? null : null,
      endpoints
    };
  }

  private selectMetricForPeriod(stats: PersistedEndpointStats, period: EndpointStatsPeriod): PersistedEndpointMetric {
    if (period === "all") {
      return cloneMetric(stats.overall);
    }

    const cutoff = getPeriodCutoff(period);
    const selectedKeys = Object.keys(stats.daily).filter((key) => key >= cutoff);
    const aggregated = createEmptyMetric();

    for (const key of selectedKeys) {
      const dayMetric = stats.daily[key];
      if (!dayMetric) continue;
      aggregated.total += dayMetric.total;
      aggregated.success += dayMetric.success;
      aggregated.clientError += dayMetric.clientError;
      aggregated.serverError += dayMetric.serverError;
      aggregated.lastCalledAt = maxIso(aggregated.lastCalledAt, dayMetric.lastCalledAt);
    }

    return aggregated;
  }

  private pruneDailyBuckets(stats: PersistedEndpointStats, now = nowApp()) {
    const oldestAllowed = now.minus({ days: DAILY_RETENTION_DAYS - 1 }).toFormat("yyyy-MM-dd");
    for (const key of Object.keys(stats.daily)) {
      if (key < oldestAllowed) {
        delete stats.daily[key];
      }
    }
  }

  private async load() {
    try {
      const content = await fs.readFile(this.statsFilePath, "utf8");
      const parsed = JSON.parse(content) as StatsFileShape | LegacyStatsFileShape;

      for (const endpoint of TRACKED_ENDPOINTS) {
        const current = this.stats.get(endpoint.key) ?? createEmptyEndpointStats();
        const stored = parsed.endpoints?.[endpoint.key];
        if (!stored) {
          this.stats.set(endpoint.key, current);
          continue;
        }

        if ("overall" in stored) {
          current.overall = normalizeMetric(stored.overall);
          current.daily = normalizeDaily(stored.daily);
        } else {
          current.overall = normalizeMetric(stored as PersistedEndpointMetric);
          current.daily = {};
          const inferredBucket = inferLegacyBucketKey(current.overall.lastCalledAt);
          if (current.overall.total > 0 && inferredBucket) {
            current.daily[inferredBucket] = cloneMetric(current.overall);
          }
        }

        this.pruneDailyBuckets(current);
        this.stats.set(endpoint.key, current);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error("Falha ao carregar estatisticas da API:", err);
      }
    }
  }

  private scheduleWrite() {
    if (this.writeScheduled) return;
    this.writeScheduled = true;

    setTimeout(() => {
      void this.flush();
    }, 250);
  }

  private async flush() {
    this.writeScheduled = false;
    try {
      await fs.mkdir(path.dirname(this.statsFilePath), { recursive: true });
      const endpoints = Object.fromEntries(this.stats.entries()) as StatsFileShape["endpoints"];
      await fs.writeFile(this.statsFilePath, JSON.stringify({ endpoints }, null, 2), "utf8");
    } catch (err) {
      console.error("Falha ao persistir estatisticas da API:", err);
    }
  }

  private registerProcessHooks() {
    process.on("beforeExit", () => {
      void this.flush();
    });

    const gracefulShutdown = (signal: NodeJS.Signals) => {
      if (this.shuttingDown) return;
      this.shuttingDown = true;

      void this.flush()
        .catch((err) => {
          console.error("Falha ao persistir estatisticas da API no encerramento:", err);
        })
        .finally(() => {
          process.exit(signal === "SIGINT" ? 130 : 143);
        });
    };

    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  }
}

function bumpMetric(metric: PersistedEndpointMetric, statusCode: number, calledAt: string) {
  metric.total += 1;
  if (statusCode >= 500) {
    metric.serverError += 1;
  } else if (statusCode >= 400) {
    metric.clientError += 1;
  } else {
    metric.success += 1;
  }
  metric.lastCalledAt = calledAt;
}

function normalizeMetric(metric: PersistedEndpointMetric | undefined): PersistedEndpointMetric {
  return {
    total: Number(metric?.total ?? 0),
    success: Number(metric?.success ?? 0),
    clientError: Number(metric?.clientError ?? 0),
    serverError: Number(metric?.serverError ?? 0),
    lastCalledAt: metric?.lastCalledAt ?? null
  };
}

function normalizeDaily(daily: Record<string, PersistedEndpointMetric> | undefined): Record<string, PersistedEndpointMetric> {
  const normalized: Record<string, PersistedEndpointMetric> = {};
  for (const [key, value] of Object.entries(daily ?? {})) {
    normalized[key] = normalizeMetric(value);
  }
  return normalized;
}

function cloneMetric(metric: PersistedEndpointMetric): PersistedEndpointMetric {
  return {
    total: metric.total,
    success: metric.success,
    clientError: metric.clientError,
    serverError: metric.serverError,
    lastCalledAt: metric.lastCalledAt
  };
}

function getPeriodCutoff(period: Exclude<EndpointStatsPeriod, "all">): string {
  const now = nowApp().startOf("day");
  if (period === "today") return now.toFormat("yyyy-MM-dd");
  if (period === "7d") return now.minus({ days: 6 }).toFormat("yyyy-MM-dd");
  return now.minus({ days: 29 }).toFormat("yyyy-MM-dd");
}

function maxIso(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate > current ? candidate : current;
}

function inferLegacyBucketKey(lastCalledAt: string | null): string {
  if (lastCalledAt) {
    const datePart = lastCalledAt.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      return datePart;
    }
  }

  return nowApp().toFormat("yyyy-MM-dd");
}
