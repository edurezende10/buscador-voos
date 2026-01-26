const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const prisma = require('../config/db');
const tripService = require('./tripService');
const bot = require('./telegramService');

puppeteer.use(StealthPlugin());

async function monitorarViagens() {
    console.log('🚀 Iniciando ciclo de monitoramento...');

    // Fetch all active trips with user details
    const rotas = await prisma.trip.findMany({
        where: { active: true },
        include: { group: { include: { users: true } } }
    });

    if (rotas.length === 0) return console.log('💤 Banco vazio.');

    const isServer = !!process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log(isServer ? '☁️ Modo Servidor' : '🖥️ Modo Visual');

    const browser = await puppeteer.launch({
        headless: isServer ? "new" : false,
        defaultViewport: null,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--disable-extensions'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        for (const rota of rotas) {
            console.log(`🔎 Checando: ${rota.origin}->${rota.dest}`);

            // URL OTIMIZADA
            const url = `https://www.google.com/travel/flights?q=${rota.origin}%20${rota.dest}%20${rota.dateOut}%20${rota.dateBack}&curr=BRL&hl=pt-BR`;

            try {
                // Navega e aguarda carregamento inicial
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

                let tentativas = 0;
                let sucesso = false;

                while (tentativas < 3 && !sucesso) {
                    if (tentativas > 0) {
                        console.log(`🔄 Tentativa ${tentativas + 1} de recuperação...`);
                        await page.reload({ waitUntil: 'domcontentloaded' });
                    }

                    // Wait function
                    try {
                        await page.waitForFunction(
                            () => document.querySelector('[role="main"] li') ||
                                document.querySelector('.pIav2d') ||
                                document.body.innerText.includes('Algo deu errado'),
                            { timeout: 15000 }
                        );
                    } catch (e) { }

                    const erroGoogle = await page.evaluate(() => document.body.innerText.includes('Algo deu errado'));

                    if (erroGoogle) {
                        console.log('⚠️ Página de erro do Google detectada.');
                        const clicouAtualizar = await page.evaluate(() => {
                            const btns = Array.from(document.querySelectorAll('button'));
                            const btnAtualizar = btns.find(b => b.innerText.includes('Atualizar'));
                            if (btnAtualizar) { btnAtualizar.click(); return true; }
                            return false;
                        });

                        if (clicouAtualizar) {
                            await new Promise(r => setTimeout(r, 5000));
                        }
                        tentativas++;
                        continue;
                    }

                    const resultado = await page.evaluate(() => {
                        const card = document.querySelector('[role="main"] li') || document.querySelector('.pIav2d');
                        if (!card) return null;
                        const texto = card.innerText;
                        const precoMatch = texto.match(/R\$\s?([\d.,]+)/);
                        const cia = texto.split('\n').find(l => l.length > 2 && !l.includes('R$') && !l.match(/\d+:\d+/)) || 'Cia Desconhecida';
                        return { precoTexto: precoMatch ? precoMatch[0] : null, cia };
                    });

                    if (resultado && resultado.precoTexto) {
                        const precoAtual = parseFloat(resultado.precoTexto.replace(/[^\d,]/g, '').replace(',', '.'));
                        console.log(`💰 R$ ${precoAtual}`);

                        const precoAntigo = rota.lastPrice || Infinity;
                        let notificar = false, titulo = "";

                        if (!rota.lastPrice) {
                            notificar = true; titulo = "🆕 *Monitor Iniciado*";
                        } else if (precoAtual < precoAntigo) {
                            notificar = true; titulo = `📉 *BAIXOU! R$ ${(precoAntigo - precoAtual).toFixed(2)} a menos*`;
                        }

                        // Save price regardless logic (or only if changed? Implementation plan said log every check)
                        await tripService.savePrice(rota.id, precoAtual);

                        if (notificar) {
                            let msg = `${titulo}\n\n✈️ ${rota.origin} ➡️ ${rota.dest}\n📅 ${rota.dateOut} a ${rota.dateBack}\n💰 *R$ ${precoAtual}*\n🏢 ${resultado.cia}\n🔗 [Ver no Google](${url})`;

                            // Notify Group Users
                            if (rota.group && rota.group.users) {
                                for (const user of rota.group.users) {
                                    try {
                                        await bot.sendMessage(user.telegramId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
                                    } catch (e) {
                                        console.error(`Erro envio msg: ${e.message}`);
                                    }
                                }
                            }
                        }
                        sucesso = true;
                    } else {
                        console.log('⚠️ Seletores não encontrados.');
                        tentativas++;
                    }
                }

                if (!sucesso) console.log('❌ Falha na rota.');
                await new Promise(r => setTimeout(r, 3000));

            } catch (erroRota) {
                console.error(`Erro Rota: ${erroRota.message}`);
            }
        }

    } catch (error) {
        console.error('Erro Geral:', error);
    } finally {
        if (browser) await browser.close();
        console.log('🏁 Ciclo finalizado.');
    }
}

module.exports = { monitorarViagens };
