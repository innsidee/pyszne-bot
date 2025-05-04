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
  } else {
    console.log('Baza danych shifts.db podłączona pomyślnie');
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
  console.log('Inicjalizacja bazy danych...');
  await db.run(`CREATE TABLE IF NOT EXISTS shifts (id INTEGER PRIMARY KEY, username TEXT, date TEXT, time TEXT, strefa TEXT)`);
  await db.run(`CREATE TABLE IF NOT EXISTS subscriptions (id INTEGER PRIMARY KEY, user_id INTEGER, strefa TEXT)`);
  console.log('Baza danych zainicjalizowana pomyślnie');
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
      for (const id of session[chatId].messagesToDelete) await bot.deleteMessage(chatId, id).catch(() => {});
    }
    delete session[chatId];
  } else if (data.startsWith('koord_')) {
    const takerId = data.split('_')[1];
    await bot.sendMessage(takerId, 'Właściciel zmiany napisał do koordynatora!');
    await bot.answerCallbackQuery(query.id, { text: 'Dzięki!' });
  } else if (data.startsWith('take_')) {
    const [_, id, giver] = data.split('_');
    session[chatId] = { mode: 'take', shiftId: id, giver, messagesToDelete: [], userMessages: [] };
    const message = await bot.sendMessage(chatId, 'Podaj swoje imię, nazwisko i ID kuriera (np. Jan Kowalski 12345)');
    session[chatId].messagesToDelete.push(message.message_id);
  }
});

// Начало отдачи смены
bot.onText(/Oddaj zmianę/, async (msg) => {
  session[msg.chat.id] = { mode: 'oddaj', messagesToDelete: [], userMessages: [] };
  const message = await bot.sendMessage(msg.chat.id, 'Wybierz strefę:', zonesKeyboard);
  session[msg.chat.id].messagesToDelete.push(message.message_id);
});

bot.on('message', async (msg) => {
  const text = msg.text?.trim();
  const chatId = msg.chat.id;
  const user = msg.from.username || msg.from.first_name;
  if (text?.startsWith('/')) return;

  const sess = session[chatId];
  if (!sess) return;

  if (!sess.userMessages) sess.userMessages = [];
  sess.userMessages.push(msg.message_id);

  console.log(`Получено сообщение от ${chatId}: "${text}", режим: ${sess?.mode || 'нет'}`);

  try {
    if (text === 'Powrót') {
      await cleanup(chatId);
      return await bot.sendMessage(chatId, 'Cześć! Co chcesz zrobić?', mainKeyboard);
    }

    // Просмотр смен
    if (text.toLowerCase().includes('zobaczyć zmiany')) {
      const msg = await bot.sendMessage(chatId, 'Wybierz strefę:', zonesKeyboard);
      session[chatId] = { mode: 'view', messagesToDelete: [msg.message_id], userMessages: [] };
      return;
    }

    // Выбор зоны для просмотра смен
    if (sess.mode === 'view' && STREFY.includes(text)) {
      console.log(`Выбор зоны ${text} в режиме просмотра для ${chatId}`);
      const rows = await db.all(`SELECT rowid, username, date, time FROM shifts WHERE strefa = ?`, [text]);
      if (!rows.length) {
        const msg2 = await bot.sendMessage(chatId, 'Brak zmian.');
        sess.messagesToDelete.push(msg2.message_id);
      } else {
        for (const row of rows) {
          const msg3 = await bot.sendMessage(
            chatId,
            `${row.rowid}: ${row.date} ${row.time}\nNapisał: @${row.username}\nChcesz przejąć tę zmianę?`,
            { reply_markup: { inline_keyboard: [[{ text: 'Przejmuję zmianę', callback_data: `take_${row.rowid}_${row.username}` }]] } }
          );
          sess.messagesToDelete.push(msg3.message_id);
        }
      }
      return await cleanup(chatId, true);
    }

    // Отдача смены
    if (sess.mode === 'oddaj') {
      if (!sess.strefa && STREFY.includes(text)) {
        sess.strefa = text;
        const msg1 = await bot.sendMessage(chatId, 'Kiedy? (np. dzisiaj, jutro, albo 05.05)');
        sess.messagesToDelete.push(msg1.message_id);
        return;
      }

      if (sess.strefa && !sess.date) {
        const date = parseDate(text);
        if (!date) return await sendErr(chatId, sess, 'Zły format daty. Napisz np. 05.05');
        sess.date = date;
        const msg2 = await bot.sendMessage(chatId, 'O jakich godzinach? (np. 11:00-19:00)');
        sess.messagesToDelete.push(msg2.message_id);
        return;
      }

      if (sess.date && !sess.time) {
        const time = parseTime(text);
        if (!time) return await sendErr(chatId, sess, 'Zły format godzin. Napisz np. 11:00-19:00');
        sess.time = time;
        await db.run(`INSERT INTO shifts (username, date, time, strefa) VALUES (?, ?, ?, ?)`,
          [user, sess.date, sess.time, sess.strefa]);
        await bot.sendMessage(chatId, `Zapisano: ${sess.date}, ${sess.time}, ${sess.strefa}`);
        await notifySubscribers(sess.strefa, sess.date, sess.time);
        return await cleanup(chatId, true);
      }
    }

    // Передача смены
    if (sess.mode === 'take') {
      const [imie, nazwisko, idk] = text.split(/\s+/);
      if (!imie || !nazwisko || !idk || isNaN(idk)) return await sendErr(chatId, sess, 'Błąd formatu. Podaj np. Jan Kowalski 12345');
      await bot.sendMessage(sess.giver,
        `@${msg.from.username} chce przejąć Twoją zmianę!\nD