# Обновленный план реализации мониторинга (с учетом таймингов)

Я добавлю в проект базу данных SQLite и логику отслеживания активности с расчетом времени пребывания в сети/вне сети.

## 1. Настройка базы данных (Prisma + SQLite)
*   **Установка**: `npm install prisma @prisma/client`.
*   **Схема данных**:
    *   Добавляем поля для подсчета времени: `lastStatusChange` (время последнего изменения статуса) и `totalOnlineSeconds` (общее время онлайн).

```prisma
model Client {
  mac              String   @id
  ip               String?
  name             String?
  hostname         String?
  interface        String?
  ssid             String?
  
  isOnline         Boolean  @default(false)
  firstSeen        DateTime @default(now())
  lastSeen         DateTime @default(now())
  
  // Для подсчета длительности
  lastStatusChange DateTime @default(now()) 
  totalOnlineSeconds Int    @default(0)

  events           Event[]
}

model Event {
  id        Int      @id @default(autoincrement())
  type      String   // CONNECTED, DISCONNECTED, UPDATED
  timestamp DateTime @default(now())
  details   String?  // Например: "Online for 1h 20m", "Offline for 5h"
  client    Client   @relation(fields: [clientMac], references: [mac])
  clientMac String
}
```

## 2. Обновление `KeeneticClient`
*   Модификация `getHotspotClients` для возврата данных (массив объектов), а не только логирования.

## 3. Реализация логики (`monitor.js`)
Сервис будет рассчитывать длительность при смене статуса:

1.  **Клиент подключился (Offline -> Online)**:
    *   Вычисляем `offlineDuration = now - lastStatusChange`.
    *   Обновляем `lastStatusChange = now`.
    *   Создаем событие `CONNECTED` (в деталях: "Был офлайн: X мин").

2.  **Клиент отключился (Online -> Offline)**:
    *   Вычисляем `sessionDuration = now - lastStatusChange`.
    *   Обновляем `lastStatusChange = now`.
    *   Добавляем `sessionDuration` к `totalOnlineSeconds`.
    *   Создаем событие `DISCONNECTED` (в деталях: "Был онлайн: X мин").

3.  **Обновление (Online -> Online)**:
    *   Просто обновляем `lastSeen`.
    *   Если изменились параметры (IP, интерфейс) — событие `UPDATED`.

## 4. Интеграция
*   Подключение сервиса в `service.js`.

Готов приступить к установке и кодированию.