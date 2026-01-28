const KeeneticClient = require('./keenetic');
const logger = require('./logger');
const monitorService = require('./monitor');

const args = process.argv.slice(2);
const runOnce = args.includes('--once');

const INTERVAL_MS = 60 * 1000; // 60 секунд

async function run() {
    logger.info(`Запуск опроса...`);
    const keenetic = new KeeneticClient();
    
    try {
        const isAuth = await keenetic.authenticate();
        if (isAuth) {
            await keenetic.getSystemInfo();
            const clients = await keenetic.getHotspotClients();
            await monitorService.updateClients(clients);
        }
    } catch (error) {
        logger.error(`Ошибка выполнения: ${error.message}`);
        logger.error(error.stack);
    }
}

// Запуск
if (runOnce) {
    logger.info('Режим: однократный запуск (--once)');
    run().then(() => {
        logger.info('Работа завершена.');
        logger.on('finish', () => process.exit(0));
        logger.end();
    });
} else {
    logger.info(`Режим: периодический опрос (интервал ${INTERVAL_MS / 1000} сек)`);
    run();
    setInterval(run, INTERVAL_MS);
}
