# WaConnect – API WhatsApp (Baileys)

Painel web e API REST para gerenciar uma instância do WhatsApp usando **@whiskeysockets/baileys**. Inclui dashboard com QR Code, envio de mensagens, mídias, contatos e áudio narrado (TTS), além de documentação via Swagger.

## Requisitos
- Node.js 18+ e npm
- Conta/instância WhatsApp para pareamento via QR

## Variáveis de ambiente (`.env`)
| Chave        | Descrição                                           | Padrão          |
|--------------|-----------------------------------------------------|-----------------|
| `PORT`       | Porta do servidor HTTP                              | `3000`          |
| `SERVER_URL` | URL pública/base usada no Swagger                    | `http://localhost:3000` |
| `API_TOKEN`  | Token para proteger as rotas `/api/*` (header `x-api-token`) | **obrigatório** |
| `DASH_USER`  | Usuário do login do painel                           | `admin`         |
| `DASH_PASS`  | Senha do login do painel                             | `admin`         |

## Fuso horário oficial do projeto
- Todo o projeto usa o horário oficial de São Paulo, Brasil: `America/Sao_Paulo`.
- No módulo de agendamento, quando `scheduledAt` vier sem offset, o backend assume esse fuso.
- As respostas do agendamento retornam datas formatadas nesse mesmo fuso.

## Instalação
```bash
npm install
```

## Desenvolvimento
```bash
npm run dev       # ts-node-dev com hot reload
```

## Build e produção
```bash
npm run build
npm start         # executa dist/index.js
```

## Painel Web
- Servido em `/` com login (DASH_USER/DASH_PASS).
- Exibe QR Code para parear, status, logs e ações (gerar QR, desconectar, limpar cache).
- Tema dark neon alinhado ao login, com logo em `public/logo-login.png`.

## Autenticação da API
Enviar o header `x-api-token: <API_TOKEN>` em todas as rotas `/api/*`.

## Principais endpoints
- `GET /api/qr` — status/QR atual (data URL quando disponível).
- `POST /api/qr/new` — força novo QR (reinicia sessão).
- `POST /api/disconnect` — encerra sessão e limpa auth.
- `POST /api/clear-cache` — limpa cache/auth sem reiniciar.
- `GET /api/status` — status da instância.
- `POST /api/check-number` — verifica se número é WhatsApp.
- `POST /api/send/text` — envia texto `{ to, message, delay? }` (delay em segundos, mínimo 3s; padrão 3s).
- `POST /api/send/media` — envia mídia multipart form-data (`file`, `to`, `kind?`, `caption?`).
- `POST /api/send/contact` — envia vCard `{ to, name, phone }`.
- `POST /api/send/narration` — gera TTS (Google TTS) e envia áudio `{ to, text, lang?, slow? }`.

## Curl rápido (texto)
```bash
curl -X POST http://localhost:3000/api/send/text \
  -H "Content-Type: application/json" \
  -H "x-api-token: $API_TOKEN" \
  -d '{ "to":"5599999999999", "message":"Olá do WaConnect!", "delay": 4 }'
```

## Documentação Swagger
- Acesse `/api-docs` (UI) ou `/api-docs.json` (JSON).

## Agendamento de mensagens (MySQL)
- O módulo de agendamento é opcional e usa flags próprias com prefixo `SCHED_`.
- Quando `SCHED_DB_ENABLED=true`, o servidor inicializa o pool MySQL, cria a tabela automaticamente por padrão e sobe o worker de processamento.
- O script SQL manual está em `sql/message_schedules.mysql.sql`.

### Flags do agendamento
| Chave | Descrição | Padrão |
|---|---|---|
| `SCHED_DB_ENABLED` | Habilita o módulo de agendamento | `false` |
| `SCHED_DB_HOST` | Host do MySQL do agendamento | `127.0.0.1` |
| `SCHED_DB_PORT` | Porta do MySQL do agendamento | `3306` |
| `SCHED_DB_USER` | Usuário do MySQL | `root` |
| `SCHED_DB_PASSWORD` | Senha do MySQL | vazio |
| `SCHED_DB_NAME` | Banco de dados do agendamento | `waconnect` |
| `SCHED_DB_POOL_LIMIT` | Tamanho máximo do pool | `10` |
| `SCHED_AUTO_CREATE_SCHEMA` | Cria a tabela automaticamente na inicialização | `true` |
| `SCHED_WORKER_ENABLED` | Habilita o worker que processa agendamentos vencidos | `true` |
| `SCHED_WORKER_POLL_MS` | Intervalo de polling do worker em ms | `5000` |
| `SCHED_WORKER_BATCH_SIZE` | Quantidade máxima de agendamentos processados por ciclo | `10` |
| `SCHED_STALE_PROCESSING_MS` | Refilamento de itens travados em `processing` | `300000` |

### Exemplo de flags
```env
SCHED_DB_ENABLED=true
SCHED_DB_HOST=127.0.0.1
SCHED_DB_PORT=3306
SCHED_DB_USER=root
SCHED_DB_PASSWORD=senha
SCHED_DB_NAME=waconnect
SCHED_DB_POOL_LIMIT=10
SCHED_AUTO_CREATE_SCHEMA=true
SCHED_WORKER_ENABLED=true
SCHED_WORKER_POLL_MS=5000
SCHED_WORKER_BATCH_SIZE=10
SCHED_STALE_PROCESSING_MS=300000
```

### Endpoints de agendamento
- `POST /api/schedules` — cria um agendamento de texto.
- `GET /api/schedules` — lista agendamentos com filtros opcionais.
- `GET /api/schedules/:id` — detalha um agendamento.
- `POST /api/schedules/:id/cancel` — cancela um agendamento pendente ou com falha.

### Exemplo de criação
```bash
curl -X POST http://localhost:3000/api/schedules \
  -H "Content-Type: application/json" \
  -H "x-api-token: $API_TOKEN" \
  -d '{ "to":"5599999999999", "message":"Mensagem agendada", "scheduledAt":"2026-07-05T18:30:00-03:00", "maxAttempts":3 }'
```

## Atendimento (MySQL)
- O script principal do schema do atendimento está em `sql/attendance.mysql.sql`.
- O script de manutenção para remover conversas inválidas já gravadas no banco está em `sql/attendance_cleanup_invalid.mysql.sql`.
- Essa limpeza remove qualquer conversa cujo `contact_jid` não seja contato direto por número (`@s.whatsapp.net`).
- Mensagens e notas vinculadas são removidas automaticamente por `ON DELETE CASCADE`.

## Estrutura
- `src/` — código TypeScript (Express, Baileys, serviços).
- `public/` — frontend (HTML/CSS/JS) + assets.
- `dist/` — build gerado pelo TypeScript.
- `auth/` — credenciais/sessão Baileys (criado em tempo de execução).

## Notas sobre TTS
- Usa `google-tts-api`; requer acesso externo à Google Translate. Se receber 403/500, tente novamente ou verifique conectividade.

## Licença
ISC OpenSource.
