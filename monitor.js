const { PrismaClient } = require('@prisma/client');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const { logger } = require('./logger');

// Setup adapter for Prisma 7
const adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL
});
const prisma = new PrismaClient({ adapter });

class MonitorService {
    constructor() {
        this.prisma = prisma;
    }

    /**
     * Updates client status in DB based on fetched list
     * @param {Array} fetchedClients - List of active clients from Router
     * @returns {Promise<Array>} List of changes/events
     */
    async updateClients(fetchedClients) {
        const changes = [];
        if (!Array.isArray(fetchedClients)) return changes;

        const now = new Date();
        const fetchedMap = new Map();
        
        // 1. Process Fetched Clients
        for (const fc of fetchedClients) {
            if (!fc.mac) continue;
            fetchedMap.set(fc.mac, fc);

            const mac = fc.mac;
            const ip = fc.ip || null;
            const name = fc.name || fc.hostname || null;
            const hostname = fc.hostname || null;
            
            // Extract interface name properly (it can be an object or string)
            let iface = null;
            if (fc.interface) {
                if (typeof fc.interface === 'string') {
                    iface = fc.interface;
                } else if (typeof fc.interface === 'object' && fc.interface.name) {
                    iface = fc.interface.name; // e.g., "Home"
                } else if (typeof fc.interface === 'object' && fc.interface.id) {
                    iface = fc.interface.id;   // e.g., "Bridge0"
                }
            }
            
            const ssid = fc.ssid || null;

            // Check if client exists
            const existing = await this.prisma.client.findUnique({ where: { mac } });

            if (!existing) {
                // New Client
                logger.info(`[Monitor] New client detected: ${mac} (${name})`);
                const newClient = await this.prisma.client.create({
                    data: {
                        mac, ip, name, hostname, interface: iface, ssid,
                        isOnline: true,
                        firstSeen: now,
                        lastSeen: now,
                        lastStatusChange: now
                    }
                });
                await this.logEvent(mac, 'CONNECTED', 'New device detected');
                changes.push({ type: 'CONNECTED', client: newClient, message: 'New device detected' });
            } else {
                // Existing Client
                const wasOnline = existing.isOnline;
                let details = [];

                // Check for Info Changes
                if (existing.ip !== ip) details.push(`IP: ${existing.ip} -> ${ip}`);
                if (existing.name !== name && name) details.push(`Name: ${existing.name} -> ${name}`);
                if (existing.interface !== iface && iface) details.push(`Interface: ${existing.interface} -> ${iface}`);
                if (existing.ssid !== ssid && ssid) details.push(`SSID: ${existing.ssid} -> ${ssid}`);

                // Update Data
                const updateData = {
                    lastSeen: now,
                    ip, name, hostname, interface: iface, ssid,
                    isOnline: true
                };

                // Logic for Offline -> Online
                if (!wasOnline) {
                    const offlineDurationMs = now.getTime() - existing.lastStatusChange.getTime();
                    const offlineText = this.formatDuration(offlineDurationMs);
                    
                    logger.info(`[Monitor] Клиент ${mac} снова в сети: ${name} (Оффлайн for ${offlineText})`);
                    
                    updateData.lastStatusChange = now;
                    await this.logEvent(mac, 'CONNECTED', `Back online. Offline for ${offlineText}`);
                    
                    // Merge existing with updateData for the event object
                    changes.push({ 
                        type: 'CONNECTED', 
                        client: { ...existing, ...updateData }, 
                        message: `Back online. Offline for ${offlineText}` 
                    });
                } else if (details.length > 0) {
                    logger.info(`[Monitor] Client updated: ${mac} - ${details.join(', ')}`);
                    await this.logEvent(mac, 'UPDATED', details.join(', '));
                    // Optional: Notify on updates too? Maybe not requested, but good for logs.
                    // keeping it out of 'changes' to reduce spam unless user asked for it.
                    // User asked: "appearance in network / or exit from network". So updates are not required.
                }

                await this.prisma.client.update({
                    where: { mac },
                    data: updateData
                });
            }
        }

        // 2. Process Disconnected Clients (In DB as Online, but not in fetched list)
        const onlineClients = await this.prisma.client.findMany({
            where: { isOnline: true }
        });

        for (const dbClient of onlineClients) {
            if (!fetchedMap.has(dbClient.mac)) {
                // Client went offline
                const now = new Date();
                const onlineDurationMs = now.getTime() - dbClient.lastStatusChange.getTime();
                const onlineText = this.formatDuration(onlineDurationMs);
                const onlineSeconds = Math.floor(onlineDurationMs / 1000);

                logger.info(`[Monitor] Клиент ${dbClient.mac} отключился: ${dbClient.name} (Online for ${onlineText})`);

                await this.prisma.client.update({
                    where: { mac: dbClient.mac },
                    data: {
                        isOnline: false,
                        lastStatusChange: now,
                        totalOnlineSeconds: { increment: onlineSeconds }
                    }
                });

                await this.logEvent(dbClient.mac, 'DISCONNECTED', `Online for ${onlineText}`);
                changes.push({ type: 'DISCONNECTED', client: dbClient, message: `Online for ${onlineText}` });
            }
        }
        
        return changes;
    }

    async getOnlineClients() {
        return this.prisma.client.findMany({
            where: { isOnline: true },
            orderBy: { lastStatusChange: 'desc' }
        });
    }

    /**
     * Get event history for a specific client or all clients
     * @param {string|null} mac - MAC address of the client (optional)
     * @param {number} limit - Number of events to retrieve (default: 10)
     * @returns {Promise<Array>} List of events with client details
     */
    async getClientHistory(mac, limit = 10) {
        const where = mac ? { clientMac: mac } : {};
        return this.prisma.event.findMany({
            where,
            orderBy: { timestamp: 'desc' },
            take: limit,
            include: {
                client: true
            }
        });
    }

    async logEvent(mac, type, details) {
        await this.prisma.event.create({
            data: {
                clientMac: mac,
                type,
                details
            }
        });
    }

    formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        
        if (hours > 0) return `${hours}ч ${minutes % 60}м`;
        if (minutes > 0) return `${minutes}м ${seconds % 60}с`;
        return `${seconds}с`;
    }
}

module.exports = new MonitorService();
