require('dotenv').config();
const bot = require('../src/services/telegramService');
const prisma = require('../src/config/db');

async function test() {
    console.log('📧 Testing Telegram Notification...');
    try {
        const user = await prisma.user.findFirst();
        if (!user) {
            console.log('❌ No users found in DB to send message to.');
            return;
        }

        console.log(`📤 Sending message to ${user.name} (${user.telegramId})...`);
        await bot.sendMessage(user.telegramId, "🔔 Teste de Notificação: Seu sistema está funcionando!");
        console.log('✅ Message sent successfully!');
    } catch (e) {
        console.error('❌ Error sending message:', e);
        if (e.code === 'ETELEGRAM') {
            console.error('   -> Check your TELEGRAM_TOKEN');
        }
    } finally {
        await prisma.$disconnect();
    }
}

test();
