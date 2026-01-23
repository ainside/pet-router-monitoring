-- CreateTable
CREATE TABLE "Client" (
    "mac" TEXT NOT NULL PRIMARY KEY,
    "ip" TEXT,
    "name" TEXT,
    "hostname" TEXT,
    "interface" TEXT,
    "ssid" TEXT,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "firstSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStatusChange" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalOnlineSeconds" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "Event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" TEXT,
    "clientMac" TEXT NOT NULL,
    CONSTRAINT "Event_clientMac_fkey" FOREIGN KEY ("clientMac") REFERENCES "Client" ("mac") ON DELETE RESTRICT ON UPDATE CASCADE
);
