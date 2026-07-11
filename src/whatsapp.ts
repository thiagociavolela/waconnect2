import type { AnyMessageContent, WAMessage, WAMessageKey, WASocket, WAUrlInfo } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import type PQueue from "p-queue";
import path from "path";
import fs from "fs/promises";
import { getAudioUrl } from "google-tts-api";

export type MediaKind = "image" | "video" | "audio" | "document";

export interface SendTextPayload {
  to: string;
  message: string;
  /** Delay desejado em segundos entre mensagens. Mínimo aplicado: 3s. */
  delaySeconds?: number;
}

export interface SendMediaPayload {
  to: string;
  kind: MediaKind;
  buffer: Buffer;
  mimetype?: string;
  fileName?: string;
  caption?: string;
}

export interface SendContactPayload {
  to: string;
  name: string;
  phone: string;
}

export interface SendNarrationPayload {
  to: string;
  text: string;
  lang?: string;
  slow?: boolean;
}

export interface CheckNumberResult {
  input: string;
  tried: string[];
  exists: boolean;
  jid?: string;
}

export type IncomingWhatsAppMessageType = "text" | "image" | "video" | "audio" | "document" | "sticker" | "unknown";

export interface IncomingWhatsAppMessage {
  waMessageId: string;
  remoteJid: string;
  remoteJidAlt: string | null;
  fromNumber: string;
  pushName: string | null;
  text: string | null;
  messageType: IncomingWhatsAppMessageType;
  mediaBuffer?: Buffer | null;
  mediaMimeType?: string | null;
  mediaFileName?: string | null;
}

type IncomingMessageListener = (message: IncomingWhatsAppMessage) => void | Promise<void>;

export class WhatsAppService {
  private socket: WASocket | null = null;
  private qrString: string | null = null;
  private connecting = false;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private manualDisconnect = false;
  private authFolder = path.join(process.cwd(), "auth");
  private meJid: string | undefined;
  private pushName: string | undefined;
  private profilePicUrl: string | undefined;
  private readonly contactProfilePicCache = new Map<string, { url: string | null; expiresAt: number }>();
  private queuePromise: Promise<PQueue> | null = null;
  private readonly incomingMessageListeners = new Set<IncomingMessageListener>();
  // último envio global (qualquer destinatário) para garantir espaçamento mínimo
  private lastSendAt = 0;
  private lastSendByJid = new Map<string, number>();

  private baileysModule: Promise<typeof import("@whiskeysockets/baileys")> | null = null;

  private async loadProfilePic() {
    try {
      const jid = this.socket?.user?.id;
      if (!jid) return;
      const url = await this.socket?.profilePictureUrl(jid, "image");
      this.profilePicUrl = url ?? undefined;
    } catch (err) {
      console.warn("Não foi possível carregar foto de perfil", err);
    }
  }

  private loadBaileys() {
    if (!this.baileysModule) {
      // usa import nativo para evitar require() em ESM
      const dynamicImport = new Function("specifier", "return import(specifier);") as (
        s: string
      ) => Promise<typeof import("@whiskeysockets/baileys")>;
      this.baileysModule = dynamicImport("@whiskeysockets/baileys");
    }
    return this.baileysModule;
  }

  private loadQueue(): Promise<PQueue> {
    if (!this.queuePromise) {
      // usa import dinâmico real para não depender de require() em módulo ESM
      const dynamicImport = new Function("specifier", "return import(specifier);") as (
        s: string
      ) => Promise<typeof import("p-queue")>;
      // concurrency 1 força fila global, evitando envios simultâneos
      this.queuePromise = dynamicImport("p-queue").then((mod) => new mod.default({ concurrency: 1 }));
    }
    return this.queuePromise;
  }

  get status() {
    return {
      connected: this.connected,
      me: this.meJid,
      pushName: this.pushName,
      qr: this.qrString,
      profilePicUrl: this.profilePicUrl
    };
  }

  async statusWithFreshPic() {
    await this.loadProfilePic();
    return this.status;
  }

  getCachedProfilePictureUrl(jid: string): string | null {
    const normalizedJid = this.formatJid(jid);
    const cached = this.contactProfilePicCache.get(normalizedJid);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.url;
    }
    return null;
  }

  async getProfilePictureUrl(jid: string): Promise<string | null> {
    const normalizedJid = this.formatJid(jid);
    const cached = this.contactProfilePicCache.get(normalizedJid);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.url;
    }

    if (!this.socket || !this.connected) {
      return cached?.url ?? null;
    }

    try {
      const sock = this.assertSocket();
      const url = await sock.profilePictureUrl(normalizedJid, "image");
      const resolved = url ?? null;
      this.contactProfilePicCache.set(normalizedJid, {
        url: resolved,
        expiresAt: Date.now() + 1000 * 60 * 10
      });
      return resolved;
    } catch {
      this.contactProfilePicCache.set(normalizedJid, {
        url: null,
        expiresAt: Date.now() + 1000 * 60 * 2
      });
      return null;
    }
  }

  onIncomingMessage(listener: IncomingMessageListener): () => void {
    this.incomingMessageListeners.add(listener);
    return () => {
      this.incomingMessageListeners.delete(listener);
    };
  }

  async start() {
    if (this.connecting) return;
    this.clearReconnectTimer();
    this.manualDisconnect = false;
    this.connecting = true;

    try {
      const baileys = await this.loadBaileys();
      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.authFolder);
      const { version } = await baileys.fetchLatestBaileysVersion();

      const socket = baileys.makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: baileys.Browsers.macOS("Chrome"),
        // ativa thumbnails enviadas para gerar previews ricos de links
        generateHighQualityLinkPreview: true,
        // define user-agent para melhorar compatibilidade de scraping de OG tags
        options: {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
          }
        }
      });

      this.socket = socket;
      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("connection.update", (update) => {
        if (this.socket !== socket) return;

        console.log("conn update", update.connection, update.qr ? "qr-received" : "", update.lastDisconnect?.error?.message ?? "");
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          console.log("qr received len", qr.length);
          this.qrString = qr;
          this.connected = false;
        }

        if (connection === "open") {
          this.connected = true;
          this.qrString = null;
          this.meJid = socket.user?.id;
          this.pushName = socket.user?.name;
          void this.loadProfilePic();
        }

        if (connection === "close") {
          this.connected = false;
          this.socket = null;
          const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
          const shouldReconnect = statusCode !== baileys.DisconnectReason.loggedOut;

          if (this.manualDisconnect) {
            return;
          }

          if (shouldReconnect) {
            this.scheduleReconnect(3000);
          } else {
            this.qrString = null;
            void this.resetAuthAndRestart();
          }
        }
      });

      socket.ev.on("messages.upsert", async (payload) => {
        if (this.socket !== socket) return;

        for (const message of payload.messages ?? []) {
          const parsed = await this.parseIncomingWhatsAppMessage(message, payload.type);
          if (!parsed) continue;
          for (const listener of this.incomingMessageListeners) {
            Promise.resolve(listener(parsed)).catch((err) => {
              console.error("Falha ao processar listener de mensagem recebida:", err);
            });
          }
        }
      });
    } catch (err) {
      this.connected = false;
      this.socket = null;
      console.error("Falha ao iniciar conexao do WhatsApp:", err);
      this.scheduleReconnect(5000);
    } finally {
      this.connecting = false;
    }
  }

  private async resetAuthAndRestart() {
    this.clearReconnectTimer();
    this.manualDisconnect = false;
    try {
      await fs.rm(this.authFolder, { recursive: true, force: true });
    } catch (err) {
      console.error("Erro ao limpar auth:", err);
    }
    this.connecting = false;
    this.connected = false;
    this.socket = null;
    this.qrString = null;
    this.profilePicUrl = undefined;
    this.scheduleReconnect(1000);
  }

  async forceNewQr() {
    await this.resetAuthAndRestart();
  }

  async clearCacheOnly() {
    try {
      await fs.rm(this.authFolder, { recursive: true, force: true });
      this.qrString = null;
    } catch (err) {
      console.error("Erro ao limpar cache:", err);
    }
  }

  async disconnect() {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    try {
      await this.socket?.logout();
      await this.socket?.end(new Error("manual disconnect"));
    } catch (err) {
      console.error("Erro ao desconectar:", err);
    }
    await this.clearCacheOnly();
    this.connected = false;
    this.socket = null;
    this.qrString = null;
    this.profilePicUrl = undefined;
    this.contactProfilePicCache.clear();
  }

  private scheduleReconnect(delayMs: number) {
    if (this.manualDisconnect || this.connecting || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private assertSocket(): WASocket {
    if (!this.socket) throw new Error("WhatsApp socket not initialized");
    return this.socket;
  }

  private async scheduleSend<T>(jid: string, fn: () => Promise<T>, requestedDelayMs = 3000): Promise<T> {
    const queue = await this.loadQueue();
    return queue.add<T>(
      async () => {
        const jitter = Math.floor(Math.random() * 500); // ruído para evitar padrão fixo
        const minGap = Math.max(3000, requestedDelayMs); // mínimo absoluto 3s
        const now = Date.now();
        const nextAllowed = this.lastSendAt + minGap;
        // aguarda sempre pelo menos minGap antes de enviar, e respeita espaçamento entre mensagens
        const waitMs = Math.max(minGap, nextAllowed - now) + jitter;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        const result = await fn();
        const sentAt = Date.now();
        this.lastSendAt = sentAt;
        this.lastSendByJid.set(jid, sentAt);
        return result;
      },
      { throwOnTimeout: true }
    );
  }

  /**
   * Remove caracteres especiais e mantém apenas dígitos para números sem JID.
   */
  private normalizeNumber(raw: string): string {
    return raw.replace(/\D/g, "");
  }

  private formatJid(raw: string): string {
    const normalized = raw.replace(/\s|-/g, "");
    if (normalized.endsWith("@s.whatsapp.net") || normalized.endsWith("@g.us")) {
      return normalized;
    }
    if (normalized.includes("@")) return normalized;
    return `${this.normalizeNumber(normalized)}@s.whatsapp.net`;
  }

  private buildLookupCandidateJids(raw: string): string[] {
    const normalized = raw.replace(/\s|-/g, "");
    const normalizedLower = normalized.toLowerCase();
    if (normalizedLower.endsWith("@g.us")) {
      return [normalized];
    }
    if (normalized.includes("@") && !normalizedLower.endsWith("@s.whatsapp.net")) {
      return [normalized];
    }

    const digits = extractLookupPhoneDigits(normalized);
    if (!digits) {
      return [this.formatJid(raw)];
    }

    return buildLookupCandidateNumbers(digits).map((candidate) => `${candidate}@s.whatsapp.net`);
  }

  private async lookupNumberCandidates(to: string): Promise<CheckNumberResult> {
    const sock = this.assertSocket();
    const tried = this.buildLookupCandidateJids(to);
    for (const candidate of tried) {
      const result = await sock.onWhatsApp(candidate);
      const first = result?.[0];
      if (first?.exists) {
        const jid = typeof first.jid === "string" && first.jid.trim() ? first.jid : candidate;
        return { input: to, tried, exists: true, jid };
      }
    }

    return { input: to, tried, exists: false };
  }

  private async resolveSendJid(to: string): Promise<string> {
    const candidates = this.buildLookupCandidateJids(to);
    if (candidates.length <= 1) {
      return this.formatJid(to);
    }

    const resolution = await this.withRetry(() => this.lookupNumberCandidates(to));
    return resolution.jid ?? resolution.tried[0] ?? this.formatJid(to);
  }

  async sendText({ to, message, delaySeconds }: SendTextPayload) {
    const jid = await this.resolveSendJid(to);
    const requestedDelayMs = Number.isFinite(delaySeconds) ? (delaySeconds as number) * 1000 : 3000;
    return this.scheduleSend(
      jid,
      () =>
        this.withRetry(async () => {
          const baileys = await this.loadBaileys();
          const sock = this.assertSocket();
          let linkPreview: WAUrlInfo | undefined;
          const hasUrl = /(https?:\/\/[^\s]+)/i.test(message);
          if (hasUrl) {
            try {
              linkPreview = await baileys.getUrlInfo(message, {
                thumbnailWidth: 192,
                fetchOpts: {
                  timeout: 8000,
                  headers: {
                    "User-Agent":
                      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
                  }
                }
              });
            } catch (err) {
              console.warn("Falha ao gerar link preview", err);
            }
          }
          const content: AnyMessageContent = linkPreview ? { text: message, linkPreview } : { text: message };
          const result = await sock.sendMessage(jid, content);
          return result?.key as WAMessageKey;
        }),
      requestedDelayMs
    );
  }

  async sendMedia({ to, buffer, kind, mimetype, fileName, caption }: SendMediaPayload) {
    const jid = await this.resolveSendJid(to);
    return this.scheduleSend(jid, () =>
      this.withRetry(async () => {
        const sock = this.assertSocket();

        let content: AnyMessageContent;
        switch (kind) {
          case "image":
            content = { image: buffer, ...(caption ? { caption } : {}) };
            break;
          case "video":
            content = { video: buffer, ...(caption ? { caption } : {}) };
            break;
          case "audio":
            content = { audio: buffer, mimetype: mimetype ?? "audio/ogg; codecs=opus" };
            break;
          case "document":
          default:
            content = {
              document: buffer,
              mimetype: mimetype ?? "application/octet-stream",
              fileName: fileName ?? "document"
            };
            break;
        }

        const result = await sock.sendMessage(jid, content);
        return result?.key as WAMessageKey;
      })
    );
  }

  async sendContact({ to, name, phone }: SendContactPayload) {
    const jid = await this.resolveSendJid(to);
    return this.scheduleSend(jid, () =>
      this.withRetry(async () => {
        const sock = this.assertSocket();

        const vcard = [
          "BEGIN:VCARD",
          "VERSION:3.0",
          `FN:${name}`,
          `TEL;type=CELL;type=VOICE;waid=${phone.replace(/\D/g, "")}:${phone}`,
          "END:VCARD"
        ].join("\n");

        const content: AnyMessageContent = {
          contacts: {
            displayName: name,
            contacts: [{ vcard }]
          }
        };

        const result = await sock.sendMessage(jid, content);
        return result?.key as WAMessageKey;
      })
    );
  }

  async sendNarration({ to, text, lang = "pt-BR", slow = false }: SendNarrationPayload) {
    return this.withRetry(async () => {
      const url = getAudioUrl(text, { lang, slow, host: "https://translate.google.com" });
      const audioRes = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
        }
      });
      if (!audioRes.ok) throw new Error(`Falha ao gerar TTS: ${audioRes.status} ${audioRes.statusText}`);
      const arrayBuffer = await audioRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return this.sendMedia({
        to,
        buffer,
        kind: "audio",
        mimetype: "audio/mpeg",
        fileName: "narracao.mp3"
      });
    });
  }

  async checkNumber(to: string): Promise<CheckNumberResult> {
    return this.withRetry(() => this.lookupNumberCandidates(to));
  }

  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt < maxAttempts) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        attempt += 1;
        const backoff = 200 * attempt; // 200ms, 400ms, 600ms
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }

  private async parseIncomingWhatsAppMessage(message: WAMessage, upsertType?: string): Promise<IncomingWhatsAppMessage | null> {
    if (message.key?.fromMe) return null;

    const rawRemoteJid = typeof message.key?.remoteJid === "string" ? message.key.remoteJid : "";
    const rawRemoteJidAlt = typeof message.key?.remoteJidAlt === "string" && message.key.remoteJidAlt ? message.key.remoteJidAlt : null;
    if (!rawRemoteJid || shouldIgnoreInboundJid(rawRemoteJid)) {
      return null;
    }

    const normalizedPrimaryJid = extractDirectPhoneJid(rawRemoteJid);
    const normalizedAltJid = extractDirectPhoneJid(rawRemoteJidAlt);
    const remoteJid = normalizedAltJid ?? normalizedPrimaryJid;
    if (!remoteJid) {
      return null;
    }
    const remoteJidAlt = normalizedAltJid && normalizedPrimaryJid && normalizedAltJid !== normalizedPrimaryJid ? normalizedPrimaryJid : null;

    const waMessageId = typeof message.key?.id === "string" ? message.key.id : "";
    if (!waMessageId) return null;

    const fromNumber = extractPhoneNumberFromJid(remoteJid);
    if (!fromNumber) return null;

    const baileys = await this.loadBaileys();
    if (!message.message) {
      console.warn("Mensagem recebida sem payload utilizavel no atendimento:", {
        remoteJid,
        waMessageId,
        upsertType: upsertType ?? null,
        messageStubType: message.messageStubType ?? null
      });
      return null;
    }

    const normalized = baileys.normalizeMessageContent(message.message);
    const contentType = baileys.getContentType(normalized);
    if (!contentType) {
      console.warn("Mensagem recebida sem tipo de conteudo utilizavel no atendimento:", {
        remoteJid,
        waMessageId,
        upsertType: upsertType ?? null,
        messageStubType: message.messageStubType ?? null
      });
      return null;
    }

    const content = readNormalizedMessageContent(baileys, normalized);
    const messageType = detectIncomingMessageTypeFromContent(content);
    const mediaMetadata = readIncomingMediaMetadata(content);
    const mediaBuffer = await this.downloadIncomingMedia(message, messageType);
    if (messageType === "unknown") {
      console.warn("Mensagem recebida com formato nao mapeado no atendimento:", {
        remoteJid,
        waMessageId,
        contentKeys: Object.keys(content)
      });
    }

    return {
      waMessageId,
      remoteJid,
      remoteJidAlt,
      fromNumber,
      pushName: typeof message.pushName === "string" && message.pushName.trim() ? message.pushName.trim() : null,
      text: extractIncomingMessageTextFromContent(content),
      messageType,
      mediaBuffer,
      mediaMimeType: mediaMetadata?.mimetype ?? null,
      mediaFileName: mediaMetadata?.fileName ?? null
    };
  }

  private async downloadIncomingMedia(
    message: WAMessage,
    messageType: IncomingWhatsAppMessageType
  ): Promise<Buffer | null> {
    if (messageType !== "image" && messageType !== "video" && messageType !== "audio" && messageType !== "document") {
      return null;
    }

    try {
      const baileys = await this.loadBaileys();
      return await baileys.downloadMediaMessage(message, "buffer", {});
    } catch (error) {
      console.warn(`Falha ao baixar midia recebida (${messageType}):`, error);
      return null;
    }
  }
}

function readNormalizedMessageContent(
  baileys: typeof import("@whiskeysockets/baileys"),
  normalizedMessage: WAMessage["message"]
): Record<string, unknown> {
  const content = baileys.extractMessageContent(normalizedMessage) ?? normalizedMessage;
  return (content ?? {}) as Record<string, unknown>;
}

function detectIncomingMessageTypeFromContent(content: Record<string, unknown>): IncomingWhatsAppMessageType {
  if (readIncomingTextBodyFromContent(content) || describeStructuredMessage(content)) return "text";
  if (content.imageMessage) return "image";
  if (content.videoMessage) return "video";
  if (content.audioMessage) return "audio";
  if (content.documentMessage) return "document";
  if (content.stickerMessage) return "sticker";
  return "unknown";
}

function extractIncomingMessageTextFromContent(content: Record<string, unknown>): string | null {
  const candidates = [
    readIncomingTextBodyFromContent(content),
    readNestedCaption(content.imageMessage),
    readNestedCaption(content.videoMessage),
    readNestedCaption(content.documentMessage),
    readNestedText(content.documentMessage),
    describeStructuredMessage(content)
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function readIncomingMediaMetadata(
  content: Record<string, unknown>
): { mimetype: string | null; fileName: string | null } | null {
  const mediaContent =
    readNestedRecord(content.imageMessage) ??
    readNestedRecord(content.videoMessage) ??
    readNestedRecord(content.audioMessage) ??
    readNestedRecord(content.documentMessage);

  if (!mediaContent) {
    return null;
  }

  return {
    mimetype: typeof mediaContent.mimetype === "string" && mediaContent.mimetype.trim() ? mediaContent.mimetype.trim() : null,
    fileName: typeof mediaContent.fileName === "string" && mediaContent.fileName.trim() ? mediaContent.fileName.trim() : null
  };
}

function shouldIgnoreInboundJid(jid: string): boolean {
  const normalized = jid.trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized === "status@broadcast" ||
    normalized.endsWith("@g.us") ||
    normalized.endsWith("@newsletter") ||
    normalized.endsWith("@broadcast")
  );
}

function extractPhoneNumberFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;

  const normalized = jid.trim().toLowerCase();
  if (!normalized.endsWith("@s.whatsapp.net")) {
    return null;
  }

  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0) {
    return null;
  }

  const localPart = normalized.slice(0, atIndex);
  const phonePart = localPart.split(":")[0] ?? localPart;
  const digits = phonePart.replace(/\D/g, "");
  return digits || null;
}

function extractDirectPhoneJid(jid: string | null | undefined): string | null {
  const phoneNumber = extractPhoneNumberFromJid(jid);
  return phoneNumber ? `${phoneNumber}@s.whatsapp.net` : null;
}

function extractLookupPhoneDigits(value: string): string | null {
  if (!value) return null;

  const normalizedLower = value.toLowerCase();
  if (normalizedLower.endsWith("@s.whatsapp.net")) {
    const atIndex = value.indexOf("@");
    if (atIndex <= 0) {
      return null;
    }

    const localPart = value.slice(0, atIndex);
    const phonePart = localPart.split(":")[0] ?? localPart;
    const digits = phonePart.replace(/\D/g, "");
    return digits || null;
  }

  if (value.includes("@")) {
    return null;
  }

  const digits = value.replace(/\D/g, "");
  return digits || null;
}

function buildLookupCandidateNumbers(phoneNumber: string): string[] {
  if (!phoneNumber.startsWith("55")) {
    return [phoneNumber];
  }

  const nationalNumber = phoneNumber.slice(2);
  if (nationalNumber.length !== 10 && nationalNumber.length !== 11) {
    return [phoneNumber];
  }

  const ddd = nationalNumber.slice(0, 2);
  const subscriber = nationalNumber.slice(2);
  if (!/^\d{2}$/.test(ddd)) {
    return [phoneNumber];
  }

  if (subscriber.length === 9 && subscriber.startsWith("9")) {
    return uniqueStrings([phoneNumber, `55${ddd}${subscriber.slice(1)}`]);
  }

  if (subscriber.length === 8 && /^[6-9]/.test(subscriber)) {
    return uniqueStrings([`55${ddd}9${subscriber}`, phoneNumber]);
  }

  return [phoneNumber];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function readNestedText(value: unknown): string | null {
  const record = readNestedRecord(value);
  if (!record) return null;
  return typeof record.text === "string" ? record.text : null;
}

function readNestedString(value: unknown, key: string): string | null {
  const record = readNestedRecord(value);
  if (!record) return null;
  return typeof record[key] === "string" ? (record[key] as string) : null;
}

function readNestedCaption(value: unknown): string | null {
  const record = readNestedRecord(value);
  if (!record) return null;
  return typeof record.caption === "string" ? record.caption : null;
}

function readIncomingTextBodyFromContent(content: Record<string, unknown>): string | null {
  const candidates = [
    typeof content.conversation === "string" ? content.conversation : null,
    readNestedText(content.extendedTextMessage),
    readNestedString(content.buttonsResponseMessage, "selectedDisplayText"),
    readNestedString(content.buttonsResponseMessage, "selectedButtonId"),
    readNestedString(content.templateButtonReplyMessage, "selectedDisplayText"),
    readNestedString(content.templateButtonReplyMessage, "selectedId"),
    readListResponseText(content.listResponseMessage),
    readInteractiveResponseText(content.interactiveResponseMessage)
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function readListResponseText(value: unknown): string | null {
  const record = readNestedRecord(value);
  if (!record) return null;

  const candidates = [
    typeof record.title === "string" ? record.title : null,
    typeof record.description === "string" ? record.description : null,
    readNestedString(record.singleSelectReply, "selectedRowId")
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function readInteractiveResponseText(value: unknown): string | null {
  const record = readNestedRecord(value);
  if (!record) return null;

  const bodyText = readNestedText(record.body);
  if (bodyText?.trim()) {
    return bodyText.trim();
  }

  const nativeFlow = readNestedRecord(record.nativeFlowResponseMessage);
  const paramsJson = nativeFlow && typeof nativeFlow.paramsJson === "string" ? nativeFlow.paramsJson.trim() : "";
  if (paramsJson) {
    const fromJson = readResponseTextFromJson(paramsJson);
    if (fromJson) {
      return fromJson;
    }
  }

  const name = nativeFlow && typeof nativeFlow.name === "string" ? nativeFlow.name.trim() : "";
  return name || null;
}

function readResponseTextFromJson(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return findPreferredString(parsed, ["display_text", "title", "text", "label", "id", "selected_id"]);
  } catch {
    return value.trim() || null;
  }
}

function findPreferredString(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findPreferredString(item, keys, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findPreferredString(nestedValue, keys, depth + 1);
    if (nested) return nested;
  }

  return null;
}

function describeStructuredMessage(content: Record<string, unknown>): string | null {
  if (content.contactMessage || content.contactsArrayMessage) {
    return "[Contato recebido]";
  }

  if (content.locationMessage || content.liveLocationMessage) {
    return "[Localizacao recebida]";
  }

  if (content.reactionMessage) {
    const reaction = readNestedString(content.reactionMessage, "text");
    return reaction?.trim() ? `[Reacao] ${reaction.trim()}` : "[Reacao recebida]";
  }

  if (content.encReactionMessage) {
    return "[Reacao recebida]";
  }

  if (content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3) {
    return "[Enquete recebida]";
  }

  if (content.pollUpdateMessage) {
    return "[Resposta de enquete]";
  }

  if (content.placeholderMessage) {
    return "[Mensagem indisponivel]";
  }

  return null;
}

function readNestedRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}
