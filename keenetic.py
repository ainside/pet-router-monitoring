import requests
import hashlib
import json
import os
from dotenv import load_dotenv

# Загрузка переменных окружения
load_dotenv()

# --- Настройки ---
ROUTER_IP = os.getenv("ROUTER_IP")
LOGIN = os.getenv("LOGIN")
PASSWORD = os.getenv("PASSWORD")
COOKIES_FILENAME = os.getenv("COOKIES_FILE", "auth_cookies.json")
DATA_DIR = "data"
COOKIES_FILE = os.path.join(DATA_DIR, COOKIES_FILENAME)

def get_md5(data):
    return hashlib.md5(data.encode('utf-8')).hexdigest()

def get_sha256(data):
    return hashlib.sha256(data.encode('utf-8')).hexdigest()

def save_cookies(session, filename):
    try:
        # Убедимся, что папка существует
        os.makedirs(os.path.dirname(filename), exist_ok=True)
        with open(filename, 'w') as f:
            json.dump(session.cookies.get_dict(), f)
        print(f"Куки сохранены в {filename}")
    except Exception as e:
        print(f"Ошибка сохранения куки: {e}")

def load_cookies(session, filename):
    if os.path.exists(filename):
        try:
            with open(filename, 'r') as f:
                cookies = json.load(f)
                session.cookies.update(cookies)
            print(f"Куки загружены из {filename}")
            return True
        except Exception as e:
            print(f"Ошибка загрузки куки: {e}")
    return False

def authenticate():
    session = requests.Session()
    
    # Попытка восстановить сессию
    if load_cookies(session, COOKIES_FILE):
        print("Проверка сохраненной сессии...")
        try:
            # Проверяем валидность сессии запросом информации о системе
            check_url = f"http://{ROUTER_IP}/rci/show/system"
            r = session.get(check_url, timeout=5)
            if r.status_code == 200:
                print("Сессия валидна.")
                return session
            else:
                print(f"Сессия устарела (код {r.status_code}). Требуется повторная авторизация.")
        except Exception as e:
            print(f"Ошибка при проверке сессии: {e}")

    auth_url = f"http://{ROUTER_IP}/auth"

    # 1. Первый GET запрос для получения соли (Challenge)
    print("--- Шаг 1: Получение Challenge ---")
    r1 = session.get(auth_url)
    
    challenge = r1.headers.get('X-NDM-Challenge')
    realm = r1.headers.get('X-NDM-Realm')
    product = r1.headers.get('X-NDM-Product')
    
    print(f"X-NDM-Challenge: {challenge}")
    print(f"X-NDM-Realm: {realm}")
    print(f"X-NDM-Product: {product}")

    if not challenge or not realm:
        print("Ошибка: не удалось получить данные для авторизации.")
        return None

    # 2. Вычисление хеша
    # Формула: SHA256(challenge + MD5(login + ":" + realm + ":" + password))
    h1_string = f"{LOGIN}:{realm}:{PASSWORD}"
    h1 = get_md5(h1_string)
    print(f"MD5({h1_string}): {h1}")
    
    final_hash = get_sha256(challenge + h1)
    print(f"\nВычисленный хеш: {final_hash}")

    # 3. POST запрос для авторизации
    print("\n--- Шаг 2: Отправка хеша ---")
    auth_data = {
        "login": LOGIN,
        "password": final_hash
    }
    
    r2 = session.post(auth_url, json=auth_data)
    
    print(f"Статус ответа: {r2.status_code}")
    
    # Проверяем куки (Session ID сохраняется в них автоматически в объекте session)
    if r2.status_code == 200:
        print("Авторизация успешна!")
        print("Полученные куки (сессия):", session.cookies.get_dict())
        save_cookies(session, COOKIES_FILE)
        return session
    else:
        print("Ошибка авторизации!")
        return None

# --- Пример использования ---
if __name__ == "__main__":
    authorized_session = authenticate()
    
    if authorized_session:
        # Пробуем получить информацию о системе
        print("\n--- Шаг 3: Тестовый запрос (show system) ---")
        api_url = f"http://{ROUTER_IP}/rci/show/system"
        response = authorized_session.get(api_url)
        
        if response.status_code == 200:
            data = response.json()
            print(f"Модель устройства: {data.get('model')}")
            print(f"Версия ОС: {data.get('release')}")
            print(f"Аптайм: {data.get('uptime')} сек.")
        else:
            print(f"Ошибка RCI: {response.status_code}")

        # Получение списка клиентов (show ip hotspot)
        print("\n--- Шаг 4: Список клиентов (show ip hotspot) ---")
        hotspot_url = f"http://{ROUTER_IP}/rci/show/ip/hotspot"
        resp_hotspot = authorized_session.get(hotspot_url)

        if resp_hotspot.status_code == 200:
            clients = resp_hotspot.json()
            # Ответ может быть списком или объектом, содержащим список. Обычно это список объектов.
            # На всякий случай проверим структуру, но обычно это просто список хостов.
            
            # В некоторых версиях API ответ может быть обернут.
            # Если clients это словарь (dict), попробуем найти в нем список.
            if isinstance(clients, dict):
                 # Иногда бывает так: {"host": [...]}
                 clients = clients.get('host', [])
            
            # Фильтруем только активных клиентов
            active_clients = [c for c in clients if c.get('active')]

            print(f"Найдено активных клиентов: {len(active_clients)}")
            print("-" * 60)
            print(f"{'IP Address':<16} | {'MAC Address':<18} | {'Hostname'}")
            print("-" * 60)
            
            for client in active_clients:
                ip = client.get('ip', 'N/A')
                mac = client.get('mac', 'N/A')
                name = client.get('name', '')
                hostname = client.get('hostname', '')
                if not name:
                    name = client.get('hostname', 'Unknown')
                
                print(f"{ip:<16} | {mac:<18} | {hostname}")
        else:
            print(f"Ошибка получения списка клиентов: {resp_hotspot.status_code}")

     