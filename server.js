const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();

dotenv.config();

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;

const db = new sqlite3.Database('shifts.db');

// Инициализация таблицы
db.run(`
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    date TEXT,
    time TEXT,
    strefa TEXT
  )
`);

const STREFY = {
  centrum: ['centrum', 'center', 'central'],
  ursus: ['ursus'],
  'bemowo/bielany': ['bemowo', 'bielany', 'bemowo/bielany'],
  'białojęka/tarchomin': ['bialoleka', 'białoleka', 'tarchomin', 'bialoleka/tarchomin'],
  praga: ['praga'],
  rembertów: ['rembertow', 'rember'],
  wawer: ['wawer'],
  służew: ['sluzew', 'służew'],
  ursynów: ['ursynow', 'ursynów'],
  wilanów: ['wilanow', 'wilanów'],
  marki: ['marki'],
  legionowo: ['legionowo'],
  łomianki: ['lomianki', 'łomianki']
};

// Утилита для нормализации стрефы
function znajdzStrefe(msg) {
  const tekst = msg.toLowerCase();
  for (const [klucz, warianty] of Object.entries(STREFY)) {
    if (warianty.some(w => tekst.includes(w))) return klucz;
  }
  return null;
}

// Утилита для извлечения даты
function znajdzDate(msg) {
  const dzisiaj = new Date();
  const jutro = new Date(Date.now() + 86400000);

  if (msg.includes('dzisiaj') || msg.includes('dziś')) return dzisiaj.toISOString().slice(0, 10);
  if (msg.includes('jutro')) return jutro.toISOString().slice(0, 10);

  const regex = /(\d{1,2})[.\-/](\d{1,2})/;
  const match = msg.match(regex);
  if (match) {
    const [_, d, m] = match;
    const rok = new Date().getFullYear();
    return `${rok}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return null;
}

// Утилита для времени
function znajdzGodziny(msg) {
  const regex = /(\d{1,2}[:.]?\d{0,2})\D+(\d{1,2}[:.]?\d{0,2})/;
  const match = msg.match(regex);
  if (!match) return null;

  const clean = x => x.replace(/[:.]/, ':').padEnd(5, '0').slice(0, 5);
  return `${clean(match[1])}–${clean(match[2])}`;
}

// Обработка сообщений
// ... всё как раньше до строки bot.on('message'...

let pendingConfirmation = {};

bot.on('message', msg => {
  const text = msg.text.toLowerCase();
  const chatId = msg.chat.id;
  const user = msg.from.username || msg.from.first_name;

  // Проверка на подтверждение
  if (pendingConfirmation[chatId]) {
    if (text.includes('tak') || text.includes('zgadza')) {
      const { date, time, strefa } = pendingConfirmation[chatId];
      db.run('INSERT INTO shifts (username, date, time, strefa) VALUES (?, ?, ?, ?)', [user, date, time, strefa], err => {
        if (err) return bot.sendMessage(chatId, 'Błąd zapisu.');
        bot.sendMessage(chatId, `Zapisano: ${user}, ${date} ${time}, ${strefa}`);
        delete pendingConfirmation[chatId];
      });
      return;
    } else {
      bot.sendMessage(chatId, 'OK, nie zapisuję.');
      delete pendingConfirmation[chatId];
      return;
    }
  }

  // Смена
  if (text.includes('oddaj') || text.includes('oddaje')) {
    const strefa = znajdzStrefe(text);
    const date = znajdzDate(text);
    const time = znajdzGodziny(text);

    if (!strefa || !date || !time) {
      // Попытка догадаться
      if (strefa || date || time) {
        pendingConfirmation[chatId] = { strefa, date, time };
        return bot.sendMessage(chatId, `Nie rozumiem dokładnie. Czy chodzi Ci o: ${date || '?'}, ${time || '?'}, ${strefa || '?'}`);
      } else {
        return bot.sendMessage(chatId, 'Nie rozumiem formatu. Przykład: Oddaję 03.05 14:00–17:00 Praga');
      }
    }

    db.run('INSERT INTO shifts (username, date, time, strefa) VALUES (?, ?, ?, ?)', [user, date, time, strefa], err => {
      if (err) return bot.sendMessage(chatId, 'Błąd zapisu.');
      bot.sendMessage(chatId, `Zapisano: ${user}, ${date} ${time}, ${strefa}`);
    });
    return;
  }

  // Просмотр
  if (text.includes('zobacz zmiany')) {
    const strefa = znajdzStrefe(text);
    if (!strefa) return bot.sendMessage(chatId, 'Podaj nazwę strefy.');

    db.all('SELECT username, date, time FROM shifts WHERE strefa = ?', [strefa], (err, rows) => {
      if (err || !rows.length) return bot.sendMessage(chatId, `Brak dostępnych zmian w strefie ${strefa}.`);
      const list = rows.map(r => `${r.username}: ${r.date} ${r.time}`).join('\n');
      bot.sendMessage(chatId, `Dostępne zmiany w strefie ${strefa}:\n${list}`);
    
    });

    
  }
  
}); app.get('/', (req, res) => res.send('Bot działa.'));
app.listen(PORT, () => console.log(`Serwer działa na porcie ${PORT}`));

