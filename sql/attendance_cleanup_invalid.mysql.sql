-- Limpeza de conversas invalidas do modulo de atendimento
-- Remove grupos, newsletters, broadcasts, LIDs sem telefone e qualquer JID que nao seja contato direto por numero.
-- As tabelas attendance_messages e attendance_notes serao limpas automaticamente
-- pelas foreign keys com ON DELETE CASCADE.
--
-- Uso sugerido:
--   1. Execute os SELECTs de conferencia.
--   2. Revise os registros retornados.
--   3. Execute o bloco START TRANSACTION ... COMMIT.
--
-- Exemplo:
--   USE wa_agenda;

SET NAMES utf8mb4;

-- Conferencia rapida dos registros invalidos
SELECT
  id,
  contact_jid,
  contact_number,
  contact_name,
  status,
  created_at,
  updated_at
FROM attendance_conversations
WHERE contact_jid NOT LIKE '%@s.whatsapp.net'
ORDER BY updated_at DESC, created_at DESC;

-- Resumo antes da limpeza
SELECT
  COUNT(*) AS invalid_conversations,
  SUM(CASE WHEN contact_jid LIKE '%@g.us' THEN 1 ELSE 0 END) AS groups_count,
  SUM(CASE WHEN contact_jid LIKE '%@newsletter' THEN 1 ELSE 0 END) AS newsletters_count,
  SUM(CASE WHEN contact_jid LIKE '%@broadcast' THEN 1 ELSE 0 END) AS broadcasts_count,
  SUM(CASE WHEN contact_jid LIKE '%@lid' THEN 1 ELSE 0 END) AS lid_count,
  SUM(CASE WHEN contact_jid NOT LIKE '%@g.us'
            AND contact_jid NOT LIKE '%@newsletter'
            AND contact_jid NOT LIKE '%@broadcast'
            AND contact_jid NOT LIKE '%@lid'
           THEN 1 ELSE 0 END) AS other_invalid_count
FROM attendance_conversations
WHERE contact_jid NOT LIKE '%@s.whatsapp.net';

-- Limpeza efetiva
START TRANSACTION;

DELETE FROM attendance_conversations
WHERE contact_jid NOT LIKE '%@s.whatsapp.net';

COMMIT;

-- Resumo apos a limpeza
SELECT
  COUNT(*) AS remaining_invalid_conversations
FROM attendance_conversations
WHERE contact_jid NOT LIKE '%@s.whatsapp.net';
