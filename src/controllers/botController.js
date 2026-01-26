const bot = require('../services/telegramService');
const tripService = require('../services/tripService');
const chartService = require('../services/chartService');
const prisma = require('../config/db');

const userSessions = {};

const MAIN_KEYBOARD = {
    keyboard: [
        [{ text: '✈️ Nova Viagem' }, { text: '📋 Minhas Viagens' }],
        [{ text: '❓ Ajuda' }, { text: '❌ Cancelar' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
};

async function verifyUser(chatId) {
    const user = await prisma.user.findUnique({ where: { telegramId: chatId.toString() } });
    return user;
}

function init() {
    bot.onText(/\/(start|menu)/, async (msg) => {
        const user = await verifyUser(msg.chat.id);
        if (!user) return bot.sendMessage(msg.chat.id, "🚫 Acesso Negado. Peça ao administrador para te adicionar.");
        mostrarMenuPrincipal(msg.chat.id);
    });

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id.toString();
        const texto = msg.text;

        if (!texto || texto.startsWith('/')) return;

        const user = await verifyUser(chatId);
        if (!user) return;

        if (texto === '✈️ Nova Viagem') {
            userSessions[chatId] = { step: 'AGUARDANDO_ORIGEM', dados: {} };
            return bot.sendMessage(chatId, "✈️ *Nova Viagem*\n\nQual a sigla da **ORIGEM**? (ex: GRU)", {
                parse_mode: 'Markdown',
                reply_markup: { keyboard: [[{ text: '❌ Cancelar' }]], resize_keyboard: true }
            });
        }

        if (texto === '📋 Minhas Viagens') return listarViagens(chatId, user);
        if (texto === '❌ Cancelar') return mostrarMenuPrincipal(chatId);
        if (texto === '❓ Ajuda') return bot.sendMessage(chatId, "💡 *Ajuda*\n\nMonitoro preços no Google Flights.", { parse_mode: 'Markdown' });

        if (userSessions[chatId]) {
            handleSession(chatId, texto, user);
        }
    });

    bot.on('callback_query', async (callback) => {
        const chatId = callback.message.chat.id.toString();
        const data = callback.data;
        bot.answerCallbackQuery(callback.id);

        if (data.startsWith('btn_apagar_')) {
            const id = data.split('_')[2];
            await tripService.deleteTrip(id);
            bot.sendMessage(chatId, "🗑️ Viagem apagada.");
            const user = await verifyUser(chatId);
            listarViagens(chatId, user);
        }
        else if (data.startsWith('btn_hist_')) {
            const id = data.split('_')[2];
            await enviarGrafico(chatId, id);
        }
    });
}

function mostrarMenuPrincipal(chatId) {
    delete userSessions[chatId];
    bot.sendMessage(chatId, "🤖 *Painel de Controle*\nEscolha uma opção:", {
        parse_mode: 'Markdown',
        reply_markup: MAIN_KEYBOARD
    });
}

async function handleSession(chatId, texto, user) {
    const session = userSessions[chatId];

    if (session.step === 'AGUARDANDO_ORIGEM') {
        if (texto.length !== 3) return bot.sendMessage(chatId, "⚠️ Sigla inválida (3 letras).");
        session.dados.origem = texto.toUpperCase();
        session.step = 'AGUARDANDO_DESTINO';
        bot.sendMessage(chatId, `✅ Origem: ${session.dados.origem}\n\nQual o **DESTINO**?`);
    }
    else if (session.step === 'AGUARDANDO_DESTINO') {
        if (texto.length !== 3) return bot.sendMessage(chatId, "⚠️ Sigla inválida.");
        session.dados.destino = texto.toUpperCase();
        session.step = 'AGUARDANDO_IDA';
        bot.sendMessage(chatId, "Qual a data de **IDA**? (AAAA-MM-DD)");
    }
    else if (session.step === 'AGUARDANDO_IDA') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return bot.sendMessage(chatId, "⚠️ Formato inválido.");
        session.dados.ida = texto;
        session.step = 'AGUARDANDO_VOLTA';
        bot.sendMessage(chatId, "Qual a data de **VOLTA**? (AAAA-MM-DD)");
    }
    else if (session.step === 'AGUARDANDO_VOLTA') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return bot.sendMessage(chatId, "⚠️ Formato inválido.");
        session.dados.volta = texto;

        // Save to DB
        await tripService.createTrip({
            origin: session.dados.origem,
            dest: session.dados.destino,
            dateOut: session.dados.ida,
            dateBack: session.dados.volta,
            groupId: user.groupId
        });

        bot.sendMessage(chatId, "💾 Viagem salva!", { reply_markup: MAIN_KEYBOARD });
        delete userSessions[chatId];
    }
}

async function listarViagens(chatId, user) {
    const trips = await tripService.listTrips(user.groupId);
    if (trips.length === 0) return bot.sendMessage(chatId, "📭 Nenhuma viagem.", { reply_markup: MAIN_KEYBOARD });

    bot.sendMessage(chatId, "📋 *Viagens do Grupo:*", { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD });

    for (const t of trips) {
        const preco = t.lastPrice ? `R$ ${t.lastPrice}` : "???";
        const url = `https://www.google.com/travel/flights?q=${t.origin}%20${t.dest}%20${t.dateOut}%20${t.dateBack}&curr=BRL&hl=pt-BR`;

        let infoData = "Nunca verificado";
        if (t.lastCheck) {
            infoData = new Date(t.lastCheck).toLocaleString('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        }

        await bot.sendMessage(chatId,
            `✈️ *${t.origin} ➡️ ${t.dest}*\n` +
            `📅 ${t.dateOut} a ${t.dateBack}\n` +
            `💰 Último: ${preco}\n` +
            `🕒 Verificado em: ${infoData}\n` +
            `🔗 [Comprar no Google](${url})`,
            {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🗑️ Apagar', callback_data: `btn_apagar_${t.id}` }, { text: '📈 Histórico', callback_data: `btn_hist_${t.id}` }]
                    ]
                }
            }
        );
        await new Promise(r => setTimeout(r, 100));
    }
}

async function enviarGrafico(chatId, tripId) {
    bot.sendMessage(chatId, "⏳ Gerando gráfico...");
    const history = await tripService.getHistory(tripId);
    if (history.length < 2) return bot.sendMessage(chatId, "⚠️ Poucos dados para gráfico.");

    const labels = history.map(h => h.date.toISOString().split('T')[0]);
    const data = history.map(h => h.price);
    const trip = await tripService.getTrip(tripId);

    const url = await chartService.generatePriceChart(labels, data, `${trip.origin}-${trip.dest}`);
    bot.sendPhoto(chatId, url);
}

module.exports = { init };
