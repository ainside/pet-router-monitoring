import os
from dotenv import load_dotenv
from tplinkrouterc6u import TplinkRouterProvider

# Загрузка переменных окружения
load_dotenv()

# --- Настройки ---
ROUTER_IP = os.getenv("ROUTER_IP")
LOGIN = os.getenv("LOGIN", "admin")
PASSWORD = os.getenv("PASSWORD")

def main():
    if not ROUTER_IP or not PASSWORD:
        print("Ошибка: Не заданы ROUTER_IP или PASSWORD в .env")
        return

    print(f"Подключение к роутеру {ROUTER_IP}...")
    
    # Инициализация клиента
    # Библиотека автоматически пытается определить тип шифрования
    try:
        # Важно: передаем http:// перед IP, библиотека этого требует
        router = TplinkRouterProvider.get_client(f'http://{ROUTER_IP}', PASSWORD, LOGIN)
    except Exception as e:
        print(f"Ошибка создания клиента: {e}")
        return

    try:
        # 1. Авторизация
        # TP-Link использует динамические ключи шифрования, поэтому авторизуемся при каждом запуске.
        # Сохранять куки (как в keenetic.py) здесь сложнее и менее надежно.
        router.authorize()
        print("Авторизация успешна!")

        # 2. Информация о системе
        print("\n--- Шаг 3: Информация о системе ---")
        try:
            status = router.get_status()
            hw_ver = getattr(status, 'hardware_version', 'N/A')
            fw_ver = getattr(status, 'firmware_version', 'N/A')
            print(f"Модель устройства: {hw_ver}")
            print(f"Версия прошивки: {fw_ver}")
        except Exception as e:
            print(f"Не удалось получить статус: {e}")

        # 3. Список клиентов
        print("\n--- Шаг 4: Список клиентов (DHCP Leases) ---")
        try:
            # Получаем список DHCP аренд (аналог списка устройств)
            leases = router.get_ipv4_dhcp_leases()
            
            print(f"Найдено записей DHCP: {len(leases)}")
            print("-" * 60)
            print(f"{'IP Address':<16} | {'MAC Address':<18} | {'Hostname'}")
            print("-" * 60)
            
            for lease in leases:
                # Обработка возможных пустых полей
                ip = lease.ipaddr if lease.ipaddr else "N/A"
                mac = lease.macaddr if lease.macaddr else "N/A"
                name = lease.hostname if lease.hostname else "Unknown"
                
                print(f"{ip:<16} | {mac:<18} | {name}")
        except Exception as e:
            print(f"Не удалось получить список клиентов: {e}")

    except Exception as e:
        print(f"\nКритическая ошибка: {e}")
        print("Совет: Проверьте IP адрес и пароль. Если роутер перезагружался, подождите пару минут.")
    
    finally:
        # Важно: TP-Link поддерживает только 1 админа одновременно.
        # Обязательно делаем logout, иначе веб-интерфейс будет недоступен некоторое время.
        if 'router' in locals():
            try:
                router.logout()
                print("\nСессия закрыта.")
            except:
                pass

if __name__ == "__main__":
    main()