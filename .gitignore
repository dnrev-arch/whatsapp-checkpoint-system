const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuração do PostgreSQL
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
});

async function setupDatabase() {
    console.log('🗄️ Configurando banco de dados...');
    
    try {
        // Testa conexão
        console.log('📡 Testando conexão com PostgreSQL...');
        const testResult = await pool.query('SELECT NOW()');
        console.log(`✅ Conectado ao PostgreSQL: ${testResult.rows[0].now}`);
        
        // Lê e executa o schema SQL
        console.log('📋 Executando schema SQL...');
        const schemaPath = path.join(__dirname, '../database/schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        
        // Executa schema
        await pool.query(schemaSql);
        console.log('✅ Schema criado com sucesso!');
        
        // Insere dados padrão
        console.log('🔧 Inserindo dados padrão...');
        
        // Instâncias WhatsApp (baseado no seu código original)
        const instancesQuery = `
            INSERT INTO whatsapp_instances (instance_name, instance_id, status, max_conversations) VALUES
            ('G01', '584F8ACCAA48-488D-A26E-E75E1A5B2994', 'online', 50),
            ('G02', '2E2C41AB88F9-4356-B866-9ADA88530FD0', 'online', 50),
            ('G03', '9AFECAC9683B-4611-8C51-933447B70905', 'online', 50),
            ('G04', 'C974682BB258-4756-98F0-CF6D90FC2755', 'online', 50),
            ('G05', '118E0162F12C-4841-ADD6-33E11DDB341A', 'online', 50),
            ('G08', 'A63C380B277D-4A5E-9ECD-48710291E5A6', 'online', 50),
            ('G10', 'D6932E02E658-40BD-9784-8932841CCFA4', 'online', 50),
            ('G11', 'A1A28E54D712-41B9-A682-A49072EA2C0B', 'online', 50),
            ('G12', '86A4086DE74E-490B-B116-FF6F8B740EB1', 'online', 50)
            ON CONFLICT (instance_name) DO NOTHING;
        `;
        
        await pool.query(instancesQuery);
        console.log('✅ Instâncias WhatsApp inseridas!');
        
        // Configuração de fluxo padrão
        const flowQuery = `
            INSERT INTO flow_configs (flow_name, n8n_webhook_url, instance_pool, is_active) VALUES
            ('fluxo_principal', $1, $2, true)
            ON CONFLICT (flow_name) DO UPDATE SET
                n8n_webhook_url = EXCLUDED.n8n_webhook_url,
                instance_pool = EXCLUDED.instance_pool;
        `;
        
        const instancePool = JSON.stringify(['G01', 'G02', 'G03', 'G04', 'G05', 'G08', 'G10', 'G11', 'G12']);
        
        await pool.query(flowQuery, [
            process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/checkpoint',
            instancePool
        ]);
        
        console.log('✅ Configuração de fluxo criada!');
        
        // Verifica dados inseridos
        const instanceCount = await pool.query('SELECT COUNT(*) FROM whatsapp_instances');
        const flowCount = await pool.query('SELECT COUNT(*) FROM flow_configs');
        
        console.log('\n📊 Resumo da instalação:');
        console.log(`   • ${instanceCount.rows[0].count} instâncias WhatsApp configuradas`);
        console.log(`   • ${flowCount.rows[0].count} fluxo(s) configurado(s)`);
        console.log(`   • Timeout de conversas: 24 horas`);
        console.log(`   • Sistema pronto para uso!\n`);
        
        console.log('🎉 Banco de dados configurado com sucesso!');
        console.log('💡 Para iniciar o sistema, execute: npm start');
        
    } catch (error) {
        console.error('❌ Erro ao configurar banco de dados:');
        console.error(error.message);
        
        if (error.code === 'ECONNREFUSED') {
            console.log('\n💡 Dicas para resolver:');
            console.log('   1. Verifique se o PostgreSQL está rodando');
            console.log('   2. Confirme as credenciais no arquivo .env');
            console.log('   3. Certifique-se que o banco existe');
        }
        
        process.exit(1);
    } finally {
        await pool.end();
    }
}

// Verifica se foi chamado com --reset
const resetMode = process.argv.includes('--reset');
if (resetMode) {
    console.log('⚠️ MODO RESET: Todas as tabelas serão recriadas!');
}

setupDatabase();
