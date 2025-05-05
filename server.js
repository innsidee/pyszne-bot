const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const util = require('util');
const moment = require('moment');
const winston = require('winston');
moment.locale('pl');

dotenv.config();
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error('TELEGRAM_TOKEN nie ustawiony w .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const app = express();
const PORT = process.env.PORT || 3000;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: 'bot.log' }),
    new winston.transports.Console(),
  ],
});

const db = new sqlite3.Database('shifts.db', (err) => {
  if (err) {
    logger.error('Błąd DB:', err);
    process.exit(1);
  } else {
    logger.info('Baza danych shifts.db podłączona pomyślnie');
  }
});
db.run = util.promisify(db.run);
db.all = util.promisify(db.all);
db.get = util.promisify(db.get);

const STREFY = ['Centrum', 'Ursus', 'Bemowo/Bielany', 'Białołęka/Tarchomin', 'Praga', 'Rembertów', 'Wawer', 'Służew', 'Ursynów', 'Wilanów', 'Marki', 'Legionowo', 'Łomianki'];
const session = {};
const SESSION_TIMEOUT = 60 * 60 * 1000;
const LAST_COMMAND_TIMEOUT = 5 * 60 * 1000;
const SHIFT_EXPIRY_HOURS = 24;
const REMINDER_INTERVAL_HOURS = 3;
const lastCommand = {};
const lastReminderTimes = new Map();

const mainKeyboard = {
  reply_markup: {
    keyboard: [['Oddaj zmianę', 'Zobaczyć zmiany'], ['Subskrybuj strefę', 'Moje statystyki'], ['Instrukcja']],
    resize_keyboard: true,
  },
};
const zonesKeyboard = {
  reply_markup: {
    keyboard: [...STREFY.map(s => [s]), ['Powrót']],
    resize_keyboard: true,
  },
};
const returnKeyboard = {
  reply_markup: {
    keyboard: [['Powrót']],
    resize_keyboard: true,
  },
};

async function initializeDatabase() {
  logger.info('Inicjalizacja bazy danych...');
  await db.run(`
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
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
  await db.run(`
    CREATE TABLE IF NOT EXISTS shift_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id INTEGER NOT NULL,
      giver_chat_id INTEGER NOT NULL,
      taker_chat_id INTEGER NOT NULL,
      taker_username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS stats (
      user_id INTEGER PRIMARY KEY,
      shifts_given INTEGER DEFAULT 0,
      shifts_taken INTEGER DEFAULT 0,
      subscriptions INTEGER DEFAULT 0
    )
  `);
  logger.info('Baza danych zainicjalizowana pomyślnie');
}
initializeDatabase();

process.on('SIGINT', () => {
  logger.info('Zamykanie bazy danych...');
  db.close((err) => {
    if (err) {
      logger.error('Błąd podczas zamykania bazy danych:', err);
    } else {
      logger.info('Baza danych zamknięta.');
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
    const startTotalMinutes = parseInt(startHour) * 60 + parseInt(startMinute);
    const endTotalMinutes = parseInt(endHour) * 60 + parseInt(endMinute);

    if (
      parseInt(startHour) >= 0 && parseInt(startHour) <= 23 &&
      parseInt(startMinute) >= 0 && parseInt(startMinute) <= 59 &&
      parseInt(endHour) >= 0 && parseInt(endHour) <= 23 &&
      parseInt(endMinute) >= 0 && parseInt(endMinute) <= 59
    ) {
      if (endTotalMinutes >= startTotalMinutes || endTotalMinutes < startTotalMinutes) {
        return `${startHour}:${startMinute}-${endHour}:${endMinute}`;
      }
    }
  }
  return null;
}

async function sendErr(chatId, sess, message) {
  const errMessage = await bot.sendMessage(chatId, `Błąd: ${message}`, returnKeyboard);
  sess.messagesToDelete.push(errMessage.message_id);
  logger.info(`Wysłano błąd do ${chatId}: ${message}`);
}

async function notifySubscribers(strefa, date, time, username) {
  try {
    const subscribers = await db.all(`SELECT user_id FROM subscriptions WHERE strefa = ?`, [strefa]);
    for (let i = 0; i < subscribers.length; i++) {
      const sub = subscribers[i];
      if (sub.user_id !== username) {
        setTimeout(async () => {
          try {
            await bot.sendMessage(sub.user_id, `Nowa zmiana w Twojej strefie (${strefa}): ${date}, ${time} (od @${username})`);
            logger.info(`Wysłano powiadomienie do ${sub.user_id}: Nowa zmiana w ${strefa}`);
          } catch (err) {
            logger.error(`Błąd wysyłania powiadomienia do ${sub.user_id}: ${err.message}`);
          }
        }, i * 100);
      }
    }
  } catch (error) {
    logger.error('Błąd podczas powiadamiania subskrybentów:', error.message);
  }
}

async function sendReminder(shift) {
  const shiftId = shift.id;
  try {
    const subscribers = await db.all(`SELECT user_id FROM subscriptions WHERE strefa = ?`, [shift.strefa]);
    for (let i = 0; i < subscribers.length; i++) {
      const sub = subscribers[i];
      if (sub.user_id !== shift.chat_id) {
        setTimeout(async () => {
          try {
            await bot.sendMessage(sub.user_id, `Przypomnienie: Zmiana w strefie (${shift.strefa}) wciąż dostępna! ${shift.date}, ${shift.time} (od @${shift.username})`);
            logger.info(`Wysłano przypomnienie o zmianie ID ${shiftId} do ${sub.user_id}`);
          } catch (err) {
            logger.error(`Błąd wysyłania przypomnienia do ${sub.user_id}: ${err.message}`);
          }
        }, i * 100);
      }
    }
    lastReminderTimes.set(shiftId, moment());
  } catch (error) {
    logger.error(`Błąd podczas wysyłania przypomnienia dla zmiany ID ${shiftId}: ${error.message}`);
  }
}

async function cleanExpiredShifts() {
  try {
    const shifts = await db.all(`SELECT id, username, chat_id, date, time, strefa, created_at FROM shifts`);
    const now = moment();
    for (const shift of shifts) {
      const createdAt = moment(shift.created_at);
      const hoursSinceCreation = now.diff(createdAt, 'hours', true);

      if (hoursSinceCreation >= SHIFT_EXPIRY_HOURS) {
        await db.run(`DELETE FROM shifts WHERE id = ?`, [shift.id]);
        logger.info(`Usunięto zmianę ID ${shift.id} - wygasła po ${SHIFT_EXPIRY_HOURS} godzinach`);
        lastReminderTimes.delete(shift.id);
        continue;
      }

      const lastReminder = lastReminderTimes.get(shift.id) || createdAt;
      const hoursSinceLastReminder = now.diff(lastReminder, 'hours', true);
      if (hoursSinceLastReminder >= REMINDER_INTERVAL_HOURS) {
        await sendReminder(shift);
      }
    }
  } catch (error) {
    logger.error(`Błąd podczas czyszczenia wygasłych zmian: ${error.message}`);
  }
}

async function updateStats(userId, field, increment = 1) {
  try {
    await db.run(
      `INSERT OR IGNORE INTO stats (user_id, shifts_given, shifts_taken, subscriptions) VALUES (?, 0, 0, 0)`,
      [userId]
    );
    await db.run(
      `UPDATE stats SET ${field} = ${field} + ? WHERE user_id = ?`,
      [increment, userId]
    );
    logger.info(`Zaktualizowano statystyki dla user_id ${userId}: ${field} + ${increment}`);
  } catch (error) {
    logger.error(`Błąd aktualizacji statystyk dla ${userId}: ${error.message}`);
  }
}

// Komenda /start
bot.onText(/\/start/, async (msg) => {
  clearSession(msg.chat.id);
  updateLastCommand(msg.chat.id);
  session[msg.chat.id] = { lastActive: Date.now() };
  await bot.sendMessage(msg.chat.id, 'Cześć! Co chcesz zrobić?', mainKeyboard);
  logger.info(`Użytkownik ${msg.chat.id} (@${msg.from.username || 'brak'}) uruchomił /start`);
});

// Komenda /cancel
bot.onText(/\/cancel/, async (msg) => {
  clearSession(msg.chat.id);
  delete lastCommand[msg.chat.id];
  await bot.sendMessage(msg.chat.id, 'Operacja anulowana.', mainKeyboard);
  logger.info(`Użytkownik ${msg.chat.id} (@${msg.from.username || 'brak'}) anulował operację`);
});

// Komenda /subskrypcje
bot.onText(/\/subskrypcje/, async (msg) => {
  const chatId = msg.chat.id;
  updateLastCommand(chatId);
  logger.info(`Użytkownik ${chatId} (@${msg.from.username || 'brak'}) wywołał /subskrypcje`);

  try {
    const subscriptions = await db.all(`SELECT strefa FROM subscriptions WHERE user_id = ?`, [chatId]);
    if (!subscriptions.length) {
      await bot.sendMessage(chatId, 'Nie subskrybujesz żadnych stref.', mainKeyboard);
      logger.info(`Użytkownik ${chatId} nie ma subskrypcji`);
      return;
    }

    const inlineKeyboard = subscriptions.map(sub => [
      { text: sub.strefa, callback_data: `unsub_${sub.strefa}` },
    ]);
    await bot.sendMessage(chatId, 'Twoje subskrypcje (kliknij, aby odsubskrybować):', {
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
    logger.info(`Wysłano listę subskrypcji użytkownikowi ${chatId}`);
  } catch (error) {
    logger.error(`Błąd podczas pobierania subskrypcji dla ${chatId}: ${error.message}`);
    await bot.sendMessage(chatId, 'Wystąpił błąd podczas pobierania subskrypcji.', mainKeyboard);
  }
});

// Komenda Moje statystyki
bot.onText(/Moje statystyki/, async (msg) => {
  const chatId = msg.chat.id;
  updateLastCommand(chatId);
  logger.info(`Użytkownik ${chatId} (@${msg.from.username || 'brak'}) wywołał Moje statystyki`);

  try {
    const stats = await db.get(`SELECT shifts_given, shifts_taken, subscriptions FROM stats WHERE user_id = ?`, [chatId]);
    if (!stats) {
      await bot.sendMessage(chatId, 'Brak statystyk. Zacznij korzystać z bota, aby zbierać dane!', mainKeyboard);
      logger.info(`Brak statystyk dla użytkownika ${chatId}`);
      return;
    }

    const message = `Twoje statystyki:\n` +
                    `Oddane zmiany: ${stats.shifts_given}\n` +
                    `Przejęte zmiany: ${stats.shifts_taken}\n` +
                    `Aktywne subskrypcje: ${stats.subscriptions}`;
    await bot.sendMessage(chatId, message, mainKeyboard);
    logger.info(`Wysłano statystyki użytkownikowi ${chatId}`);
  } catch (error) {
    logger.error(`Błąd podczas pobierania statystyk dla ${chatId}: ${error.message}`);
    await bot.sendMessage(chatId, 'Wystąpił błąd podczas pobierania statystyk.', mainKeyboard);
  }
});

// Komenda Instrukcja
bot.onText(/Instrukcja/, async (msg) => {
  const chatId = msg.chat.id;
  updateLastCommand(chatId);
  logger.info(`Użytkownik ${chatId} (@${msg.from.username || 'brak'}) wywołał Instrukcję`);

  const instruction = `📋 **Instrukcja obsługi bota Wymiana zmian Pyszne**

Cześć! Ten bot pomaga w wygodnej wymianie zmian między kurierami. Oto, co potrafi:

1. **Oddaj zmianę** 📅
   - Wybierz strefę, datę i godziny zmiany, którą chcesz oddać.
   - Zmiana pojawi się w wybranej strefie, a subskrybenci dostaną powiadomienie.
   - Po 24 godzinach zmiana wygasa, jeśli nikt jej nie przejmie.

2. **Zobaczyć zmiany** 🔍
   - Przeglądaj dostępne zmiany w wybranej strefie.
   - Kliknij „Przejmuję zmianę”, podaj swoje dane (imię, nazwisko, ID kuriera), a bot powiadomi osobę oddającą.

3. **Subskrybuj strefę** 🔔
   - Subskrybuj strefy, aby otrzymywać powiadomienia o nowych zmianach.
   - Możesz zarządzać subskrypcjami przez komendę /subskrypcje.

4. **Moje statystyki** 📊
   - Sprawdzaj, ile zmian oddałeś, przejąłeś i ile masz aktywnych subskrypcji.

5. **Anulowanie** 🚫
   - Użyj /cancel, aby przerwać bieżącą operację i wrócić do menu.

💡 **Wskazówki**:
- Upewnij się, że podajesz poprawne dane (np. format daty: 05.05.2025, godziny: 11:00-19:00).
- Po przejęciu zmiany skontaktuj się z osobą oddającą, aby potwierdzić szczegóły.
- W razie problemów z botem napisz do @oginside66.

Masz pytania, problemy lub pomysły na nowe funkcje? Pisz do @oginside66! 🚀`;
  
  await bot.sendMessage(chatId, instruction, mainKeyboard);
  logger.info(`Wysłano instrukcję użytkownikowi ${chatId}`);
});

// Subskrypcja strefy
bot.onText(/Subskrybuj strefę/, async (msg) => {
  updateLastCommand(msg.chat.id);
  session[msg.chat.id] = { mode: 'subskrypcja', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
  const message = await bot.sendMessage(msg.chat.id, 'Wybierz strefę:', {
    reply_markup: {
      inline_keyboard: STREFY.map(s => [{ text: s, callback_data: `sub_${s}` }]),
    },
  });
  session[msg.chat.id].messagesToDelete.push(message.message_id);
  logger.info(`Użytkownik ${msg.chat.id} (@${msg.from.username || 'brak'}) rozpoczął subskrypcję strefy`);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  updateLastCommand(chatId);
  session[chatId] = { ...session[chatId], lastActive: Date.now() };
  logger.info(`Użytkownik ${chatId} (@${query.from.username || 'brak'}) kliknął callback: ${data}`);

  if (data.startsWith('sub_')) {
    const strefa = data.slice(4);
    try {
      await db.run(`INSERT OR IGNORE INTO subscriptions (user_id, strefa) VALUES (?, ?)`, [chatId, strefa]);
      await updateStats(chatId, 'subscriptions', 1);
      await bot.sendMessage(chatId, `Zapisano subskrypcję na: ${strefa}`, mainKeyboard);
      logger.info(`Użytkownik ${chatId} zasubskrybował strefę: ${strefa}`);
    } catch (error) {
      logger.error(`Błąd podczas zapisu subskrypcji dla ${chatId}: ${error.message}`);
      await bot.sendMessage(chatId, 'Już subskrybujesz tę strefę lub wystąpił inny błąd.', mainKeyboard);
    } finally {
      clearSession(chatId);
    }
    await bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('unsub_')) {
    const strefa = data.slice(6);
    try {
      await db.run(`DELETE FROM subscriptions WHERE user_id = ? AND strefa = ?`, [chatId, strefa]);
      await updateStats(chatId, 'subscriptions', -1);
      await bot.sendMessage(chatId, `Odsubskrybowano strefę: ${strefa}`, mainKeyboard);
      logger.info(`Użytkownik ${chatId} odsubskrybował strefę: ${strefa}`);
    } catch (error) {
      logger.error(`Błąd podczas odsubskrybowania strefy dla ${chatId}: ${error.message}`);
      await bot.sendMessage(chatId, 'Wystąpił błąd podczas odsubskrybowania.', mainKeyboard);
    }
    await bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('take_')) {
    const [_, shiftId, giverChatId] = data.split('_');
    session[chatId] = { mode: 'take', shiftId: parseInt(shiftId), giverChatId, messagesToDelete: [], userMessages: [], lastActive: Date.now() };
    const message = await bot.sendMessage(chatId, 'Podaj swoje imię, nazwisko i ID kuriera (np. Jan Kowalski 12345)', returnKeyboard);
    session[chatId].messagesToDelete.push(message.message_id);
    logger.info(`Użytkownik ${chatId} chce przejąć zmianę o ID: ${shiftId}`);
    await bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('confirm_')) {
    const [_, shiftId, takerChatId, takerUsername] = data.split('_');
    try {
      await bot.sendMessage(takerChatId,
        `Kurier @${query.from.username} już powiadomił koordynatora. Zmiana niebawem zostanie przypisana do Twojego grafiku. W razie pytań pisz do koordynatora albo do @${query.from.username}.`);
      await bot.sendMessage(chatId, 'Dziękujemy za potwierdzenie. Osoba przejmująca zmianę została powiadomiona.', mainKeyboard);
      await updateStats(takerChatId, 'shifts_taken', 1);
      logger.info(`Użytkownik ${chatId} potwierdził powiadomienie koordynatora dla zmiany ${shiftId}, powiadomiono ${takerChatId}`);

      await db.run(`DELETE FROM shift_confirmations WHERE shift_id = ? AND giver_chat_id = ? AND taker_chat_id = ?`, [shiftId, chatId, takerChatId]);
    } catch (error) {
      logger.error(`Błąd podczas potwierdzania powiadomienia koordynatora dla ${chatId}: ${error.message}`);
      await bot.sendMessage(chatId, 'Wystąpił błąd. Spróbuj ponownie lub skontaktuj się z koordynatorem ręcznie.', mainKeyboard);
    }
    await bot.answerCallbackQuery(query.id);
  }
});

// Oddawanie zmiany
bot.onText(/Oddaj zmianę/, async (msg) => {
  updateLastCommand(msg.chat.id);
  session[msg.chat.id] = { mode: 'oddaj', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
  const message = await bot.sendMessage(msg.chat.id, 'Wybierz strefę:', zonesKeyboard);
  session[msg.chat.id].messagesToDelete.push(message.message_id);
  logger.info(`Użytkownik ${msg.chat.id} (@${msg.from.username || 'brak'}) rozpoczął oddawanie zmiany`);
});

bot.on('message', async (msg) => {
  const text = msg.text?.trim();
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name || 'Użytkownik';

  if (!await checkLastCommand(chatId)) return;
  if (text?.startsWith('/')) return;

  session[chatId] = { ...session[chatId], lastActive: Date.now() };
  const sess = session[chatId];
  if (!sess) return;

  if (!sess.userMessages) sess.userMessages = [];
  sess.userMessages.push(msg.message_id);

  logger.info(`Otrzymano wiadomość od ${chatId} (@${username}): "${text}", tryb: ${sess?.mode || 'brak'}`);

  try {
    if (text === 'Powrót') {
      clearSession(chatId);
      await bot.sendMessage(chatId, 'Cześć! Co chcesz zrobić?', mainKeyboard);
      logger.info(`Użytkownik ${chatId} wrócił do menu głównego`);
      return;
    }

    if (text.toLowerCase().includes('zobaczyć zmiany')) {
      updateLastCommand(chatId);
      session[chatId] = { mode: 'view', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
      const message = await bot.sendMessage(chatId, 'Wybierz strefę:', zonesKeyboard);
      session[chatId].messagesToDelete.push(message.message_id);
      logger.info(`Użytkownik ${chatId} chce zobaczyć zmiany`);
      return;
    }

    if (sess.mode === 'view' && STREFY.includes(text)) {
      logger.info(`Wybór strefy ${text} w trybie widoku dla ${chatId}`);
      try {
        const rows = await db.all(`SELECT id, username, chat_id, date, time FROM shifts WHERE strefa = ? ORDER BY created_at DESC`, [text]);
        logger.info(`Znaleziono ${rows.length} zmian dla strefy ${text}`);
        if (!rows.length) {
          const msg2 = await bot.sendMessage(chatId, 'Brak dostępnych zmian w tej strefie.', zonesKeyboard);
          sess.messagesToDelete.push(msg2.message_id);
          logger.info(`Brak zmian w strefie ${text} dla ${chatId}`);
        } else {
          for (const row of rows) {
            const displayUsername = row.username || 'Użytkownik';
            const msg3 = await bot.sendMessage(
              chatId,
              `ID: ${row.id}\nData: ${row.date}, Godzina: ${row.time}\nOddaje: @${displayUsername}\nChcesz przejąć tę zmianę?`,
              { reply_markup: { inline_keyboard: [[{ text: 'Przejmuję zmianę', callback_data: `take_${row.id}_${row.chat_id}` }]] } }
            );
            sess.messagesToDelete.push(msg3.message_id);
            logger.info(`Wysłano zmianę ID ${row.id} użytkownikowi ${chatId}`);
          }
        }
      } catch (err) {
        logger.error(`Błąd podczas pobierania zmian dla strefy ${text}: ${err.message}`);
        throw err;
      }
      return;
    }

    if (sess.mode === 'oddaj') {
      if (!sess.strefa && STREFY.includes(text)) {
        sess.strefa = text;
        const msg1 = await bot.sendMessage(chatId, 'Na kiedy oddajesz zmianę? (np. dzisiaj, jutro, 05.05.2025)', returnKeyboard);
        sess.messagesToDelete.push(msg1.message_id);
        logger.info(`Użytkownik ${chatId} wybrał strefę ${text} w trybie oddaj`);
        return;
      }

      if (sess.strefa && !sess.date) {
        const date = parseDate(text);
        if (!date) return await sendErr(chatId, sess, 'Zły format daty. Napisz np. dzisiaj, jutro lub 05.05.2025');
        sess.date = date;
        const msg2 = await bot.sendMessage(chatId, 'O jakich godzinach? (np. 11:00-19:00)', returnKeyboard);
        sess.messagesToDelete.push(msg2.message_id);
        logger.info(`Użytkownik ${chatId} wybrał datę ${date} w trybie oddaj`);
        return;
      }

      if (sess.date && !sess.time) {
        const time = parseTime(text);
        if (!time) return await sendErr(chatId, sess, 'Zły format godzin. Napisz np. 11:00-19:00');
        sess.time = time;

        const existingShift = await db.get(
          `SELECT id FROM shifts WHERE username = ? AND date = ? AND time = ? AND strefa = ?`,
          [username, sess.date, sess.time, sess.strefa]
        );
        if (existingShift) {
          const errMsg = await bot.sendMessage(chatId, 'Już oddałeś taką zmianę! Nie możesz oddać tej samej zmiany ponownie.', mainKeyboard);
          sess.messagesToDelete.push(errMsg.message_id);
          logger.info(`Użytkownik ${chatId} próbował oddać duplikat zmiany: ${sess.date}, ${sess.time}, ${sess.strefa}`);
          clearSession(chatId);
          return;
        }

        try {
          await db.run(`INSERT INTO shifts (username, chat_id, date, time, strefa) VALUES (?, ?, ?, ?, ?)`,
            [username, chatId, sess.date, sess.time, sess.strefa]);
          await updateStats(chatId, 'shifts_given', 1);
          logger.info(`Dodano zmianę: ${sess.date}, ${sess.time}, ${sess.strefa}, użytkownik: @${username}, chatId: ${chatId}`);
          await bot.sendMessage(chatId, `Zapisano: ${sess.date}, ${sess.time}, ${sess.strefa}`, mainKeyboard);
          await notifySubscribers(sess.strefa, sess.date, sess.time, username);
        } catch (error) {
          logger.error(`Błąd podczas zapisywania zmiany dla ${chatId}: ${error.message}`);
          await bot.sendMessage(chatId, 'Wystąpił błąd podczas zapisywania zmiany.', mainKeyboard);
        } finally {
          clearSession(chatId);
        }
        return;
      }
    }

    if (sess.mode === 'take') {
      const [imie, nazwisko, idk] = text.split(/\s+/);
      if (!imie || !nazwisko || !idk || isNaN(idk)) return await sendErr(chatId, sess, 'Błąd formatu. Podaj imię, nazwisko i ID kuriera, oddzielone spacjami (np. Jan Kowalski 12345).');

      try {
        logger.info(`Próba przejęcia zmiany: shiftId=${sess.shiftId}, giverChatId=${sess.giverChatId}`);
        const shift = await db.get(`SELECT username, chat_id, date, time, strefa FROM shifts WHERE id = ?`, [sess.shiftId]);
        if (!shift) {
          await bot.sendMessage(chatId, 'Ta zmiana już nie jest dostępna.', mainKeyboard);
          logger.info(`Zmiana ID ${sess.shiftId} niedostępna dla ${chatId}`);
          return;
        }

        if (!shift.chat_id || isNaN(shift.chat_id)) {
          logger.error(`Nieprawidłowy chat_id osoby oddającej zmianę: ${shift.chat_id}`);
          await bot.sendMessage(chatId, 'Błąd: Nie można skontaktować się z osobą oddającą zmianę.', mainKeyboard);
          return;
        }

        let notificationSent = false;

        try {
          await bot.sendMessage(shift.chat_id,
            `@${username} (${imie} ${nazwisko}, ID: ${idk}) chce przejąć Twoją zmianę:\nData: ${shift.date}, Godzina: ${shift.time}, Strefa: ${shift.strefa}\nSkontaktuj się z nim, aby ustalić szczegóły.`);
          logger.info(`Wiadomość wysłana do chatId ${shift.chat_id} (@${shift.username})`);
          notificationSent = true;

          await bot.sendMessage(shift.chat_id,
            `Musisz teraz powiadomić koordynatora, że oddajesz zmianę.`,
            { reply_markup: { inline_keyboard: [[{ text: 'Powiadomiłem koordynatora ✅', callback_data: `confirm_${sess.shiftId}_${chatId}_${username}` }]] } }
          );

          await db.run(`INSERT INTO shift_confirmations (shift_id, giver_chat_id, taker_chat_id, taker_username) VALUES (?, ?, ?, ?)`,
            [sess.shiftId, shift.chat_id, chatId, username]);
        } catch (error) {
          logger.error(`Błąd wysyłania wiadomości do chatId ${shift.chat_id} (@${shift.username}): ${error.message}`);
          await bot.sendMessage(chatId, `Nie udało się powiadomić @${shift.username}. Skontaktuj się z nim ręcznie, aby ustalić szczegóły przejęcia zmiany. Może być konieczne rozpoczęcie rozmowy z botem przez @${shift.username} (np. wpisanie /start).`, mainKeyboard);
        }

        if (notificationSent) {
          await bot.sendMessage(chatId, `Wiadomość o Twoim zainteresowaniu została wysłana do @${shift.username}. Skontaktuj się z nim w celu ustalenia szczegółów.`, mainKeyboard);
        }

        await db.run(`DELETE FROM shifts WHERE id = ?`, [sess.shiftId]);
        logger.info(`Zmiana o ID ${sess.shiftId} usunięta z bazy danych`);
        lastReminderTimes.delete(parseInt(sess.shiftId));
      } catch (error) {
        logger.error(`Błąd podczas przekazywania zmiany dla ${chatId}: ${error.message}`);
        await bot.sendMessage(chatId, 'Wystąpił błąd podczas próby przekazania zmiany.', mainKeyboard);
      } finally {
        clearSession(chatId);
      }
      return;
    }
  } catch (err) {
    logger.error(`Błąd przetwarzania wiadomości od ${chatId}: ${err.message}`);
    await bot.sendMessage(chatId, 'Wystąpił błąd. Spróbuj ponownie.', mainKeyboard);
    clearSession(chatId);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const chatId in session) {
    if (now - session[chatId].lastActive > SESSION_TIMEOUT) {
      clearSession(chatId);
      delete lastCommand[chatId];
      logger.info(`Sesja dla ${chatId} wyczyszczona z powodu timeoutu`);
    }
  }
  cleanExpiredShifts();
}, 5 * 60 * 1000);

setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    axios.get(url).then(() => {
      logger.info('Ping do samego siebie wysłany');
    }).catch((err) => {
      logger.error('Błąd pingu:', err.message);
    });
  }
}, 240000);

app.get('/', (_, res) => res.send('Bot is running'));
app.listen(PORT, () => {
  logger.info(`Bot is listening on port ${PORT}`);
});