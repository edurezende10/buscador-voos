require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Redis = require('ioredis');
const express = require('express');

puppeteer.use(StealthPlugin());

// ==================================================================
// 1. CONFIGURAÇÕES E PERMISSÕES
// ==================================================================
const app = express();
const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TELEGRAM_TOKEN;

// Carrega permissões do JSON
let GRUPOS = {};
try {
    GRUPOS = JSON.parse(process.env.TELEGRAM_CONFIG_JSON || '{}');
} catch (error) {
    console.error("❌ ERRO: JSON de configuração inválido no .env");
    GRUPOS = {};
}
const ADMINS = Object.keys(GRUPOS);
const userSessions = {};

// ==================================================================
// 2. CONEXÃO REDIS
// ==================================================================
const redis = new Redis(process.env.REDIS_URL, {
    tls: { rejectUnauthorized: false },
    family: 4,
    maxRetriesPerRequest: 3
});
redis.on('error', (err) => console.error('❌ Redis:', err.message));
redis.on('connect', () => console.log('✅ Conectado ao Redis!'));

const bot = new TelegramBot(TG_TOKEN, { polling: true });

// ==================================================================
// 3. MENU E FLUXO (MANTIDO IGUAL)
// ==================================================================
const MAIN_KEYBOARD = {
    keyboard: [
        [{ text: '✈️ Nova Viagem' }, { text: '📋 Minhas Viagens' }],
        [{ text: '❓ Ajuda' }, { text: '❌ Cancelar' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
};

bot.onText(/\/(start|menu)/, (msg) => {
    if (!verificarPermissao(msg.chat.id)) return;
    mostrarMenuPrincipal(msg.chat.id);
});

function mostrarMenuPrincipal(chatId) {
    delete userSessions[chatId];
    bot.sendMessage(chatId, "🤖 *Painel de Controle*\nEscolha uma opção abaixo:", {
        parse_mode: 'Markdown',
        reply_markup: MAIN_KEYBOARD
    });
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const texto = msg.text;

    if (!texto || texto.startsWith('/')) return;
    if (!verificarPermissao(chatId)) return;

    if (texto === '✈️ Nova Viagem') {
        userSessions[chatId] = { step: 'AGUARDANDO_ORIGEM', dados: {} };
        return bot.sendMessage(chatId, "✈️ *Nova Viagem*\n\nQual a sigla da **ORIGEM**? (ex: GRU)", {
            parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '❌ Cancelar' }]], resize_keyboard: true }
        });
    }
    if (texto === '📋 Minhas Viagens') return listarViagensComBotoes(chatId);
    if (texto === '❌ Cancelar') return mostrarMenuPrincipal(chatId);
    if (texto === '❓ Ajuda') return bot.sendMessage(chatId, "💡 *Ajuda*\n\nEu monitoro preços no Google Flights.", { parse_mode: 'Markdown' });

    if (userSessions[chatId]) {
        const session = userSessions[chatId];
        if (session.step === 'AGUARDANDO_ORIGEM') {
            if (texto.length !== 3) return bot.sendMessage(chatId, "⚠️ Sigla inválida (3 letras).");
            session.dados.origem = texto.toUpperCase();
            session.step = 'AGUARDANDO_DESTINO';
            bot.sendMessage(chatId, `✅ Origem: ${session.dados.origem}\n\nQual o **DESTINO**?`);
        } else if (session.step === 'AGUARDANDO_DESTINO') {
            if (texto.length !== 3) return bot.sendMessage(chatId, "⚠️ Sigla inválida (3 letras).");
            session.dados.destino = texto.toUpperCase();
            session.step = 'AGUARDANDO_IDA';
            bot.sendMessage(chatId, `✅ Destino: ${session.dados.destino}\n\nQual a data de **IDA**? (AAAA-MM-DD)`);
        } else if (session.step === 'AGUARDANDO_IDA') {
            if (!validarData(texto)) return bot.sendMessage(chatId, "⚠️ Data inválida (AAAA-MM-DD).");
            session.dados.ida = texto;
            session.step = 'AGUARDANDO_VOLTA';
            bot.sendMessage(chatId, `✅ Ida: ${texto}\n\nQual a data de **VOLTA**?`);
        } else if (session.step === 'AGUARDANDO_VOLTA') {
            if (!validarData(texto)) return bot.sendMessage(chatId, "⚠️ Data inválida.");
            session.dados.volta = texto;
            await finalizarCadastro(chatId, session);
        }
        return;
    }
    mostrarMenuPrincipal(chatId);
});

bot.on('callback_query', async (callback) => {
    const chatId = callback.message.chat.id.toString();
    const data = callback.data;
    bot.answerCallbackQuery(callback.id);

    if (data.startsWith('btn_apagar_')) {
        const index = parseInt(data.split('_')[2]);
        await apagarViagem(chatId, index);
    } else if (data.startsWith('btn_editar_')) {
        const index = parseInt(data.split('_')[2]);
        userSessions[chatId] = { step: 'AGUARDANDO_ORIGEM', dados: {}, editandoIndex: index };
        bot.sendMessage(chatId, "✏️ *Editando*\n\nQual a nova **ORIGEM**?", {
            parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '❌ Cancelar' }]], resize_keyboard: true }
        });
    }
});

// Funções Auxiliares
function verificarPermissao(chatId) { return ADMINS.includes(chatId.toString()); }
function validarData(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }

async function finalizarCadastro(chatId, session) {
    const { origem, destino, ida, volta } = session.dados;
    const rotaId = `${origem}_${destino}_${Date.now()}`;
    const novaRota = { id: rotaId, dono: chatId, origem, destino, ida, volta, ativo: true };
    let rotas = JSON.parse(await redis.get('banco_rotas') || '[]');

    if (session.editandoIndex !== undefined) {
        const meusIndices = rotas.map((r, i) => r.dono === chatId ? i : -1).filter(i => i !== -1);
        const indiceReal = meusIndices[session.editandoIndex];
        if (indiceReal !== undefined) {
            let historico = JSON.parse(await redis.get('historico_precos') || '{}');
            delete historico[rotas[indiceReal].id];
            await redis.set('historico_precos', JSON.stringify(historico));
            rotas[indiceReal] = novaRota;
            bot.sendMessage(chatId, "🔄 Atualizado!", { reply_markup: MAIN_KEYBOARD });
        }
    } else {
        rotas.push(novaRota);
        bot.sendMessage(chatId, "💾 Salvo!", { reply_markup: MAIN_KEYBOARD });
    }
    await redis.set('banco_rotas', JSON.stringify(rotas));
    delete userSessions[chatId];
}

async function listarViagensComBotoes(chatId) {
    const rotas = JSON.parse(await redis.get('banco_rotas') || '[]');
    const minhasRotas = rotas.filter(r => r.dono === chatId);
    if (minhasRotas.length === 0) return bot.sendMessage(chatId, "📭 Nada cadastrado.", { reply_markup: MAIN_KEYBOARD });
    bot.sendMessage(chatId, "📋 *Suas Viagens:*", { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD });
    for (let i = 0; i < minhasRotas.length; i++) {
        const r = minhasRotas[i];
        await bot.sendMessage(chatId, `✈️ *${r.origem} ➡️ ${r.destino}*\n📅 ${r.ida} a ${r.volta}`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '✏️ Editar', callback_data: `btn_editar_${i}` }, { text: '🗑️ Apagar', callback_data: `btn_apagar_${i}` }]]
            }
        });
        await new Promise(r => setTimeout(r, 200));
    }
}

async function apagarViagem(chatId, index) {
    let rotas = JSON.parse(await redis.get('banco_rotas') || '[]');
    const meusIndices = rotas.map((r, i) => r.dono === chatId ? i : -1).filter(i => i !== -1);
    if (index >= 0 && index < meusIndices.length) {
        const [removida] = rotas.splice(meusIndices[index], 1);
        await redis.set('banco_rotas', JSON.stringify(rotas));
        let historico = JSON.parse(await redis.get('historico_precos') || '{}');
        delete historico[removida.id];
        await redis.set('historico_precos', JSON.stringify(historico));
        bot.sendMessage(chatId, "🗑️ Apagada.");
        listarViagensComBotoes(chatId);
    }
}

// ==================================================================
// 6. MONITORAMENTO ORACLE ARM (CHROMIUM)
// ==================================================================
async function monitorarViagens() {
    console.log('🚀 Iniciando monitoramento...');
    let rotas = [];
    try {
        const dados = await redis.get('banco_rotas');
        rotas = JSON.parse(dados || '[]');
    } catch (e) { return console.error('❌ Redis:', e.message); }

    if (rotas.length === 0) return console.log('💤 Banco vazio.');

    // CONFIGURAÇÃO ESPECÍFICA PARA ORACLE/DOCKER
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Vital para Docker/VPS
            '--disable-gpu',
            '--no-first-run'
        ],
        // Prioriza a variável de ambiente (definida no Dockerfile)
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });

    let dbPrecos = JSON.parse(await redis.get('historico_precos') || '{}');

    try {
        const page = await browser.newPage();
        // User Agent para enganar o Google
        await page.setUserAgent('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36');

        for (const rota of rotas) {
            console.log(`🔎 ${rota.origem}->${rota.destino}`);
            const url = `https://www.google.com/travel/flights?q=Flights%20to%20${rota.destino}%20from%20${rota.origem}%20on%20${rota.ida}%20through%20${rota.volta}&curr=BRL&hl=pt-BR`;

            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

                const resultado = await page.evaluate(() => {
                    const card = document.querySelector('[role="main"] li');
                    if (!card) return null;
                    const texto = card.innerText;
                    const precoMatch = texto.match(/R\$\s?([\d.,]+)/);
                    const cia = texto.split('\n').find(l => l.length > 2 && !l.includes('R$') && !l.match(/\d+:\d+/)) || 'Cia Desconhecida';
                    return { precoTexto: precoMatch ? precoMatch[0] : null, cia };
                });

                if (resultado && resultado.precoTexto) {
                    const precoAtual = parseFloat(resultado.precoTexto.replace(/[^\d,]/g, '').replace(',', '.'));
                    console.log(`💰 R$ ${precoAtual}`);

                    const precoAntigo = dbPrecos[rota.id] || Infinity;
                    let notificar = false, titulo = "";

                    if (!dbPrecos[rota.id]) {
                        notificar = true; titulo = "🆕 *Monitor Iniciado*"; dbPrecos[rota.id] = precoAtual;
                    } else if (precoAtual < precoAntigo) {
                        notificar = true; titulo = `📉 *BAIXOU! R$ ${(precoAntigo - precoAtual).toFixed(2)} a menos*`; dbPrecos[rota.id] = precoAtual;
                    } else if (precoAtual > precoAntigo) dbPrecos[rota.id] = precoAtual;

                    if (notificar) {
                        let msg = `${titulo}\n\n✈️ ${rota.origem} ➡️ ${rota.destino}\n📅 ${rota.ida} a ${rota.volta}\n💰 *R$ ${precoAtual}*\n🏢 ${resultado.cia}\n🔗 [Ver no Google](${url})`;
                        const destinatarios = GRUPOS[rota.dono] || [rota.dono];
                        for (const id of destinatarios) try { await bot.sendMessage(id, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }); } catch (e) { }
                    }
                } else {
                    console.log('⚠️ Preço não encontrado.');
                }
                await new Promise(r => setTimeout(r, 4000));
            } catch (erroRota) { console.error(`Erro Rota: ${erroRota.message}`); }
        }
        await redis.set('historico_precos', JSON.stringify(dbPrecos));
    } catch (error) { console.error('Erro Geral:', error); }
    finally { if (browser) await browser.close(); console.log('🏁 Fim.'); }
}

app.get('/', (req, res) => res.send('🤖 Bot Oracle ARM Ativo.'));
app.get('/rodar', async (req, res) => { res.send('Rodando...'); monitorarViagens(); });
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));