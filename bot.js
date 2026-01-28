require('dotenv').config();
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const KeeneticClient = require('./keenetic');
const monitorService = require('./monitor');
const { logger, botLogger } = require('./logger');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID_FILE = path.join(__dirname, 'data', 'chat_id.json');

if (!BOT_TOKEN) {
    logger.error('Ошибка: BOT_TOKEN не найден в .env');
    botLogger.error('Ошибка: BOT_TOKEN не найден в .env');
    console.error('Пожалуйста, добавьте BOT_TOKEN в файл .env');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// --- Middleware: Проверка доступа ---
const ALLOWED_USERS = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',').map(id => Number(id.trim())) : [];

bot.use((ctx, next) => {
    // Если ALLOWED_USERS не задан в .env, считаем что ограничений нет (совместимость).
    // Если задан, но пуст - никого не пускаем.
    
    if (process.env.ALLOWED_USERS === undefined) {
        return next();
    }

    const userId = ctx.from?.id;
    if (userId && ALLOWED_USERS.includes(userId)) {
        botLogger.info(`Пользователь ${userId} (@${ctx.from?.username}) выполнил команду/действие`);
        return next();
    }

    logger.warn(`Попытка несанкционированного доступа: ${userId} (@${ctx.from?.username})`);
    botLogger.warn(`Попытка несанкционированного доступа: ${userId} (@${ctx.from?.username})`);
    // Не отвечаем на сообщения чужаков
});

// Управление Chat ID (загрузка из .env или файла)
let subscribers = new Set();

// Если задан CHAT_ID в env - добавляем его сразу
if (process.env.CHAT_ID) {
    subscribers.add(Number(process.env.CHAT_ID));
}

if (fs.existsSync(CHAT_ID_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(CHAT_ID_FILE, 'utf8'));
        // Поддержка старого формата (один chatId) и нового (массив subscribers)
        if (data.subscribers && Array.isArray(data.subscribers)) {
            data.subscribers.forEach(id => subscribers.add(id));
        } else if (data.chatId) {
            subscribers.add(data.chatId);
        }
        logger.info(`Загружены подписчики: ${Array.from(subscribers).join(', ')}`);
    } catch (e) {
        logger.error('Ошибка загрузки chat ID:', e);
    }
}

function addSubscriber(chatId) {
    if (!subscribers.has(chatId)) {
        subscribers.add(chatId);
        saveSubscribers();
    }
}

function saveSubscribers() {
    try {
        if (!fs.existsSync(path.dirname(CHAT_ID_FILE))) {
            fs.mkdirSync(path.dirname(CHAT_ID_FILE), { recursive: true });
        }
        const data = { subscribers: Array.from(subscribers) };
        fs.writeFileSync(CHAT_ID_FILE, JSON.stringify(data));
        logger.info(`Список подписчиков сохранен: ${data.subscribers.join(', ')}`);
    } catch (e) {
        logger.error('Ошибка сохранения подписчиков:', e);
    }
}

// --- Команды Бота ---

bot.start((ctx) => {
    const chatId = ctx.chat.id;
    botLogger.info(`Получена команда /start от ${chatId} (@${ctx.from?.username})`);
    addSubscriber(chatId);
    ctx.reply('✅ Бот запущен! Теперь я буду присылать уведомления о статусе клиентов сети Keenetic.\n\nИспользуйте /list для просмотра активных клиентов.');
});

bot.command('list', async (ctx) => {
    botLogger.info(`Получена команда /list от ${ctx.chat.id} (@${ctx.from?.username})`);
    try {
        const clients = await monitorService.getOnlineClients();
        if (clients.length === 0) {
            return ctx.reply('Нет активных клиентов.');
        }

        const lines = clients.map(c => {
            // Форматирование даты
            const date = new Date(c.lastStatusChange);
            const timeStr = date.toLocaleString('ru-RU', { 
                day: '2-digit', month: '2-digit', 
                hour: '2-digit', minute: '2-digit', second: '2-digit' 
            });
            
            const name = c.name || c.hostname || c.mac;
            return `📱 <b>${name}</b>\n└ 🕒 В сети с: ${timeStr}\n└ 🌐 IP: ${c.ip || 'N/A'} | ${c.interface || '?'}`;
        });

        // Разбиваем на сообщения, если список слишком длинный (лимит Telegram ~4096)
        // Для простоты пока отправляем одним, или первыми 20-30
        const message = `<b>Список онлайн клиентов (${clients.length}):</b>\n\n${lines.join('\n\n')}`;
        
        if (message.length > 4000) {
             // Простая обрезка, если очень много клиентов
             ctx.replyWithHTML(message.substring(0, 4000) + '\n\n... (список обрезан)');
        } else {
             ctx.replyWithHTML(message);
        }
    } catch (e) {
        logger.error('Ошибка в команде /list:', e);
        ctx.reply('❌ Ошибка получения списка клиентов.');
    }
});

// Запуск бота
bot.launch().then(() => {
    logger.info('Telegram bot started.');
}).catch(err => {
    logger.error('Ошибка запуска Telegram бота:', err);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --- Периодический опрос (Cron) ---

// Запуск каждую минуту
cron.schedule('* * * * *', async () => {
    logger.info('Запуск периодического опроса (cron)...');
    
    if (subscribers.size === 0) {
        logger.warn('Нет подписчиков (Chat ID). Отправьте /start боту.');
        return;
    }

    const keenetic = new KeeneticClient();
    
    try {
        const isAuth = await keenetic.authenticate();
        if (isAuth) {
            await keenetic.getSystemInfo(); // Поддержание активности / проверка
            const clients = await keenetic.getHotspotClients();
            
            // Получаем изменения
            const changes = await monitorService.updateClients(clients);
            
            if (changes && changes.length > 0) {
                logger.info(`Обнаружено ${changes.length} изменений. Отправка уведомлений...`);
                
                for (const change of changes) {
                    let icon = '❓';
                    let title = 'Статус изменен';
                    
                    if (change.type === 'CONNECTED') {
                        icon = '🟢';
                        title = 'Появился в сети';
                    } else if (change.type === 'DISCONNECTED') {
                        icon = '🔴';
                        title = 'Вышел из сети';
                    }

                    const name = change.client.name || change.client.hostname || change.client.mac;
                    const ip = change.client.ip ? ` (${change.client.ip})` : '';
                    const message = `${icon} <b>${name}</b>${ip}\n${title}\n${change.message}`;
                    
                    // Рассылка всем подписчикам
                    for (const chatId of subscribers) {
                        try {
                            await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
                        } catch (err) {
                            logger.error(`Ошибка отправки сообщения пользователю ${chatId}: ${err.message}`);
                        }
                    }
                }
            } else {
                logger.info('Изменений нет.');
            }
        }
    } catch (error) {
        logger.error(`Ошибка выполнения опроса: ${error.message}`);
        logger.error(error.stack);
    }
});
