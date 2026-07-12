import cors from "cors";
import express, { Request, Response } from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import multer from "multer";
import QRCode from "qrcode";
import path from "path";
import swaggerUi from "swagger-ui-express";
import swaggerJSDoc, { Options as SwaggerOptions } from "swagger-jsdoc";
import { ApiStatsService, EndpointStatsPeriod, TrackedEndpointKey } from "./api-stats";
import {
  AttendanceMediaReplyInput,
  AttendanceConversationRecord,
  AttendanceConversationStatus,
  AttendanceModule,
  AttendanceReplyInput,
  AttendanceValidationError,
  CreateAttendanceConversationInput,
  loadAttendanceConfig
} from "./attendance";
import {
  ConversationScheduleSummary,
  CreateScheduleInput,
  loadScheduleConfig,
  ScheduleModule,
  ScheduleValidationError,
  ScheduleStatus,
  ScheduleType
} from "./schedules";
import { MediaKind, WhatsAppService } from "./whatsapp";

dotenv.config();

type CachedResponse = { status: number; body: unknown; expiresAt: number };

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_URL = normalizeServerUrl(process.env.SERVER_URL);
const DASH_USER = process.env.DASH_USER ?? "admin";
const DASH_PASS = process.env.DASH_PASS ?? "admin123";
const rawApiToken = process.env.API_TOKEN?.trim();

if (!rawApiToken) {
  throw new Error("API_TOKEN is required to start the server.");
}

const API_TOKEN = rawApiToken;
const DASH_SESSION_COOKIE = "dash_session";
const DASH_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const dashboardSessions = new Map<string, { user: string; expiresAt: number }>();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB cap for media
});

const IDEM_TTL_MS = 5 * 60 * 1000;
const idempotencyCache = new Map<string, CachedResponse>();
const rateWindowMs = 1000;
const rateMax = 3;
let rateTimestamps: number[] = [];

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const whatsapp = new WhatsAppService();
const attendanceModule = new AttendanceModule(loadAttendanceConfig(), whatsapp);
const scheduleModule = new ScheduleModule(loadScheduleConfig(), whatsapp);
const apiStatsService = new ApiStatsService();

type AttendanceConversationWithSchedule = AttendanceConversationRecord & {
  hasActiveSchedule: boolean;
  activeScheduleCount: number;
  nextScheduleId: string | null;
  nextScheduleAt: string | null;
  nextScheduleMessage: string | null;
  nextScheduleStatus: Extract<ScheduleStatus, "pending" | "paused" | "processing"> | null;
};

const swaggerOptions: SwaggerOptions = {
  definition: {
    openapi: "3.0.1",
    info: {
      title: "API WPP",
      version: "1.0.0",
      description: "Endpoints para controle da instância WhatsApp via Baileys."
    },
    servers: [{ url: SERVER_URL ?? `http://localhost:${PORT}` }],
    components: {
      securitySchemes: {
        ApiToken: {
          type: "apiKey",
          in: "header",
          name: "x-api-token",
          description: "Token definido na variável de ambiente API_TOKEN"
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer"
        }
      },
      schemas: {
        SendTextRequest: {
          type: "object",
          required: ["to", "message"],
          properties: {
            to: { type: "string", example: "5599999999999" },
            message: { type: "string", example: "Olá!" },
            delay: {
              type: "number",
              minimum: 3,
              example: 3,
              description: "Delay em segundos entre envios. Mínimo 3s; padrão 3s se omitido."
            }
          }
        },
        SendContactRequest: {
          type: "object",
          required: ["to", "name", "phone"],
          properties: {
            to: { type: "string", example: "5599999999999" },
            name: { type: "string", example: "Fulano" },
            phone: { type: "string", example: "5598888888888" }
          }
        },
        SendNarrationRequest: {
          type: "object",
          required: ["to", "text"],
          properties: {
            to: { type: "string", example: "5599999999999" },
            text: { type: "string", example: "Seu pedido saiu para entrega." },
            lang: { type: "string", example: "pt-BR", description: "Código do idioma suportado pelo Google TTS" },
            slow: { type: "boolean", example: false }
          }
        },
        SendResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            key: { type: "object", description: "Mensagem retornada pelo Baileys" },
            error: { type: "string" }
          }
        },
        StatusResponse: {
          type: "object",
          properties: {
            connected: { type: "boolean" },
            qr: { type: "string", nullable: true },
            qrDataUrl: { type: "string", nullable: true },
            me: { type: "string", nullable: true },
            pushName: { type: "string", nullable: true }
          }
        },
        CreateScheduleRequest: {
          type: "object",
          required: ["to", "message", "scheduledAt"],
          properties: {
            type: { type: "string", enum: ["text"], default: "text" },
            to: { type: "string", example: "5599999999999" },
            message: { type: "string", example: "Mensagem agendada para envio." },
            scheduledAt: {
              type: "string",
              format: "date-time",
              example: "2026-07-05T18:30:00-03:00",
              description: "Horário oficial de São Paulo (America/Sao_Paulo). O backend interpreta a data/hora informada sempre como horário local de São Paulo e rejeita valores em horário passado."
            },
            maxAttempts: { type: "integer", minimum: 1, maximum: 10, example: 3 },
            createdBy: { type: "string", example: "dashboard-admin" },
            externalRef: { type: "string", example: "pedido-123" }
          }
        },
        ScheduleResponse: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            type: { type: "string", enum: ["text"] },
            to: { type: "string" },
            message: { type: "string", nullable: true },
            payload: { nullable: true },
            scheduledAt: { type: "string", format: "date-time", description: "Retornado no fuso America/Sao_Paulo." },
            status: { type: "string", enum: ["pending", "paused", "processing", "sent", "failed", "cancelled"] },
            attempts: { type: "integer" },
            maxAttempts: { type: "integer" },
            lastError: { type: "string", nullable: true },
            processingAt: { type: "string", format: "date-time", nullable: true },
            sentAt: { type: "string", format: "date-time", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            createdBy: { type: "string", nullable: true },
            externalRef: { type: "string", nullable: true },
            result: { nullable: true }
          }
        },
        ScheduleStatsResponse: {
          type: "object",
          properties: {
            total: { type: "integer" },
            pending: { type: "integer" },
            paused: { type: "integer" },
            processing: { type: "integer" },
            sent: { type: "integer" },
            failed: { type: "integer" },
            cancelled: { type: "integer" },
            sentToday: { type: "integer" }
          }
        },
        ApiEndpointStatsResponse: {
          type: "object",
          properties: {
            timezone: { type: "string" },
            period: { type: "string", enum: ["today", "7d", "30d", "all"] },
            totalRequests: { type: "integer" },
            totalSuccess: { type: "integer" },
            totalClientError: { type: "integer" },
            totalServerError: { type: "integer" },
            lastActivityAt: { type: "string", format: "date-time", nullable: true },
            endpoints: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  method: { type: "string" },
                  path: { type: "string" },
                  label: { type: "string" },
                  total: { type: "integer" },
                  success: { type: "integer" },
                  clientError: { type: "integer" },
                  serverError: { type: "integer" },
                  lastCalledAt: { type: "string", format: "date-time", nullable: true }
                }
              }
            }
          }
        }
      }
    },
    paths: {
      "/api/qr": {
        get: {
          summary: "Obter QR Code atual",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          responses: {
            200: { description: "Status da sessão e QR", content: { "application/json": { schema: { $ref: "#/components/schemas/StatusResponse" } } } }
          }
        }
      },
      "/api/qr/new": {
        post: {
          summary: "Forçar novo QR (limpa sessão e reinicia conexão)",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          responses: { 200: { description: "Sessão reiniciada" } }
        }
      },
      "/api/status": {
        get: {
          summary: "Status da sessão",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          responses: {
            200: { description: "Status", content: { "application/json": { schema: { $ref: "#/components/schemas/StatusResponse" } } } }
          }
        }
      },
      "/api/disconnect": {
        post: {
          summary: "Desconectar e limpar sessão",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          responses: { 200: { description: "Instância desconectada" } }
        }
      },
      "/api/clear-cache": {
        post: {
          summary: "Limpar cache/auth sem reiniciar",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          responses: { 200: { description: "Cache limpo" } }
        }
      },
      "/api/check-number": {
        post: {
          summary: "Verificar se número é WhatsApp",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["to"],
                  properties: { to: { type: "string", example: "5599999999999" } }
                }
              }
            }
          },
          responses: {
            200: {
              description: "Resultado da checagem",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      exists: { type: "boolean" },
                      jid: { type: "string" },
                      input: { type: "string" },
                      tried: {
                        type: "array",
                        items: { type: "string" }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/send/text": {
        post: {
          summary: "Enviar mensagem de texto",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/SendTextRequest" } } }
          },
          responses: {
            200: { description: "Resultado", content: { "application/json": { schema: { $ref: "#/components/schemas/SendResponse" } } } }
          }
        }
      },
      "/api/send/media": {
        post: {
          summary: "Enviar mídia (imagem, vídeo, áudio, documento)",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["to", "file"],
                  properties: {
                    to: { type: "string", example: "5599999999999" },
                    caption: { type: "string", example: "Legenda opcional" },
                    kind: { type: "string", enum: ["image", "video", "audio", "document"] },
                    file: { type: "string", format: "binary" }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "Resultado", content: { "application/json": { schema: { $ref: "#/components/schemas/SendResponse" } } } }
          }
        }
      },
      "/api/send/contact": {
        post: {
          summary: "Enviar contato vCard",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/SendContactRequest" } } }
          },
          responses: {
            200: { description: "Resultado", content: { "application/json": { schema: { $ref: "#/components/schemas/SendResponse" } } } }
          }
        }
      },
      "/api/send/narration": {
        post: {
          summary: "Enviar áudio narrado (TTS)",
          description: "Gera áudio via Google TTS e envia como mensagem de áudio.",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/SendNarrationRequest" } } }
          },
          responses: {
            200: { description: "Resultado", content: { "application/json": { schema: { $ref: "#/components/schemas/SendResponse" } } } }
          }
        }
      },
      "/api/schedules": {
        get: {
          summary: "Listar agendamentos",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          parameters: [
            { in: "query", name: "status", schema: { type: "string", enum: ["pending", "paused", "processing", "sent", "failed", "cancelled"] } },
            { in: "query", name: "from", schema: { type: "string", format: "date-time" } },
            { in: "query", name: "to", schema: { type: "string", format: "date-time" } },
            { in: "query", name: "page", schema: { type: "integer", minimum: 1 } },
            { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 200 } }
          ],
          responses: {
            200: {
              description: "Lista de agendamentos",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: "#/components/schemas/ScheduleResponse" }
                      },
                      total: { type: "integer" },
                      page: { type: "integer" },
                      pageSize: { type: "integer" },
                      totalPages: { type: "integer" }
                    }
                  }
                }
              }
            }
          }
        },
        post: {
          summary: "Criar agendamento",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateScheduleRequest" } } }
          },
          responses: {
            201: { description: "Agendamento criado", content: { "application/json": { schema: { $ref: "#/components/schemas/ScheduleResponse" } } } }
          }
        },
        delete: {
          summary: "Limpar mensagens enviadas",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          parameters: [
            { in: "query", name: "status", required: true, schema: { type: "string", enum: ["sent"] } }
          ],
          responses: {
            200: {
              description: "Resumo da limpeza",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      deleted: { type: "integer" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/schedules/{id}": {
        get: {
          summary: "Detalhar agendamento",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            200: { description: "Agendamento", content: { "application/json": { schema: { $ref: "#/components/schemas/ScheduleResponse" } } } }
          }
        },
        put: {
          summary: "Editar agendamento",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateScheduleRequest" } } }
          },
          responses: {
            200: { description: "Agendamento atualizado", content: { "application/json": { schema: { $ref: "#/components/schemas/ScheduleResponse" } } } }
          }
        },
        delete: {
          summary: "Deletar agendamento",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { 200: { description: "Agendamento removido" } }
        }
      },
      "/api/schedules/{id}/cancel": {
        post: {
          summary: "Cancelar agendamento",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            200: { description: "Agendamento cancelado", content: { "application/json": { schema: { $ref: "#/components/schemas/ScheduleResponse" } } } }
          }
        }
      },
      "/api/schedules/{id}/pause": {
        post: {
          summary: "Pausar agendamento",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            200: { description: "Agendamento pausado", content: { "application/json": { schema: { $ref: "#/components/schemas/ScheduleResponse" } } } }
          }
        }
      },
      "/api/schedules/{id}/resume": {
        post: {
          summary: "Retomar agendamento",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            200: { description: "Agendamento retomado", content: { "application/json": { schema: { $ref: "#/components/schemas/ScheduleResponse" } } } }
          }
        }
      },
      "/api/schedules/stats": {
        get: {
          summary: "Resumo estatístico dos agendamentos",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          responses: {
            200: { description: "Resumo", content: { "application/json": { schema: { $ref: "#/components/schemas/ScheduleStatsResponse" } } } }
          }
        }
      },
      "/api/stats/endpoints": {
        get: {
          summary: "Resumo estatístico dos endpoints da API",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          parameters: [
            { in: "query", name: "period", schema: { type: "string", enum: ["today", "7d", "30d", "all"] } }
          ],
          responses: {
            200: { description: "Resumo", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiEndpointStatsResponse" } } } }
          }
        }
      }
    }
  },
  apis: []
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);

app.get("/api-docs.json", (req, res) => res.json(buildSwaggerSpec(req)));
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(undefined, {
    swaggerOptions: {
      url: "/api-docs.json"
    }
  })
);

function authGuard(req: Request, res: Response, next: () => void) {
  const headerToken =
    (req.headers["x-api-token"] as string | undefined) ||
    (req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");

  if (headerToken) {
    if (headerToken === API_TOKEN) return next();
    return res.status(401).json({ error: "Token inválido ou ausente." });
  }
  if (hasValidDashboardSession(req)) return next();
  return res.status(401).json({ error: "Token inválido ou ausente." });
}

app.use("/api", authGuard);
app.use("/api/send", rateLimiter);

app.post("/login", (req: Request, res: Response) => {
  const { user, pass } = req.body;
  if (user === DASH_USER && pass === DASH_PASS) {
    const sessionId = createDashboardSession(user);
    setDashboardSessionCookie(res, sessionId);
    return res.json({ success: true, user });
  }
  return res.status(401).json({ error: "Credenciais inválidas." });
});

app.post("/logout", (req: Request, res: Response) => {
  const sessionId = getCookieValue(req, DASH_SESSION_COOKIE);
  if (sessionId) {
    dashboardSessions.delete(sessionId);
  }
  clearDashboardSessionCookie(res);
  res.json({ success: true });
});

app.get("/api/qr", async (_req: Request, res: Response) => {
  const status = whatsapp.status;
  const qr = status.qr;

  let qrDataUrl: string | null = null;
  if (qr) {
    qrDataUrl = await QRCode.toDataURL(qr);
  }

  res.json({
    connected: status.connected,
    qr,
    qrDataUrl,
    me: status.me,
    pushName: status.pushName,
    profilePicUrl: status.profilePicUrl
  });
});

app.get("/api/status", async (_req: Request, res: Response) => {
  res.json(await whatsapp.statusWithFreshPic());
});

app.post("/api/qr/new", async (_req: Request, res: Response) => {
  await whatsapp.forceNewQr();
  res.json({ success: true });
});

app.post("/api/disconnect", async (_req: Request, res: Response) => {
  await whatsapp.disconnect();
  res.json({ success: true });
});

app.post("/api/clear-cache", async (_req: Request, res: Response) => {
  await whatsapp.clearCacheOnly();
  res.json({ success: true });
});

app.post("/api/check-number", trackApiEndpoint("check_number"), async (req: Request, res: Response) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Campo 'to' é obrigatório." });
  try {
    const result = await whatsapp.checkNumber(to);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao checar número." });
  }
});

app.post("/api/send/text", trackApiEndpoint("send_text"), async (req: Request, res: Response) => {
  const { to, message, delay } = req.body;
  const idemKey = getIdemKey(req);
  if (idemKey && replyIfCached(idemKey, res)) return;
  if (!to || !message) {
    return res.status(400).json({ error: "Campos 'to' e 'message' são obrigatórios." });
  }
  const delaySeconds = delay !== undefined ? Number(delay) : undefined;
  if (delaySeconds !== undefined && Number.isNaN(delaySeconds)) {
    return res.status(400).json({ error: "Campo 'delay' deve ser numérico (segundos)." });
  }
  const clampedDelay = delaySeconds !== undefined ? Math.max(3, delaySeconds) : undefined;

  try {
    const payload = clampedDelay !== undefined ? { to, message, delaySeconds: clampedDelay } : { to, message };
    const key = await whatsapp.sendText(payload);
    if (attendanceModule.isEnabled()) {
      try {
        await attendanceModule.syncExternalTextMessage({
          to: key?.remoteJid ?? to,
          message,
          waMessageId: key?.id ?? null
        });
      } catch (attendanceError) {
        console.error("Falha ao sincronizar envio de texto no atendimento:", attendanceError);
      }
    }
    cacheIdem(idemKey, res, { success: true, key });
  } catch (err) {
    console.error(err);
    cacheIdem(idemKey, res, { error: "Falha ao enviar mensagem de texto." }, 500);
  }
});

app.post("/api/send/media", trackApiEndpoint("send_media"), upload.single("file"), async (req: Request, res: Response) => {
  const { to, caption, kind: kindInput } = req.body;
  const file = req.file;

  if (!to || !file) {
    return res.status(400).json({ error: "Campos 'to' e arquivo 'file' são obrigatórios." });
  }

  const mimetype = file.mimetype;
  const kind = (kindInput as MediaKind) ?? deduceKind(mimetype);

  try {
    const key = await whatsapp.sendMedia({
      to,
      buffer: file.buffer,
      kind,
      mimetype,
      fileName: file.originalname,
      caption
    });
    res.json({ success: true, key });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao enviar mídia." });
  }
});

app.post("/api/send/contact", trackApiEndpoint("send_contact"), async (req: Request, res: Response) => {
  const { to, name, phone } = req.body;
  if (!to || !name || !phone) {
    return res.status(400).json({ error: "Campos 'to', 'name' e 'phone' são obrigatórios." });
  }

  try {
    const key = await whatsapp.sendContact({ to, name, phone });
    res.json({ success: true, key });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao enviar contato." });
  }
});

app.post("/api/send/narration", trackApiEndpoint("send_narration"), async (req: Request, res: Response) => {
  const { to, text, lang, slow } = req.body;
  const idemKey = getIdemKey(req);
  if (idemKey && replyIfCached(idemKey, res)) return;

  if (!to || !text) {
    return res.status(400).json({ error: "Campos 'to' e 'text' são obrigatórios." });
  }

  try {
    const key = await whatsapp.sendNarration({ to, text, lang, slow });
    cacheIdem(idemKey, res, { success: true, key });
  } catch (err) {
    console.error("Erro ao enviar áudio narrado:", err);
    cacheIdem(idemKey, res, { error: "Falha ao enviar áudio narrado.", detail: (err as Error)?.message }, 500);
  }
});

app.post("/api/attendance/conversations", trackApiEndpoint("attendance_create"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const payload: CreateAttendanceConversationInput = {
      to: requireBodyString(req.body?.to, "to")
    };

    const contactName = parseOptionalBodyString(req.body?.contactName);
    const assignedAgent = parseOptionalBodyString(req.body?.assignedAgent);
    if (contactName !== undefined) payload.contactName = contactName;
    if (assignedAgent !== undefined) payload.assignedAgent = assignedAgent;

    const conversation = await attendanceModule.createOrOpenConversation(payload);
    res.status(201).json(await enrichAttendanceConversation(conversation));
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao criar conversa de atendimento.");
  }
});

app.get("/api/attendance/conversations", trackApiEndpoint("attendance_list"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const filters: {
      status?: AttendanceConversationStatus;
      search?: string;
      assignedAgent?: string;
      tag?: string;
      limit?: number;
    } = {};

    const parsedStatus = parseAttendanceStatus(req.query.status);
    const parsedSearch = asOptionalString(req.query.search);
    const parsedAssignedAgent = asOptionalString(req.query.assignedAgent);
    const parsedTag = asOptionalString(req.query.tag);
    const parsedLimit = parseAttendanceLimit(req.query.limit);

    if (parsedStatus) filters.status = parsedStatus;
    if (parsedSearch) filters.search = parsedSearch;
    if (parsedAssignedAgent) filters.assignedAgent = parsedAssignedAgent;
    if (parsedTag) filters.tag = parsedTag;
    if (parsedLimit !== undefined) filters.limit = parsedLimit;

    const conversations = await attendanceModule.listConversations(filters);
    res.json(await enrichAttendanceConversations(conversations));
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao listar conversas de atendimento.");
  }
});

app.get("/api/attendance/conversations/:id/messages", trackApiEndpoint("attendance_messages"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const conversationId = getRouteParam(req.params.id);
    const conversation = await attendanceModule.getConversationById(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: "Conversa nao encontrada." });
    }

    const messages = await attendanceModule.listMessages(conversationId, parseAttendanceMessagesLimit(req.query.limit));
    res.json({ conversation: await enrichAttendanceConversation(conversation), messages });
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao listar mensagens do atendimento.");
  }
});

app.get("/api/attendance/conversations/:id/profile-picture", async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const conversationId = getRouteParam(req.params.id);
    const conversation = await attendanceModule.getConversationById(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: "Conversa nao encontrada." });
    }

    const profilePicUrl = await attendanceModule.resolveConversationProfilePicture(conversationId);
    res.json({ profilePicUrl });
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao carregar foto de perfil da conversa.");
  }
});

app.get("/api/attendance/conversations/:id/notes", trackApiEndpoint("attendance_notes_list"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const conversationId = getRouteParam(req.params.id);
    const conversation = await attendanceModule.getConversationById(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: "Conversa nao encontrada." });
    }

    const notes = await attendanceModule.listNotes(conversationId, parseAttendanceNotesLimit(req.query.limit));
    res.json({ conversation, notes });
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao listar notas do atendimento.");
  }
});

app.post("/api/attendance/conversations/:id/notes", trackApiEndpoint("attendance_note_create"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const notePayload: { noteText: string; createdBy?: string } = {
      noteText: requireBodyString(req.body?.noteText, "noteText")
    };
    const createdBy = parseOptionalBodyString(req.body?.createdBy);
    if (createdBy !== undefined) {
      notePayload.createdBy = createdBy;
    }

    const note = await attendanceModule.addNote(getRouteParam(req.params.id), notePayload);
    res.status(201).json(note);
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao criar nota do atendimento.");
  }
});

app.post("/api/attendance/conversations/:id/reply", trackApiEndpoint("attendance_reply"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const payload: AttendanceReplyInput = {
      message: requireBodyString(req.body?.message, "message")
    };

    const agentName = parseOptionalBodyString(req.body?.agentName);
    const replyToMessageId = parseOptionalBodyString(req.body?.replyToMessageId);
    const delaySeconds = req.body?.delaySeconds;
    if (agentName !== undefined) payload.agentName = agentName;
    if (replyToMessageId !== undefined) payload.replyToMessageId = replyToMessageId;
    if (delaySeconds !== undefined && delaySeconds !== null && delaySeconds !== "") {
      payload.delaySeconds = Number(delaySeconds);
    }

    const message = await attendanceModule.sendReply(getRouteParam(req.params.id), payload);
    res.status(201).json(message);
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao enviar resposta do atendimento.");
  }
});

app.post("/api/attendance/conversations/:id/media", trackApiEndpoint("attendance_media"), upload.single("file"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "Arquivo 'file' obrigatorio." });
    }

    const payload: AttendanceMediaReplyInput = {
      kind: (req.body?.kind as MediaKind | undefined) ?? deduceKind(file.mimetype),
      buffer: file.buffer,
      mimetype: file.mimetype,
      fileName: file.originalname
    };

    const caption = parseOptionalBodyString(req.body?.caption);
    const agentName = parseOptionalBodyString(req.body?.agentName);
    const replyToMessageId = parseOptionalBodyString(req.body?.replyToMessageId);
    if (caption !== undefined) payload.caption = caption;
    if (agentName !== undefined) payload.agentName = agentName;
    if (replyToMessageId !== undefined) payload.replyToMessageId = replyToMessageId;

    const message = await attendanceModule.sendMediaReply(getRouteParam(req.params.id), payload);
    res.status(201).json(message);
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao enviar midia do atendimento.");
  }
});

app.post("/api/attendance/conversations/:id/schedule", trackApiEndpoint("attendance_schedule"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  try {
    const conversationId = getRouteParam(req.params.id);
    const conversation = await attendanceModule.getConversationById(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: "Conversa nao encontrada." });
    }

    const payload: CreateScheduleInput = {
      to: conversation.contactNumber,
      message: requireBodyString(req.body?.message, "message"),
      scheduledAt: requireBodyString(req.body?.scheduledAt, "scheduledAt"),
      conversationId,
      externalRef: `attendance:${conversationId}:${crypto.randomUUID()}`
    };

    const parsedType = parseScheduleType(req.body?.type);
    const parsedMaxAttempts = parseOptionalBodyInteger(req.body?.maxAttempts, "maxAttempts");
    const parsedCreatedBy = parseOptionalBodyString(req.body?.createdBy);

    if (parsedType) payload.type = parsedType;
    if (parsedMaxAttempts !== undefined) payload.maxAttempts = parsedMaxAttempts;
    if (parsedCreatedBy !== undefined) payload.createdBy = parsedCreatedBy;

    const schedule = await scheduleModule.createSchedule(payload);
    res.status(201).json(schedule);
  } catch (err) {
    if (err instanceof ScheduleValidationError) {
      return handleScheduleError(err, res, "Falha ao criar agendamento do atendimento.");
    }
    handleAttendanceError(err, res, "Falha ao criar agendamento do atendimento.");
  }
});

app.put("/api/attendance/conversations/:id/schedules/:scheduleId", trackApiEndpoint("attendance_schedule"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  try {
    const conversationId = getRouteParam(req.params.id);
    const scheduleId = getRouteParam(req.params.scheduleId);
    const conversation = await attendanceModule.getConversationById(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: "Conversa nao encontrada." });
    }

    const existingSchedule = await scheduleModule.getScheduleById(scheduleId);
    if (!existingSchedule || existingSchedule.conversationId !== conversationId) {
      return res.status(404).json({ error: "Agendamento nao encontrado para esta conversa." });
    }

    const payload: {
      message?: string;
      scheduledAt?: string;
      status?: "pending" | "paused";
    } = {};

    if (req.body?.message !== undefined) payload.message = requireBodyString(req.body.message, "message");
    if (req.body?.scheduledAt !== undefined) payload.scheduledAt = requireBodyString(req.body.scheduledAt, "scheduledAt");

    const parsedStatus = parseAttendanceConversationScheduleStatus(req.body?.status);
    if (parsedStatus) payload.status = parsedStatus;

    const updatedSchedule = await scheduleModule.updateSchedule(scheduleId, payload);
    if (!updatedSchedule) {
      return res.status(404).json({ error: "Agendamento nao encontrado." });
    }

    res.json(updatedSchedule);
  } catch (err) {
    if (err instanceof ScheduleValidationError) {
      return handleScheduleError(err, res, "Falha ao editar agendamento do atendimento.");
    }
    handleAttendanceError(err, res, "Falha ao editar agendamento do atendimento.");
  }
});

app.post("/api/attendance/conversations/:id/assign", trackApiEndpoint("attendance_assign"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const conversation = await attendanceModule.assignConversation(
      getRouteParam(req.params.id),
      parseNullableBodyString(req.body?.assignedAgent)
    );
    if (!conversation) {
      return res.status(404).json({ error: "Conversa nao encontrada." });
    }
    res.json(conversation);
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao atribuir conversa.");
  }
});

app.post("/api/attendance/conversations/:id/status", trackApiEndpoint("attendance_status"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const conversation = await attendanceModule.updateConversationStatus(
      getRouteParam(req.params.id),
      parseRequiredAttendanceStatus(req.body?.status)
    );
    if (!conversation) {
      return res.status(404).json({ error: "Conversa nao encontrada." });
    }
    res.json(conversation);
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao atualizar status da conversa.");
  }
});

app.post("/api/attendance/conversations/:id/read", trackApiEndpoint("attendance_read"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const conversation = await attendanceModule.markConversationRead(getRouteParam(req.params.id));
    if (!conversation) {
      return res.status(404).json({ error: "Conversa nao encontrada." });
    }
    res.json(conversation);
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao marcar conversa como lida.");
  }
});

app.post("/api/attendance/conversations/:id/tags", trackApiEndpoint("attendance_tags_update"), async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    const conversation = await attendanceModule.updateConversationTags(
      getRouteParam(req.params.id),
      parseAttendanceTags(req.body?.tags)
    );
    if (!conversation) {
      return res.status(404).json({ error: "Conversa nao encontrada." });
    }
    res.json(conversation);
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao atualizar tags da conversa.");
  }
});

app.get("/api/attendance/agents/summary", trackApiEndpoint("attendance_agents_summary"), async (_req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    res.json(await attendanceModule.listAgentSummary());
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao carregar resumo por atendente.");
  }
});

app.get("/api/attendance/stats", trackApiEndpoint("attendance_stats"), async (_req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  try {
    res.json(await attendanceModule.getStats());
  } catch (err) {
    handleAttendanceError(err, res, "Falha ao carregar estatisticas do atendimento.");
  }
});

app.get("/api/attendance/stream", async (req: Request, res: Response) => {
  if (!attendanceModule.isEnabled()) {
    return res.status(503).json({ error: "Modulo de atendimento desabilitado. Configure ATTEND_DB_ENABLED=true." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "ready", at: new Date().toISOString() })}\n\n`);

  const unsubscribe = attendanceModule.onRealtimeEvent((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

app.post("/api/schedules", async (req: Request, res: Response) => {
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Módulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  const { type, to, message, scheduledAt, maxAttempts, createdBy, externalRef } = req.body;

  try {
    const parsedType = parseScheduleType(type);
    const schedulePayload: CreateScheduleInput = {
      to: requireBodyString(to, "to"),
      message: requireBodyString(message, "message"),
      scheduledAt: requireBodyString(scheduledAt, "scheduledAt")
    };

    if (parsedType) schedulePayload.type = parsedType;
    const parsedMaxAttempts = parseOptionalBodyInteger(maxAttempts, "maxAttempts");
    const parsedCreatedBy = parseOptionalBodyString(createdBy);
    const parsedExternalRef = parseOptionalBodyString(externalRef);

    if (parsedMaxAttempts !== undefined) schedulePayload.maxAttempts = parsedMaxAttempts;
    if (parsedCreatedBy !== undefined) schedulePayload.createdBy = parsedCreatedBy;
    if (parsedExternalRef !== undefined) schedulePayload.externalRef = parsedExternalRef;

    const schedule = await scheduleModule.createSchedule(schedulePayload);
    res.status(201).json(schedule);
  } catch (err) {
    handleScheduleError(err, res, "Falha ao criar agendamento.");
  }
});

app.put("/api/schedules/:id", async (req: Request, res: Response) => {
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Módulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  try {
    const payload: {
      to?: string;
      message?: string;
      scheduledAt?: string;
      maxAttempts?: number;
      createdBy?: string | null;
      externalRef?: string | null;
      status?: "pending" | "paused";
    } = {};

    if (req.body?.to !== undefined) payload.to = requireBodyString(req.body.to, "to");
    if (req.body?.message !== undefined) payload.message = requireBodyString(req.body.message, "message");
    if (req.body?.scheduledAt !== undefined) payload.scheduledAt = requireBodyString(req.body.scheduledAt, "scheduledAt");
    if (req.body?.maxAttempts !== undefined) payload.maxAttempts = parseRequiredBodyInteger(req.body.maxAttempts, "maxAttempts");
    if (req.body?.createdBy !== undefined) payload.createdBy = parseNullableOptionalBodyString(req.body.createdBy);
    if (req.body?.externalRef !== undefined) payload.externalRef = parseNullableOptionalBodyString(req.body.externalRef);
    if (req.body?.status !== undefined) payload.status = parseEditableScheduleStatus(req.body.status);

    const schedule = await scheduleModule.updateSchedule(getRouteParam(req.params.id), payload);
    if (!schedule) {
      return res.status(404).json({ error: "Agendamento não encontrado." });
    }
    res.json(schedule);
  } catch (err) {
    handleScheduleError(err, res, "Falha ao editar agendamento.");
  }
});

app.get("/api/schedules", async (req: Request, res: Response) => {
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Módulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  try {
    const filters: {
      status?: ScheduleStatus;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    } = {};
    const parsedStatus = parseScheduleStatus(req.query.status);
    const from = asOptionalString(req.query.from);
    const to = asOptionalString(req.query.to);
    const page = parseSchedulePage(req.query.page);
    const limit = parseScheduleLimit(req.query.limit);

    if (parsedStatus) filters.status = parsedStatus;
    if (from) filters.from = from;
    if (to) filters.to = to;
    if (page !== undefined) filters.page = page;
    if (limit !== undefined) filters.limit = limit;

    const schedules = await scheduleModule.listSchedules(filters);
    res.json(schedules);
  } catch (err) {
    handleScheduleError(err, res, "Falha ao listar agendamentos.");
  }
});

app.get("/api/schedules/stats", async (_req: Request, res: Response) => {
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Módulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  try {
    const stats = await scheduleModule.getStats();
    res.json(stats);
  } catch (err) {
    handleScheduleError(err, res, "Falha ao carregar estatísticas dos agendamentos.");
  }
});

app.get("/api/stats/endpoints", async (req: Request, res: Response) => {
  try {
    const period = parseEndpointStatsPeriod(req.query.period);
    res.json(await apiStatsService.getSummary(period));
  } catch (err) {
    handleScheduleError(err, res, "Falha ao carregar estatísticas dos endpoints.");
  }
});

app.get("/api/schedules/:id", async (req: Request, res: Response) => {
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Módulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  try {
    const schedule = await scheduleModule.getScheduleById(getRouteParam(req.params.id));
    if (!schedule) {
      return res.status(404).json({ error: "Agendamento não encontrado." });
    }
    res.json(schedule);
  } catch (err) {
    handleScheduleError(err, res, "Falha ao buscar agendamento.");
  }
});

app.post("/api/schedules/:id/pause", async (req: Request, res: Response) => {
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Módulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  try {
    const schedule = await scheduleModule.pauseSchedule(getRouteParam(req.params.id));
    if (!schedule) {
      return res.status(404).json({ error: "Agendamento não encontrado." });
    }
    res.json(schedule);
  } catch (err) {
    handleScheduleError(err, res, "Falha ao pausar agendamento.");
  }
});

app.post("/api/schedules/:id/resume", async (req: Request, res: Response) => {
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Módulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  try {
    const schedule = await scheduleModule.resumeSchedule(getRouteParam(req.params.id));
    if (!schedule) {
      return res.status(404).json({ error: "Agendamento não encontrado." });
    }
    res.json(schedule);
  } catch (err) {
    handleScheduleError(err, res, "Falha ao retomar agendamento.");
  }
});

app.post("/api/schedules/:id/cancel", async (req: Request, res: Response) => {
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Módulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  try {
    const schedule = await scheduleModule.cancelSchedule(getRouteParam(req.params.id));
    if (!schedule) {
      return res.status(404).json({ error: "Agendamento não encontrado." });
    }
    res.json(schedule);
  } catch (err) {
    handleScheduleError(err, res, "Falha ao cancelar agendamento.");
  }
});

app.delete("/api/schedules/:id", async (req: Request, res: Response) => {
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Módulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  try {
    const existing = await scheduleModule.getScheduleById(getRouteParam(req.params.id));
    if (!existing) {
      return res.status(404).json({ error: "Agendamento não encontrado." });
    }
    if (existing.status === "processing") {
      return res.status(409).json({ error: "Não é possível deletar um agendamento em processamento." });
    }

    await scheduleModule.deleteSchedule(existing.id);
    res.json({ success: true, id: existing.id });
  } catch (err) {
    handleScheduleError(err, res, "Falha ao deletar agendamento.");
  }
});

app.delete("/api/schedules", async (req: Request, res: Response) => {
  if (!scheduleModule.isEnabled()) {
    return res.status(503).json({ error: "Módulo de agendamento desabilitado. Configure SCHED_DB_ENABLED=true e as flags do MySQL." });
  }

  try {
    const status = asOptionalString(req.query.status);
    if (status !== "sent") {
      throw new ScheduleValidationError("Use status=sent para limpar apenas mensagens enviadas.");
    }

    const deleted = await scheduleModule.clearSentSchedules();
    res.json({ success: true, deleted });
  } catch (err) {
    handleScheduleError(err, res, "Falha ao limpar mensagens enviadas.");
  }
});

app.use(express.static(path.join(process.cwd(), "public")));

void bootstrap();

async function bootstrap() {
  try {
    await whatsapp.start();
    await attendanceModule.start();
    await scheduleModule.start();
    app.listen(PORT, () => {
      console.log(`API WPP iniciada na porta ${PORT}`);
    });
  } catch (err) {
    console.error("Falha ao iniciar modulos da aplicacao:", err);
    process.exit(1);
  }
}

function deduceKind(mimetype: string): MediaKind {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("audio/")) return "audio";
  return "document";
}

function rateLimiter(_req: Request, res: Response, next: () => void) {
  const now = Date.now();
  rateTimestamps = rateTimestamps.filter((t) => now - t < rateWindowMs);
  if (rateTimestamps.length >= rateMax) {
    return res.status(429).json({ error: "Muitas requisições, tente novamente em instantes." });
  }
  rateTimestamps.push(now);
  next();
}

function trackApiEndpoint(key: TrackedEndpointKey) {
  return (_req: Request, res: Response, next: () => void) => {
    res.once("finish", () => {
      void apiStatsService.track(key, res.statusCode);
    });
    next();
  };
}

function parseEndpointStatsPeriod(value: unknown): EndpointStatsPeriod {
  if (value === undefined) return "all";
  if (typeof value !== "string") {
    throw new ScheduleValidationError("Campo 'period' inválido.");
  }

  const normalized = value.trim();
  const allowed: EndpointStatsPeriod[] = ["today", "7d", "30d", "all"];
  if (!allowed.includes(normalized as EndpointStatsPeriod)) {
    throw new ScheduleValidationError("Campo 'period' inválido.");
  }

  return normalized as EndpointStatsPeriod;
}

function parseAttendanceStatus(value: unknown): AttendanceConversationStatus | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim();
  const allowed: AttendanceConversationStatus[] = ["new", "open", "waiting_agent", "closed"];
  if (!allowed.includes(normalized as AttendanceConversationStatus)) {
    throw new AttendanceValidationError("Campo 'status' invalido.");
  }
  return normalized as AttendanceConversationStatus;
}

function parseRequiredAttendanceStatus(value: unknown): AttendanceConversationStatus {
  const parsed = parseAttendanceStatus(value);
  if (!parsed) {
    throw new AttendanceValidationError("Campo 'status' e obrigatorio.");
  }
  return parsed;
}

function parseAttendanceLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new AttendanceValidationError("Campo 'limit' deve ser um inteiro entre 1 e 200.");
  }
  return parsed;
}

function parseAttendanceMessagesLimit(value: unknown): number {
  if (value === undefined) return 200;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new AttendanceValidationError("Campo 'limit' deve ser um inteiro entre 1 e 500.");
  }
  return parsed;
}

function parseAttendanceNotesLimit(value: unknown): number {
  if (value === undefined) return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 300) {
    throw new AttendanceValidationError("Campo 'limit' deve ser um inteiro entre 1 e 300.");
  }
  return parsed;
}

function parseAttendanceTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AttendanceValidationError("Campo 'tags' deve ser um array de strings.");
  }

  const parsed = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  if (parsed.length !== value.length) {
    throw new AttendanceValidationError("Campo 'tags' deve conter apenas strings validas.");
  }

  return parsed;
}

function parseAttendanceConversationScheduleStatus(value: unknown): "pending" | "paused" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return parseEditableScheduleStatus(value);
}

function emptyConversationScheduleSummary(conversationId: string): ConversationScheduleSummary {
  return {
    conversationId,
    hasActiveSchedule: false,
    activeScheduleCount: 0,
    nextScheduleId: null,
    nextScheduleAt: null,
    nextScheduleMessage: null,
    nextScheduleStatus: null
  };
}

function applyConversationScheduleSummary(
  conversation: AttendanceConversationRecord,
  summary?: ConversationScheduleSummary
): AttendanceConversationWithSchedule {
  const safeSummary = summary ?? emptyConversationScheduleSummary(conversation.id);
  return {
    ...conversation,
    hasActiveSchedule: safeSummary.hasActiveSchedule,
    activeScheduleCount: safeSummary.activeScheduleCount,
    nextScheduleId: safeSummary.nextScheduleId,
    nextScheduleAt: safeSummary.nextScheduleAt,
    nextScheduleMessage: safeSummary.nextScheduleMessage,
    nextScheduleStatus: safeSummary.nextScheduleStatus
  };
}

async function enrichAttendanceConversation(conversation: AttendanceConversationRecord): Promise<AttendanceConversationWithSchedule> {
  const [enriched] = await enrichAttendanceConversations([conversation]);
  return enriched ?? applyConversationScheduleSummary(conversation);
}

async function enrichAttendanceConversations(
  conversations: AttendanceConversationRecord[]
): Promise<AttendanceConversationWithSchedule[]> {
  if (!conversations.length) {
    return [];
  }

  if (!scheduleModule.isEnabled()) {
    return conversations.map((conversation) => applyConversationScheduleSummary(conversation));
  }

  const summaries = await scheduleModule.getConversationScheduleSummaries(conversations.map((conversation) => conversation.id));
  return conversations.map((conversation) => applyConversationScheduleSummary(conversation, summaries.get(conversation.id)));
}

function getIdemKey(req: Request): string | null {
  return (req.headers["idempotency-key"] as string | undefined) ?? (req.body?.clientMessageId as string | undefined) ?? null;
}

function replyIfCached(key: string | null, res: Response): boolean {
  if (!key) return false;
  const cached = idempotencyCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    res.status(cached.status).json(cached.body);
    return true;
  }
  return false;
}

function cacheIdem(key: string | null, res: Response, body: unknown, status = 200) {
  if (key) {
    idempotencyCache.set(key, { status, body, expiresAt: Date.now() + IDEM_TTL_MS });
  }
  res.status(status).json(body);
}

function parseScheduleType(value: unknown): ScheduleType | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim();
  if (normalized !== "text") {
    throw new ScheduleValidationError("Campo 'type' inválido. Use 'text'.");
  }
  return normalized as ScheduleType;
}

function parseScheduleStatus(value: unknown): ScheduleStatus | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim();
  const allowed: ScheduleStatus[] = ["pending", "paused", "processing", "sent", "failed", "cancelled"];
  if (!allowed.includes(normalized as ScheduleStatus)) {
    throw new ScheduleValidationError("Campo 'status' inválido.");
  }
  return normalized as ScheduleStatus;
}

function parseEditableScheduleStatus(value: unknown): "pending" | "paused" {
  if (typeof value !== "string" || !value.trim()) {
    throw new ScheduleValidationError("Campo 'status' inválido.");
  }
  const normalized = value.trim();
  if (normalized !== "pending" && normalized !== "paused") {
    throw new ScheduleValidationError("Campo 'status' inválido. Use 'pending' ou 'paused'.");
  }
  return normalized;
}

function parseScheduleLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new ScheduleValidationError("Campo 'limit' deve ser um inteiro entre 1 e 200.");
  }
  return parsed;
}

function parseSchedulePage(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ScheduleValidationError("Campo 'page' deve ser um inteiro maior ou igual a 1.");
  }
  return parsed;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireBodyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ScheduleValidationError(`Campo '${fieldName}' é obrigatório.`);
  }
  return value.trim();
}

function parseOptionalBodyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseNullableBodyString(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new AttendanceValidationError("Campo deve ser uma string valida.");
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function parseOptionalBodyInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ScheduleValidationError(`Campo '${fieldName}' deve ser um número inteiro.`);
  }
  return parsed;
}

function parseRequiredBodyInteger(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ScheduleValidationError(`Campo '${fieldName}' deve ser um número inteiro.`);
  }
  return parsed;
}

function parseNullableOptionalBodyString(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ScheduleValidationError("Campo deve ser uma string válida.");
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function getRouteParam(value: string | string[] | undefined): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new ScheduleValidationError("Parâmetro de rota inválido.");
}

function handleScheduleError(err: unknown, res: Response, fallbackMessage: string) {
  if (err instanceof ScheduleValidationError) {
    return res.status(400).json({ error: err.message });
  }

  console.error(err);
  return res.status(500).json({ error: fallbackMessage });
}

function handleAttendanceError(err: unknown, res: Response, fallbackMessage: string) {
  if (err instanceof AttendanceValidationError || err instanceof ScheduleValidationError) {
    return res.status(400).json({ error: err.message });
  }

  console.error(err);
  return res.status(500).json({ error: fallbackMessage });
}

function createDashboardSession(user: string): string {
  const sessionId = crypto.randomBytes(32).toString("hex");
  dashboardSessions.set(sessionId, { user, expiresAt: Date.now() + DASH_SESSION_TTL_MS });
  return sessionId;
}

function hasValidDashboardSession(req: Request): boolean {
  const sessionId = getCookieValue(req, DASH_SESSION_COOKIE);
  if (!sessionId) return false;

  const session = dashboardSessions.get(sessionId);
  if (!session) return false;

  if (session.expiresAt <= Date.now()) {
    dashboardSessions.delete(sessionId);
    return false;
  }

  return true;
}

function getCookieValue(req: Request, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((item) => item.trim());
  const cookie = cookies.find((item) => item.startsWith(`${name}=`));
  if (!cookie) return null;

  return decodeURIComponent(cookie.slice(name.length + 1));
}

function setDashboardSessionCookie(res: Response, sessionId: string) {
  res.cookie(DASH_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: DASH_SESSION_TTL_MS,
    path: "/"
  });
}

function clearDashboardSessionCookie(res: Response) {
  res.clearCookie(DASH_SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });
}

function buildSwaggerSpec(req: Request) {
  return {
    ...swaggerSpec,
    servers: [{ url: resolveServerUrl(req) }]
  };
}

function resolveServerUrl(req: Request): string {
  if (SERVER_URL) {
    return SERVER_URL;
  }

  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get("host");

  if (host) {
    return `${protocol}://${host}`;
  }

  return `http://localhost:${PORT}`;
}

function normalizeServerUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.replace(/\/+$/, "");
}
