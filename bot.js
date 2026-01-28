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

// --- Общая логика для истории ---
async function handleHistoryCommand(ctx, mac, count = 10) {
    // Если MAC не передан (или пустой), будем считать это запросом глобальной истории.
    // Если передан "all", тоже считаем глобальной историей.
    let normalizedMac = null;
    if (mac && mac.toLowerCase() !== 'all') {
        normalizedMac = mac.replace(/_/g, ':');
    }
    
    try {
        const events = await monitorService.getClientHistory(normalizedMac, count);
        
        if (events.length === 0) {
            const target = normalizedMac ? normalizedMac : 'всех клиентов';
            return ctx.reply(`📜 История для ${target} пуста.`);
        }

        let header;
        if (normalizedMac) {
             const clientName = events[0].client.name || events[0].client.hostname || normalizedMac;
             header = `<b>📜 История событий для ${clientName} (${events.length}):</b>\n`;
        } else {
             header = `<b>📜 Последние события (${events.length}):</b>\n`;
        }
        
        const lines = events.map(e => {
            const date = new Date(e.timestamp);
            const timeStr = date.toLocaleString('ru-RU', { 
                day: '2-digit', month: '2-digit', 
                hour: '2-digit', minute: '2-digit' 
            });
            
            let icon = '⚪';
            if (e.type === 'CONNECTED') icon = '🟢';
            else if (e.type === 'DISCONNECTED') icon = '🔴';
            else if (e.type === 'UPDATED') icon = '🔵';

            const name = e.client.name || e.client.hostname || e.clientMac;
            // Если история глобальная, добавляем имя клиента в строку
            const details = normalizedMac ? (e.details || e.type) : `<b>${name}</b>: ${e.details || e.type}`;

            return `${icon} ${timeStr} - ${details}`;
        });

        const message = header + '\n' + lines.join('\n');
        
        if (message.length > 4000) {
            ctx.replyWithHTML(message.substring(0, 4000) + '\n...');
        } else {
            ctx.replyWithHTML(message);
        }
    } catch (e) {
        logger.error(`Ошибка получения истории для ${normalizedMac || 'all'}:`, e);
        ctx.reply('❌ Ошибка при получении истории.');
    }
}

bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    addSubscriber(chatId);

    // Проверка payload (deep linking)
    const payload = ctx.payload || (ctx.message.text.split(' ')[1]); 
    if (payload && payload.startsWith('history_')) {
        botLogger.info(`Deep link history request от ${chatId}`);
        
        // Удаляем сообщение /start чтобы не засорять чат
        try {
            await ctx.deleteMessage();
        } catch (e) {
            logger.warn(`Не удалось удалить сообщение /start: ${e.message}`);
        }

        const mac = payload.replace('history_', '');
        return handleHistoryCommand(ctx, mac);
    }

    botLogger.info(`Получена команда /start от ${chatId} (@${ctx.from?.username})`);
    ctx.reply('✅ Бот запущен! Теперь я буду присылать уведомления о статусе клиентов сети Keenetic.\n\nИспользуйте /list для просмотра активных клиентов.');
});

bot.command('history', async (ctx) => {
    botLogger.info(`Получена команда /history от ${ctx.chat.id}`);
    const parts = ctx.message.text.split(' ');
    const mac = parts[1];
    const count = parts[2] ? parseInt(parts[2]) : 10;
    
    await handleHistoryCommand(ctx, mac, count);
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
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit' 
            });
            
            // Формируем ссылку для скрытого вызова команды через Deep Linking
            // Если бот запущен, ctx.botInfo должен быть доступен. Если нет, fallback на обычный текст.
            const botUsername = ctx.botInfo?.username;
            let macDisplay = c.mac || '';
            
            if (c.mac && botUsername) {
                // Заменяем двоеточия на _, так как в URL параметры могут быть ограничены
                const macParam = c.mac.replace(/:/g, '_');
                macDisplay = `<a href="https://t.me/${botUsername}?start=history_${macParam}">${c.mac}</a>`;
            }

            // Расчет Uptime
            const now = new Date();
            const uptimeMs = now.getTime() - date.getTime();
            const uptimeStr = monitorService.formatDuration(uptimeMs);

            const name = `${c.hostname || c.name || 'N/A'}  -  ${macDisplay}  -  🌐 IP: ${c.ip || 'N/A'}`;
            return `📱 <b>${name}</b>\n└ 🕒 В сети с: ${timeStr} (${uptimeStr})`;
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
bot.launch().then(async () => {
    logger.info('Telegram bot started.');
    // Запуск первичного сканирования при старте
    logger.info('Выполнение первичного сканирования сети...');
    await runNetworkScan();
}).catch(err => {
    logger.error('Ошибка запуска Telegram бота:', err);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --- Периодический опрос (Cron) ---
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/2 * * * *';

async function runNetworkScan() {
    logger.info('Запуск сканирования сети...');
    
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
}

// Запуск по расписанию
cron.schedule(CRON_SCHEDULE, async () => {
    logger.info(`Запуск периодического опроса (cron) [${CRON_SCHEDULE}]...`);
    await runNetworkScan();
});
