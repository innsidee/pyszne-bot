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

// Команда /start
bot.onText(/\/start/, async (msg) => {
  try {
    await sendMessageWithRateLimit(msg.chat.id, 'Cześć! Co chcesz zrobić?', {
      reply_markup: {
        keyboard: [['Oddaj zmianę', 'Zobacz zmiany'], ['Subskrybuj strefę']],
        resize_keyboard: true,
      },
    });
  } catch (err) {
    console.error('Ошибка команды /start:', err);
  }
});

// Команда /cancel
bot.onText(/\/cancel/, async (msg) => {
  try {
    delete session[msg.chat.id];
    await sendMessageWithRateLimit(msg.chat.id, 'Operacja anulowana.');
  } catch (err) {
    console.error('Ошибка команды /cancel:', err);
  }
});

// Подписка на зону
bot.onText(/Subskrybuj strefę/, async (msg) => {
  try {
    await sendMessageWithRateLimit(msg.chat.id, 'Wybierz strefę:', {
      reply_markup: {
        inline_keyboard: STREFY.map((s) => [{ text: s, callback_data: `sub_${s}` }]),
      },
    });
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
      await bot.sendMessage(chatId, `Zapisano subskrypcję na: ${strefa}`);
    } else if (data.startsWith('koord_')) {
      const takerId = data.split('_')[1];
      await bot.sendMessage(takerId, 'Właściciel zmiany napisał do koordynatora!');
      await bot.answerCallbackQuery(query.id, { text: 'Dzięki!' });
    } else if (data.startsWith('take_')) {
      const [_, id, giver] = data.split('_');
      session[chatId] = { mode: 'take', shiftId: id, giver };
      await bot.sendMessage(chatId, 'Podaj swoje imię, nazwisko i ID kuriera (np. Jan Kowalski 12345)');
    }
  } catch (err) {
    console.error('Ошибка обработки callback_query:', err);
    await bot.sendMessage(chatId, 'Wystąpił błąd. Spróbuj ponownie.');
  }
});

// Oddanie смены
bot.onText(/Oddaj zmianę/, async (msg) => {
  try {
    session[msg.chat.id] = {};
    await sendMessageWithRateLimit(msg.chat.id, 'Wybierz strefę:', {
      reply_markup: {
        keyboard: STREFY.map((s) => [s]),
        resize_keyboard: true,
      },
    });
  } catch (err) {
    console.error('Ошибка команды Oddaj zmianę:', err);
  }
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
  const text = msg.text;
  const chatId = msg.chat.id;
  const user = msg.from.username || msg.from.first_name;

  // Пропуск команд
  if (text.startsWith('/')) return;

  // Проверка на спам
  if (!checkRateLimit(chatId)) {
    await bot.sendMessage(chatId, 'Zbyt szybko! Poczekaj chwilę.');
    return;
  }

  try {
    const sess = session[chatId];
    if (!sess) return;

    // Выбор зоны для отдачи смены
    if (!sess.strefa && STREFY.includes(text)) {
      sess.strefa = text;
      await bot.sendMessage(chatId, 'Kiedy? (np. dzisiaj, jutro, albo 05.05)');
      return;
    }

    // Парсинг даты
    if (sess.strefa && !sess.date) {
      const date = parseDate(text);
      if (!date) {
        await bot.sendMessage(chatId, 'Zły format daty. Napisz np. 05.05');
        return;
      }
      sess.date = date;
      await bot.sendMessage(chatId, 'O jakich godzinach? (np. 11:00-19:00)');
      return;
    }

    // Парсинг времени
    if (sess.date && !sess.time) {
      const time = parseTime(text);
      if (!time) {
        await bot.sendMessage(chatId, 'Zły format godzin. Napisz np. 11:00-19:00');
        return;
      }
      sess.time = time;
      await db.run(
        `INSERT INTO shifts (username, date, time, strefa) VALUES (?, ?, ?, ?)`,
        [user, sess.date, sess.time, sess.strefa]
      );
      await bot.sendMessage(chatId, `Zapisano: ${sess.date}, ${sess.time}, ${sess.strefa}`);
      await notifySubscribers(sess.strefa, sess.date, sess.time);
      delete session[chatId];
      return;
    }

    // Просмотр смен
    if (text.includes('Zobacz zmiany')) {
      await sendMessageWithRateLimit(msg.chat.id, 'Wybierz strefę:', {
        reply_markup: {
          keyboard: STREFY.map((s) => [s]),
          resize_keyboard: true,
        },
      });
      session[chatId] = { mode: 'view' };
      return;
    }

    // Выбор зоны для просмотра смен
    if (sess.mode === 'view' && STREFY.includes(text)) {
      const rows = await db.all(`SELECT rowid, username, date, time FROM shifts WHERE strefa = ?`, [text]);
      if (!rows.length) {
        await bot.sendMessage(chatId, 'Brak zmian.');
      } else {
        for (const row of rows) {
          await bot.sendMessage(
            chatId,
            `${row.rowid}: ${row.date} ${row.time}\nNapisał: @${row.username}\nChcesz przejąć tę zmianę?`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: 'Przejmuję zmianę', callback_data: `take_${row.rowid}_${row.username}` }],
                ],
              },
            }
          );
        }
      }
      delete session[chatId];
      return;
    }

    // Обработка данных для взятия смены
    if (sess.mode === 'take') {
      const [imie, nazwisko, idk] = text.trim().split(/\s+/);
      if (!imie || !nazwisko || !idk || isNaN(idk)) {
        await bot.sendMessage(chatId, 'Błąd formatu. Podaj np. Jan Kowalski 12345');
        return;
      }
      await bot.sendMessage(
        sess.giver,
        `@${msg.from.username} chce przejąć Twoją zmianę!\nDane: ${imie} ${nazwisko}, ${idk}`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: 'Napisałem do koordynatora', callback_data: `koord_${chatId}` }]],
          },
        }
      );
      await bot.sendMessage(chatId, 'Dziękuję, właściciel zmiany dostał Twoje dane.');
      delete session[chatId];
    }
  } catch (err) {
    console.error('Ошибка обработки сообщения:', err);
    await bot.sendMessage(chatId, 'Wystąpił błąd. Spróbuj ponownie.');
  }
});

// Уведомление подписчиков
async function notifySubscribers(strefa, date, time) {
  try {
    const rows = await db.all(`SELECT user_id FROM subscriptions WHERE strefa = ?`, [strefa]);
    for (let i = 0; i < rows.length; i++) {
      setTimeout(async () => {
        try {
          await bot.sendMessage(
            rows[i].user_id,
            `Nowa zmiana w Twojej strefie ${strefa}:\n${date} ${time}`
          );
        } catch (err) {
          console.error(`Ошибка отправки уведомления пользователю ${rows[i].user_id}:`, err);
        }
      }, i * 100); // Задержка 100 мс между сообщениями
    }
  } catch (err) {
    console.error('Ошибка при получении подписчиков:', err);
  }
}

// Парсинг даты
function parseDate(text) {
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  if (text.toLowerCase().includes('dzi')) {
    return today.toISOString().split('T')[0];
  } else if (text.toLowerCase().includes('jutro')) {
    return tomorrow.toISOString().split('T')[0];
  } else {
    const match = text.match(/(\d{1,2})[.\-/](\d{1,2})/);
    if (!match) return null;
    const [_, d, m] = match;
    const year = today.getFullYear();
    const date = new Date(`${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0];
  }
}

// Парсинг времени
function parseTime(text) {
  const match = text.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
  if (!match) return null;
  return `${match[1]}–${match[2]}`;
}

// Защита от спама
function checkRateLimit(chatId) {
  const now = Date.now();
  if (lastCommand[chatId] && now - lastCommand[chatId] < 1000) {
    return false;
  }
  lastCommand[chatId] = now;
  return true;
}

// Отправка сообщений с учетом лимитов
async function sendMessageWithRateLimit(chatId, text, options) {
  if (!checkRateLimit(chatId)) {
    await bot.sendMessage(chatId, 'Zbyt szybko! Poczekaj chwilę.');
    return;
  }
  await bot.sendMessage(chatId, text, options);
}

// Веб-сервер
app.get('/', (_, res) => res.send('Działa.'));
app.listen(PORT, () => console.log(`Serwer działa na porcie ${PORT}`));