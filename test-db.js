const Database = require('better-sqlite3');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const dbPath = path.join(__dirname, 'dev.db');
console.log(`Database path: ${dbPath}`);

try {
    const db = new Database(dbPath);
    console.log('better-sqlite3: Connected successfully');
    
    // Test native query
    const stmt = db.prepare('SELECT 1 as val');
    const row = stmt.get();
    console.log('better-sqlite3 query result:', row);
    
    // Close manual connection to avoid lock?
    db.close(); 
    console.log('Closed manual connection.');

    console.log('Initializing adapter...');
    // Trying the new API style for Prisma 7 adapter factory
    const adapter = new PrismaBetterSqlite3({
        url: `file:${dbPath}`
    });
    console.log('Adapter initialized.');

    console.log('Initializing PrismaClient...');
    const prisma = new PrismaClient({ adapter });
    
    console.log('Running Prisma query...');
    prisma.client.count().then(count => {
        console.log(`Prisma: Found ${count} clients.`);
    }).catch(e => {
        console.error('Prisma Error:', e);
        console.error(e.stack);
    });

} catch (e) {
    console.error('Setup Error:', e);
}
