-- Schema para Sistema de Checkpoints WhatsApp
-- Criado para operação de anúncios com fluxos N8N

-- Limpar tabelas se existirem (para reset)
DROP TABLE IF EXISTS message_history CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS flow_configs CASCADE;
DROP TABLE IF EXISTS whatsapp_instances CASCADE;

-- Tabela principal de conversas ativas
CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    instance_id VARCHAR(50) NOT NULL,
    flow_id VARCHAR(100) DEFAULT 'fluxo_principal', -- Identificador do fluxo N8N
    current_step VARCHAR(100) DEFAULT 'start', -- Posição atual no fluxo
    status VARCHAR(20) DEFAULT 'ativo', -- ativo, aguardando, finalizado, pausado
    first_message TEXT, -- Primeira mensagem do lead
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    timeout_at TIMESTAMP -- Quando expira (24h)
);

-- Índices para performance da tabela conversations
CREATE INDEX idx_conversations_phone ON conversations(phone_number);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_conversations_timeout ON conversations(timeout_at);
CREATE INDEX idx_conversations_instance ON conversations(instance_id);

-- Tabela de histórico de mensagens (opcional, para debug)
CREATE TABLE message_history (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id),
    direction VARCHAR(10), -- 'in' ou 'out'
    content TEXT,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_conversation (conversation_id),
    INDEX idx_sent_at (sent_at)
);

-- Tabela de configuração de fluxos
CREATE TABLE flow_configs (
    id SERIAL PRIMARY KEY,
    flow_name VARCHAR(100) UNIQUE NOT NULL,
    n8n_webhook_url TEXT NOT NULL,
    instance_pool JSON, -- Array de instâncias disponíveis para este fluxo
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_flow_name (flow_name),
    INDEX idx_active (is_active)
);

-- Tabela de instâncias WhatsApp
CREATE TABLE whatsapp_instances (
    id SERIAL PRIMARY KEY,
    instance_name VARCHAR(50) UNIQUE NOT NULL,
    instance_id VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT 'online', -- online, offline, busy
    current_conversations INTEGER DEFAULT 0,
    max_conversations INTEGER DEFAULT 50,
    last_ping TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_status (status),
    INDEX idx_conversations (current_conversations)
);

-- Função para limpar conversas expiradas
CREATE OR REPLACE FUNCTION cleanup_expired_conversations() 
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM conversations 
    WHERE timeout_at < NOW() AND status IN ('aguardando', 'ativo');
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Trigger para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_conversations_updated_at 
    BEFORE UPDATE ON conversations 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Inserir instâncias padrão (baseado no seu código atual)
INSERT INTO whatsapp_instances (instance_name, instance_id) VALUES
('G01', '584F8ACCAA48-488D-A26E-E75E1A5B2994'),
('G02', '2E2C41AB88F9-4356-B866-9ADA88530FD0'),
('G03', '9AFECAC9683B-4611-8C51-933447B70905'),
('G04', 'C974682BB258-4756-98F0-CF6D90FC2755'),
('G05', '118E0162F12C-4841-ADD6-33E11DDB341A'),
('G08', 'A63C380B277D-4A5E-9ECD-48710291E5A6'),
('G10', 'D6932E02E658-40BD-9784-8932841CCFA4'),
('G11', 'A1A28E54D712-41B9-A682-A49072EA2C0B'),
('G12', '86A4086DE74E-490B-B116-FF6F8B740EB1');

-- Configuração de fluxo padrão
INSERT INTO flow_configs (flow_name, n8n_webhook_url, instance_pool) VALUES
('fluxo_principal', 'https://n8n.flowzap.fun/webhook/checkpoint', 
 '["G01", "G02", "G03", "G04", "G05", "G08", "G10", "G11", "G12"]');

-- Views úteis para monitoramento
CREATE VIEW active_conversations_summary AS
SELECT 
    status,
    COUNT(*) as count,
    COUNT(*) FILTER (WHERE timeout_at < NOW()) as expired_count
FROM conversations 
GROUP BY status;

CREATE VIEW instance_load AS
SELECT 
    wi.instance_name,
    wi.status,
    wi.current_conversations,
    wi.max_conversations,
    ROUND((wi.current_conversations::FLOAT / wi.max_conversations) * 100, 2) as load_percentage
FROM whatsapp_instances wi
ORDER BY load_percentage DESC;
