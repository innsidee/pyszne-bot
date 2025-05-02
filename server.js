import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';
import sqlite3 from 'sqlite3';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// === ANTYSEN (PING) ===
setInterval(() => {
  fetch('https://pyszne-bot.onrender.com/').catch(() => {});
}, 14 * 60 * 1000); // co 14 minut

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// === BAZA ===
const db = new sqlite3.Database('./shifts.db');
db.run(`CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT,
  userId INTEGER,
  date TEXT,
  hours TEXT,
  zone TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

const knownZones = {
  "centrum": "Centrum",
  "ursus": "Ursus",
  "bemowo": "Bemowo/Bielany",
  "bielany": "Bemowo/Bielany",
  "białołęka": "Białołęka/Tarchomin",
  "tarchomin": "Białołęka/Tarchomin",
  "praga": "Praga",
  "rembertów": "Rembertów",
  "wawer": "Wawer",
  "służew": "Służew",
  "ursynów": "Ursynów",
  "wilanów": "Wilanów",
  "marki": "Marki",
  "legionowo": "Legionowo",
  "łomianki": "Łomianki"
};

function parseZone(text) {
  const lower = text.toLowerCase();
  for (const [key, val] of Object.entries(knownZones)) {
    if (lower.includes(key)) return val;
  }
  return null;
}

// === ZAPISYWANIE ZMIANY ===
bot.onText(/oddaj[eę]? zmian[ęe]? (.+)/i, (msg, match) => {
  const text = match[1];
  const chatId = msg.chat.id;
  const user = `${msg.from.first_name} ${msg.from.last_name || ''}`.trim();
  const userId = msg.from.id;

  const regex = /(\d{1,2}\.\d{1,2})[, ]+(\d{1,2}:\d{2})[-–](\d{1,2}:\d{2})[, ]+(.+)/;
  const found = text.match(regex);
  if (!found) {
    bot.sendMessage(chatId, `Nie rozumiem formatu. Podaj: oddaję zmianę 12.05, 15:00–19:00, strefa`);
    return;
  }

  const [_, date, start, end, zoneRaw] = found;
  const zone = parseZone(zoneRaw);
  if (!zone) {
    bot.sendMessage(chatId, `Nie rozpoznano strefy "${zoneRaw}".`);
    return;
  }

  const hours = `${start}–${end}`;
  db.run(
    `INSERT INTO shifts (user, userId, date, hours, zone) VALUES (?, ?, ?, ?, ?)`,
    [user, userId, date, hours, zone],
    function () {
      bot.sendMessage(chatId, `Zapisano: ${user}, ${date} ${hours}, ${zone}`);
    }
  );
});

// === ODCZYT ZMIAN ===
bot.onText(/zobacz zmiany (.+)/i, (msg, match) => {
  const zoneRaw = match[1];
  const zone = parseZone(zoneRaw);
  if (!zone) {
    bot.sendMessage(msg.chat.id, `Nie rozpoznano strefy "${zoneRaw}".`);
    return;
  }

  db.all(`SELECT * FROM shifts WHERE zone = ? ORDER BY date ASC`, [zone], (err, rows) => {
    if (!rows || rows.length === 0) {
      bot.sendMessage(msg.chat.id, `Brak dostępnych zmian w strefie ${zone}.`);
      return;
    }

    const list = rows.map(s => `${s.user}: ${s.date} ${s.hours}`).join('\n');
    bot.sendMessage(msg.chat.id, `Dostępne zmiany w strefie ${zone}:\n${list}`);
  });
});
