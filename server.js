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

// Таблицы
db.run(`CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  date TEXT,
  time TEXT,
  strefa TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  strefa TEXT
)`);

// Стрефы
const STREFY = [
  'Centrum', 'Ursus', 'Bemowo/Bielany', 'Białołęka/Tarchomin',
  'Praga', 'Rembertów', 'Wawer', 'Służew', 'Ursynów',
  'Wilanów', 'Marki', 'Legionowo', 'Łomianki'
];

const session = {};

// Начало
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, 'Cześć! Co chcesz zrobić?', {
    reply_markup: {
      keyboard: [['Oddaj zmianę', 'Zobacz zmiany'], ['Subskrybuj strefę']],
      resize_keyboard: true
    }
  });
});

// Subskrypcje
bot.onText(/Subskrybuj strefę/, msg => {
  bot.sendMessage(msg.chat.id, 'Wybierz strefę:', {
    reply_markup: {
      inline_keyboard: STREFY.map(s => [{ text: s, callback_data: 'sub_' + s }])
    }
  });
});

bot.on('callback_query', query => {
  const data = query.data;
  const chatId = query.message.chat.id;

  if (data.startsWith('sub_')) {
    const strefa = data.slice(4);
    db.run(`INSERT INTO subscriptions (user_id, strefa) VALUES (?, ?)`, [chatId, strefa]);
    bot.sendMessage(chatId, `Zapisano subskrypcję na: ${strefa}`);
  }

  if (data.startsWith('koord_')) {
    const takerId = data.split('_')[1];
    bot.sendMessage(takerId, 'Właściciel zmiany napisał do koordynatora!');
    bot.answerCallbackQuery(query.id, { text: 'Dzięki!' });
  }
});

// Oddanie zmiany
bot.onText(/Oddaj zmianę/, msg => {
  session[msg.chat.id] = {};
  bot.sendMessage(msg.chat.id, 'Wybierz strefę:', {
    reply_markup: {
      keyboard: STREFY.map(s => [s]),
      resize_keyboard: true
    }
  });
});

bot.on('message', msg => {
  const text = msg.text;
  const chatId = msg.chat.id;
  const user = msg.from.username || msg.from.first_name;

  const sess = session[chatId];

  if (sess && !sess.strefa && STREFY.includes(text)) {
    sess.strefa = text;
    return bot.sendMessage(chatId, 'Kiedy? (np. dzisiaj, jutro, albo 05.05)');
  }

  if (sess && sess.strefa && !sess.date) {
    const dzis = new Date();
    const jutro = new Date(Date.now() + 86400000);
    if (text.toLowerCase().includes('dzi')) {
      sess.date = dzis.toISOString().split('T')[0];
    } else if (text.toLowerCase().includes('jutro')) {
      sess.date = jutro.toISOString().split('T')[0];
    } else {
      const match = text.match(/(\d{1,2})[.\-/](\d{1,2})/);
      if (!match) return bot.sendMessage(chatId, 'Zły format daty. Napisz np. 05.05');
      const [_, d, m] = match;
      sess.date = `${dzis.getFullYear()}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    return bot.sendMessage(chatId, 'O jakich godzinach? (np. 11:00-19:00)');
  }

  if (sess && sess.date && !sess.time) {
    const match = text.match(/(\d{1,2}[:.]?\d{0,2})\D+(\d{1,2}[:.]?\d{0,2})/);
    if (!match) return bot.sendMessage(chatId, 'Zły format godzin. Napisz np. 11:00-19:00');
    const clean = x => x.replace(/[:.]/, ':').padEnd(5, '0').slice(0, 5);
    sess.time = `${clean(match[1])}–${clean(match[2])}`;
    db.run(`INSERT INTO shifts (username, date, time, strefa) VALUES (?, ?, ?, ?)`,
      [user, sess.date, sess.time, sess.strefa]);
    bot.sendMessage(chatId, `Zapisano: ${sess.date}, ${sess.time}, ${sess.strefa}`);
    notifySubscribers(sess.strefa, sess.date, sess.time);
    delete session[chatId];
    return;
  }

  // Zobacz zmiany
  if (text.includes('Zobacz zmiany')) {
    bot.sendMessage(chatId, 'Wybierz strefę:', {
      reply_markup: {
        keyboard: STREFY.map(s => [s]),
        resize_keyboard: true
      }
    });
    session[chatId] = { mode: 'view' };
    return;
  }

  if (session[chatId]?.mode === 'view' && STREFY.includes(text)) {
    db.all(`SELECT rowid, username, date, time FROM shifts WHERE strefa = ?`, [text], (err, rows) => {
      if (!rows.length) return bot.sendMessage(chatId, 'Brak zmian.');
      rows.forEach(row => {
        bot.sendMessage(chatId,
          `${row.rowid}: ${row.date} ${row.time}\nNapisał: @${row.username}\nChcesz przejąć tę zmianę?`,
          {
            reply_markup: {
              inline_keyboard: [[{ text: 'Przejmuję zmianę', callback_data: `take_${row.rowid}_${row.username}` }]]
            }
          });
      });
      delete session[chatId];
    });
    return;
  }
});

// Zabieranie zmiany
bot.on('callback_query', query => {
  const data = query.data;
  const chatId = query.message.chat.id;
  if (data.startsWith('take_')) {
    const [_, id, giver] = data.split('_');
    session[chatId] = { mode: 'take', shiftId: id, giver };
    bot.sendMessage(chatId, 'Podaj swoje imię, nazwisko i ID kuriera (np. Jan Kowalski 12345)');
  }
});

bot.on('message', msg => {
  const text = msg.text;
  const chatId = msg.chat.id;
  const sess = session[chatId];
  if (sess?.mode === 'take') {
    const [imie, nazwisko, idk] = text.split(' ');
    if (!imie || !nazwisko || !idk) return bot.sendMessage(chatId, 'Błąd formatu. Podaj np. Jan Kowalski 12345');
    bot.sendMessage(sess.giver, `@${msg.from.username} chce przejąć Twoją zmianę!\nDane: ${imie} ${nazwisko}, ${idk}`, {
      reply_markup: {
        inline_keyboard: [[{ text: 'Napisałem do koordynatora', callback_data: `koord_${chatId}` }]]
      }
    });
    bot.sendMessage(chatId, 'Dziękuję, właściciel zmiany dostał Twoje dane.');
    delete session[chatId];
  }
});

function notifySubscribers(strefa, date, time) {
  db.all(`SELECT user_id FROM subscriptions WHERE strefa = ?`, [strefa], (err, rows) => {
    rows.forEach(r => {
      bot.sendMessage(r.user_id, `Nowa zmiana w Twojej strefie ${strefa}:\n${date} ${time}`);
    });
  });
}

app.get('/', (_, res) => res.send('Działa.'));
app.listen(PORT, () => console.log('Serwer OK'));