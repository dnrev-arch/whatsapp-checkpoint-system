// database/config.js
const { Pool } = require('pg');
require('dotenv').config();

// Configuração do Pool PostgreSQL
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'whatsapp_checkpoints',
    password: process.env.DB_PASSWORD || 'senha123',
    port: process.env.DB_PORT || 5432,
    max: 20, // máximo de conexões no pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Classe para gerenciar conversas
class ConversationManager {
    constructor() {
        this.pool = pool;
    }

    // Verifica se lead já existe na base
    async checkExistingLead(phoneNumber) {
        const normalizedPhone = this.normalizePhone(phoneNumber);
        
        const query = `
            SELECT id, phone_number, instance_id, flow_id, current_step, status, timeout_at
            FROM conversations 
            WHERE phone_number = $1 
            AND status IN ('ativo', 'aguardando')
            AND timeout_at > NOW()
        `;
        
        const result = await this.pool.query(query, [normalizedPhone]);
        return result.rows[0] || null;
    }

    // Cria nova conversa para lead
    async createNewConversation(phoneNumber, firstMessage, instanceId, flowId = 'fluxo_principal') {
        const normalizedPhone = this.normalizePhone(phoneNumber);
        const timeoutAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
        
        const query = `
            INSERT INTO conversations (phone_number, instance_id, flow_id, current_step, status, first_message, timeout_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `;
        
        const result = await this.pool.query(query, [
            normalizedPhone,
            instanceId,
            flowId,
            'start',
            'ativo',
            firstMessage,
            timeoutAt
        ]);
        
        // Atualiza contador da instância
        await this.updateInstanceCounter(instanceId, 1);
        
        return result.rows[0];
    }

    // Atualiza status da conversa
    async updateConversationStatus(phoneNumber, status, currentStep = null) {
        const normalizedPhone = this.normalizePhone(phoneNumber);
        
        let query = 'UPDATE conversations SET status = $1, updated_at = NOW()';
        let params = [status, normalizedPhone];
        
        if (currentStep) {
            query += ', current_step = $3';
            params.splice(1, 0, currentStep);
        }
        
        query += ' WHERE phone_number = $' + params.length + ' RETURNING *';
        
        const result = await this.pool.query(query, params);
        return result.rows[0];
    }

    // Busca conversa por telefone
    async getConversation(phoneNumber) {
        const normalizedPhone = this.normalizePhone(phoneNumber);
        
        const query = `
            SELECT * FROM conversations 
            WHERE phone_number = $1 
            AND status IN ('ativo', 'aguardando')
            ORDER BY updated_at DESC 
            LIMIT 1
        `;
        
        const result = await this.pool.query(query, [normalizedPhone]);
        return result.rows[0] || null;
    }

    // Finaliza conversa
    async finalizeConversation(phoneNumber) {
        const conversation = await this.getConversation(phoneNumber);
        if (conversation) {
            await this.updateConversationStatus(phoneNumber, 'finalizado');
            await this.updateInstanceCounter(conversation.instance_id, -1);
        }
    }

    // Busca instância com menor carga
    async getAvailableInstance(flowId = 'fluxo_principal') {
        const query = `
            SELECT wi.instance_name, wi.instance_id, wi.current_conversations, wi.max_conversations
            FROM whatsapp_instances wi
            JOIN flow_configs fc ON fc.flow_name = $1
            WHERE wi.status = 'online'
            AND wi.instance_name = ANY(fc.instance_pool::text[])
            AND wi.current_conversations < wi.max_conversations
            ORDER BY wi.current_conversations ASC
            LIMIT 1
        `;
        
        const result = await this.pool.query(query, [flowId]);
        return result.rows[0] || null;
    }

    // Atualiza contador de conversas da instância
    async updateInstanceCounter(instanceId, increment) {
        const query = `
            UPDATE whatsapp_instances 
            SET current_conversations = GREATEST(0, current_conversations + $1),
                last_ping = NOW()
            WHERE instance_name = $2 OR instance_id = $2
        `;
        
        await this.pool.query(query, [increment, instanceId]);
    }

    // Salva mensagem no histórico
    async saveMessage(conversationId, direction, content) {
        const query = `
            INSERT INTO message_history (conversation_id, direction, content)
            VALUES ($1, $2, $3)
        `;
        
        await this.pool.query(query, [conversationId, direction, content]);
    }

    // Busca conversas aguardando resposta
    async getConversationsWaitingResponse() {
        const query = `
            SELECT c.*, wi.instance_name
            FROM conversations c
            JOIN whatsapp_instances wi ON wi.instance_name = c.instance_id
            WHERE c.status = 'aguardando'
            AND c.timeout_at > NOW()
            ORDER BY c.updated_at ASC
        `;
        
        const result = await this.pool.query(query);
        return result.rows;
    }

    // Limpa conversas expiradas
    async cleanupExpiredConversations() {
        const query = 'SELECT cleanup_expired_conversations()';
        const result = await this.pool.query(query);
        return result.rows[0].cleanup_expired_conversations;
    }

    // Estatísticas do sistema
    async getSystemStats() {
        const statsQuery = `
            SELECT 
                COUNT(*) FILTER (WHERE status = 'ativo') as ativo_count,
                COUNT(*) FILTER (WHERE status = 'aguardando') as aguardando_count,
                COUNT(*) FILTER (WHERE status = 'finalizado' AND updated_at > NOW() - INTERVAL '24 hours') as finalizados_24h,
                COUNT(*) FILTER (WHERE timeout_at < NOW() AND status IN ('ativo', 'aguardando')) as expirados
            FROM conversations
        `;
        
        const instanceQuery = `
            SELECT instance_name, current_conversations, max_conversations, status
            FROM whatsapp_instances
            ORDER BY current_conversations DESC
        `;
        
        const [stats, instances] = await Promise.all([
            this.pool.query(statsQuery),
            this.pool.query(instanceQuery)
        ]);
        
        return {
            conversations: stats.rows[0],
            instances: instances.rows
        };
    }

    // Normaliza número de telefone
    normalizePhone(phone) {
        // Remove tudo que não é número
        let cleaned = phone.replace(/\D/g, '');
        
        // Se começa com 55 (Brasil)
        if (cleaned.startsWith('55')) {
            // Pega DDD (posições 2-3 ou 2-4 dependendo do caso)
            const withoutCountry = cleaned.substring(2);
            
            // Se tem 11 dígitos (DDD + 9 + número)
            if (withoutCountry.length === 11) {
                const ddd = withoutCountry.substring(0, 2);
                const rest = withoutCountry.substring(2);
                
                // Se o resto começa com 9 e tem 9 dígitos, remove o 9
                if (rest.startsWith('9') && rest.length === 9) {
                    cleaned = '55' + ddd + rest.substring(1);
                }
            }
        }
        
        return cleaned;
    }

    // Testa conexão do banco
    async testConnection() {
        try {
            const result = await this.pool.query('SELECT NOW()');
            return { success: true, timestamp: result.rows[0].now };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Fecha pool de conexões
    async close() {
        await this.pool.end();
    }
}

module.exports = {
    pool,
    ConversationManager
};
