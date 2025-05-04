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

// Таблица смен
db.run(`CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  date TEXT,
  time TEXT,
  strefa TEXT
)`);

// Подписки
db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
  user_id INTEGER,
  strefa TEXT
)`);

const STREFY = [
  'Centrum', 'Ursus', 'Bemowo/Bielany', 'Białołęka/Tarchomin',
  'Praga', 'Rembertów', 'Wawer', 'Służew', 'Ursynów', 'Wilanów',
  'Marki', 'Legionowo', 'Łomianki'
];

const state = {};

function sendReset(chatId) {
  bot.sendMessage(chatId, 'Wybierz strefę:', {
    reply_markup: {
      keyboard: STREFY.map(s => [s]).concat([['⏪ Cofnij'], ['❌ Anuluj']]),
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
  state[chatId] = { step: 'strefa' };
}

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, 'Cześć! Witaj w asystencie zmian. Wpisz /oddaj, aby oddać zmianę, lub /sub, by zapisać się na powiadomienia.');
});

bot.onText(/\/oddaj/, msg => {
  sendReset(msg.chat.id);
});

bot.onText(/\/sub/, msg => {
  bot.sendMessage(msg.chat.id, 'Wybierz strefę, którą chcesz subskrybować:', {
    reply_markup: {
      keyboard: STREFY.map(s => [s]),
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
  state[msg.chat.id] = { step: 'sub' };
});

bot.on('message', msg => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const username = msg.from.username || msg.from.first_name;

  if (text === '❌ Anuluj') {
    delete state[chatId];
    return bot.sendMessage(chatId, 'Anulowano.');
  }

  if (text === '⏪ Cofnij') {
    sendReset(chatId);
    return;
  }

  const userState = state[chatId];
  if (!userState) return;

  if (userState.step === 'sub') {
    if (STREFY.includes(text)) {
      db.run('INSERT INTO subscriptions (user_id, strefa) VALUES (?, ?)', [chatId, text]);
      bot.sendMessage(chatId, `Zapisano subskrypcję na strefę: ${text}`);
      delete state[chatId];
    }
    return;
  }

  if (userState.step === 'strefa') {
    if (STREFY.includes(text)) {
      state[chatId] = { ...userState, step: 'data', strefa: text };
      bot.sendMessage(chatId, 'Podaj datę (np. 05.05 lub dzisiaj/jutro):');
    }
    return;
  }

  if (userState.step === 'data') {
    const today = new Date();
    let date = null;
    if (text.toLowerCase().includes('dzis')) date = today.toISOString().split('T')[0];
    else if (text.toLowerCase().includes('jutro')) {
      const jutro = new Date(today.getTime() + 86400000);
      date = jutro.toISOString().split('T')[0];
    } else {
      const match = text.match(/(\d{1,2})[.\-/](\d{1,2})/);
      if (match) {
        const [_, d, m] = match;
        const year = new Date().getFullYear();
        date = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      }
    }

    if (!date) return bot.sendMessage(chatId, 'Nie rozumiem daty. Podaj np. 05.05 lub dzisiaj.');

    state[chatId] = { ...userState, step: 'godzina', date };
    bot.sendMessage(chatId, 'Podaj godziny (np. 12:00–16:00):');
    return;
  }

  if (userState.step === 'godzina') {
    const match = text.match(/(\d{1,2}[:.]?\d{0,2})\D+(\d{1,2}[:.]?\d{0,2})/);
    if (!match) return bot.sendMessage(chatId, 'Nie rozumiem godzin. Przykład: 12:00–16:00');
    const fix = x => x.replace(/[:.]/g, ':').padEnd(5, '0').slice(0, 5);
    const time = `${fix(match[1])}–${fix(match[2])}`;

    const { strefa, date } = userState;
    db.run('INSERT INTO shifts (username, date, time, strefa) VALUES (?, ?, ?, ?)', [username, date, time, strefa]);
    bot.sendMessage(chatId, `Oddano zmianę: ${strefa}, ${date}, ${time}`);

    // Powiadom subskrybentów
    db.all('SELECT user_id FROM subscriptions WHERE strefa = ?', [strefa], (err, rows) => {
      rows.forEach(r => {
        if (r.user_id != chatId) {
          bot.sendMessage(r.user_id, `Hej, wleciała nowa zmiana w twojej strefie ${strefa}!\n${date}, ${time}\nPośpiesz się, zanim ktoś ją weźmie!`);
        }
      });
    });

    delete state[chatId];
    return;
  }
});

app.get('/', (req, res) => res.send('Bot działa'));
app.listen(PORT, () => console.log(`Serwer na porcie ${PORT}`));