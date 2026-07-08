import crypto from "crypto";
import mysql, { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { APP_TIMEZONE, APP_TIMEZONE_OFFSET, appDateTimeToMysql, mysqlAppToIso, nowApp, parseAppWallClockDateTime, subtractMilliseconds } from "./timezone";
import { WhatsAppService } from "./whatsapp";

export type ScheduleType = "text";
export type ScheduleStatus = "pending" | "paused" | "processing" | "sent" | "failed" | "cancelled";

export interface ScheduleConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  poolLimit: number;
  autoCreateSchema: boolean;
  workerEnabled: boolean;
  workerPollMs: number;
  workerBatchSize: number;
  staleProcessingMs: number;
}

export interface CreateScheduleInput {
  type?: ScheduleType;
  to: string;
  message: string;
  scheduledAt: string;
  maxAttempts?: number;
  createdBy?: string;
  externalRef?: string;
}

export interface UpdateScheduleInput {
  to?: string;
  message?: string;
  scheduledAt?: string;
  maxAttempts?: number;
  createdBy?: string | null;
  externalRef?: string | null;
  status?: Extract<ScheduleStatus, "pending" | "paused">;
}

export interface ListSchedulesFilters {
  status?: ScheduleStatus;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface ListSchedulesResult {
  items: ScheduleRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ScheduleRecord {
  id: string;
  type: ScheduleType;
  to: string;
  message: string | null;
  payload: unknown;
  scheduledAt: string;
  status: ScheduleStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  processingAt: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  externalRef: string | null;
  result: unknown;
}

export interface ScheduleStats {
  total: number;
  pending: number;
  paused: number;
  processing: number;
  sent: number;
  failed: number;
  cancelled: number;
  sentToday: number;
}

interface ScheduleRow extends RowDataPacket {
  id: string;
  type: ScheduleType;
  to_number: string;
  message_text: string | null;
  payload_json: string | null;
  scheduled_at: string;
  status: ScheduleStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  processing_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  external_ref: string | null;
  result_json: string | null;
}

interface ScheduleStatsRow extends RowDataPacket {
  total: number | string | null;
  pending: number | string | null;
  paused: number | string | null;
  processing: number | string | null;
  sent: number | string | null;
  failed: number | string | null;
  cancelled: number | string | null;
  sent_today: number | string | null;
}

interface CountRow extends RowDataPacket {
  total: number | string | null;
}

const CREATE_SCHEDULES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS message_schedules (
  id CHAR(36) NOT NULL PRIMARY KEY,
  type VARCHAR(20) NOT NULL DEFAULT 'text',
  to_number VARCHAR(30) NOT NULL,
  message_text TEXT NULL,
  payload_json JSON NULL,
  scheduled_at DATETIME(3) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  last_error TEXT NULL,
  processing_at DATETIME(3) NULL,
  sent_at DATETIME(3) NULL,
  result_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  created_by VARCHAR(100) NULL,
  external_ref VARCHAR(100) NULL,
  KEY idx_schedule_status_time (status, scheduled_at),
  KEY idx_schedule_external_ref (external_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

export class ScheduleValidationError extends Error {}

export function loadScheduleConfig(env: NodeJS.ProcessEnv = process.env): ScheduleConfig {
  const enabled = parseBoolean(env.SCHED_DB_ENABLED, false);
  const workerEnabled = parseBoolean(env.SCHED_WORKER_ENABLED, true);
  const autoCreateSchema = parseBoolean(env.SCHED_AUTO_CREATE_SCHEMA, true);

  return {
    enabled,
    host: env.SCHED_DB_HOST ?? "127.0.0.1",
    port: parseNumber(env.SCHED_DB_PORT, 3306),
    user: env.SCHED_DB_USER ?? "root",
    password: env.SCHED_DB_PASSWORD ?? "",
    database: env.SCHED_DB_NAME ?? "waconnect",
    poolLimit: parseNumber(env.SCHED_DB_POOL_LIMIT, 10),
    autoCreateSchema,
    workerEnabled,
    workerPollMs: Math.max(1000, parseNumber(env.SCHED_WORKER_POLL_MS, 5000)),
    workerBatchSize: Math.max(1, parseNumber(env.SCHED_WORKER_BATCH_SIZE, 10)),
    staleProcessingMs: Math.max(60_000, parseNumber(env.SCHED_STALE_PROCESSING_MS, 300_000))
  };
}

export class ScheduleModule {
  private pool: Pool | null = null;
  private workerTimer: NodeJS.Timeout | null = null;
  private workerRunning = false;

  constructor(
    private readonly config: ScheduleConfig,
    private readonly whatsapp: WhatsAppService
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async start() {
    if (!this.config.enabled) return;

    this.assertRequiredConfig();

    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: this.config.poolLimit,
      queueLimit: 0,
      timezone: APP_TIMEZONE_OFFSET,
      dateStrings: true,
      enableKeepAlive: true,
      jsonStrings: true,
      charset: "utf8mb4"
    });

    if (this.config.autoCreateSchema) {
      await this.pool.execute(CREATE_SCHEDULES_TABLE_SQL);
    }

    if (this.config.workerEnabled) {
      this.workerTimer = setInterval(() => {
        void this.processDueSchedules();
      }, this.config.workerPollMs);
      this.workerTimer.unref?.();
      void this.processDueSchedules();
    }
  }

  async stop() {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }

    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async createSchedule(input: CreateScheduleInput): Promise<ScheduleRecord> {
    const pool = this.requirePool();
    const type = input.type ?? "text";
    const to = input.to?.trim();
    const message = input.message?.trim();
    const scheduledAt = parseScheduleDate(input.scheduledAt, "scheduledAt");
    const maxAttempts = input.maxAttempts ?? 3;
    const createdBy = sanitizeOptional(input.createdBy);
    const externalRef = sanitizeOptional(input.externalRef);

    if (type !== "text") {
      throw new ScheduleValidationError("Somente agendamentos do tipo 'text' estão habilitados neste MVP.");
    }
    if (!to) {
      throw new ScheduleValidationError("Campo 'to' é obrigatório.");
    }
    if (!message) {
      throw new ScheduleValidationError("Campo 'message' é obrigatório.");
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new ScheduleValidationError("Campo 'maxAttempts' deve ser um inteiro entre 1 e 10.");
    }

    const id = crypto.randomUUID();
    const now = nowApp();
    if (scheduledAt.toMillis() <= now.toMillis()) {
      throw new ScheduleValidationError(`Campo 'scheduledAt' deve estar no futuro considerando o fuso ${APP_TIMEZONE}.`);
    }
    const scheduledAtDb = appDateTimeToMysql(scheduledAt);
    const nowDb = appDateTimeToMysql(now);

    await pool.execute<ResultSetHeader>(
      `INSERT INTO message_schedules (
        id, type, to_number, message_text, payload_json, scheduled_at, status, attempts, max_attempts,
        last_error, processing_at, sent_at, result_json, created_at, updated_at, created_by, external_ref
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
      [id, type, to, message, null, scheduledAtDb, maxAttempts, nowDb, nowDb, createdBy, externalRef]
    );

    const created = await this.getScheduleById(id);
    if (!created) {
      throw new Error("Falha ao recarregar agendamento recém-criado.");
    }

    return created;
  }

  async getScheduleById(id: string): Promise<ScheduleRecord | null> {
    const pool = this.requirePool();
    const [rows] = await pool.execute<ScheduleRow[]>(
      `SELECT id, type, to_number, message_text, payload_json, scheduled_at, status, attempts, max_attempts,
              last_error, processing_at, sent_at, result_json, created_at, updated_at, created_by, external_ref
         FROM message_schedules
        WHERE id = ?
        LIMIT 1`,
      [id]
    );

    return rows[0] ? mapScheduleRow(rows[0]) : null;
  }

  async listSchedules(filters: ListSchedulesFilters): Promise<ListSchedulesResult> {
    const pool = this.requirePool();
    const where: string[] = [];
    const params: unknown[] = [];
    const pageSize = Math.min(Math.max(filters.limit ?? 25, 1), 200);
    const page = Math.max(filters.page ?? 1, 1);
    const offset = (page - 1) * pageSize;

    if (filters.status) {
      where.push("status = ?");
      params.push(filters.status);
    }
    if (filters.from) {
      where.push("scheduled_at >= ?");
      params.push(appDateTimeToMysql(parseScheduleDate(filters.from, "from")));
    }
    if (filters.to) {
      where.push("scheduled_at <= ?");
      params.push(appDateTimeToMysql(parseScheduleDate(filters.to, "to")));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [countRows] = await pool.query<CountRow[]>(
      `SELECT COUNT(*) AS total
         FROM message_schedules
         ${whereSql}`,
      params
    );
    const total = numericCell(countRows[0]?.total);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const safeOffset = (safePage - 1) * pageSize;
    const [rows] = await pool.query<ScheduleRow[]>(
      `SELECT id, type, to_number, message_text, payload_json, scheduled_at, status, attempts, max_attempts,
              last_error, processing_at, sent_at, result_json, created_at, updated_at, created_by, external_ref
         FROM message_schedules
         ${whereSql}
        ORDER BY scheduled_at ASC, created_at ASC
        LIMIT ?
        OFFSET ?`,
      [...params, pageSize, safeOffset]
    );

    return {
      items: rows.map(mapScheduleRow),
      total,
      page: safePage,
      pageSize,
      totalPages
    };
  }

  async cancelSchedule(id: string): Promise<ScheduleRecord | null> {
    const pool = this.requirePool();
    const current = await this.getScheduleById(id);
    if (!current) return null;
    if (!["pending", "paused", "failed"].includes(current.status)) {
      throw new ScheduleValidationError("Somente agendamentos com status 'pending', 'paused' ou 'failed' podem ser cancelados.");
    }

    const nowDb = appDateTimeToMysql(nowApp());

    await pool.execute<ResultSetHeader>(
      `UPDATE message_schedules
          SET status = 'cancelled',
              processing_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND status IN ('pending', 'paused', 'failed')`,
      [nowDb, id]
    );

    return this.getScheduleById(id);
  }

  async updateSchedule(id: string, input: UpdateScheduleInput): Promise<ScheduleRecord | null> {
    const pool = this.requirePool();
    const current = await this.getScheduleById(id);
    if (!current) return null;
    if (["processing", "sent", "cancelled"].includes(current.status)) {
      throw new ScheduleValidationError("Somente agendamentos pendentes, pausados ou com falha podem ser editados.");
    }

    const nextTo = input.to?.trim() || current.to;
    const nextMessage = input.message?.trim() || current.message || "";
    const nextMaxAttempts = input.maxAttempts ?? current.maxAttempts;
    const nextCreatedBy = normalizeNullableString(input.createdBy, current.createdBy);
    const nextExternalRef = normalizeNullableString(input.externalRef, current.externalRef);
    const nextScheduledAt = input.scheduledAt
      ? parseScheduleDate(input.scheduledAt, "scheduledAt")
      : parseScheduleDate(current.scheduledAt, "scheduledAt");
    const fallbackStatus: Extract<ScheduleStatus, "pending" | "paused"> =
      current.status === "paused" ? "paused" : "pending";
    const nextStatus = input.status ?? fallbackStatus;

    if (!nextTo) {
      throw new ScheduleValidationError("Campo 'to' é obrigatório.");
    }
    if (!nextMessage) {
      throw new ScheduleValidationError("Campo 'message' é obrigatório.");
    }
    if (!Number.isInteger(nextMaxAttempts) || nextMaxAttempts < 1 || nextMaxAttempts > 10) {
      throw new ScheduleValidationError("Campo 'maxAttempts' deve ser um inteiro entre 1 e 10.");
    }
    if (nextScheduledAt.toMillis() <= nowApp().toMillis()) {
      throw new ScheduleValidationError(`Campo 'scheduledAt' deve estar no futuro considerando o fuso ${APP_TIMEZONE}.`);
    }

    const nowDb = appDateTimeToMysql(nowApp());
    await pool.execute<ResultSetHeader>(
      `UPDATE message_schedules
          SET to_number = ?,
              message_text = ?,
              scheduled_at = ?,
              max_attempts = ?,
              created_by = ?,
              external_ref = ?,
              status = ?,
              last_error = NULL,
              processing_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND status IN ('pending', 'paused', 'failed')`,
      [
        nextTo,
        nextMessage,
        appDateTimeToMysql(nextScheduledAt),
        nextMaxAttempts,
        nextCreatedBy,
        nextExternalRef,
        nextStatus,
        nowDb,
        id
      ]
    );

    return this.getScheduleById(id);
  }

  async pauseSchedule(id: string): Promise<ScheduleRecord | null> {
    const pool = this.requirePool();
    const current = await this.getScheduleById(id);
    if (!current) return null;
    if (!["pending", "failed", "paused"].includes(current.status)) {
      throw new ScheduleValidationError("Somente agendamentos pendentes, pausados ou com falha podem ser pausados.");
    }
    if (current.status === "paused") {
      return current;
    }

    const nowDb = appDateTimeToMysql(nowApp());
    await pool.execute<ResultSetHeader>(
      `UPDATE message_schedules
          SET status = 'paused',
              processing_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND status IN ('pending', 'failed')`,
      [nowDb, id]
    );

    return this.getScheduleById(id);
  }

  async resumeSchedule(id: string): Promise<ScheduleRecord | null> {
    const pool = this.requirePool();
    const current = await this.getScheduleById(id);
    if (!current) return null;
    if (current.status !== "paused") {
      throw new ScheduleValidationError("Somente agendamentos pausados podem ser retomados.");
    }
    if (parseScheduleDate(current.scheduledAt, "scheduledAt").toMillis() <= nowApp().toMillis()) {
      throw new ScheduleValidationError("Nao é possível retomar um agendamento pausado em horário passado. Edite a data antes de retomar.");
    }

    const nowDb = appDateTimeToMysql(nowApp());
    await pool.execute<ResultSetHeader>(
      `UPDATE message_schedules
          SET status = 'pending',
              last_error = NULL,
              processing_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND status = 'paused'`,
      [nowDb, id]
    );

    return this.getScheduleById(id);
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const pool = this.requirePool();
    const [result] = await pool.execute<ResultSetHeader>(
      `DELETE FROM message_schedules
        WHERE id = ?
          AND status <> 'processing'`,
      [id]
    );

    return result.affectedRows === 1;
  }

  async clearSentSchedules(): Promise<number> {
    const pool = this.requirePool();
    const [result] = await pool.execute<ResultSetHeader>(
      `DELETE FROM message_schedules
        WHERE status = 'sent'`
    );

    return result.affectedRows ?? 0;
  }

  async getStats(): Promise<ScheduleStats> {
    const pool = this.requirePool();
    const startOfDay = nowApp().startOf("day");
    const endOfDay = nowApp().endOf("day");
    const [rows] = await pool.query<ScheduleStatsRow[]>(
      `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
          SUM(CASE WHEN sent_at IS NOT NULL AND sent_at >= ? AND sent_at <= ? THEN 1 ELSE 0 END) AS sent_today
        FROM message_schedules`,
      [appDateTimeToMysql(startOfDay), appDateTimeToMysql(endOfDay)]
    );

    return mapScheduleStatsRow(rows[0]);
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error("Módulo de agendamento não inicializado.");
    }
    return this.pool;
  }

  private assertRequiredConfig() {
    const required = [
      ["SCHED_DB_HOST", this.config.host],
      ["SCHED_DB_USER", this.config.user],
      ["SCHED_DB_NAME", this.config.database]
    ];

    for (const [key, value] of required) {
      if (!value) {
        throw new Error(`Flag obrigatória ausente para agendamento: ${key}.`);
      }
    }
  }

  private async processDueSchedules() {
    if (this.workerRunning || !this.pool) return;
    this.workerRunning = true;

    try {
      await this.requeueStaleProcessing();
      const dueSchedules = await this.fetchDuePendingSchedules();

      for (const schedule of dueSchedules) {
        const claimed = await this.claimSchedule(schedule.id);
        if (!claimed) continue;
        await this.dispatchSchedule(schedule.id);
      }
    } catch (err) {
      console.error("Erro no worker de agendamento:", err);
    } finally {
      this.workerRunning = false;
    }
  }

  private async fetchDuePendingSchedules(): Promise<ScheduleRecord[]> {
    const pool = this.requirePool();
    const nowDb = appDateTimeToMysql(nowApp());
    const [rows] = await pool.query<ScheduleRow[]>(
      `SELECT id, type, to_number, message_text, payload_json, scheduled_at, status, attempts, max_attempts,
              last_error, processing_at, sent_at, result_json, created_at, updated_at, created_by, external_ref
         FROM message_schedules
        WHERE status = 'pending'
          AND scheduled_at <= ?
        ORDER BY scheduled_at ASC, created_at ASC
        LIMIT ?`,
      [nowDb, this.config.workerBatchSize]
    );

    return rows.map(mapScheduleRow);
  }

  private async claimSchedule(id: string): Promise<boolean> {
    const pool = this.requirePool();
    const nowDb = appDateTimeToMysql(nowApp());
    const [result] = await pool.execute<ResultSetHeader>(
      `UPDATE message_schedules
          SET status = 'processing',
              processing_at = ?,
              attempts = attempts + 1,
              updated_at = ?
        WHERE id = ?
          AND status = 'pending'`,
      [nowDb, nowDb, id]
    );

    return result.affectedRows === 1;
  }

  private async dispatchSchedule(id: string) {
    const schedule = await this.getScheduleById(id);
    if (!schedule || schedule.status !== "processing") return;

    try {
      if (schedule.type !== "text" || !schedule.message) {
        throw new Error("Agendamento inválido para envio.");
      }

      const key = await this.whatsapp.sendText({
        to: schedule.to,
        message: schedule.message
      });

      await this.markScheduleSent(id, key);
    } catch (err) {
      await this.markScheduleFailure(schedule, err);
    }
  }

  private async markScheduleSent(id: string, result: unknown) {
    const pool = this.requirePool();
    const nowDb = appDateTimeToMysql(nowApp());
    await pool.execute<ResultSetHeader>(
      `UPDATE message_schedules
          SET status = 'sent',
              sent_at = ?,
              processing_at = NULL,
              result_json = ?,
              last_error = NULL,
              updated_at = ?
        WHERE id = ?`,
      [nowDb, safeJsonStringify(result), nowDb, id]
    );
  }

  private async markScheduleFailure(schedule: ScheduleRecord, err: unknown) {
    const pool = this.requirePool();
    const nowDb = appDateTimeToMysql(nowApp());
    const attempts = schedule.attempts;
    const willRetry = attempts < schedule.maxAttempts;
    const nextStatus: ScheduleStatus = willRetry ? "pending" : "failed";
    const errorMessage = err instanceof Error ? err.message : "Falha desconhecida ao processar agendamento.";

    await pool.execute<ResultSetHeader>(
      `UPDATE message_schedules
          SET status = ?,
              last_error = ?,
              processing_at = NULL,
              updated_at = ?
        WHERE id = ?`,
      [nextStatus, errorMessage, nowDb, schedule.id]
    );
  }

  private async requeueStaleProcessing() {
    const pool = this.requirePool();
    const cutoff = subtractMilliseconds(nowApp(), this.config.staleProcessingMs);
    const cutoffDb = appDateTimeToMysql(cutoff);
    const nowDb = appDateTimeToMysql(nowApp());

    await pool.execute<ResultSetHeader>(
      `UPDATE message_schedules
          SET status = 'pending',
              processing_at = NULL,
              updated_at = ?
        WHERE status = 'processing'
          AND processing_at IS NOT NULL
          AND processing_at <= ?`,
      [nowDb, cutoffDb]
    );
  }
}

function mapScheduleRow(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    type: row.type,
    to: row.to_number,
    message: row.message_text,
    payload: parseJsonOrNull(row.payload_json),
    scheduledAt: mysqlAppToIso(row.scheduled_at),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    processingAt: nullableIso(row.processing_at),
    sentAt: nullableIso(row.sent_at),
    createdAt: mysqlAppToIso(row.created_at),
    updatedAt: mysqlAppToIso(row.updated_at),
    createdBy: row.created_by,
    externalRef: row.external_ref,
    result: parseJsonOrNull(row.result_json)
  };
}

function mapScheduleStatsRow(row: ScheduleStatsRow | undefined): ScheduleStats {
  return {
    total: numericCell(row?.total),
    pending: numericCell(row?.pending),
    paused: numericCell(row?.paused),
    processing: numericCell(row?.processing),
    sent: numericCell(row?.sent),
    failed: numericCell(row?.failed),
    cancelled: numericCell(row?.cancelled),
    sentToday: numericCell(row?.sent_today)
  };
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseScheduleDate(value: string, fieldName: string) {
  try {
    return parseAppWallClockDateTime(value);
  } catch {
    throw new ScheduleValidationError(`Campo '${fieldName}' deve ser uma data válida no fuso ${APP_TIMEZONE}.`);
  }
}

function sanitizeOptional(value: string | undefined): string | null {
  const sanitized = value?.trim();
  return sanitized ? sanitized : null;
}

function normalizeNullableString(value: string | null | undefined, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function nullableIso(mysqlDateTime: string | null): string | null {
  return mysqlDateTime ? mysqlAppToIso(mysqlDateTime) : null;
}

function numericCell(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJsonOrNull(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safeJsonStringify(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "Falha ao serializar resultado do provedor." });
  }
}
