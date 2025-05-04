const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const util = require('util');
const moment = require('moment');
moment.locale('pl'); // Ustawienie lokalizacji dla języka polskiego

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
db.get = util.promisify(db.get); // Dodano dla pobierania jednej pozycji

const STREFY = ['Centrum', 'Ursus', 'Bemowo/Bielany', 'Białołęka/Tarchomin', 'Praga', 'Rembertów', 'Wawer', 'Służew', 'Ursynów', 'Wilanów', 'Marki', 'Legionowo', 'Łomianki'];
const session = {};
const SESSION_TIMEOUT = 60 * 60 * 1000; // 1 godzina
const LAST_COMMAND_TIMEOUT = 5 * 60 * 1000; // 5 minut
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
  await db.run(`
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      chat_id INTEGER NOT NULL,  -- Dodajemy pole chat_id
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      strefa TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      strefa TEXT NOT NULL,
      UNIQUE (user_id, strefa)
    )
  `);
  console.log('Baza danych zainicjalizowana pomyślnie');
}
initializeDatabase();

process.on('SIGINT', () => {
  console.log('Zamykanie bazy danych...');
  db.close((err) => {
    if (err) {
      console.error('Błąd podczas zamykania bazy danych:', err);
    } else {
      console.log('Baza danych zamknięta.');
    }
    process.exit(0);
  });
});

async function clearSession(chatId) {
  const sess = session[chatId];
  if (sess?.messagesToDelete) {
    for (const id of sess.messagesToDelete) {
      await bot.deleteMessage(chatId, id).catch(() => {});
    }
  }
  if (sess?.userMessages) {
    for (const id of sess.userMessages) {
      await bot.deleteMessage(chatId, id).catch(() => {});
    }
  }
  delete session[chatId];
}

function updateLastCommand(chatId) {
  lastCommand[chatId] = Date.now();
}

async function checkLastCommand(chatId) {
  if (lastCommand[chatId] && Date.now() - lastCommand[chatId] > LAST_COMMAND_TIMEOUT) {
    await bot.sendMessage(chatId, 'Minęło trochę czasu. Co chcesz zrobić?', mainKeyboard);
    delete session[chatId];
    delete lastCommand[chatId];
    return false;
  }
  return true;
}

function parseDate(text) {
  const today = moment().startOf('day');
  const tomorrow = moment().add(1, 'day').startOf('day');
  const dayAfterTomorrow = moment().add(2, 'day').startOf('day');

  if (text.toLowerCase() === 'dzisiaj') return today.format('DD.MM.YYYY');
  if (text.toLowerCase() === 'jutro') return tomorrow.format('DD.MM.YYYY');
  if (text.toLowerCase() === 'pojutrze') return dayAfterTomorrow.format('DD.MM.YYYY');

  const parsed = moment(text, ['DD.MM', 'DD.MM.YYYY'], true);
  if (parsed.isValid()) {
    return parsed.format('DD.MM.YYYY');
  }
  return null;
}

function parseTime(text) {
  const match = text.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (match) {
    const [_, startHour, startMinute, endHour, endMinute] = match;
    if (
      parseInt(startHour) >= 0 && parseInt(startHour) <= 23 &&
      parseInt(startMinute) >= 0 && parseInt(startMinute) <= 59 &&
      parseInt(endHour) >= 0 && parseInt(endHour) <= 23 &&
      parseInt(endMinute) >= 0 && parseInt(endMinute) <= 59 &&
      `${startHour}:${startMinute}` < `${endHour}:${endMinute}`
    ) {
      return `${startHour}:${startMinute}-${endHour}:${endMinute}`;
    }
  }
  return null;
}

async function sendErr(chatId, sess, message) {
  const errMessage = await bot.sendMessage(chatId, `Błąd: ${message}`);
  sess.messagesToDelete.push(errMessage.message_id);
}

async function notifySubscribers(strefa, date, time, username) {
  try {
    const subscribers = await db.all(`SELECT user_id FROM subscriptions WHERE strefa = ?`, [strefa]);
    for (let i = 0; i < subscribers.length; i++) {
      const sub = subscribers[i];
      if (sub.user_id !== username) { // Nie powiadamiaj osoby oddającej zmianę
        setTimeout(() => {
          bot.sendMessage(sub.user_id, `Nowa zmiana w Twojej strefie (${strefa}): ${date}, ${time} (od @${username})`).catch((err) => {
            console.error(`Błąd wysyłania powiadomienia do ${sub.user_id}:`, err);
          });
        }, i * 100); // Задержка 100 мс между сообщениями
      }
    }
  } catch (error) {
    console.error('Błąd podczas powiadamiania subskrybentów:', error);
  }
}

// Команда /start
bot.onText(/\/start/, async (msg) => {
  clearSession(msg.chat.id);
  updateLastCommand(msg.chat.id);
  session[msg.chat.id] = { lastActive: Date.now() }; // Инициализация времени последней активности
  await bot.sendMessage(msg.chat.id, 'Cześć! Co chcesz zrobić?', mainKeyboard);
});

// Команда /cancel
bot.onText(/\/cancel/, async (msg) => {
  clearSession(msg.chat.id);
  delete lastCommand[msg.chat.id];
  await bot.sendMessage(msg.chat.id, 'Operacja anulowana.', mainKeyboard);
});

// Подписка на зону
bot.onText(/Subskrybuj strefę/, async (msg) => {
  updateLastCommand(msg.chat.id);
  session[msg.chat.id] = { mode: 'subskrypcja', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
  const message = await bot.sendMessage(msg.chat.id, 'Wybierz strefę:', {
    reply_markup: {
      inline_keyboard: STREFY.map(s => [{ text: s, callback_data: `sub_${s}` }]),
    },
  });
  session[msg.chat.id].messagesToDelete.push(message.message_id);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  updateLastCommand(chatId);
  session[chatId] = { ...session[chatId], lastActive: Date.now() };

  if (data.startsWith('sub_')) {
    const strefa = data.slice(4);
    try {
      await db.run(`INSERT OR IGNORE INTO subscriptions (user_id, strefa) VALUES (?, ?)`, [chatId, strefa]);
      await bot.sendMessage(chatId, `Zapisano subskrypcję na: ${strefa}`, mainKeyboard);
    } catch (error) {
      console.error('Błąd podczas zapisu subskrypcji:', error);
      await bot.sendMessage(chatId, 'Już subskrybujesz tę strefę lub wystąpił inny błąd.');
    } finally {
      clearSession(chatId);
    }
    await bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('take_')) {
    const [_, shiftId, giver] = data.split('_');
    session[chatId] = { mode: 'take', shiftId: parseInt(shiftId), giver, messagesToDelete: [], userMessages: [], lastActive: Date.now() };
    const message = await bot.sendMessage(chatId, 'Podaj swoje imię, nazwisko i ID kuriera (np. Jan Kowalski 12345)');
    session[chatId].messagesToDelete.push(message.message_id);
    await bot.answerCallbackQuery(query.id);
  }
});

// Начало отдачи смены
bot.onText(/Oddaj zmianę/, async (msg) => {
  updateLastCommand(msg.chat.id);
  session[msg.chat.id] = { mode: 'oddaj', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
  const message = await bot.sendMessage(msg.chat.id, 'Wybierz strefę:', zonesKeyboard);
  session[msg.chat.id].messagesToDelete.push(message.message_id);
});

bot.on('message', async (msg) => {
  const text = msg.text?.trim();
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name || 'Użytkownik'; // Добавляем запасной вариант

  if (!await checkLastCommand(chatId)) return;
  if (text?.startsWith('/')) return;

  session[chatId] = { ...session[chatId], lastActive: Date.now() }; // Обновление времени активности

  const sess = session[chatId];
  if (!sess) return;

  if (!sess.userMessages) sess.userMessages = [];
  sess.userMessages.push(msg.message_id);

  console.log(`Polucheno soobschenie ot ${chatId} (@${username}): "${text}", rezhim: ${sess?.mode || 'net'}`);

  try {
    if (text === 'Powrót') {
      clearSession(chatId);
      return await bot.sendMessage(chatId, 'Cześć! Co chcesz zrobić?', mainKeyboard);
    }

    // Просмотр смен
    if (text.toLowerCase().includes('zobaczyć zmiany')) {
      updateLastCommand(chatId);
      session[chatId] = { mode: 'view', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
      const message = await bot.sendMessage(chatId, 'Wybierz strefę:', zonesKeyboard);
      session[chatId].messagesToDelete.push(message.message_id);
      return;
    }

    // Wybor zony dla prosmootra smen
    if (sess.mode === 'view' && STREFY.includes(text)) {
      console.log(`Wybór strefy ${text} w trybie widoku dla ${chatId}`);
      try {
        const rows = await db.all(`SELECT id, username, chat_id, date, time FROM shifts WHERE strefa = ? ORDER BY created_at DESC`, [text]);
        console.log(`Znaleziono ${rows.length} zmian dla strefy ${text}`);
        if (!rows.length) {
          const msg2 = await bot.sendMessage(chatId, 'Brak dostępnych zmian w tej strefie.');
          sess.messagesToDelete.push(msg2.message_id);
        } else {
          for (const row of rows) {
            const displayUsername = row.username || 'Użytkownik'; // Zapasowy wariant, jeśli username отсутствует
            const msg3 = await bot.sendMessage(
              chatId,
              `ID: ${row.id}\nData: ${row.date}, Godzina: ${row.time}\nOddaje: @${displayUsername}\nChcesz przejąć tę zmianę?`,
              { reply_markup: { inline_keyboard: [[{ text: 'Przejmuję zmianę', callback_data: `take_${row.id}_${row.chat_id}` }]] } }
            );
            sess.messagesToDelete.push(msg3.message_id);
          }
        }
      } catch (err) {
        console.error(`Błąd podczas pobierania zmian dla strefy ${text}:`, err);
        throw err; // Pobrasywaem oshibku, chtoby wneshnij catch ją obrobotat
      }
      return; // Nie czyścimy sesji, aby użytkownik mógł zobaczyć inne strefy
    }

    // Oddacha smeny
    if (sess.mode === 'oddaj') {
      if (!sess.strefa && STREFY.includes(text)) {
        sess.strefa = text;
        const msg1 = await bot.sendMessage(chatId, 'Na kiedy oddajesz zmianę? (np. dzisiaj, jutro, 05.05.2025)');
        sess.messagesToDelete.push(msg1.message_id);
        return;
      }

      if (sess.strefa && !sess.date) {
        const date = parseDate(text);
        if (!date) return await sendErr(chatId, sess, 'Zły format daty. Napisz np. dzisiaj, jutro lub 05.05.2025');
        sess.date = date;
        const msg2 = await bot.sendMessage(chatId, 'O jakich godzinach? (np. 11:00-19:00)');
        sess.messagesToDelete.push(msg2.message_id);
        return;
      }

      if (sess.date && !sess.time) {
        const time = parseTime(text);
        if (!time) return await sendErr(chatId, sess, 'Zły format godzin. Napisz np. 11:00-19:00');
        sess.time = time;
        try {
          await db.run(`INSERT INTO shifts (username, chat_id, date, time, strefa) VALUES (?, ?, ?, ?, ?)`,
            [username, chatId, sess.date, sess.time, sess.strefa]); // Zapisujemy chatId
          console.log(`Dodano zmianę: ${sess.date}, ${sess.time}, ${sess.strefa}, użytkownik: @${username}, chatId: ${chatId}`);
          await bot.sendMessage(chatId, `Zapisano: ${sess.date}, ${sess.time}, ${sess.strefa}`);
          await notifySubscribers(sess.strefa, sess.date, sess.time, username);
        } catch (error) {
          console.error('Błąd podczas zapisywania zmiany:', error);
          await bot.sendMessage(chatId, 'Wystąpił błąd podczas zapisywania zmiany.');
        } finally {
          clearSession(chatId);
        }
        return;
      }
    }

    // Peredacha smeny
    if (sess.mode === 'take') {
      const [imie, nazwisko, idk] = text.split(/\s+/);
      if (!imie || !nazwisko || !idk || isNaN(idk)) return await sendErr(chatId, sess, 'Błąd formatu. Podaj imię, nazwisko i ID kuriera, oddzielone spacjami (np. Jan Kowalski 12345).');

      try {
        console.log(`Próba przejęcia zmiany: shiftId=${sess.shiftId}, giverChatId=${sess.giver}`);
        const shift = await db.get(`SELECT username, chat_id, date, time, strefa FROM shifts WHERE id = ?`, [sess.shiftId]);
        if (!shift) {
          await bot.sendMessage(chatId, 'Ta zmiana już nie jest dostępna.');
          return;
        }

        // Sprawdzenie, czy giverChatId istnieje i jest poprawny
        if (!shift.chat_id || isNaN(shift.chat_id)) {
          console.error(`Nieprawidłowy chat_id osoby oddającej zmianę: ${shift.chat_id}`);
          await bot.sendMessage(chatId, 'Błąd: Nie można skontaktować się z osobą oddającą zmianę.');
          return;
        }

        let notificationSent = false; // Flaga śledząca, czy powiadomienie się udało

        // Próba wysłania wiadomości do giver (używamy chat_id z bazy danych)
        try {
          await bot.sendMessage(shift.chat_id,
            `@${username} (${imie} ${nazwisko}, ID: ${idk}) chce przejąć Twoją zmianę:\nData: ${shift.date}, Godzina: ${shift.time}, Strefa: ${shift.strefa}\nSkontaktuj się z nim, aby ustalić szczegóły.`);
          console.log(`Wiadomość wysłana do chatId ${shift.chat_id} (@${shift.username})`);
          notificationSent = true; // Ustawiamy flagę na true, jeśli się udało
        } catch (error) {
          console.error(`Błąd wysyłania wiadomości do chatId ${shift.chat_id} (@${shift.username}):`, error.message);
          await bot.sendMessage(chatId, `Nie udało się powiadomić @${shift.username}. Skontaktuj się z nim ręcznie, aby ustalić szczegóły przejęcia zmiany. Może być konieczne rozpoczęcie rozmowy z botem przez @${shift.username} (np. wpisanie /start).`);
        }

        // Wysłanie potwierdzenia do użytkownika tylko, jeśli powiadomienie się udało
        if (notificationSent) {
          await bot.sendMessage(chatId, `Wiadomość o Twoim zainteresowaniu została wysłana do @${shift.username}. Skontaktuj się z nim w celu ustalenia szczegółów.`);
        }

        // Usunięcie zmiany z bazy danych
        await db.run(`DELETE FROM shifts WHERE id = ?`, [sess.shiftId]);
        console.log(`Zmiana o ID ${sess.shiftId} usunięta z bazy danych`);
      } catch (error) {
        console.error('Błąd podczas przekazywania zmiany:', error);
        await bot.sendMessage(chatId, 'Wystąpił błąd podczas próby przekazania zmiany.');
      } finally {
        clearSession(chatId);
      }
      return;
    }
  } catch (err) {
    console.error('Błąd przetwarzania wiadomości:', err);
    await bot.sendMessage(chatId, 'Wystąpił błąd. Spróbuj ponownie.');
    clearSession(chatId);
  }
});

// Таймер dla очистки sesji
setInterval(() => {
  const now = Date.now();
  for (const chatId in session) {
    if (now - session[chatId].lastActive > SESSION_TIMEOUT) {
      clearSession(chatId);
      delete lastCommand[chatId];
    }
  }
}, 5 * 60 * 1000); // Prikazka kadżyje 5 minut

// Antyzasypiacz (ping co 4 minuty)
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    axios.get(url).then(() => {
      console.log('Ping do samego siebie wysłany');
    }).catch((err) => {
      console.error('Błąd pingu:', err.message);
    });
  }
}, 240000); // 4 minuty

// Web-serwer
app.get('/', (_, res) => res.send('Bot is running'));
app.listen(PORT, () => {
  console.log(`Bot is listening on port ${PORT}`);
});