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

// Словарь с вариантами написания стреф
const STREFY = {
  centrum: ['centrum', 'centr', 'center'],
  ursus: ['ursus'],
  'bemowo/bielany': ['bemowo', 'bielany', 'bemowo/bielany'],
  'białołęka/tarchomin': ['białołęka', 'bialoleka', 'tarchomin', 'bialoleka/tarchomin'],
  praga: ['praga'],
  rembertów: ['rembertów', 'rember'],
  wawer: ['wawer'],
  służew: ['służew', 'sluzew'],
  ursynów: ['ursynów', 'ursynow'],
  wilanów: ['wilanów', 'wilanow'],
  marki: ['marki'],
  legionowo: ['legionowo'],
  łomianki: ['łomianki', 'lomianki']
};

// Нормализует текст в нижний регистр и убирает лишние пробелы
function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Поиск стрефы по любому написанию
function znajdzStrefe(input) {
  const norm = normalize(input);
  for (const [strefa, warianty] of Object.entries(STREFY)) {
    if (warianty.some(v => norm.includes(v))) return strefa;
  }
  return null;
}

// Создание таблицы при запуске, если не существует
db.run(`CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT,
  strefa TEXT,
  data TEXT,
  godziny TEXT
)`);

// Обработка сообщений
bot.on('message', (msg) => {
  const text = msg.text;
  const user = msg.from.username || msg.from.first_name;

  // Проверка на добавление смены
  if (/oddaj/i.test(text)) {
    const strefa = znajdzStrefe(text);
    const dataMatch = text.match(/(\d{1,2}[./-]\d{1,2}|\bjutro\b|\bdziś\b)/i);
    const godzinyMatch = text.match(/(\d{1,2}[:.]\d{2})\s*[-–]\s*(\d{1,2}[:.]\d{2})/);

    if (!strefa || !dataMatch || !godzinyMatch) {
      bot.sendMessage(msg.chat.id, 'Nie rozumiem formatu. Przykład: Oddaję 03.05 14:00–17:00 Praga');
      return;
    }

    const data = normalize(dataMatch[1]);
    const godziny = `${godzinyMatch[1].replace('.', ':')}–${godzinyMatch[2].replace('.', ':')}`;

    db.run(`INSERT INTO shifts (user, strefa, data, godziny) VALUES (?, ?, ?, ?)`,
      [user, strefa, data, godziny]);

    bot.sendMessage(msg.chat.id, `Zapisano: ${user}, ${data} ${godziny}, ${strefa}`);
    return;
  }

  // Проверка на просмотр смен
  const zobaczMatch = text.match(/zobacz zmiany (.+)/i);
  if (zobaczMatch) {
    const strefa = znajdzStrefe(zobaczMatch[1]);
    if (!strefa) {
      bot.sendMessage(msg.chat.id, 'Nie rozpoznano strefy.');
      return;
    }

    db.all(`SELECT user, data, godziny FROM shifts WHERE strefa = ?`, [strefa], (err, rows) => {
      if (err) {
        bot.sendMessage(msg.chat.id, 'Błąd podczas pobierania zmian.');
        return;
      }

      if (rows.length === 0) {
        bot.sendMessage(msg.chat.id, `Brak dostępnych zmian w strefie ${strefa}.`);
        return;
      }

      const lista = rows.map(r => `${r.user}: ${r.data} ${r.godziny}`).join('\n');
      bot.sendMessage(msg.chat.id, `Dostępne zmiany w strefie ${strefa}:\n${lista}`);
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
