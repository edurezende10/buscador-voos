const prisma = require('../src/config/db');

async function debug() {
    console.log('🔍 Debugging DB Connection...');

    try {
        const trips = await prisma.trip.findMany();
        console.log(`📦 Total Trips Found: ${trips.length}`);

        trips.forEach(t => {
            console.log(` - [${t.active ? 'ACTIVE' : 'INACTIVE'}] ${t.origin}->${t.dest} (ID: ${t.id})`);
        });

        if (trips.length === 0) {
            console.log('⚠️ The database is reachable but empty.');
        }

    } catch (e) {
        console.error('❌ Error connecting to DB:', e);
    } finally {
        await prisma.$disconnect();
    }
}

debug();
