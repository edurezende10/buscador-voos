const prisma = require('../config/db');

async function listTrips(groupId) {
    return await prisma.trip.findMany({ where: { groupId, active: true } });
}

async function createTrip(data) {
    return await prisma.trip.create({ data });
}

async function getTrip(id) {
    return await prisma.trip.findUnique({ where: { id } });
}

async function deleteTrip(id) {
    try {
        // Cascade delete handles priceHistory
        return await prisma.trip.delete({ where: { id } });
    } catch (e) {
        if (e.code === 'P2025') return null; // Already deleted
        throw e;
    }
}

async function getHistory(tripId) {
    // Get last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    return await prisma.priceHistory.findMany({
        where: {
            tripId,
            date: { gte: sevenDaysAgo }
        },
        orderBy: { date: 'asc' }
    });
}

async function savePrice(tripId, price) {
    // Update Trip lastPrice
    await prisma.trip.update({
        where: { id: tripId },
        data: { lastPrice: price }
    });

    // Add History
    return await prisma.priceHistory.create({
        data: {
            tripId,
            price,
            date: new Date()
        }
    });
}

module.exports = { listTrips, createTrip, getTrip, deleteTrip, getHistory, savePrice };
