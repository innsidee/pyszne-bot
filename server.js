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

db.run(`
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    date TEXT,
    time TEXT,
    strefa TEXT,
    taker_username TEXT,
    taker_id TEXT,
    taker_fullname TEXT
  )
`);

const STREFY = {
  centrum: ['centrum', 'central', 'center'],
  ursus: ['ursus'],
  'bemowo/bielany': ['bemowo', 'bielany'],
  'białojęka/tarchomin': ['bialoleka', 'białoleka', 'tarchomin'],
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

function znajdzStrefe(text) {
  text = text.toLowerCase();
  for (const [strefa, aliasy] of Object.entries(STREFY)) {
    if (aliasy.some(alias => text.includes(alias))) return strefa;
  }
  return null;
}

function znajdzDate(text) {
  const dzisiaj = new Date();
  const jutro = new Date(Date.now() + 86400000);
  if (text.includes('dziś') || text.includes('dzisiaj')) return dzisiaj.toISOString().split('T')[0];
  if (text.includes('jutro')) return jutro.toISOString().split('T')[0];
  const regex = /(\d{1,2})[.\-/](\d{1,2})/;
  const match = text.match(regex);
  if (match) {
    const rok = new Date().getFullYear();
    const [_, d, m] = match;
    return `${rok}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

function znajdzGodziny(text) {
  const regex = /(\d{1,2}[:.]?\d{0,2})\D+(\d{1,2}[:.]?\d{0,2})/;
  const match = text.match(regex);
  if (!match) return null;
  const format = x => x.replace(/[:.]/g, ':').padEnd(5, '0').slice(0, 5);
  return `${format(match[1])}–${format(match[2])}`;
}

let pendingConfirmation = {};
let pendingTaker = {};

bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Cześć! Wybierz akcję:', {
    reply_markup: {
      keyboard: [['Zobacz zmiany', 'Oddaj zmianę']],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
});

bot.on('message', msg => {
  const text = msg.text.toLowerCase();
  const chatId = msg.chat.id;
  const user = msg.from.username || msg.from.first_name;

  if (pendingConfirmation[chatId]) {
    if (text.includes('tak') || text.includes('zgadza')) {
      const { date, time, strefa } = pendingConfirmation[chatId];
      db.run('INSERT INTO shifts (username, date, time, strefa) VALUES (?, ?, ?, ?)', [user, date, time, strefa], () => {
        bot.sendMessage(chatId, `Zapisano zmianę: ${date} ${time}, ${strefa}`);
        delete pendingConfirmation[chatId];
      });
    } else {
      bot.sendMessage(chatId, 'OK, nie zapisuję.');
      delete pendingConfirmation[chatId];
    }
    return;
  }

  if (pendingTaker[chatId]) {
    const { giverId, shiftId } = pendingTaker[chatId];
    const [imie, nazwisko, idKuriera] = text.split(' ');
    if (!imie || !nazwisko || !idKuriera) {
      return bot.sendMessage(chatId, 'Podaj dane w formacie: Imię Nazwisko ID');
    }
    db.get('SELECT * FROM shifts WHERE id = ?', [shiftId], (err, row) => {
      if (!row) return bot.sendMessage(chatId, 'Zmiana nie istnieje.');
      bot.sendMessage(giverId, `Ktoś chce przejąć Twoją zmianę!\nImię i nazwisko: ${imie} ${nazwisko}\nID: ${idKuriera}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Napisałem do koordynatora', callback_data: `potwierdz_${chatId}` }
          ]]
        }
      });
      bot.sendMessage(chatId, 'Dzięki! Właściciel zmiany otrzymał Twoje dane.');
    });
    delete pendingTaker[chatId];
    return;
  }

  if (text.includes('oddaj')) {
    const strefa = znajdzStrefe(text);
    const date = znajdzDate(text);
    const time = znajdzGodziny(text);

    if (!strefa || !date || !time) {
      if (strefa || date || time) {
        pendingConfirmation[chatId] = { strefa, date, time };
        return bot.sendMessage(chatId, `Czy chodziło Ci o: ${date || '?'}, ${time || '?'}, ${strefa || '?'}`);
      }
      return bot.sendMessage(chatId, 'Nie rozumiem. Napisz np. „Oddaję 05.05 14:00–18:00 Praga”');
    }

    db.run('INSERT INTO shifts (username, date, time, strefa) VALUES (?, ?, ?, ?)', [user, date, time, strefa], () => {
      bot.sendMessage(chatId, `Zapisano zmianę: ${date} ${time}, ${strefa}`);
    });
    return;
  }

  if (text.includes('zobacz zmiany')) {
    const strefa = znajdzStrefe(text);
    if (!strefa) return bot.sendMessage(chatId, 'Podaj strefę.');
    db.all('SELECT id, username, date, time FROM shifts WHERE strefa = ?', [strefa], (err, rows) => {
      if (!rows || !rows.length) return bot.sendMessage(chatId, 'Brak zmian.');
      const list = rows.map(r => `${r.id}: ${r.date} ${r.time} (${r.username})`).join('\n');
      bot.sendMessage(chatId, `Dostępne zmiany:\n${list}\n\nNapisz np. „Chcę zmianę 3”`);
    });
    return;
  }

  if (text.includes('chcę zmianę')) {
    const id = parseInt(text.split(' ').pop());
    if (!id) return;
    db.get('SELECT * FROM shifts WHERE id = ?', [id], (err, row) => {
      if (!row) return bot.sendMessage(chatId, 'Nie ma takiej zmiany.');
      pendingTaker[chatId] = { giverId: row.username, shiftId: id };
      bot.sendMessage(chatId, 'Podaj swoje imię, nazwisko i ID (np. Jan Kowalski 12345)');
    });
  }
});

bot.on('callback_query', query => {
  const data = query.data;
  if (data.startsWith('potwierdz_')) {
    const takerChatId = data.split('_')[1];
    bot.sendMessage(takerChatId, 'Właściciel zmiany napisał do koordynatora. Sprawdź aplikację!');
    bot.answerCallbackQuery(query.id, { text: 'Dzięki!' });
  }
});

app.get('/', (req, res) => res.send('Bot działa.'));
app.listen(PORT, () => console.log(`Serwer działa na porcie ${PORT}`));
