const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const util = require('util');

// Загрузка переменных окружения
dotenv.config();
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error('TELEGRAM_TOKEN не указан в .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const app = express();
const PORT = process.env.PORT || 3000;

// Инициализация базы данных
const db = new sqlite3.Database('shifts.db', (err) => {
  if (err) {
    console.error('Ошибка подключения к базе данных:', err);
    process.exit(1);
  }
});

// Промисификация методов SQLite
db.run = util.promisify(db.run);
db.all = util.promisify(db.all);

// Создание таблиц
async function initializeDatabase() {
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      date TEXT,
      time TEXT,
      strefa TEXT
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      strefa TEXT
    )`);
    console.log('Таблицы успешно созданы или уже существуют');
  } catch (err) {
    console.error('Ошибка при создании таблиц:', err);
    process.exit(1);
  }
}
initializeDatabase();

// Закрытие базы данных при завершении процесса
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) console.error('Ошибка при закрытии базы данных:', err);
    console.log('База данных закрыта');
    process.exit(0);
  });
});

// Зоны
const STREFY = [
  'Centrum', 'Ursus', 'Bemowo/Bielany', 'Białołęka/Tarchomin',
  'Praga', 'Rembertów', 'Wawer', 'Służew', 'Ursynów',
  'Wilanów', 'Marki', 'Legionowo', 'Łomianki'
];

// Хранилище сессий и защита от спама
const session = {};
const lastCommand = {};

// Начальная клавиатура
const mainKeyboard = {
  reply_markup: {
    keyboard: [['Oddaj zmianę', 'Zobacz zmiany'], ['Subskrybuj strefę']],
    resize_keyboard: true,
  },
};

// Клавиатура с зонами (добавим кнопку "Powrót")
const zonesKeyboard = {
  reply_markup: {
    keyboard: [...STREFY.map((s) => [s]), ['Powrót']],
    resize_keyboard: true,
  },
};

// Команда /start
bot.onText(/\/start/, async (msg) => {
  try {
    await bot.sendMessage(msg.chat.id, 'Cześć! Co chcesz zrobić?', mainKeyboard);
  } catch (err) {
    console.error('Ошибка команды /start:', err);
  }
});

// Команда /cancel
bot.onText(/\/cancel/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const sess = session[chatId];
    if (sess?.messagesToDelete) {
      for (const messageId of sess.messagesToDelete) {
        await bot.deleteMessage(chatId, messageId).catch(() => {});
      }
    }
    if (sess?.userMessages) {
      for (const messageId of sess.userMessages) {
        await bot.deleteMessage(chatId, messageId).catch(() => {});
      }
    }
    delete session[chatId];
    await bot.sendMessage(chatId, 'Operacja anulowana.', mainKeyboard);
  } catch (err) {
    console.error('Ошибка команды /cancel:', err);
  }
});

// Подписка на зону
bot.onText(/Subskrybuj strefę/, async (msg) => {
  try {
    if (!checkRateLimit(msg.chat.id)) {
      console.log(`Rate limit: Пользователь ${msg.chat.id} отправил "Subskrybuj strefę" слишком быстро`);
      await bot.sendMessage(msg.chat.id, 'Zbyt szybko! Poczekaj chwilę.');
      return;
    }
    const message = await bot.sendMessage(msg.chat.id, 'Wybierz strefę:', {
      reply_markup: {
        inline_keyboard: STREFY.map((s) => [{ text: s, callback_data: `sub_${s}` }]),
      },
    });
    session[msg.chat.id] = { messagesToDelete: [message.message_id], userMessages: [] };
  } catch (err) {
    console.error('Ошибка команды Subskrybuj strefę:', err);
  }
});

// Обработка callback-запросов
bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;

  try {
    if (data.startsWith('sub_')) {
      const strefa = data.slice(4);
      await db.run(`INSERT INTO subscriptions (user_id, strefa) VALUES (?, ?)`, [chatId, strefa]);
      await bot.sendMessage(chatId, `Zapisano subskrypcję na: ${strefa}`, mainKeyboard);
      // Удаляем сообщение с выбором зоны
      if (session[chatId]?.messagesToDelete) {
        for (const messageId of session[chatId].messagesToDelete) {
          await bot.deleteMessage(chatId, messageId).catch(() => {});
        }
        delete session[chatId];
      }
    } else if (data.startsWith('koord_')) {
      const takerId = data.split('_')[1];
      await bot.sendMessage(takerId, 'Właściciel zmiany napisał do koordynatora!');
      await bot.answerCallbackQuery(query.id, { text: 'Dzięki!' });
    } else if (data.startsWith('take_')) {
      const [_, id, giver] = data.split('_');
      session[chatId] = { mode