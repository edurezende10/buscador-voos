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

// Carrega permissões do JSON (Estratégia de Espelho para Casais/Amigos)
let GRUPOS = {};
try {
    GRUPOS = JSON.parse(process.env.TELEGRAM_CONFIG_JSON || '{}');
} catch (error) {
    console.error("❌ ERRO: JSON de configuração inválido no .env");
    GRUPOS = {};
}
const ADMINS = Object.keys(GRUPOS);

// Estado da Sessão (Memória temporária da conversa)
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
// 3. MENU PRINCIPAL (TECLADO PERSISTENTE)
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

// ==================================================================
// 4. INTERATIVIDADE (ESCUTA TEXTO E BOTÕES)
// ==================================================================

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const texto = msg.text;

    if (!texto || texto.startsWith('/')) return;
    if (!verificarPermissao(chatId)) return;

    // --- A. BOTÕES DO MENU PRINCIPAL ---
    if (texto === '✈️ Nova Viagem') {
        userSessions[chatId] = { step: 'AGUARDANDO_ORIGEM', dados: {} };
        return bot.sendMessage(chatId, "✈️ *Nova Viagem*\n\nQual a sigla da **ORIGEM**? (ex: GRU)", {
            parse_mode: 'Markdown',
            reply_markup: { keyboard: [[{ text: '❌ Cancelar' }]], resize_keyboard: true }
        });
    }

    if (texto === '📋 Minhas Viagens') {
        return listarViagensComBotoes(chatId);
    }

    if (texto === '❌ Cancelar') {
        return mostrarMenuPrincipal(chatId);
    }

    if (texto === '❓ Ajuda') {
        return bot.sendMessage(chatId, "💡 *Ajuda*\n\nEu monitoro preços no Google Flights.\nCadastre uma rota e eu te aviso quando o preço baixar!", { parse_mode: 'Markdown' });
    }

    // --- B. FLUXO DE PERGUNTAS (CADASTRO) ---
    if (userSessions[chatId]) {
        const session = userSessions[chatId];

        if (session.step === 'AGUARDANDO_ORIGEM') {
            if (texto.length !== 3) return bot.sendMessage(chatId, "⚠️ Sigla inválida. Use 3 letras (Ex: GRU).");
            session.dados.origem = texto.toUpperCase();
            session.step = 'AGUARDANDO_DESTINO';
            bot.sendMessage(chatId, `✅ Origem: ${session.dados.origem}\n\nQual o **DESTINO**? (ex: MIA)`);
        }
        else if (session.step === 'AGUARDANDO_DESTINO') {
            if (texto.length !== 3) return bot.sendMessage(chatId, "⚠️ Sigla inválida. Use 3 letras (Ex: MIA).");
            session.dados.destino = texto.toUpperCase();
            session.step = 'AGUARDANDO_IDA';
            bot.sendMessage(chatId, `✅ Destino: ${session.dados.destino}\n\nQual a data de **IDA**? (AAAA-MM-DD)`);
        }
        else if (session.step === 'AGUARDANDO_IDA') {
            if (!validarData(texto)) return bot.sendMessage(chatId, "⚠️ Formato inválido. Use AAAA-MM-DD (ex: 2026-10-10).");
            session.dados.ida = texto;
            session.step = 'AGUARDANDO_VOLTA';
            bot.sendMessage(chatId, `✅ Ida: ${texto}\n\nQual a data de **VOLTA**? (AAAA-MM-DD)`);
        }
        else if (session.step === 'AGUARDANDO_VOLTA') {
            if (!validarData(texto)) return bot.sendMessage(chatId, "⚠️ Formato inválido. Use AAAA-MM-DD.");
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
    }
    else if (data.startsWith('btn_editar_')) {
        const index = parseInt(data.split('_')[2]);
        userSessions[chatId] = { step: 'AGUARDANDO_ORIGEM', dados: {}, editandoIndex: index };
        bot.sendMessage(chatId, "✏️ *Editando Viagem*\n\nQual a nova **ORIGEM**? (ex: GRU)", {
            parse_mode: 'Markdown',
            reply_markup: { keyboard: [[{ text: '❌ Cancelar' }]], resize_keyboard: true }
        });
    }
});

// ==================================================================
// 5. FUNÇÕES AUXILIARES
// ==================================================================

function verificarPermissao(chatId) {
    return ADMINS.includes(chatId.toString());
}

function validarData(d) {
    return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

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
            bot.sendMessage(chatId, "🔄 Viagem atualizada!", { reply_markup: MAIN_KEYBOARD });
        }
    } else {
        rotas.push(novaRota);
        bot.sendMessage(chatId, "💾 Viagem salva e monitorada!", { reply_markup: MAIN_KEYBOARD });
    }
    await redis.set('banco_rotas', JSON.stringify(rotas));
    delete userSessions[chatId];
}

async function listarViagensComBotoes(chatId) {
    const rotas = JSON.parse(await redis.get('banco_rotas') || '[]');
    const minhasRotas = rotas.filter(r => r.dono === chatId);

    if (minhasRotas.length === 0) {
        return bot.sendMessage(chatId, "📭 Nenhuma viagem cadastrada.", { reply_markup: MAIN_KEYBOARD });
    }
    bot.sendMessage(chatId, "📋 *Suas Viagens:*", { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD });

    for (let i = 0; i < minhasRotas.length; i++) {
        const r = minhasRotas[i];
        await bot.sendMessage(chatId, `✈️ *${r.origem} ➡️ ${r.destino}*\n📅 ${r.ida} a ${r.volta}`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✏️ Editar', callback_data: `btn_editar_${i}` },
                    { text: '🗑️ Apagar', callback_data: `btn_apagar_${i}` }
                ]]
            }
        });
        await new Promise(r => setTimeout(r, 200));
    }
}

async function apagarViagem(chatId, indexUsuario) {
    let rotas = JSON.parse(await redis.get('banco_rotas') || '[]');
    const meusIndices = rotas.map((r, i) => r.dono === chatId ? i : -1).filter(i => i !== -1);

    if (indexUsuario >= 0 && indexUsuario < meusIndices.length) {
        const indiceReal = meusIndices[indexUsuario];
        const [removida] = rotas.splice(indiceReal, 1);
        await redis.set('banco_rotas', JSON.stringify(rotas));
        let historico = JSON.parse(await redis.get('historico_precos') || '{}');
        delete historico[removida.id];
        await redis.set('historico_precos', JSON.stringify(historico));
        bot.sendMessage(chatId, "🗑️ Apagada.");
        listarViagensComBotoes(chatId);
    }
}

// ==================================================================
// 6. MONITORAMENTO (ORACLE ARM / DOCKER COMPATIBLE)
// ==================================================================
async function monitorarViagens() {
    console.log('🚀 Iniciando ciclo de monitoramento...');

    let rotas = [];
    try {
        const dadosBanco = await redis.get('banco_rotas');
        rotas = JSON.parse(dadosBanco || '[]');
    } catch (e) {
        console.error('❌ Redis:', e.message);
        return;
    }

    if (rotas.length === 0) return console.log('💤 Banco vazio.');

    // --- CONFIGURAÇÃO BLINDADA PARA ORACLE (ARM) ---
    const browser = await puppeteer.launch({
        headless: "new",
        // Lê o caminho do Chromium instalado no Docker ou usa undefined (local)
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',             // OBRIGATÓRIO: Permite rodar como root no Docker
            '--disable-setuid-sandbox', // OBRIGATÓRIO: Segurança do Chrome
            '--disable-dev-shm-usage',  // CRUCIAL: Usa /tmp em vez de RAM (evita crash de memória)
            '--disable-accelerated-2d-canvas', // Otimização para evitar erros gráficos no ARM
            '--disable-gpu',            // Servidor não tem placa de vídeo
            '--no-first-run',
            '--no-zygote',
            '--disable-extensions'
        ]
    });

    let dbPrecos = JSON.parse(await redis.get('historico_precos') || '{}');

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        for (const rota of rotas) {
            console.log(`🔎 Checando: ${rota.origem}->${rota.destino}`);

            // CORREÇÃO: Adicionado o $ que faltava em {rota.destino}
            const url = `https://www.google.com/travel/flights?q=Flights%20to%20$${rota.destino}%20from%20${rota.origem}%20on%20${rota.ida}%20through%20${rota.volta}&curr=BRL&hl=pt-BR`;

            try {
                // Timeout aumentado para 60s para garantir
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

                const resultado = await page.evaluate(() => {
                    const card = document.querySelector('[role="main"] li');
                    if (!card) return null;
                    const texto = card.innerText;
                    const precoMatch = texto.match(/R\$\s?([\d.,]+)/);
                    const cia = texto.split('\n').find(l => l.length > 2 && !l.includes('R$') && !l.match(/\d+:\d+/)) || 'Cia Desconhecida';
                    return { precoTexto: precoMatch ? precoMatch[0] : null, cia };
                });

                if (!resultado || !resultado.precoTexto) {
                    console.log('⚠️ Preço não encontrado.');
                    continue;
                }

                const precoAtual = parseFloat(resultado.precoTexto.replace(/[^\d,]/g, '').replace(',', '.'));
                console.log(`💰 R$ ${precoAtual}`);

                const precoAntigo = dbPrecos[rota.id] || Infinity;
                let notificar = false, titulo = "";

                if (!dbPrecos[rota.id]) {
                    notificar = true; titulo = "🆕 *Monitor Iniciado*"; dbPrecos[rota.id] = precoAtual;
                } else if (precoAtual < precoAntigo) {
                    notificar = true; titulo = `📉 *BAIXOU! R$ ${(precoAntigo - precoAtual).toFixed(2)} a menos*`; dbPrecos[rota.id] = precoAtual;
                } else if (precoAtual > precoAntigo) {
                    dbPrecos[rota.id] = precoAtual;
                }

                if (notificar) {
                    let msg = `${titulo}\n\n✈️ ${rota.origem} ➡️ ${rota.destino}\n📅 ${rota.ida} a ${rota.volta}\n💰 *R$ ${precoAtual}*\n🏢 ${resultado.cia}\n🔗 [Ver no Google](${url})`;

                    const destinatarios = GRUPOS[rota.dono] || [];
                    if (destinatarios.length === 0) destinatarios.push(rota.dono);

                    for (const id of destinatarios) {
                        try { await bot.sendMessage(id, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }); }
                        catch (e) { console.error(`Erro envio msg: ${e.message}`); }
                    }
                }

                await new Promise(r => setTimeout(r, 3000));

            } catch (erroRota) {
                console.error(`Erro Rota: ${erroRota.message}`);
            }
        }
        await redis.set('historico_precos', JSON.stringify(dbPrecos));

    } catch (error) {
        console.error('Erro Geral:', error);
    } finally {
        if (browser) await browser.close();
        console.log('🏁 Ciclo finalizado.');
    }
}

// ==================================================================
// 7. SERVIDOR WEB
// ==================================================================
app.get('/', (req, res) => res.send('🤖 Bot de Passagens ONLINE (Oracle ARM).'));
app.get('/rodar', async (req, res) => {
    res.send('Processo disparado em background.');
    monitorarViagens();
});
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));