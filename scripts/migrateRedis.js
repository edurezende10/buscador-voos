require('dotenv').config();
const Redis = require('ioredis');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Config redis similar to index.js
const redis = new Redis(process.env.REDIS_URL, {
    tls: { rejectUnauthorized: false },
    family: 4,
    maxRetriesPerRequest: 3
});

async function migrate() {
    console.log('🚀 Starting Migration...');

    // 1. Config Groups
    let GRUPOS_CONFIG = {};
    try {
        GRUPOS_CONFIG = JSON.parse(process.env.TELEGRAM_CONFIG_JSON || '{}');
    } catch (e) {
        console.warn('⚠️ Invalid JSON Config');
    }

    // 2. Fetch Data
    const rotasRaw = await redis.get('banco_rotas');
    const rotas = JSON.parse(rotasRaw || '[]');
    const historicoRaw = await redis.get('historico_precos');
    const historico = JSON.parse(historicoRaw || '{}');

    console.log(`📦 Found: ${rotas.length} trips / ${Object.keys(historico).length} price records.`);

    for (const rota of rotas) {
        // Logic to determine Group Name
        let groupName = `Group_${rota.dono}`;

        // Try to match with config keys or values
        for (const [key, members] of Object.entries(GRUPOS_CONFIG)) {
            // Check if user is the key (Admin) or in the list
            if (key === rota.dono || (Array.isArray(members) && members.includes(rota.dono))) {
                groupName = key; // Use the Config Key as Group Name (e.g., "Casal A")
                break;
            }
        }

        console.log(`🔹 Processing Trip: ${rota.origem}->${rota.destino} for user ${rota.dono} (Group: ${groupName})`);

        // Upsert Group
        const group = await prisma.group.upsert({
            where: { name: groupName },
            update: {},
            create: { name: groupName }
        });

        // Upsert User
        await prisma.user.upsert({
            where: { telegramId: rota.dono },
            update: { groupId: group.id },
            create: {
                telegramId: rota.dono,
                name: `User_${rota.dono}`,
                groupId: group.id
            }
        });

        // Check if trip already exists (to avoid error on re-run)
        const existingTrip = await prisma.trip.findUnique({ where: { id: rota.id } });

        if (!existingTrip) {
            const trip = await prisma.trip.create({
                data: {
                    id: rota.id, // PRESERVE ID from Redis
                    origin: rota.origem,
                    dest: rota.destino,
                    dateOut: rota.ida,
                    dateBack: rota.volta,
                    active: rota.ativo,
                    groupId: group.id
                }
            });

            // Handle Price History
            const lastPrice = historico[rota.id];
            if (lastPrice) {
                const priceVal = parseFloat(lastPrice);
                // Create history entry
                await prisma.priceHistory.create({
                    data: {
                        tripId: trip.id,
                        price: priceVal,
                        date: new Date() // Use current time as migration time
                    }
                });
                // Update trip lastPrice
                await prisma.trip.update({
                    where: { id: trip.id },
                    data: { lastPrice: priceVal }
                });
            }
        } else {
            console.log('   ⚠️ Trip already exists, skipping creation.');
        }
    }

    console.log('✅ Migration Finished!');
}

migrate()
    .catch(console.error)
    .finally(async () => {
        await prisma.$disconnect();
        redis.disconnect();
    });
