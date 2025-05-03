const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const dotenv = require('dotenv');
dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const db = new sqlite3.Database('shifts.db');

// Strefy i ich warianty pisowni
const STREFY = {
  centrum: ['centrum', 'сentrum', 'center'],
  ursus: ['ursus'],
  'bemowo/bielany': ['bemowo', 'bielany', 'bemowo/bielany'],
  'białołęka/tarchomin': ['bialoleka', 'białołęka', 'tarchomin', 'bialoleka/tarchomin'],
  praga: ['praga', 'prage'],
  rembertów: ['rembertów', 'rember'],
  wawer: ['wawer'],
  służew: ['służew', 'sluzew'],
  ursynów: ['ursynów', 'ursynow'],
  wilanów: ['wilanów', 'wilanow'],
  marki: ['marki'],
  legionowo: ['legionowo', 'legionow'],
  łomianki: ['łomianki', 'lomianki']
};

function normalizujStrefe(tekst) {
  const lower = tekst.toLowerCase();
  for (const [strefa, warianty] of Object.entries(STREFY)) {
    if (warianty.some(w => lower.includes(w))) return strefa;
  }
  return null;
}

function extractDate(text) {
  const patterns = [
    /\b(\d{1,2}[./\- ]\d{1,2})\b/i,
    /\bdn\s*(\d{1,2}[./\- ]\d{1,2})\b/i,
    /\b(dziś|dzisiaj)\b/i,
    /\bjutro\b/i,
    /\b(?:pn|wt|śr|czw|pt|sb|nd|sobota|niedziela|poniedziałek)\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1] || match[0];
  }
  return null;
}

function extractTime(text) {
  const pattern = /(\d{1,2}[:.\s]?\d{0,2})\s*(?:-|do|–|—|–>)\s*(\d{1,2}[:.\s]?\d{0,2})/i;
  const match = text.match(pattern);
  if (match) {
    const from = match[1].replace(/[^\d]/g, ':').replace(/^(\d{1,2})$/, '$1:00');
    const to = match[2].replace(/[^\d]/g, ':').replace(/^(\d{1,2})$/, '$1:00');
    return `${from}–${to}`;
  }
  return null;
}

function initDb() {
  db.run(`CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    date TEXT,
    time TEXT,
    strefa TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    user_id INTEGER,
    strefa TEXT
  )`);
}
initDb();

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Siema! Wysyłaj mi zmianę w formacie np: "oddaję 03.05, 14:00–18:00, Bemowo" albo po ludzku typu "dziś 11:30–14 Praga", a ja ją ogarnę i rozeslę dalej. Możesz też zapisać się na powiadomienia: /powiadomienia_on Wilanów');
});

bot.onText(/\/powiadomienia_on (.+)/, (msg, match) => {
  const strefa = normalizujStrefe(match[1]);
  if (!strefa) return bot.sendMessage(msg.chat.id, 'Nie rozpoznano strefy.');
  db.run('INSERT INTO subscriptions (user_id, strefa) VALUES (?, ?)', [msg.from.id, strefa]);
  bot.sendMessage(msg.chat.id, `OK, będziesz dostawać powiadomienia o zmianach w strefie: ${strefa}`);
});

bot.onText(/\/powiadomienia_off (.+)/, (msg, match) => {
  const strefa = normalizujStrefe(match[1]);
  if (!strefa) return bot.sendMessage(msg.chat.id, 'Nie rozpoznano strefy.');
  db.run('DELETE FROM subscriptions WHERE user_id = ? AND strefa = ?', [msg.from.id, strefa]);
  bot.sendMessage(msg.chat.id, `Powiadomienia o ${strefa} wyłączone.`);
});

bot.onText(/\/powiadomienia_off_all/, (msg) => {
  db.run('DELETE FROM subscriptions WHERE user_id = ?', [msg.from.id]);
  bot.sendMessage(msg.chat.id, `Wszystkie powiadomienia wyłączone.`);
});

bot.on('message', (msg) => {
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  const strefa = normalizujStrefe(text);
  const date = extractDate(text);
  const time = extractTime(text);
  if (!strefa || !date || !time) return;

  db.get('SELECT * FROM shifts WHERE user_id = ? AND date = ? AND time = ? AND strefa = ?', [msg.from.id, date, time, strefa], (err, row) => {
    if (row) return bot.sendMessage(msg.chat.id, 'Już masz dodaną taką zmianę.');
    db.run('INSERT INTO shifts (user_id, username, date, time, strefa) VALUES (?, ?, ?, ?, ?)',
      [msg.from.id, msg.from.username || '', date, time, strefa]);

    bot.sendMessage(msg.chat.id, `Zapisano zmianę: ${date} / ${time} / ${strefa}`);

    db.all('SELECT user_id FROM subscriptions WHERE strefa = ?', [strefa], (err, rows) => {
      if (rows.length > 0) {
        rows.forEach(row => {
          if (row.user_id !== msg.from.id) {
            bot.sendMessage(row.user_id, `Nowa zmiana dostępna: ${date} / ${time} / ${strefa}`);
          }
        });
      }
    });
  });
});
