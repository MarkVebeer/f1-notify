# Időjárás Értesítés Rendszer Problémái

## 1. **KRITIKUS HIBA: WORKER_INTERVAL_MS nem definiálva a runWeatherNotifications kontextusában**
- **Fájl:** [server/weatherWorker.js](server/weatherWorker.js#L7)
- **Probléma:** A `WORKER_INTERVAL_MS` (60 * 1000 = 60000 ms = 1 perc) csak az adott fájlban van definiálva, de a scheduler minden percben futtatja a `runWeatherNotifications()`-t.
- **Hatás:** Az időjárás értesítés akkor küldődik el, ha: `now < scheduledTimeUtc || now >= windowEnd`
  - `windowEnd = scheduledTimeUtc + 60000` (1 perc)
  - Ez azt jelenti, hogy az értesítés csak egy 1 perces ablakban fog elküldödni!
  - Ha a scheduler 1 percet késik vagy az idő múlása miatt kihagyja ezt az ablakot, az értesítés nem kerül elküldésre.

## 2. **DESIGN HIBA: Túl szűk időablak az értesítésekhez**
- Az 1 perces ablak túl szűk a megbízható futtatáshoz:
  - Hálózati késések
  - Adatbázis queries ideje
  - Meteoblue API hívások (timeout lehetséges)
  - Dátum/idő számítások
  - Discord API hívások
- **Ajánlás:** Növelni az ablakot legalább 5-10 percre

## 3. **FRONTEND PROBLÉMA: Bekapcsolás/kikapcsolás logika nem teljes**
- **Fájl:** [client/src/App.jsx](client/src/App.jsx#L1274)
- A frontend-en van egy "Aktív" checkbox, amely működik, de:
  - Az `enabled` mező értéke SQLite-ben INTEGER (0/1) formában tárolódik
  - A `getWeatherConfigByGuild()` megfelelően konvertálja: `Boolean(row.enabled)`
  - Ez működik, VISZONT az API save után újra betöltődik a config

## 4. **POTENCIÁLIS SZINKRONIZÁCIÓS HIBA: `enabled` mezőhöz nincs default érték**
- **Fájl:** [server/discordDb.js](server/discordDb.js#L63-L73)
- Új guild-ek számára az `enabled` mezőhöz van default érték: `DEFAULT 0` (kikapcsolt)
- Ez OK, de a `/api/discord/weather-config` POST végpont elküld `enabled: false` értékeket

## 5. **RACE DAY WEATHER NOTIFICATION - Nincs külön ellenőrzés az aktiváláshoz**
- **Fájl:** [server/weatherWorker.js](server/weatherWorker.js#L339)
- A `runRaceDayWeatherNotifications()` nem ellenőrzi a `weatherConfig.enabled` mezőt!
- Csak azt nézz, hogy van-e `race_day_lead_minutes`:
  ```javascript
  if (!weatherConfig.race_day_lead_minutes) {
    continue;
  }
  ```
- Ez azt jelenti: ha `enabled: false` de `race_day_lead_minutes: 30`, akkor az értesítés el fog küldödni!

## 6. **SZINKRONIZÁCIÓS INKONZISZTENCIA: Weather config megjelenítése**
- **Fájl:** [client/src/App.jsx](client/src/App.jsx#L1274-L1289)
- A `setWeatherConfig()` estado setter a checkbox-ra: `checked={weatherConfig.enabled}`
- De az `enabled` tulajdonság lehet:
  - `true` / `false` (JS boolean)
  - `1` / `0` (SQLite integer)
  - `undefined` / `null`
- A checkbox rendering-nél ez problémát okozhat

## Megoldások:
1. Nagyobb időablak az értesítésekhez
2. Race day weather notification-t is ellenőrizni kell az `enabled` mezővel
3. Konziszten kezelni a boolean értékeket frontend és backend között
4. Jobb error handling és logging az időjárás értesítés logikában
