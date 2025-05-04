const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const util = require('util');

dotenv.config();
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error('TELEGRAM_TOKEN nie ustawiony w .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const app = express();
const PORT = process.env.PORT || 3000;

const db = new sqlite3.Database('shifts.db', (err) => {
  if (err) {
    console.error('Błąd DB:', err);
    process.exit(1);
  }
});
db.run = util.promisify(db.run);
db.all = util.promisify(db.all);

const STREFY = ['Centrum', 'Ursus', 'Bemowo/Bielany', 'Białołęka/Tarchomin', 'Praga', 'Rembertów', 'Wawer', 'Służew', 'Ursynów', 'Wilanów', 'Marki', 'Legionowo', 'Łomianki'];
const session = {};
const lastCommand = {};

const mainKeyboard = {
  reply_markup: {
    keyboard: [['Oddaj zmianę', 'Zobaczyć zmiany'], ['Subskrybuj strefę']],
    resize_keyboard: true,
  },
};
const zonesKeyboard = {
  reply_markup: {
    keyboard: [...STREFY.map(s => [s]), ['Powrót']],
    resize_keyboard: true,
  },
};

async function initializeDatabase() {
  await db.run(`CREATE TABLE IF NOT EXISTS shifts (id INTEGER PRIMARY KEY, username TEXT, date TEXT, time TEXT, strefa TEXT)`);
  await db.run(`CREATE TABLE IF NOT EXISTS subscriptions (id INTEGER PRIMARY KEY, user_id INTEGER, strefa TEXT)`);
}
initializeDatabase();

process.on('SIGINT', () => {
  db.close(() => process.exit(0));
});

// Команда /start
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, 'Cześć! Co chcesz zrobić?', mainKeyboard);
});

// Команда /cancel
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const sess = session[chatId];
  if (sess?.messagesToDelete) {
    for (const id of sess.messagesToDelete) await bot.deleteMessage(chatId, id).catch(() => {});
  }
  if (sess?.userMessages) {
    for (const id of sess.userMessages) await bot.deleteMessage(chatId, id).catch(() => {});
  }
  delete session[chatId];
  await bot.sendMessage(chatId, 'Operacja anulowana.', mainKeyboard);
});

// Подписка на зону
bot.onText(/Subskrybuj strefę/, async (msg) => {
  const message = await bot.sendMessage(msg.chat.id, 'Wybierz strefę:', {
    reply_markup: {
      inline_keyboard: STREFY.map(s => [{ text: s, callback_data: `sub_${s}` }]),
    },
  });
  session[msg.chat.id] = { messagesToDelete: [message.message_id], userMessages: [] };
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('sub_')) {
    const strefa = data.slice(4);
    await db.run(`INSERT INTO subscriptions (user_id, strefa) VALUES (?, ?)`, [chatId, strefa]);
    await bot.sendMessage(chatId, `Zapisano subskrypcję na: ${strefa}`, mainKeyboard);
    if (session[chatId]?.messagesToDelete) {
      for (const id of session[chatId].messagesToDelete) await bot.deleteMessage(chatId, id).catch(()