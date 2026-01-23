require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
                console.log(`Куки загружены из ${COOKIES_FILE}`);
                return true;
            } catch (e) {
                console.error(`Ошибка загрузки куки: ${e.message}`);
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
            console.log(`Куки сохранены в ${COOKIES_FILE}`);
        } catch (e) {
            console.error(`Ошибка сохранения куки: ${e.message}`);
        }
    }

    async authenticate() {
        // 1. Попытка восстановить сессию
        if (this.loadCookies()) {
            console.log("Проверка сохраненной сессии...");
            try {
                const res = await this.client.get('/rci/show/system');
                if (res.status === 200) {
                    console.log("Сессия валидна.");
                    return true;
                } else {
                    console.log(`Сессия устарела (код ${res.status}). Требуется повторная авторизация.`);
                }
            } catch (e) {
                console.log(`Ошибка при проверке сессии: ${e.message}`);
            }
        }

        // 2. Начало новой авторизации
        console.log("--- Шаг 1: Получение Challenge ---");
        const r1 = await this.client.get('/auth');
        
        const challenge = r1.headers['x-ndm-challenge'];
        const realm = r1.headers['x-ndm-realm'];
        const product = r1.headers['x-ndm-product'];

        console.log(`X-NDM-Challenge: ${challenge}`);
        console.log(`X-NDM-Realm: ${realm}`);
        console.log(`X-NDM-Product: ${product}`);

        if (!challenge || !realm) {
            console.error("Ошибка: не удалось получить данные для авторизации.");
            return false;
        }

        // 3. Вычисление хеша
        // Формула: SHA256(challenge + MD5(login + ":" + realm + ":" + password))
        const h1String = `${LOGIN}:${realm}:${PASSWORD}`;
        const h1 = getMd5(h1String);
        console.log(`MD5(${h1String}): ${h1}`);

        const finalHash = getSha256(challenge + h1);
        console.log(`\nВычисленный хеш: ${finalHash}`);

        // 4. Отправка хеша
        console.log("\n--- Шаг 2: Отправка хеша ---");
        const authData = {
            login: LOGIN,
            password: finalHash
        };

        const r2 = await this.client.post('/auth', authData);
        console.log(`Статус ответа: ${r2.status}`);

        if (r2.status === 200) {
            console.log("Авторизация успешна!");
            console.log("Полученные куки (сессия):", this.cookies);
            this.saveCookies();
            return true;
        } else {
            console.error("Ошибка авторизации!");
            return false;
        }
    }

    async getSystemInfo() {
        console.log("\n--- Шаг 3: Тестовый запрос (show system) ---");
        const res = await this.client.get('/rci/show/system');
        if (res.status === 200) {
            const data = res.data;
            // console.log('DEBUG:', JSON.stringify(data, null, 2)); // Uncomment for debug
            console.log(`Модель устройства: ${data.model}`);
            console.log(`Версия ОС: ${data.release}`);
            console.log(`Аптайм: ${data.uptime} сек.`);
        } else {
            console.log(`Ошибка RCI: ${res.status}`);
        }
    }

    async getHotspotClients() {
        console.log("\n--- Шаг 4: Список клиентов (show ip hotspot) ---");
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

            console.log(`Найдено активных клиентов: ${activeClients.length}`);
            console.log("-".repeat(60));
            console.log(`${"IP Address".padEnd(16)} | ${"MAC Address".padEnd(18)} | ${"Hostname"}`);
            console.log("-".repeat(60));

            activeClients.forEach(client => {
                const ip = client.ip || 'N/A';
                const mac = client.mac || 'N/A';
                let name = client.name || '';
                const hostname = client.hostname || '';
                if (!name) name = hostname || 'Unknown';

                console.log(`${ip.padEnd(16)} | ${mac.padEnd(18)} | ${name}`);
            });
        } else {
            console.log(`Ошибка получения списка клиентов: ${res.status}`);
        }
    }
}

module.exports = KeeneticClient;

// --- Запуск ---
// console.log('KeeneticClient module loaded.');
// console.log('require.main === module:', require.main === module);

if (require.main === module) {
    (async () => {
        if (!ROUTER_IP || !LOGIN || !PASSWORD) {
            console.error("Ошибка: Не заданы переменные окружения ROUTER_IP, LOGIN, PASSWORD");
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
