require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

// --- Настройки ---
const ROUTER_IP = process.env.ROUTER_IP;
const LOGIN = process.env.LOGIN;
const PASSWORD = process.env.PASSWORD;
const COOKIES_FILENAME = process.env.COOKIES_FILE || 'auth_cookies.json';
const DATA_DIR = 'data';
const COOKIES_FILE = path.join(__dirname, DATA_DIR, COOKIES_FILENAME);

// --- Утилиты ---
const getMd5 = (data) => crypto.createHash('md5').update(data).digest('hex');
const getSha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

class KeeneticClient {
    constructor() {
        this.cookies = {};
        this.client = axios.create({
            baseURL: `http://${ROUTER_IP}`,
            timeout: 5000,
            validateStatus: () => true, // Не выбрасывать ошибку на 4xx/5xx
        });

        // Интерцептор для добавления куки к запросам
        this.client.interceptors.request.use((config) => {
            const cookieString = Object.entries(this.cookies)
                .map(([key, value]) => `${key}=${value}`)
                .join('; ');
            if (cookieString) {
                config.headers['Cookie'] = cookieString;
            }
            return config;
        });

        // Интерцептор для сохранения куки из ответов
        this.client.interceptors.response.use((response) => {
            if (response.headers['set-cookie']) {
                response.headers['set-cookie'].forEach(cookieStr => {
                    const [cookie] = cookieStr.split(';');
                    const [key, value] = cookie.split('=');
                    if (key && value) {
                        this.cookies[key.trim()] = value.trim();
                    }
                });
                // Если куки обновились, можно сохранить их (опционально здесь, или явно после авторизации)
            }
            return response;
        });
    }

    loadCookies() {
        if (fs.existsSync(COOKIES_FILE)) {
            try {
                const data = fs.readFileSync(COOKIES_FILE, 'utf8');
                this.cookies = JSON.parse(data);
                logger.debug(`Куки загружены из ${COOKIES_FILE}`);
                return true;
            } catch (e) {
                logger.debug(`Ошибка загрузки куки: ${e.message}`);
            }
        }
        return false;
    }

    saveCookies() {
        try {
            if (!fs.existsSync(path.dirname(COOKIES_FILE))) {
                fs.mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });
            }
            fs.writeFileSync(COOKIES_FILE, JSON.stringify(this.cookies, null, 2));
            logger.info(`Куки сохранены в ${COOKIES_FILE}`);
        } catch (e) {
            logger.error(`Ошибка сохранения куки: ${e.message}`);
        }
    }

    async authenticate() {
        // 1. Попытка восстановить сессию
        if (this.loadCookies()) {
            logger.debug("Проверка сохраненной сессии...");
            try {
                const res = await this.client.get('/rci/show/system');
                if (res.status === 200) {
                    logger.debug("Сессия валидна.");
                    return true;
                } else {
                    logger.debug(`Сессия устарела (код ${res.status}). Требуется повторная авторизация.`);
                }
            } catch (e) {
                logger.debug(`Ошибка при проверке сессии: ${e.message}`);
            }
        }

        // 2. Начало новой авторизации
        logger.debug("--- Шаг 1: Получение Challenge ---");
        const r1 = await this.client.get('/auth');

        const challenge = r1.headers['x-ndm-challenge'];
        const realm = r1.headers['x-ndm-realm'];
        const product = r1.headers['x-ndm-product'];

        logger.debug(`X-NDM-Challenge: ${challenge}`); // Changed to debug
        logger.debug(`X-NDM-Realm: ${realm}`); // Changed to debug
        logger.debug(`X-NDM-Product: ${product}`); // Changed to debug

        if (!challenge || !realm) {
            logger.error("Ошибка: не удалось получить данные для авторизации.");
            return false;
        }

        // 3. Вычисление хеша
        // Формула: SHA256(challenge + MD5(login + ":" + realm + ":" + password))
        const h1String = `${LOGIN}:${realm}:${PASSWORD}`;
        const h1 = getMd5(h1String);
        logger.debug(`MD5(${h1String}): ${h1}`); // Changed to debug

        const finalHash = getSha256(challenge + h1);
        logger.debug(`\nВычисленный хеш: ${finalHash}`); // Changed to debug

        // 4. Отправка хеша
        logger.debug("\n--- Шаг 2: Отправка хеша ---");
        const authData = {
            login: LOGIN,
            password: finalHash
        };

        const r2 = await this.client.post('/auth', authData);
        logger.debug(`Статус ответа: ${r2.status}`);

        if (r2.status === 200) {
            logger.debug("Авторизация успешна!");
            logger.debug(`Полученные куки (сессия): ${JSON.stringify(this.cookies)}`);
            this.saveCookies();
            return true;
        } else {
            logger.error("Ошибка авторизации!");
            return false;
        }
    }

    async getSystemInfo() {
        logger.debug("--- Шаг 3: Тестовый запрос (show system) ---");
        const res = await this.client.get('/rci/show/system');
        if (res.status === 200) {
            const data = res.data;
            // logger.debug(`DEBUG: ${JSON.stringify(data, null, 2)}`); // Uncomment for debug
            logger.debug(`SYSTEM INFO: Hostname: ${data.hostname}\t Uptime: ${data.uptime} сек.`);
            // logger.info(`Модель устройства: ${data.hostname}`);
            // logger.info(`Версия ОС: ${data.release}`);
            // logger.info(`Аптайм: ${data.uptime} сек.`);
        } else {
            logger.error(`Ошибка RCI: ${res.status}`);
        }
    }

    async getHotspotClients() {
        logger.debug("--- Шаг 4: Список клиентов (show ip hotspot) ---");
        const res = await this.client.get('/rci/show/ip/hotspot');

        if (res.status === 200) {
            let clients = res.data;

            // Нормализация ответа
            if (clients && !Array.isArray(clients) && typeof clients === 'object') {
                clients = clients.host || [];
            }
            if (!Array.isArray(clients)) {
                clients = [];
            }

            const activeClients = clients.filter(c => c.active);

            logger.info(`Найдено активных клиентов: ${activeClients.length}`);
            logger.debug("-".repeat(60));
            logger.debug(`${"IP Address".padEnd(16)} | ${"MAC Address".padEnd(18)} | ${"Hostname"}`);
            logger.debug("-".repeat(60));

            activeClients.forEach(client => {
                const ip = client.ip || 'N/A';
                const mac = client.mac || 'N/A';
                let name = client.name || '';
                const hostname = client.hostname || '';
                if (!name) name = hostname || 'Unknown';

                logger.debug(`${ip.padEnd(16)} | ${mac.padEnd(18)} | ${name}`);
            });

            return activeClients;
        } else {
            logger.error(`Ошибка получения списка клиентов: ${res.status}`);
            return [];
        }
    }
}

module.exports = KeeneticClient;

// --- Запуск ---
// logger.info('KeeneticClient module loaded.');
// logger.info('require.main === module:', require.main === module);

if (require.main === module) {
    (async () => {
        if (!ROUTER_IP || !LOGIN || !PASSWORD) {
            logger.error("Ошибка: Не заданы переменные окружения ROUTER_IP, LOGIN, PASSWORD");
            process.exit(1);
        }

        const keenetic = new KeeneticClient();
        const isAuth = await keenetic.authenticate();

        if (isAuth) {
            await keenetic.getSystemInfo();
            await keenetic.getHotspotClients();
        }
    })();
}
