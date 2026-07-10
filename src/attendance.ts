import crypto from "crypto";
import { EventEmitter } from "events";
import fs from "fs/promises";
import mysql, { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import path from "path";
import { APP_TIMEZONE_OFFSET, appDateTimeToMysql, mysqlAppToIso, nowApp } from "./timezone";
import { IncomingWhatsAppMessage, MediaKind, WhatsAppService } from "./whatsapp";

export type AttendanceConversationStatus = "new" | "open" | "waiting_agent" | "closed";
export type AttendanceMessageDirection = "inbound" | "outbound";
export type AttendanceMessageType = "text" | "image" | "video" | "audio" | "document" | "sticker" | "unknown";

export interface AttendanceConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  poolLimit: number;
  autoCreateSchema: boolean;
}

export interface CreateAttendanceConversationInput {
  to: string;
  contactJid?: string;
  contactName?: string;
  assignedAgent?: string;
}

export interface AttendanceReplyInput {
  message: string;
  agentName?: string;
  delaySeconds?: number;
}

export interface AttendanceMediaReplyInput {
  kind: MediaKind;
  buffer: Buffer;
  mimetype?: string;
  fileName?: string;
  caption?: string;
  agentName?: string;
}

export interface AttendanceNoteInput {
  noteText: string;
  createdBy?: string;
}

export interface AttendanceConversationFilters {
  status?: AttendanceConversationStatus;
  search?: string;
  assignedAgent?: string;
  tag?: string;
  limit?: number;
}

export interface AttendanceConversationRecord {
  id: string;
  contactJid: string;
  contactNumber: string;
  contactName: string | null;
  profilePicUrl: string | null;
  status: AttendanceConversationStatus;
  assignedAgent: string | null;
  tags: string[];
  lastMessageText: string | null;
  lastMessageDirection: AttendanceMessageDirection | null;
  lastMessageType: AttendanceMessageType | null;
  lastMessageAt: string | null;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AttendanceMessageRecord {
  id: string;
  conversationId: string;
  direction: AttendanceMessageDirection;
  messageType: AttendanceMessageType;
  messageText: string | null;
  mediaUrl: string | null;
  waMessageId: string | null;
  agentName: string | null;
  createdAt: string;
}

export interface AttendanceNoteRecord {
  id: string;
  conversationId: string;
  noteText: string;
  createdBy: string | null;
  createdAt: string;
}

export interface AttendanceStats {
  total: number;
  newCount: number;
  openCount: number;
  waitingAgentCount: number;
  closedCount: number;
  unreadTotal: number;
}

export interface AttendanceAgentSummary {
  agentName: string;
  total: number;
  newCount: number;
  openCount: number;
  waitingAgentCount: number;
  closedCount: number;
  unreadTotal: number;
}

export interface AttendanceRealtimeEvent {
  type: "conversation" | "message" | "note" | "stats";
  conversationId?: string;
  at: string;
}

interface AttendanceConversationRow extends RowDataPacket {
  id: string;
  contact_jid: string;
  contact_number: string;
  contact_name: string | null;
  status: string;
  assigned_agent: string | null;
  tags_json: string | null;
  last_message_text: string | null;
  last_message_direction: AttendanceMessageDirection | null;
  last_message_type: AttendanceMessageType | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
}

interface AttendanceMessageRow extends RowDataPacket {
  id: string;
  conversation_id: string;
  direction: AttendanceMessageDirection;
  message_type: AttendanceMessageType;
  message_text: string | null;
  media_url: string | null;
  wa_message_id: string | null;
  agent_name: string | null;
  created_at: string;
}

interface AttendanceNoteRow extends RowDataPacket {
  id: string;
  conversation_id: string;
  note_text: string;
  created_by: string | null;
  created_at: string;
}

interface AttendanceStatsRow extends RowDataPacket {
  total: number | string | null;
  new_count: number | string | null;
  open_count: number | string | null;
  waiting_agent_count: number | string | null;
  closed_count: number | string | null;
  unread_total: number | string | null;
}

interface AttendanceAgentSummaryRow extends RowDataPacket {
  agent_name: string;
  total: number | string | null;
  new_count: number | string | null;
  open_count: number | string | null;
  waiting_agent_count: number | string | null;
  closed_count: number | string | null;
  unread_total: number | string | null;
}

const SUPPORTED_ATTENDANCE_JID_SQL = "contact_jid LIKE '%@s.whatsapp.net'";

const CREATE_ATTENDANCE_CONVERSATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS attendance_conversations (
  id CHAR(36) NOT NULL PRIMARY KEY,
  contact_jid VARCHAR(80) NOT NULL,
  contact_number VARCHAR(30) NOT NULL,
  contact_name VARCHAR(150) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'new',
  assigned_agent VARCHAR(120) NULL,
  tags_json JSON NULL,
  last_message_text TEXT NULL,
  last_message_direction VARCHAR(20) NULL,
  last_message_type VARCHAR(20) NULL,
  last_message_at DATETIME(3) NULL,
  unread_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_attendance_contact_jid (contact_jid),
  KEY idx_attendance_status_updated (status, updated_at),
  KEY idx_attendance_assigned_agent (assigned_agent),
  KEY idx_attendance_last_message_at (last_message_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_ATTENDANCE_MESSAGES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS attendance_messages (
  id CHAR(36) NOT NULL PRIMARY KEY,
  conversation_id CHAR(36) NOT NULL,
  direction VARCHAR(20) NOT NULL,
  message_type VARCHAR(20) NOT NULL DEFAULT 'text',
  message_text TEXT NULL,
  media_url TEXT NULL,
  wa_message_id VARCHAR(180) NULL,
  agent_name VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_attendance_wa_message_id (wa_message_id),
  KEY idx_attendance_messages_conversation_time (conversation_id, created_at),
  CONSTRAINT fk_attendance_messages_conversation
    FOREIGN KEY (conversation_id) REFERENCES attendance_conversations(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_ATTENDANCE_NOTES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS attendance_notes (
  id CHAR(36) NOT NULL PRIMARY KEY,
  conversation_id CHAR(36) NOT NULL,
  note_text TEXT NOT NULL,
  created_by VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_attendance_notes_conversation_time (conversation_id, created_at),
  CONSTRAINT fk_attendance_notes_conversation
    FOREIGN KEY (conversation_id) REFERENCES attendance_conversations(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

export class AttendanceValidationError extends Error {}

export function loadAttendanceConfig(env: NodeJS.ProcessEnv = process.env): AttendanceConfig {
  return {
    enabled: parseBoolean(env.ATTEND_DB_ENABLED, false),
    host: env.ATTEND_DB_HOST ?? env.SCHED_DB_HOST ?? "127.0.0.1",
    port: parseNumber(env.ATTEND_DB_PORT, parseNumber(env.SCHED_DB_PORT, 3306)),
    user: env.ATTEND_DB_USER ?? env.SCHED_DB_USER ?? "root",
    password: env.ATTEND_DB_PASSWORD ?? env.SCHED_DB_PASSWORD ?? "",
    database: env.ATTEND_DB_NAME ?? env.SCHED_DB_NAME ?? "waconnect",
    poolLimit: parseNumber(env.ATTEND_DB_POOL_LIMIT, 10),
    autoCreateSchema: parseBoolean(env.ATTEND_AUTO_CREATE_SCHEMA, true)
  };
}

export class AttendanceModule {
  private pool: Pool | null = null;
  private unsubscribeIncoming: (() => void) | null = null;
  private readonly events = new EventEmitter();

  constructor(
    private readonly config: AttendanceConfig,
    private readonly whatsapp: WhatsAppService
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  onRealtimeEvent(listener: (event: AttendanceRealtimeEvent) => void): () => void {
    this.events.on("attendance", listener);
    return () => {
      this.events.off("attendance", listener);
    };
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
      await this.pool.execute(CREATE_ATTENDANCE_CONVERSATIONS_TABLE_SQL);
      await this.pool.execute(CREATE_ATTENDANCE_MESSAGES_TABLE_SQL);
      await this.pool.execute(CREATE_ATTENDANCE_NOTES_TABLE_SQL);
      await this.ensureOptionalSchema();
    }

    await this.migrateLegacyStatuses();

    this.unsubscribeIncoming = this.whatsapp.onIncomingMessage((message) => {
      void this.handleIncomingMessage(message);
    });
  }

  async stop() {
    this.unsubscribeIncoming?.();
    this.unsubscribeIncoming = null;

    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async createOrOpenConversation(input: CreateAttendanceConversationInput): Promise<AttendanceConversationRecord> {
    const pool = this.requirePool();
    const contactNumber = normalizePhoneNumber(input.to);
    if (!contactNumber) {
      throw new AttendanceValidationError("Campo 'to' e obrigatorio.");
    }

    const contactJid = input.contactJid?.trim() || formatWhatsappJid(input.to);
    if (!isSupportedAttendanceJid(contactJid)) {
      throw new AttendanceValidationError("JID do contato invalido para atendimento.");
    }
    const contactName = sanitizeOptional(input.contactName);
    const assignedAgent = sanitizeOptional(input.assignedAgent);
    const existing = await this.getConversationByJid(contactJid);
    const nowDb = appDateTimeToMysql(nowApp());

    if (existing) {
      await pool.execute<ResultSetHeader>(
        `UPDATE attendance_conversations
            SET contact_name = COALESCE(?, contact_name),
                assigned_agent = COALESCE(?, assigned_agent),
                updated_at = ?
          WHERE id = ?`,
        [contactName, assignedAgent, nowDb, existing.id]
      );
      const refreshed = await this.getConversationById(existing.id);
      if (!refreshed) throw new Error("Falha ao recarregar conversa existente.");
      this.emitRealtime("conversation", refreshed.id);
      return refreshed;
    }

    const id = crypto.randomUUID();
    await pool.execute<ResultSetHeader>(
      `INSERT INTO attendance_conversations (
        id, contact_jid, contact_number, contact_name, status, assigned_agent, tags_json,
        last_message_text, last_message_direction, last_message_type, last_message_at,
        unread_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'new', ?, JSON_ARRAY(), NULL, NULL, NULL, NULL, 0, ?, ?)`,
      [id, contactJid, contactNumber, contactName, assignedAgent, nowDb, nowDb]
    );

    const created = await this.getConversationById(id);
    if (!created) throw new Error("Falha ao recarregar conversa criada.");
    this.emitRealtime("conversation", created.id);
    return created;
  }

  async listConversations(filters: AttendanceConversationFilters = {}): Promise<AttendanceConversationRecord[]> {
    const pool = this.requirePool();
    const conditions: string[] = [SUPPORTED_ATTENDANCE_JID_SQL];
    const params: Array<string | number> = [];

    if (filters.status) {
      conditions.push("status = ?");
      params.push(filters.status);
    }

    const search = sanitizeOptional(filters.search);
    if (search) {
      conditions.push("(contact_name LIKE ? OR contact_number LIKE ? OR assigned_agent LIKE ?)");
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    const assignedAgent = sanitizeOptional(filters.assignedAgent);
    if (assignedAgent) {
      conditions.push("assigned_agent = ?");
      params.push(assignedAgent);
    }

    const tag = sanitizeOptional(filters.tag);
    if (tag) {
      conditions.push("JSON_CONTAINS(COALESCE(tags_json, JSON_ARRAY()), JSON_ARRAY(?))");
      params.push(tag);
    }

    let sql = `
      SELECT id, contact_jid, contact_number, contact_name, status, assigned_agent, tags_json,
             last_message_text, last_message_direction, last_message_type, last_message_at,
             unread_count, created_at, updated_at
        FROM attendance_conversations
    `;

    if (conditions.length) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    sql += " ORDER BY COALESCE(last_message_at, created_at) DESC, updated_at DESC";

    const limit = filters.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new AttendanceValidationError("Campo 'limit' deve ser um inteiro entre 1 e 200.");
    }

    sql += ` LIMIT ${limit}`;

    const [rows] = await pool.execute<AttendanceConversationRow[]>(sql, params);
    return rows.map((row) => this.attachCachedProfilePicture(mapConversationRow(row)));
  }

  async getConversationById(id: string): Promise<AttendanceConversationRecord | null> {
    const pool = this.requirePool();
    const [rows] = await pool.execute<AttendanceConversationRow[]>(
      `SELECT id, contact_jid, contact_number, contact_name, status, assigned_agent, tags_json,
              last_message_text, last_message_direction, last_message_type, last_message_at,
              unread_count, created_at, updated_at
         FROM attendance_conversations
        WHERE id = ?
          AND ${SUPPORTED_ATTENDANCE_JID_SQL}
        LIMIT 1`,
      [id]
    );
    return rows[0] ? this.attachCachedProfilePicture(mapConversationRow(rows[0])) : null;
  }

  async resolveConversationProfilePicture(id: string): Promise<string | null> {
    const conversation = await this.getConversationById(id);
    if (!conversation) {
      return null;
    }

    return this.whatsapp.getProfilePictureUrl(conversation.contactJid);
  }

  async listMessages(conversationId: string, limit = 200): Promise<AttendanceMessageRecord[]> {
    const pool = this.requirePool();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new AttendanceValidationError("Campo 'limit' deve ser um inteiro entre 1 e 500.");
    }

    const [rows] = await pool.execute<AttendanceMessageRow[]>(
      `SELECT id, conversation_id, direction, message_type, message_text, media_url, wa_message_id, agent_name, created_at
         FROM attendance_messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC
        LIMIT ${limit}`,
      [conversationId]
    );

    return rows.map(mapMessageRow);
  }

  async listNotes(conversationId: string, limit = 100): Promise<AttendanceNoteRecord[]> {
    const pool = this.requirePool();
    if (!Number.isInteger(limit) || limit < 1 || limit > 300) {
      throw new AttendanceValidationError("Campo 'limit' deve ser um inteiro entre 1 e 300.");
    }

    const [rows] = await pool.execute<AttendanceNoteRow[]>(
      `SELECT id, conversation_id, note_text, created_by, created_at
         FROM attendance_notes
        WHERE conversation_id = ?
        ORDER BY created_at DESC
        LIMIT ${limit}`,
      [conversationId]
    );

    return rows.map(mapNoteRow);
  }

  async addNote(conversationId: string, input: AttendanceNoteInput): Promise<AttendanceNoteRecord> {
    const pool = this.requirePool();
    const conversation = await this.getConversationById(conversationId);
    if (!conversation) {
      throw new AttendanceValidationError("Conversa nao encontrada.");
    }

    const noteText = input.noteText?.trim();
    if (!noteText) {
      throw new AttendanceValidationError("Campo 'noteText' e obrigatorio.");
    }

    const id = crypto.randomUUID();
    const createdBy = sanitizeOptional(input.createdBy);
    const nowDb = appDateTimeToMysql(nowApp());

    await pool.execute<ResultSetHeader>(
      `INSERT INTO attendance_notes (id, conversation_id, note_text, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, conversationId, noteText, createdBy, nowDb]
    );

    await this.touchConversation(conversationId, nowDb);
    const note = await this.getNoteById(id);
    if (!note) throw new Error("Falha ao recarregar nota criada.");
    this.emitRealtime("note", conversationId);
    return note;
  }

  async updateConversationTags(conversationId: string, tags: string[]): Promise<AttendanceConversationRecord | null> {
    const pool = this.requirePool();
    const normalizedTags = normalizeTags(tags);
    const nowDb = appDateTimeToMysql(nowApp());
    await pool.execute<ResultSetHeader>(
      `UPDATE attendance_conversations
          SET tags_json = ?, updated_at = ?
        WHERE id = ?`,
      [JSON.stringify(normalizedTags), nowDb, conversationId]
    );
    const conversation = await this.getConversationById(conversationId);
    if (conversation) {
      this.emitRealtime("conversation", conversationId);
    }
    return conversation;
  }

  async syncExternalTextMessage(input: { to: string; message: string; waMessageId?: string | null | undefined; agentName?: string | null | undefined }) {
    const message = input.message?.trim();
    if (!message) {
      throw new AttendanceValidationError("Campo 'message' e obrigatorio.");
    }

    const conversation = await this.createOrOpenConversation({ to: input.to });
    return this.persistOutboundTextMessage(conversation, {
      message,
      agentName: input.agentName,
      waMessageId: input.waMessageId ?? null
    });
  }

  async sendReply(conversationId: string, input: AttendanceReplyInput): Promise<AttendanceMessageRecord> {
    const conversation = await this.getConversationById(conversationId);
    if (!conversation) {
      throw new AttendanceValidationError("Conversa nao encontrada.");
    }

    const message = input.message?.trim();
    if (!message) {
      throw new AttendanceValidationError("Campo 'message' e obrigatorio.");
    }

    const delaySeconds = input.delaySeconds !== undefined ? Number(input.delaySeconds) : undefined;
    if (delaySeconds !== undefined && Number.isNaN(delaySeconds)) {
      throw new AttendanceValidationError("Campo 'delaySeconds' deve ser numerico.");
    }

    const sendPayload =
      delaySeconds !== undefined
        ? { to: conversation.contactNumber, message, delaySeconds: Math.max(3, delaySeconds) }
        : { to: conversation.contactNumber, message };

    const key = await this.whatsapp.sendText(sendPayload);
    return this.persistOutboundTextMessage(conversation, {
      message,
      agentName: input.agentName,
      waMessageId: key?.id
    });
  }

  async sendMediaReply(conversationId: string, input: AttendanceMediaReplyInput): Promise<AttendanceMessageRecord> {
    const pool = this.requirePool();
    const conversation = await this.getConversationById(conversationId);
    if (!conversation) {
      throw new AttendanceValidationError("Conversa nao encontrada.");
    }

    if (!input.buffer?.length) {
      throw new AttendanceValidationError("Arquivo obrigatorio para envio de midia.");
    }

    const kind = normalizeOutgoingMediaKind(input.kind);
    const caption = sanitizeOptional(input.caption);
    const fileName = sanitizeOptional(input.fileName);
    const mimetype = sanitizeOptional(input.mimetype) ?? undefined;

    const sendPayload: {
      to: string;
      kind: MediaKind;
      buffer: Buffer;
      mimetype?: string;
      fileName?: string;
      caption?: string;
    } = {
      to: conversation.contactNumber,
      kind,
      buffer: input.buffer
    };
    if (mimetype) sendPayload.mimetype = mimetype;
    if (fileName) sendPayload.fileName = fileName;
    if (caption) sendPayload.caption = caption;

    const key = await this.whatsapp.sendMedia(sendPayload);

    const waMessageId = buildExternalMessageId(conversation.contactJid, key?.id);
    const agentName = sanitizeOptional(input.agentName);
    const messageId = crypto.randomUUID();
    const nowDb = appDateTimeToMysql(nowApp());
    const previewText = buildOutgoingMediaPreview(kind, caption, fileName);
    const mediaAssetOptions: {
      kind: MediaKind;
      mimetype?: string;
      fileName?: string | null;
    } = {
      kind,
      fileName
    };
    if (mimetype) mediaAssetOptions.mimetype = mimetype;

    const mediaUrl = await persistAttendanceMediaAsset(input.buffer, mediaAssetOptions);

    await pool.execute<ResultSetHeader>(
      `INSERT INTO attendance_messages (
        id, conversation_id, direction, message_type, message_text, media_url, wa_message_id, agent_name, created_at
      ) VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?)`,
      [messageId, conversation.id, kind, previewText, mediaUrl, waMessageId, agentName, nowDb]
    );

    await pool.execute<ResultSetHeader>(
      `UPDATE attendance_conversations
          SET status = ?,
              assigned_agent = COALESCE(?, assigned_agent),
              last_message_text = ?,
              last_message_direction = 'outbound',
              last_message_type = ?,
              last_message_at = ?,
              unread_count = 0,
              updated_at = ?
        WHERE id = ?`,
      [resolveOutboundConversationStatus(conversation.status), agentName, previewText, kind, nowDb, nowDb, conversation.id]
    );

    const inserted = await this.getMessageById(messageId);
    if (!inserted) throw new Error("Falha ao recarregar midia enviada.");
    this.emitRealtime("message", conversation.id);
    return inserted;
  }

  async assignConversation(conversationId: string, assignedAgent: string | null): Promise<AttendanceConversationRecord | null> {
    const pool = this.requirePool();
    const nowDb = appDateTimeToMysql(nowApp());
    await pool.execute<ResultSetHeader>(
      `UPDATE attendance_conversations
          SET assigned_agent = ?, updated_at = ?
        WHERE id = ?`,
      [sanitizeOptional(assignedAgent ?? undefined), nowDb, conversationId]
    );
    const conversation = await this.getConversationById(conversationId);
    if (conversation) {
      this.emitRealtime("conversation", conversationId);
    }
    return conversation;
  }

  async updateConversationStatus(conversationId: string, status: AttendanceConversationStatus): Promise<AttendanceConversationRecord | null> {
    const pool = this.requirePool();
    const nowDb = appDateTimeToMysql(nowApp());
    await pool.execute<ResultSetHeader>(
      `UPDATE attendance_conversations
          SET status = ?, updated_at = ?
        WHERE id = ?`,
      [status, nowDb, conversationId]
    );
    const conversation = await this.getConversationById(conversationId);
    if (conversation) {
      this.emitRealtime("conversation", conversationId);
    }
    return conversation;
  }

  async markConversationRead(conversationId: string): Promise<AttendanceConversationRecord | null> {
    const pool = this.requirePool();
    const nowDb = appDateTimeToMysql(nowApp());
    await pool.execute<ResultSetHeader>(
      `UPDATE attendance_conversations
          SET unread_count = 0, updated_at = ?
        WHERE id = ?`,
      [nowDb, conversationId]
    );
    const conversation = await this.getConversationById(conversationId);
    if (conversation) {
      this.emitRealtime("conversation", conversationId);
    }
    return conversation;
  }

  async getStats(): Promise<AttendanceStats> {
    const pool = this.requirePool();
    const [rows] = await pool.execute<AttendanceStatsRow[]>(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'waiting_agent' THEN 1 ELSE 0 END) AS waiting_agent_count,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
        SUM(unread_count) AS unread_total
      FROM attendance_conversations
      WHERE ${SUPPORTED_ATTENDANCE_JID_SQL}
    `);

    return mapStatsRow(rows[0]);
  }

  async listAgentSummary(): Promise<AttendanceAgentSummary[]> {
    const pool = this.requirePool();
    const [rows] = await pool.execute<AttendanceAgentSummaryRow[]>(`
      SELECT
        assigned_agent AS agent_name,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'waiting_agent' THEN 1 ELSE 0 END) AS waiting_agent_count,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
        SUM(unread_count) AS unread_total
      FROM attendance_conversations
      WHERE ${SUPPORTED_ATTENDANCE_JID_SQL}
        AND assigned_agent IS NOT NULL AND assigned_agent <> ''
      GROUP BY assigned_agent
      ORDER BY total DESC, assigned_agent ASC
    `);

    return rows.map((row) => ({
      agentName: row.agent_name,
      total: numericCell(row.total),
      newCount: numericCell(row.new_count),
      openCount: numericCell(row.open_count),
      waitingAgentCount: numericCell(row.waiting_agent_count),
      closedCount: numericCell(row.closed_count),
      unreadTotal: numericCell(row.unread_total)
    }));
  }

  private async handleIncomingMessage(message: IncomingWhatsAppMessage) {
    if (!this.pool) return;

    const waMessageId = buildExternalMessageId(message.remoteJid, message.waMessageId);
    const alreadyExists = waMessageId ? await this.messageExists(waMessageId) : false;
    if (alreadyExists) return;

    const conversation = await this.findOrCreateConversationFromInbound(message);
    const messageId = crypto.randomUUID();
    const nowDb = appDateTimeToMysql(nowApp());
    const text = message.text ?? labelForMessageType(message.messageType);
    const nextStatus = resolveInboundConversationStatus(conversation.status, conversation.assignedAgent);
    const mediaUrl = await this.persistInboundMediaAsset(message);

    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO attendance_messages (
        id, conversation_id, direction, message_type, message_text, media_url, wa_message_id, agent_name, created_at
      ) VALUES (?, ?, 'inbound', ?, ?, ?, ?, NULL, ?)`,
      [messageId, conversation.id, message.messageType, text, mediaUrl, waMessageId, nowDb]
    );

    await this.pool.execute<ResultSetHeader>(
      `UPDATE attendance_conversations
          SET contact_name = COALESCE(?, contact_name),
              contact_number = ?,
              contact_jid = ?,
              status = ?,
              last_message_text = ?,
              last_message_direction = 'inbound',
              last_message_type = ?,
              last_message_at = ?,
              unread_count = unread_count + 1,
              updated_at = ?
        WHERE id = ?`,
      [sanitizeOptional(message.pushName ?? undefined), message.fromNumber, message.remoteJid, nextStatus, text, message.messageType, nowDb, nowDb, conversation.id]
    );

    this.emitRealtime("message", conversation.id);
  }

  private async persistOutboundTextMessage(
    conversation: AttendanceConversationRecord,
    input: { message: string; waMessageId?: string | null | undefined; agentName?: string | null | undefined }
  ): Promise<AttendanceMessageRecord> {
    const pool = this.requirePool();
    const waMessageId = buildExternalMessageId(conversation.contactJid, input.waMessageId);
    if (waMessageId) {
      const existing = await this.getMessageByExternalId(waMessageId);
      if (existing) {
        return existing;
      }
    }

    const agentName = sanitizeOptional(input.agentName ?? undefined);
    const messageId = crypto.randomUUID();
    const nowDb = appDateTimeToMysql(nowApp());

    await pool.execute<ResultSetHeader>(
      `INSERT INTO attendance_messages (
        id, conversation_id, direction, message_type, message_text, media_url, wa_message_id, agent_name, created_at
      ) VALUES (?, ?, 'outbound', 'text', ?, NULL, ?, ?, ?)`,
      [messageId, conversation.id, input.message, waMessageId, agentName, nowDb]
    );

    await pool.execute<ResultSetHeader>(
      `UPDATE attendance_conversations
          SET status = ?,
              assigned_agent = COALESCE(?, assigned_agent),
              last_message_text = ?,
              last_message_direction = 'outbound',
              last_message_type = 'text',
              last_message_at = ?,
              unread_count = 0,
              updated_at = ?
        WHERE id = ?`,
      [resolveOutboundConversationStatus(conversation.status), agentName, input.message, nowDb, nowDb, conversation.id]
    );

    const inserted = await this.getMessageById(messageId);
    if (!inserted) throw new Error("Falha ao recarregar mensagem enviada.");
    this.emitRealtime("message", conversation.id);
    return inserted;
  }

  private async persistInboundMediaAsset(message: IncomingWhatsAppMessage): Promise<string | null> {
    const mediaKind = normalizeIncomingMediaKind(message.messageType);
    if (!mediaKind || !message.mediaBuffer?.length) {
      return null;
    }

    const mediaOptions: { kind: MediaKind; mimetype?: string; fileName?: string | null } = {
      kind: mediaKind
    };
    if (message.mediaMimeType) {
      mediaOptions.mimetype = message.mediaMimeType;
    }
    if (message.mediaFileName) {
      mediaOptions.fileName = message.mediaFileName;
    }

    return persistAttendanceMediaAsset(message.mediaBuffer, mediaOptions);
  }

  private async findOrCreateConversationFromInbound(message: IncomingWhatsAppMessage): Promise<AttendanceConversationRecord> {
    const existing = await this.findConversationByIncomingMessage(message);
    if (existing) {
      return existing;
    }

    const payload: CreateAttendanceConversationInput = {
      to: message.fromNumber,
      contactJid: message.remoteJid
    };
    if (message.pushName) {
      payload.contactName = message.pushName;
    }
    return this.createOrOpenConversation(payload);
  }

  private async findConversationByIncomingMessage(message: IncomingWhatsAppMessage): Promise<AttendanceConversationRecord | null> {
    const directMatch = await this.getConversationByJid(message.remoteJid);
    if (directMatch) {
      return directMatch;
    }

    if (message.remoteJidAlt) {
      const altMatch = await this.getConversationByJid(message.remoteJidAlt);
      if (altMatch) {
        return altMatch;
      }
    }

    return null;
  }

  private async getConversationByJid(contactJid: string): Promise<AttendanceConversationRecord | null> {
    if (!isSupportedAttendanceJid(contactJid)) {
      return null;
    }

    const pool = this.requirePool();
    const [rows] = await pool.execute<AttendanceConversationRow[]>(
      `SELECT id, contact_jid, contact_number, contact_name, status, assigned_agent, tags_json,
              last_message_text, last_message_direction, last_message_type, last_message_at,
              unread_count, created_at, updated_at
         FROM attendance_conversations
        WHERE contact_jid = ?
          AND ${SUPPORTED_ATTENDANCE_JID_SQL}
        LIMIT 1`,
      [contactJid]
    );
    return rows[0] ? this.attachCachedProfilePicture(mapConversationRow(rows[0])) : null;
  }

  private attachCachedProfilePicture(conversation: AttendanceConversationRecord): AttendanceConversationRecord {
    return {
      ...conversation,
      profilePicUrl: this.whatsapp.getCachedProfilePictureUrl(conversation.contactJid)
    };
  }

  private async getMessageById(id: string): Promise<AttendanceMessageRecord | null> {
    const pool = this.requirePool();
    const [rows] = await pool.execute<AttendanceMessageRow[]>(
      `SELECT id, conversation_id, direction, message_type, message_text, media_url, wa_message_id, agent_name, created_at
         FROM attendance_messages
        WHERE id = ?
        LIMIT 1`,
      [id]
    );
    return rows[0] ? mapMessageRow(rows[0]) : null;
  }

  private async getMessageByExternalId(waMessageId: string): Promise<AttendanceMessageRecord | null> {
    const pool = this.requirePool();
    const [rows] = await pool.execute<AttendanceMessageRow[]>(
      `SELECT id, conversation_id, direction, message_type, message_text, media_url, wa_message_id, agent_name, created_at
         FROM attendance_messages
        WHERE wa_message_id = ?
        LIMIT 1`,
      [waMessageId]
    );
    return rows[0] ? mapMessageRow(rows[0]) : null;
  }

  private async getNoteById(id: string): Promise<AttendanceNoteRecord | null> {
    const pool = this.requirePool();
    const [rows] = await pool.execute<AttendanceNoteRow[]>(
      `SELECT id, conversation_id, note_text, created_by, created_at
         FROM attendance_notes
        WHERE id = ?
        LIMIT 1`,
      [id]
    );
    return rows[0] ? mapNoteRow(rows[0]) : null;
  }

  private async messageExists(waMessageId: string): Promise<boolean> {
    const pool = this.requirePool();
    const [rows] = await pool.execute<Array<RowDataPacket & { total: number | string }>>(
      "SELECT COUNT(*) AS total FROM attendance_messages WHERE wa_message_id = ? LIMIT 1",
      [waMessageId]
    );
    return numericCell(rows[0]?.total) > 0;
  }

  private async ensureOptionalSchema() {
    const pool = this.requirePool();
    await ensureColumn(pool, "attendance_conversations", "tags_json", "ALTER TABLE attendance_conversations ADD COLUMN tags_json JSON NULL AFTER assigned_agent");
  }

  private async migrateLegacyStatuses() {
    const pool = this.requirePool();
    await pool.execute<ResultSetHeader>(
      "UPDATE attendance_conversations SET status = 'open' WHERE status = 'waiting_customer'"
    );
  }

  private async touchConversation(conversationId: string, nowDb = appDateTimeToMysql(nowApp())) {
    const pool = this.requirePool();
    await pool.execute<ResultSetHeader>(
      "UPDATE attendance_conversations SET updated_at = ? WHERE id = ?",
      [nowDb, conversationId]
    );
  }

  private emitRealtime(type: AttendanceRealtimeEvent["type"], conversationId?: string) {
    const event: AttendanceRealtimeEvent = {
      type,
      at: nowApp().toISO() ?? new Date().toISOString()
    };
    if (conversationId) {
      event.conversationId = conversationId;
    }
    this.events.emit("attendance", event);
    if (type !== "stats") {
      this.events.emit("attendance", {
        type: "stats",
        at: event.at,
        ...(conversationId ? { conversationId } : {})
      } satisfies AttendanceRealtimeEvent);
    }
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error("Modulo de atendimento nao inicializado.");
    }
    return this.pool;
  }

  private assertRequiredConfig() {
    if (!this.config.host || !this.config.user || !this.config.database) {
      throw new Error("Configuracao MySQL do atendimento incompleta.");
    }
  }
}

function mapConversationRow(row: AttendanceConversationRow): AttendanceConversationRecord {
  return {
    id: row.id,
    contactJid: row.contact_jid,
    contactNumber: row.contact_number,
    contactName: row.contact_name,
    profilePicUrl: null,
    status: normalizeConversationStatus(row.status),
    assignedAgent: row.assigned_agent,
    tags: parseTags(row.tags_json),
    lastMessageText: row.last_message_text,
    lastMessageDirection: row.last_message_direction,
    lastMessageType: row.last_message_type,
    lastMessageAt: nullableIso(row.last_message_at),
    unreadCount: numericCell(row.unread_count),
    createdAt: mysqlAppToIso(row.created_at),
    updatedAt: mysqlAppToIso(row.updated_at)
  };
}

function mapMessageRow(row: AttendanceMessageRow): AttendanceMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    messageType: row.message_type,
    messageText: row.message_text,
    mediaUrl: row.media_url,
    waMessageId: row.wa_message_id,
    agentName: row.agent_name,
    createdAt: mysqlAppToIso(row.created_at)
  };
}

function mapNoteRow(row: AttendanceNoteRow): AttendanceNoteRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    noteText: row.note_text,
    createdBy: row.created_by,
    createdAt: mysqlAppToIso(row.created_at)
  };
}

function mapStatsRow(row: AttendanceStatsRow | undefined): AttendanceStats {
  return {
    total: numericCell(row?.total),
    newCount: numericCell(row?.new_count),
    openCount: numericCell(row?.open_count),
    waitingAgentCount: numericCell(row?.waiting_agent_count),
    closedCount: numericCell(row?.closed_count),
    unreadTotal: numericCell(row?.unread_total)
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

function sanitizeOptional(value: string | undefined): string | null {
  const sanitized = value?.trim();
  return sanitized ? sanitized : null;
}

function nullableIso(mysqlDateTime: string | null): string | null {
  return mysqlDateTime ? mysqlAppToIso(mysqlDateTime) : null;
}

function numericCell(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePhoneNumber(value: string): string {
  return value.replace(/\D/g, "");
}

function formatWhatsappJid(value: string): string {
  const normalized = value.replace(/\s|-/g, "");
  if (normalized.endsWith("@s.whatsapp.net")) return normalized;
  if (normalized.includes("@")) return normalized;
  return `${normalizePhoneNumber(normalized)}@s.whatsapp.net`;
}

function isSupportedAttendanceJid(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.endsWith("@s.whatsapp.net");
}

function buildExternalMessageId(remoteJid: string, messageId: string | null | undefined): string | null {
  if (!messageId) return null;
  return `${remoteJid}:${messageId}`;
}

function labelForMessageType(type: AttendanceMessageType): string {
  if (type === "image") return "[Imagem recebida]";
  if (type === "video") return "[Video recebido]";
  if (type === "audio") return "[Audio recebido]";
  if (type === "document") return "[Documento recebido]";
  if (type === "sticker") return "[Sticker recebido]";
  return "[Mensagem recebida]";
}

function normalizeTags(tags: string[]): string[] {
  const unique = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.trim();
    if (normalized) unique.add(normalized);
  }
  return Array.from(unique.values());
}

function normalizeOutgoingMediaKind(kind: MediaKind): MediaKind {
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "document") {
    return kind;
  }
  return "document";
}

function normalizeIncomingMediaKind(kind: IncomingWhatsAppMessage["messageType"]): MediaKind | null {
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "document") {
    return kind;
  }
  return null;
}

function buildOutgoingMediaPreview(kind: AttendanceMessageType, caption?: string | null, fileName?: string | null): string {
  const label = outgoingMediaLabel(kind);
  const details = [caption?.trim(), fileName?.trim()].filter((value): value is string => Boolean(value));
  if (!details.length) {
    return label;
  }
  return `${label} ${details.join(" - ")}`;
}

function outgoingMediaLabel(kind: AttendanceMessageType): string {
  if (kind === "image") return "[Imagem enviada]";
  if (kind === "video") return "[Video enviado]";
  if (kind === "audio") return "[Audio enviado]";
  return "[Arquivo enviado]";
}

async function persistAttendanceMediaAsset(
  buffer: Buffer,
  options: {
    kind: MediaKind;
    mimetype?: string;
    fileName?: string | null;
  }
): Promise<string> {
  const mediaRoot = path.join(process.cwd(), "public", "attendance-media");
  await fs.mkdir(mediaRoot, { recursive: true });

  const extension = resolveMediaExtension(options);
  const storedFileName = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const absolutePath = path.join(mediaRoot, storedFileName);
  await fs.writeFile(absolutePath, buffer);
  return `/attendance-media/${storedFileName}`;
}

function resolveMediaExtension(options: {
  kind: MediaKind;
  mimetype?: string;
  fileName?: string | null;
}): string {
  const originalName = options.fileName?.trim();
  if (originalName) {
    const ext = path.extname(originalName).replace(/^\./, "").toLowerCase();
    if (ext) {
      return ext;
    }
  }

  const mimeType = options.mimetype?.toLowerCase() || "";
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("zip")) return "zip";

  if (options.kind === "image") return "jpg";
  if (options.kind === "video") return "mp4";
  if (options.kind === "audio") return "mp3";
  return "bin";
}

function resolveInboundConversationStatus(
  currentStatus: AttendanceConversationStatus,
  assignedAgent: string | null
): AttendanceConversationStatus {
  if (currentStatus === "open") {
    return "open";
  }

  if (currentStatus === "closed") {
    return "new";
  }

  if (currentStatus === "waiting_agent") {
    return "waiting_agent";
  }

  return assignedAgent ? "open" : "new";
}

function resolveOutboundConversationStatus(_currentStatus: AttendanceConversationStatus): AttendanceConversationStatus {
  return "open";
}

function normalizeConversationStatus(value: string | null | undefined): AttendanceConversationStatus {
  const normalized = value?.trim();
  if (normalized === "waiting_customer") {
    return "open";
  }
  if (normalized === "open" || normalized === "waiting_agent" || normalized === "closed") {
    return normalized;
  }
  return "new";
}

function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return normalizeTags(parsed.filter((item): item is string => typeof item === "string"));
    }
    return [];
  } catch {
    return [];
  }
}

async function ensureColumn(pool: Pool, tableName: string, columnName: string, alterSql: string) {
  const [rows] = await pool.execute<Array<RowDataPacket & { COLUMN_NAME: string }>>(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [tableName, columnName]
  );
  if (!rows.length) {
    await pool.execute(alterSql);
  }
}
