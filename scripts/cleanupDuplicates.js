const prisma = require('../src/config/db');

async function cleanup() {
    console.log('🧹 Starting cleanup of duplicate trips...');

    const groups = await prisma.group.findMany({ include: { trips: true } });

    for (const group of groups) {
        console.log(`Checking Group: ${group.name}`);
        const seen = {};

        for (const trip of group.trips) {
            // Key defines uniqueness: Origin-Dest-Dates
            const key = `${trip.origin}-${trip.dest}-${trip.dateOut}-${trip.dateBack}`;

            if (seen[key]) {
                // Duplicate found!
                console.log(`   🗑️ Duplicate found: ${key} (Deleting ID: ${trip.id})`);

                // Delete the "current" one (keeping the first one seen, or logic to keep 'best' one)
                // Let's keep the one with lastPrice/lastCheck if possible, but simple logic: delete this one.
                await prisma.trip.delete({ where: { id: trip.id } });
            } else {
                seen[key] = trip;
            }
        }
    }
    console.log('✅ Cleanup finished.');
}

cleanup()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
