require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const Redis = require('ioredis');
const express = require('express');

puppeteer.use(StealthPlugin());

// ==================================================================
// CONFIGURAÇÕES
// ==================================================================
const app = express();
const PORT = process.env.PORT || 3000;

const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const LISTA_IDS = process.env.TELEGRAM_CHAT_IDS ? process.env.TELEGRAM_CHAT_IDS.split(',') : [];

console.log('\n--- DIAGNÓSTICO DE AMBIENTE ---');
if (process.env.REDIS_URL) console.log('✅ REDIS_URL detectada.');
else console.error('❌ ERRO: REDIS_URL não encontrada.');
console.log('-------------------------------\n');

// Configuração Redis
const redis = new Redis(process.env.REDIS_URL, {
    tls: { rejectUnauthorized: false },
    family: 4,
    maxRetriesPerRequest: 3
});

redis.on('error', (err) => console.error('❌ Erro Redis:', err.message));
redis.on('connect', () => console.log('✅ Conectado ao Redis!'));

// ==================================================================
// ROTAS
// ==================================================================
const ROTAS = [
    {
        id: 'principal_gru_lim',
        nome: '✈️ Principal: SP ↔ Lima',
        origem: 'GRU',
        destino: 'LIM',
        ida: '2026-10-18',
        volta: '2026-10-25'
    },
    {
        id: 'amiga_for_gru',
        nome: '✈️ Amiga: Fortaleza ↔ GRU (Guarulhos)',
        origem: 'FOR',
        destino: 'GRU',
        ida: '2026-10-17',
        volta: '2026-10-26'
    },
    {
        id: 'amiga_for_cgh',
        nome: '✈️ Amiga: Fortaleza ↔ CGH (Congonhas)',
        origem: 'FOR',
        destino: 'CGH',
        ida: '2026-10-17',
        volta: '2026-10-26'
    },
    {
        id: 'interno_lim_cuz',
        nome: '🏔️ Turismo: Lima ↔ Cusco',
        origem: 'LIM',
        destino: 'CUZ',
        ida: '2026-10-20',
        volta: '2026-10-24'
    }
];

// ==================================================================
// FUNÇÕES
// ==================================================================
function limparPreco(texto) {
    if (!texto) return 0;
    const numeroLimpo = texto.replace(/[^\d,]/g, '').replace(',', '.');
    return parseFloat(numeroLimpo);
}

async function lerHistorico() {
    try {
        const dados = await redis.get('historico_precos');
        return dados ? JSON.parse(dados) : {};
    } catch (error) {
        return {};
    }
}

async function salvarHistorico(novoDados) {
    try {
        await redis.set('historico_precos', JSON.stringify(novoDados));
    } catch (error) {
        console.error('❌ Erro salvar Redis:', error.message);
    }
}

async function enviarParaTodos(mensagem) {
    if (!TG_TOKEN || LISTA_IDS.length === 0) return;
    for (const id of LISTA_IDS) {
        try {
            await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                chat_id: id.trim(),
                text: mensagem,
                parse_mode: 'Markdown',
                disable_web_page_preview: true 
            });
        } catch (e) { console.error(`Erro Telegram (${id}): ${e.message}`); }
    }
}

// ==================================================================
// PUPPETEER (CONFIGURAÇÃO BLINDADA)
// ==================================================================
async function monitorarViagens() {
    console.log('🚀 Iniciando monitoramento...');
    
    // --- MUDANÇAS CRÍTICAS AQUI ---
    const browser = await puppeteer.launch({ 
        headless: true, // Mudei de "new" para true (Mais estável em Docker)
        ignoreHTTPSErrors: true,
        dumpio: true, // Mostra logs do Chrome no terminal se der erro
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Usa disco em vez de memória RAM
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-audio-output',
            '--disable-extensions'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
    });
    
    let dbPrecos = await lerHistorico();
    
    try {
        const page = await browser.newPage();
        
        // Define tamanho de tela para garantir que o site carregue o layout desktop
        await page.setViewport({ width: 1280, height: 800 });

        for (const rota of ROTAS) {
            console.log(`\n🔎 Verificando: ${rota.nome}...`);
            const url = `https://www.google.com/travel/flights?q=Flights%20to%20${rota.destino}%20from%20${rota.origem}%20on%20${rota.ida}%20through%20${rota.volta}&curr=BRL&hl=pt-BR`;

            try {
                // Aumentei o timeout para 90s (Docker as vezes é lento)
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
                
                const resultado = await page.evaluate(() => {
                    const card = document.querySelector('[role="main"] li');
                    if (!card) return null;
                    const texto = card.innerText;
                    const preco = texto.split('\n').find(l => l.includes('R$'));
                    const cia = texto.split('\n').find(l => l.length > 2 && !l.includes('R$') && !l.match(/\d+:\d+/)) || 'Cia desc.';
                    return { precoTexto: preco, cia: cia };
                });

                if (!resultado || !resultado.precoTexto) {
                    console.log(`❌ Preço não encontrado para ${rota.nome}`);
                    continue;
                }

                const precoAtual = limparPreco(resultado.precoTexto);
                const precoAntigo = dbPrecos[rota.id] || Infinity;

                console.log(`💰 Atual: R$ ${precoAtual} | Antes: R$ ${precoAntigo === Infinity ? 'Novo' : precoAntigo}`);

                let notificar = false;
                let titulo = "";

                if (!dbPrecos[rota.id]) {
                    notificar = true;
                    titulo = `🆕 *Monitor Iniciado: ${rota.nome}*`;
                    dbPrecos[rota.id] = precoAtual;
                } 
                else if (precoAtual < precoAntigo) {
                    const economia = (precoAntigo - precoAtual).toFixed(2);
                    notificar = true;
                    titulo = `📉 *BAIXOU! Economia de R$ ${economia}*`;
                    dbPrecos[rota.id] = precoAtual;
                }
                else if (precoAtual > precoAntigo) {
                     console.log('📈 Subiu. Atualizando base.');
                     dbPrecos[rota.id] = precoAtual;
                }

                if (notificar) {
                    let msg = `${titulo}\n\n`;
                    msg += `✈️ Rota: ${rota.origem} ➡️ ${rota.destino}\n`;
                    msg += `📅 Data: ${rota.ida} a ${rota.volta}\n`;
                    msg += `💰 *Valor: R$ ${precoAtual}*\n`;
                    msg += `🏢 Cia: ${resultado.cia}\n`;
                    msg += `🔗 [Ver no Google](${url})`;
                    await enviarParaTodos(msg);
                }

                await salvarHistorico(dbPrecos);
                
            } catch (erroRota) {
                console.error(`Erro rota ${rota.nome}: ${erroRota.message}`);
            }
        }

    } catch (error) {
        console.error('Erro Fatal no Puppeteer:', error);
    } finally {
        // Tenta fechar o browser, mas ignora erro se já estiver fechado
        try { await browser.close(); } catch(e) {}
        console.log('\n🏁 Monitoramento finalizado.');
    }
}

// ==================================================================
// SERVER
// ==================================================================
app.get('/', (req, res) => res.send('🤖 Bot ONLINE. Use /rodar'));
app.get('/rodar', async (req, res) => {
    console.log('⚡ Comando /rodar recebido.');
    res.send('Execução iniciada em background.');
    monitorarViagens();
});
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});