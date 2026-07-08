-- Schema do modulo de atendimento
-- Execute este script no banco ja utilizado pela aplicacao.
-- Exemplo:
--   USE wa_agenda;
-- Se a conexao ja estiver apontando para o banco correto, o USE pode ser omitido.

SET NAMES utf8mb4;

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

DROP PROCEDURE IF EXISTS attendance_schema_upgrade;

DELIMITER $$

CREATE PROCEDURE attendance_schema_upgrade()
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance_conversations'
       AND COLUMN_NAME = 'tags_json'
  ) THEN
    ALTER TABLE attendance_conversations
      ADD COLUMN tags_json JSON NULL AFTER assigned_agent;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance_conversations'
       AND INDEX_NAME = 'idx_attendance_assigned_agent'
  ) THEN
    ALTER TABLE attendance_conversations
      ADD KEY idx_attendance_assigned_agent (assigned_agent);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'attendance_conversations'
       AND INDEX_NAME = 'idx_attendance_last_message_at'
  ) THEN
    ALTER TABLE attendance_conversations
      ADD KEY idx_attendance_last_message_at (last_message_at);
  END IF;
END $$

DELIMITER ;

CALL attendance_schema_upgrade();
DROP PROCEDURE IF EXISTS attendance_schema_upgrade;
