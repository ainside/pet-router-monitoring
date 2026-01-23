const KeeneticClient = require('./keenetic');

console.log('Imported KeeneticClient type:', typeof KeeneticClient);
console.log('Imported KeeneticClient:', KeeneticClient);

const INTERVAL_MS = 60 * 1000; // 60 секунд

async function run() {
    console.log(`\n[${new Date().toISOString()}] Запуск опроса...`);
    const keenetic = new KeeneticClient();
    
    try {
        const isAuth = await keenetic.authenticate();
        if (isAuth) {
            await keenetic.getSystemInfo();
            await keenetic.getHotspotClients();
        }
    } catch (error) {
        console.error('Ошибка выполнения:', error.message);
    }
}

// Запуск
run();
setInterval(run, INTERVAL_MS);

console.log(`Сервис запущен. Интервал опроса: ${INTERVAL_MS / 1000} сек.`);
