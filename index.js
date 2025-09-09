const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { ConversationManager } = require('./database/config');

const app = express();
app.use(express.json());

// Configurações
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/checkpoint';
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'https://evo.flowzap.fun';

// Manager de conversas PostgreSQL
const conversationManager = new ConversationManager();

// Logs e estatísticas
let systemLogs = [];
let systemStats = {
    totalEvents: 0,
    successfulEvents: 0,
    failedEvents: 0,
    startTime: new Date()
};

// Função para adicionar logs
function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        brazilTime: getBrazilTime(),
        type: type,
        message: message,
        data: data
    };
    
    systemLogs.push(logEntry);
    console.log(`[${logEntry.brazilTime}] ${type.toUpperCase()}: ${message}`);
    
    // Limita logs em memória (mantém últimos 1000)
    if (systemLogs.length > 1000) {
        systemLogs = systemLogs.slice(-1000);
    }
}

// Função para obter data/hora em Brasília
function getBrazilTime() {
    return new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
}

// ========== WEBHOOK EVOLUTION MODIFICADO ==========
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.status(200).json({ success: true, message: 'Dados inválidos' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageContent = messageData.message?.conversation || '';
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        
        // Identificar instância
        const instanceName = data.instance || 'UNKNOWN';
        
        addLog('evolution_webhook', `Mensagem: ${clientNumber} | FromMe: ${fromMe} | Instância: ${instanceName}`);
        
        if (fromMe) {
            // MENSAGEM ENVIADA PELO SISTEMA - apenas log
            addLog('info', `📤 Sistema enviou mensagem para ${clientNumber} via ${instanceName}`);
            
            // Busca conversa para salvar no histórico
            const conversation = await conversationManager.getConversation(clientNumber);
            if (conversation) {
                await conversationManager.saveMessage(conversation.id, 'out', messageContent);
            }
            
        } else {
            // MENSAGEM RECEBIDA DO CLIENTE
            addLog('info', `📥 Mensagem recebida de ${clientNumber}: "${messageContent.substring(0, 50)}..."`);
            
            // Verifica se lead já existe na base
            const existingConversation = await conversationManager.checkExistingLead(clientNumber);
            
            if (!existingConversation) {
                // LEAD NOVO - INICIA FLUXO
                addLog('info', `🆕 LEAD NOVO detectado: ${clientNumber}`);
                
                // Busca instância disponível
                const availableInstance = await conversationManager.getAvailableInstance();
                if (!availableInstance) {
                    addLog('error', `❌ Nenhuma instância disponível para ${clientNumber}`);
                    return res.status(200).json({ success: false, message: 'Sem instâncias disponíveis' });
                }
                
                // Cria nova conversa
                const newConversation = await conversationManager.createNewConversation(
                    clientNumber,
                    messageContent,
                    availableInstance.instance_name
                );
                
                addLog('info', `✅ Nova conversa criada: ${clientNumber} → ${availableInstance.instance_name}`);
                
                // Salva primeira mensagem do lead
                await conversationManager.saveMessage(newConversation.id, 'in', messageContent);
                
                // INICIA FLUXO NO N8N
                const eventData = {
                    event_type: 'new_lead',
                    phone_number: clientNumber,
                    instance: availableInstance.instance_name,
                    first_message: messageContent,
                    conversation_id: newConversation.id,
                    step: 'start',
                    timestamp: new Date().toISOString(),
                    brazil_time: getBrazilTime()
                };
                
                const sendResult = await sendToN8N(eventData, 'new_lead');
                
                if (sendResult.success) {
                    addLog('info', `🚀 Fluxo iniciado para ${clientNumber}`);
                    systemStats.successfulEvents++;
                } else {
                    addLog('error', `❌ Erro ao iniciar fluxo para ${clientNumber}: ${sendResult.error}`);
                    systemStats.failedEvents++;
                }
                
            } else {
                // LEAD EXISTENTE
                if (existingConversation.status === 'aguardando') {
                    // RESPOSTA PARA CHECKPOINT
                    addLog('info', `📩 RESPOSTA recebida de ${clientNumber} (estava aguardando)`);
                    
                    // Atualiza status para ativo
                    await conversationManager.updateConversationStatus(
                        clientNumber, 
                        'ativo', 
                        existingConversation.current_step
                    );
                    
                    // Salva resposta do lead
                    await conversationManager.saveMessage(existingConversation.id, 'in', messageContent);
                    
                    // CONTINUA FLUXO NO N8N
                    const eventData = {
                        event_type: 'lead_response',
                        phone_number: clientNumber,
                        instance: existingConversation.instance_id,
                        response_message: messageContent,
                        conversation_id: existingConversation.id,
                        current_step: existingConversation.current_step,
                        timestamp: new Date().toISOString(),
                        brazil_time: getBrazilTime()
                    };
                    
                    const sendResult = await sendToN8N(eventData, 'lead_response');
                    
                    if (sendResult.success) {
                        addLog('info', `✅ Fluxo continuado para ${clientNumber}`);
                        systemStats.successfulEvents++;
                    } else {
                        addLog('error', `❌ Erro ao continuar fluxo para ${clientNumber}: ${sendResult.error}`);
                        systemStats.failedEvents++;
                    }
                    
                } else {
                    // Lead já existe mas não está aguardando resposta
                    addLog('info', `⚠️ Mensagem ignorada de ${clientNumber} (status: ${existingConversation.status})`);
                }
            }
        }
        
        systemStats.totalEvents++;
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook Evolution processado',
            client_number: clientNumber,
            status: existingConversation?.status || 'new'
        });
        
    } catch (error) {
        addLog('error', `❌ ERRO Evolution webhook: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== WEBHOOK N8N PARA CHECKPOINTS ==========
app.post('/webhook/checkpoint', async (req, res) => {
    try {
        const data = req.body;
        
        // Dados esperados do N8N:
        // {
        //   phone_number: "5511999999999",
        //   action: "pause" | "continue" | "finish",
        //   step: "step_1", "step_2", etc,
        //   message_to_send: "Texto da mensagem" (opcional)
        // }
        
        const { phone_number, action, step, message_to_send } = data;
        
        if (!phone_number || !action) {
            return res.status(400).json({ success: false, error: 'phone_number e action são obrigatórios' });
        }
        
        addLog('n8n_checkpoint', `N8N requisição: ${phone_number} | Ação: ${action} | Step: ${step}`);
        
        const conversation = await conversationManager.getConversation(phone_number);
        if (!conversation) {
            addLog('warning', `⚠️ Conversa não encontrada para ${phone_number}`);
            return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
        }
        
        switch (action) {
            case 'pause':
                // PAUSAR FLUXO - AGUARDAR RESPOSTA
                await conversationManager.updateConversationStatus(phone_number, 'aguardando', step);
                addLog('info', `⏸️ Fluxo pausado para ${phone_number} no step ${step}`);
                
                // Se tem mensagem para enviar antes de pausar
                if (message_to_send) {
                    const sendResult = await sendMessageToWhatsApp(
                        phone_number, 
                        message_to_send, 
                        conversation.instance_id
                    );
                    
                    if (sendResult.success) {
                        await conversationManager.saveMessage(conversation.id, 'out', message_to_send);
                        addLog('info', `✅ Mensagem enviada e fluxo pausado para ${phone_number}`);
                    } else {
                        addLog('error', `❌ Erro ao enviar mensagem para ${phone_number}: ${sendResult.error}`);
                    }
                }
                break;
                
            case 'continue':
                // CONTINUAR FLUXO
                await conversationManager.updateConversationStatus(phone_number, 'ativo', step);
                addLog('info', `▶️ Fluxo continuado para ${phone_number} no step ${step}`);
                
                if (message_to_send) {
                    const sendResult = await sendMessageToWhatsApp(
                        phone_number, 
                        message_to_send, 
                        conversation.instance_id
                    );
                    
                    if (sendResult.success) {
                        await conversationManager.saveMessage(conversation.id, 'out', message_to_send);
                    }
                }
                break;
                
            case 'finish':
                // FINALIZAR FLUXO
                await conversationManager.finalizeConversation(phone_number);
                addLog('info', `🏁 Fluxo finalizado para ${phone_number}`);
                
                if (message_to_send) {
                    const sendResult = await sendMessageToWhatsApp(
                        phone_number, 
                        message_to_send, 
                        conversation.instance_id
                    );
                    
                    if (sendResult.success) {
                        await conversationManager.saveMessage(conversation.id, 'out', message_to_send);
                    }
                }
                break;
                
            default:
                return res.status(400).json({ success: false, error: 'Ação inválida' });
        }
        
        res.status(200).json({ 
            success: true, 
            action: action,
            phone_number: phone_number,
            step: step
        });
        
    } catch (error) {
        addLog('error', `❌ ERRO N8N checkpoint: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== FUNÇÕES AUXILIARES ==========

// Função para enviar dados para N8N
async function sendToN8N(eventData, eventType) {
    try {
        addLog('info', `🚀 Enviando para N8N: ${eventType}`);
        
        const response = await axios.post(N8N_WEBHOOK_URL, eventData, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Webhook-Cerebro-Checkpoint/1.0'
            },
            timeout: 15000
        });
        
        addLog('webhook_sent', `✅ Enviado para N8N: ${eventType} | Status: ${response.status}`);
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        const errorMessage = error.response ? 
            `HTTP ${error.response.status}: ${error.response.statusText}` : 
            error.message;
            
        addLog('error', `❌ ERRO N8N: ${eventType} | ${errorMessage}`);
        return { success: false, error: errorMessage };
    }
}

// Função para enviar mensagem via Evolution API
async function sendMessageToWhatsApp(phoneNumber, message, instanceName) {
    try {
        // Busca ID da instância
        const instance = await conversationManager.pool.query(
            'SELECT instance_id FROM whatsapp_instances WHERE instance_name = $1',
            [instanceName]
        );
        
        if (instance.rows.length === 0) {
            throw new Error(`Instância ${instanceName} não encontrada`);
        }
        
        const instanceId = instance.rows[0].instance_id;
        const url = `${EVOLUTION_API_URL}/message/sendText/${instanceId}`;
        
        const payload = {
            number: phoneNumber,
            text: message
        };
        
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': instanceId
            },
            timeout: 10000
        });
        
        addLog('message_sent', `📤 Mensagem enviada: ${phoneNumber} via ${instanceName}`);
        return { success: true, response: response.data };
        
    } catch (error) {
        addLog('error', `❌ Erro ao enviar mensagem: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// ========== ENDPOINTS DE MONITORAMENTO ==========

// Status do sistema
app.get('/status', async (req, res) => {
    try {
        const stats = await conversationManager.getSystemStats();
        const dbTest = await conversationManager.testConnection();
        
        res.json({
            system_status: 'online',
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime(),
            uptime: process.uptime(),
            database: dbTest,
            conversation_stats: stats.conversations,
            instance_stats: stats.instances,
            system_stats: systemStats,
            n8n_webhook_url: N8N_WEBHOOK_URL,
            evolution_api_url: EVOLUTION_API_URL
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Conversas ativas
app.get('/conversations', async (req, res) => {
    try {
        const waiting = await conversationManager.getConversationsWaitingResponse();
        const stats = await conversationManager.getSystemStats();
        
        res.json({
            waiting_response: waiting,
            stats: stats.conversations,
            brazil_time: getBrazilTime()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Logs do sistema
app.get('/logs', (req, res) => {
    const { limit = 100 } = req.query;
    res.json({
        logs: systemLogs.slice(-parseInt(limit)),
        total: systemLogs.length,
        brazil_time: getBrazilTime()
    });
});

// ========== JOBS DE LIMPEZA ==========

// Limpar conversas expiradas a cada 10 minutos
cron.schedule('*/10 * * * *', async () => {
    try {
        const cleaned = await conversationManager.cleanupExpiredConversations();
        if (cleaned > 0) {
            addLog('cleanup', `🗑️ ${cleaned} conversas expiradas removidas`);
        }
    } catch (error) {
        addLog('error', `❌ Erro na limpeza: ${error.message}`);
    }
});

// Health check
app.get('/health', async (req, res) => {
    const dbTest = await conversationManager.testConnection();
    res.json({
        status: 'online',
        database: dbTest.success ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
        brazil_time: getBrazilTime()
    });
});

// Página principal
app.get('/', (req, res) => {
    res.send(`
        <h1>🧠 Sistema de Checkpoints WhatsApp</h1>
        <p><strong>Status:</strong> Online</p>
        <p><strong>Horário:</strong> ${getBrazilTime()}</p>
        <hr>
        <h3>Endpoints:</h3>
        <ul>
            <li><a href="/status">📊 Status do Sistema</a></li>
            <li><a href="/conversations">💬 Conversas Ativas</a></li>
            <li><a href="/logs">📋 Logs</a></li>
            <li><a href="/health">❤️ Health Check</a></li>
        </ul>
        <hr>
        <h3>Webhooks:</h3>
        <ul>
            <li><strong>Evolution:</strong> POST /webhook/evolution</li>
            <li><strong>N8N Checkpoint:</strong> POST /webhook/checkpoint</li>
        </ul>
    `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    addLog('info', `🧠 SISTEMA DE CHECKPOINTS iniciado na porta ${PORT}`);
    addLog('info', `📱 Webhook Evolution: http://localhost:${PORT}/webhook/evolution`);
    addLog('info', `🎯 Webhook N8N: http://localhost:${PORT}/webhook/checkpoint`);
    addLog('info', `🖥️ Dashboard: http://localhost:${PORT}`);
    addLog('info', `⏰ Horário: ${getBrazilTime()}`);
    
    // Testa conexão com banco
    const dbTest = await conversationManager.testConnection();
    if (dbTest.success) {
        addLog('info', `✅ PostgreSQL conectado: ${dbTest.timestamp}`);
    } else {
        addLog('error', `❌ Erro PostgreSQL: ${dbTest.error}`);
    }
    
    console.log(`\n🧠 SISTEMA DE CHECKPOINTS WHATSAPP ATIVO`);
    console.log(`================================================================================`);
    console.log(`📱 Webhook Evolution: http://localhost:${PORT}/webhook/evolution`);
    console.log(`🎯 Webhook N8N: http://localhost:${PORT}/webhook/checkpoint`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🗄️ PostgreSQL: ${dbTest.success ? 'Conectado' : 'Erro'}`);
    console.log(`⏰ Horário: ${getBrazilTime()}`);
    console.log(`================================================================================\n`);
});
