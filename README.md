# F1 Calendar Application

Modern F1 verseny naptár alkalmazás automatikus ICS szinkronizációval.

## Funkciók

- 📅 F1 verseny időpontok megjelenítése
- 🔄 Automatikus óránkénti frissítés az ICS feed-ből
- 🎨 Modern, egyszerű web design
- 📊 SQLite adatbázis
- ⚡ React + Vite frontend
- 🚀 Node.js + Express backend

## Telepítés

1. Függőségek telepítése:
```bash
npm install
cd client && npm install && cd ..
```

2. Alkalmazás indítása fejlesztői módban:
```bash
npm run dev
```

A backend a `http://localhost:3000` címen, a frontend a `http://localhost:5173` címen fog futni.

## Használat

Az alkalmazás automatikusan szinkronizálja az F1 verseny időpontokat a better-f1-calendar ICS feed-ből óránként.

## Projekt struktúra

```
├── server/
│   ├── index.js          # Express szerver
│   ├── db.js             # SQLite database
│   ├── icsParser.js      # ICS file parser
│   └── scheduler.js      # Cron job
├── client/
│   ├── src/
│   │   ├── App.jsx       # Fő komponens
│   │   ├── main.jsx      # Entry point
│   │   └── App.css       # Stílusok
│   └── index.html
└── package.json
```
