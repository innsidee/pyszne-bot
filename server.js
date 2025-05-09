const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const moment = require('moment');
const winston = require('winston');
moment.locale('pl');

dotenv.config();
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error('TELEGRAM_TOKEN nie ustawiony w .env');
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL nie ustawiony w .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const app = express();
const PORT = process.env.PORT || 10000;

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

const pool = new Pool({
  connectionString: dbUrl,
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.on('connect', () => {
  logger.info('Połączono z bazą danych PostgreSQL');
});

pool.on('error', (err) => {
  logger.error('Błąd połączenia z bazą danych PostgreSQL:', err.message);
  setTimeout(() => pool.connect(), 5000);
});

const db = {
  run: async (query, params = []) => {
    const client = await pool.connect();
    try {
      await client.query(query, params);
    } catch (err) {
      throw err;
    } finally {
      client.release();
    }
  },
  get: async (query, params = []) => {
    const client = await pool.connect();
    try {
      const res = await client.query(query, params);
      return res.rows[0] || null;
    } catch (err) {
      throw err;
    } finally {
      client.release();
    }
  },
  all: async (query, params = []) => {
    const client = await pool.connect();
    try {
      const res = await client.query(query, params);
      return res.rows;
    } catch (err) {
      throw err;
    } finally {
      client.release();
    }
  },
};

const STREFY = ['Centrum', 'Ursus', 'Bemowo/Bielany', 'Białołęka/Tarchomin', 'Praga', 'Rembertów', 'Wawer', 'Służew/Ursynów', 'Wilanów', 'Marki', 'Legionowo', 'Łomianki', 'Piaseczno', 'Pruszków'];
const session = {};
const SESSION_TIMEOUT = 60 * 60 * 1000;
const LAST_COMMAND_TIMEOUT = 5 * 60 * 1000;
const SHIFT_EXPIRY_HOURS = 168;
const lastCommand = {};
const lastReminderTimes = new Map();

const ADMIN_CHAT_ID = 606154517;
const mainKeyboard = {
  reply_markup: {
    keyboard: [
      ['Oddaj zmianę', 'Zobaczyć zmiany'],
      ['Subskrybuj strefę', 'Subskrypcje'],
      ['Moje statystyki', 'Usuń moją zmianę'],
      ['Ustaw profil', 'Instrukcja']
    ],
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
  logger.info('Inicjalizacja bazy danych PostgreSQL...');
  await db.run(`
    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      chat_id BIGINT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      strefa TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      strefa TEXT NOT NULL,
      CONSTRAINT unique_user_strefa UNIQUE (user_id, strefa)
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS shift_confirmations (
      id SERIAL PRIMARY KEY,
      shift_id INTEGER NOT NULL,
      giver_chat_id BIGINT NOT NULL,
      taker_chat_id BIGINT NOT NULL,
      taker_username TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS stats (
      user_id BIGINT PRIMARY KEY,
      shifts_given INTEGER DEFAULT 0,
      shifts_taken INTEGER DEFAULT 0,
      subscriptions INTEGER DEFAULT 0
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      chat_id BIGINT PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      courier_id TEXT
    )
  `);
  logger.info('Baza danych PostgreSQL zainicjalizowana pomyślnie');
}
initializeDatabase();

process.on('SIGINT', async () => {
  logger.info('Zamykanie połączenia z bazą danych...');
  await pool.end();
  logger.info('Połączenie z bazą danych zamknięte.');
  process.exit(0);
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
    if (parsed.isBefore(today)) {
      return null;
    }
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

if (match) {
  const [_, startHour, startMinute, endHour, endMinute] = match;
  return `${startHour}:${startMinute}-${endHour}:${endMinute}`;
}

  }
  return null;
}

async function sendErr(chatId, sess, message) {
  const errMessage = await bot.sendMessage(chatId, `Błąd: ${message}`, returnKeyboard);
  sess.messagesToDelete.push(errMessage.message_id);
  logger.info(`Wysłano błąd do ${chatId}: ${message}`);
}

async function notifySubscribers(strefa, date, time, username, chatId) {
  try {
    const subscribers = await db.all(`SELECT user_id FROM subscriptions WHERE strefa = $1`, [strefa]);
    for (let i = 0; i < subscribers.length; i++) {
      const sub = subscribers[i];
      if (sub.user_id !== chatId) {
        setTimeout(async () => {
          const shiftStart = moment(`${date} ${time.split('-')[0]}`, 'DD.MM.YYYY HH:mm');
          if (shiftStart.isAfter(moment())) {
            await bot.sendMessage(sub.user_id, `Nowa zmiana w Twojej strefie (${strefa}): ${date}, ${time} (od @${username})`);
            logger.info(`Wysłano powiadomienie do ${sub.user_id}: Nowa zmiana w ${strefa}`);
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
  const shiftStart = moment(`${shift.date} ${shift.time.split('-')[0]}`, 'DD.MM.YYYY HH:mm');
  if (shiftStart.isAfter(moment())) {
    try {
      const subscribers = await db.all(`SELECT user_id FROM subscriptions WHERE strefa = $1`, [shift.strefa]);
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
}

async function cleanExpiredShifts() {
  try {
    const shifts = await db.all(`SELECT id, username, chat_id, date, time, strefa, created_at FROM shifts`);
    const now = moment();
    for (const shift of shifts) {
      const createdAt = moment(shift.created_at);
      const shiftStart = moment(`${shift.date} ${shift.time.split('-')[0]}`, 'DD.MM.YYYY HH:mm');

      // Удаление если смена уже началась или истек срок жизни
if (shiftStart.isSameOrBefore(now) || now.diff(createdAt, 'hours') >= SHIFT_EXPIRY_HOURS) {
  await db.run(`DELETE FROM shifts WHERE id = $1`, [shift.id]);
  logger.info(`Usunięto zmianę ID ${shift.id} - rozpoczęła się lub wygasła`);
  lastReminderTimes.delete(shift.id);
  continue;
}

const shiftEnd = moment(`${shift.date} ${shift.time.split('-')[1]}`, 'DD.MM.YYYY HH:mm');
if (shiftEnd.isSameOrBefore(now) || now.diff(createdAt, 'hours') >= SHIFT_EXPIRY_HOURS) {
  await db.run(`DELETE FROM shifts WHERE id = $1`, [shift.id]);
  logger.info(`Usunięto zmianę ID ${shift.id} - zakończyła się lub wygasła`);
  lastReminderTimes.delete(shift.id);
  continue;
}


      }

      // Напоминание ровно за час перед началом смены
      const minutesToStart = shiftStart.diff(now, 'minutes');
     if (minutesToStart <= 120 && minutesToStart > 115) { // Okno 5 minut
  await sendReminder(shift);
  continue;
}
    }
  } catch (error) {
    logger.error(`Błąd podczas czyszczenia wygasłych zmian: ${error.message}`);
  }
}

async function updateStats(userId, field, increment = 1) {
  try {
    await db.run(
      `INSERT INTO stats (user_id, shifts_given, shifts_taken, subscriptions) VALUES ($1, 0, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    await db.run(
      `UPDATE stats SET ${field} = ${field} + $1 WHERE user_id = $2`,
      [increment, userId]
    );
    logger.info(`Zaktualizowano statystyki dla user_id ${userId}: ${field} + ${increment}`);
  } catch (error) {
    logger.error(`Błąd aktualizacji statystyk dla ${userId}: ${error.message}`);
  }
}

async function sendBroadcast(chatId, message) {
  try {
    const users = new Set();
    const tables = ['shifts', 'subscriptions', 'stats', 'shift_confirmations'];
    for (const table of tables) {
      const rows = await db.all(`SELECT DISTINCT chat_id FROM ${table} WHERE chat_id IS NOT NULL`);
      rows.forEach(row => users.add(row.chat_id));
    }

    if (users.size === 0) {
      await bot.sendMessage(chatId, 'Nie ma żadnych użytkowników do powiadomienia.', mainKeyboard);
      return;
    }

    for (const userId of users) {
      try {
        await bot.sendMessage(userId, message);
        logger.info(`Wysłano broadcast do ${userId}: ${message}`);
      } catch (err) {
        logger.error(`Błąd wysyłania broadcast do ${userId}: ${err.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await bot.sendMessage(chatId, 'Wiadomość została rozesłana do wszystkich użytkowników.', mainKeyboard);
  } catch (error) {
    logger.error(`Błąd podczas wysyłania broadcast: ${error.message}`);
    await bot.sendMessage(chatId, 'Wystąpił błąd podczas rozsyłania wiadomości.', mainKeyboard);
  }
}

bot.onText(/\/start/, async (msg) => {
  clearSession(msg.chat.id);
  updateLastCommand(msg.chat.id);
  session[msg.chat.id] = { lastActive: Date.now(), userProfile: await getUserProfile(msg.chat.id) };
  await bot.sendMessage(msg.chat.id, 'Cześć! Co chcesz zrobić?', mainKeyboard);
  logger.info(`Użytkownik ${msg.chat.id} (@${msg.from.username || 'brak'}) uruchomił /start`);
});

bot.onText(/\/broadcast/, async (msg) => {
  const chatId = msg.chat.id;
  if (chatId !== ADMIN_CHAT_ID) { 
    await bot.sendMessage(chatId, 'Nie masz uprawnień do tej komendy.', mainKeyboard);
    logger.info(`Nieautoryzowana próba użycia /broadcast przez ${chatId}`);
    return;
  }

  updateLastCommand(chatId);
  session[chatId] = { mode: 'broadcast', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
  const message = await bot.sendMessage(chatId, 'Wpisz treść wiadomości, którą chcesz rozesłać:', returnKeyboard);
  session[chatId].messagesToDelete.push(message.message_id);
  logger.info(`Użytkownik ${chatId} rozpoczął broadcast`);
});

async function getUserProfile(chatId) {
  const profile = await db.get(`SELECT first_name, last_name, courier_id FROM user_profiles WHERE chat_id = $1`, [chatId]);
  return profile || { first_name: null, last_name: null, courier_id: null };
}

async function saveUserProfile(chatId, firstName, lastName, courierId) {
  await db.run(
    `INSERT INTO user_profiles (chat_id, first_name, last_name, courier_id) VALUES ($1, $2, $3, $4) 
     ON CONFLICT (chat_id) DO UPDATE SET first_name = $2, last_name = $3, courier_id = $4`,
    [chatId, firstName, lastName, courierId]
  );
  logger.info(`Zapisano profil dla ${chatId}: ${firstName} ${lastName}, ID: ${courierId}`);
}

bot.on('message', async (msg) => {
  const text = msg.text?.trim();
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name || 'Użytkownik';

  if (!await checkLastCommand(chatId)) return;

  session[chatId] = { ...session[chatId], lastActive: Date.now(), userProfile: session[chatId]?.userProfile || await getUserProfile(chatId) };
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

    if (text === 'Oddaj zmianę') {
      updateLastCommand(chatId);
      session[chatId] = { mode: 'oddaj', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
      const message = await bot.sendMessage(chatId, 'Wybierz strefę:', zonesKeyboard);
      session[chatId].messagesToDelete.push(message.message_id);
      logger.info(`Użytkownik ${chatId} rozpoczął oddawanie zmiany`);
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

    if (text === 'Subskrybuj strefę') {
      updateLastCommand(chatId);
      session[chatId] = { mode: 'subskrypcja', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
      const message = await bot.sendMessage(chatId, 'Wybierz strefę:', {
        reply_markup: {
          inline_keyboard: STREFY.map(s => [{ text: s, callback_data: `sub_${s}` }]),
        },
      });
      session[chatId].messagesToDelete.push(message.message_id);
      logger.info(`Użytkownik ${chatId} rozpoczął subskrypcję strefy`);
      return;
    }

    if (text === 'Subskrypcje') {
      updateLastCommand(chatId);
      logger.info(`Użytkownik ${chatId} wywołał Subskrypcje`);

      try {
        const subscriptions = await db.all(`SELECT strefa FROM subscriptions WHERE user_id = $1`, [chatId]);
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
      return;
    }

    if (text === 'Usuń moją zmianę') {
      updateLastCommand(chatId);
      logger.info(`Użytkownik ${chatId} wywołał Usuń moją zmianę`);

      try {
        const shifts = await db.all(`SELECT id, date, time, strefa FROM shifts WHERE chat_id = $1 ORDER BY created_at DESC`, [chatId]);
        if (!shifts.length) {
          await bot.sendMessage(chatId, 'Nie masz żadnych zmian do usunięcia.', mainKeyboard);
          logger.info(`Użytkownik ${chatId} nie ma zmian do usunięcia`);
          return;
        }

        const inlineKeyboard = shifts.map(shift => [
          { text: `${shift.date}, ${shift.time}, ${shift.strefa}`, callback_data: `delete_shift_${shift.id}` },
        ]);
        await bot.sendMessage(chatId, 'Wybierz zmianę do usunięcia:', {
          reply_markup: { inline_keyboard: inlineKeyboard },
        });
        logger.info(`Wysłano listę zmian do usunięcia użytkownikowi ${chatId}`);
      } catch (error) {
        logger.error(`Błąd podczas pobierania zmian do usunięcia dla ${chatId}: ${error.message}`);
        await bot.sendMessage(chatId, 'Wystąpił błąd podczas pobierania zmian.', mainKeyboard);
      }
      return;
    }

    if (text === 'Moje statystyki') {
      updateLastCommand(chatId);
      logger.info(`Użytkownik ${chatId} wywołał Moje statystyki`);

      try {
        const stats = await db.get(`SELECT shifts_given, shifts_taken, subscriptions FROM stats WHERE user_id = $1`, [chatId]);
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
      return;
    }

    if (text === 'Ustaw profil') {
      updateLastCommand(chatId);
      session[chatId] = { mode: 'setprofile', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
      const message = await bot.sendMessage(chatId, 'Podaj swoje imię, nazwisko i ID kuriera (np. Jan Kowalski 12345)', returnKeyboard);
      session[chatId].messagesToDelete.push(message.message_id);
      logger.info(`Użytkownik ${chatId} rozpoczął ustawianie profilu`);
      return;
    }

    if (text === 'Instrukcja') {
      updateLastCommand(chatId);
      logger.info(`Użytkownik ${chatId} wywołał Instrukcję`);

      const instruction = `📋 **Instrukcja obsługi bota Wymiana zmian Pyszne**\nCześć! Ten bot pomaga w wygodnej wymianie zmian między kurierami. Oto, co potrafi:\n1. **Oddaj zmianę** 📅\n   - Wybierz strefę, datę i godziny zmiany, którą chcesz oddać.\n   - Zmiana pojawi się w wybranej strefie, a subskrybenci dostaną powiadomienie.\n   - Po 24 godzinach zmiana wygasa, jeśli nikt jej nie przejmie.\n2. **Zobaczyć zmiany** 🔍\n   - Przeglądaj dostępne zmiany w wybranej strefie.\n   - Kliknij „Przejmuję zmianę”, podaj swoje dane (imię, nazwisko, ID kuriera), a bot powiadomi osobę oddającą.\n3. **Usuń moją zmianę** 🗑️\n   - Usuń jedną ze swoich zmian, jeśli zmieniłeś zdanie.\n4. **Subskrybuj strefę** 🔔\n   - Subskrybuj strefy, aby otrzymywać powiadomienia o nowych zmianach.\n   - Zarządzaj subskrypcjami przez przycisk „Subskrypcje”.\n5. **Moje statystyki** 📊\n   - Sprawdzaj, ile zmian oddałeś, przejąłeś i ile masz aktywnych subskrypcji.\n6. **Anulowanie** 🚫\n   - Użyj /cancel, aby przerwać bieżącą operację i wrócić do menu.\n💡 **Wskazówki**:\n- Upewnij się, że podajesz poprawne dane (np. format daty: 05.05.2025, godziny: 11:00-19:00).\n- Po przejęciu zmiany skontaktuj się z osobą oddającą, aby potwierdzić szczegóły.\n- W razie problemów z botem napisz do @asiaolejnik.\nMasz pytania, problemy lub pomysły na nowe funkcje? Pisz do @asiaolejnik! 🚀`;
      await bot.sendMessage(chatId, instruction, mainKeyboard);
      logger.info(`Wysłano instrukcję użytkownikowi ${chatId}`);
      return;
    }

    if (sess.mode === 'view' && STREFY.includes(text)) {
      logger.info(`Wybór strefy ${text} w trybie widoku dla ${chatId}`);
      try {
        const rows = await db.all(`SELECT id, username, chat_id, date, time FROM shifts WHERE strefa = $1 ORDER BY created_at DESC`, [text]);
        logger.info(`Znaleziono ${rows.length} zmian dla strefy ${text}`);
        if (!rows.length) {
          const msg2 = await bot.sendMessage(chatId, 'Brak dostępnych zmian w tej strefie.', zonesKeyboard);
          sess.messagesToDelete.push(msg2.message_id);
          logger.info(`Brak zmian w strefie ${text} dla ${chatId}`);
        } else {
          for (const row of rows) {
            const shiftStart = moment(`${row.date} ${row.time.split('-')[0]}`, 'DD.MM.YYYY HH:mm');
            if (shiftStart.isAfter(moment())) {
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
          `SELECT id FROM shifts WHERE username = $1 AND date = $2 AND time = $3 AND strefa = $4`,
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
          await db.run(`INSERT INTO shifts (username, chat_id, date, time, strefa) VALUES ($1, $2, $3, $4, $5)`,
            [username, chatId, sess.date, sess.time, sess.strefa]);
          await updateStats(chatId, 'shifts_given', 1);
          logger.info(`Dodano zmianę: ${sess.date}, ${sess.time}, ${sess.strefa}, użytkownik: @${username}, chatId: ${chatId}`);
          await bot.sendMessage(chatId, `Zapisano: ${sess.date}, ${sess.time}, ${sess.strefa}`, mainKeyboard);
          await notifySubscribers(sess.strefa, sess.date, sess.time, username, chatId);
        } catch (error) {
          logger.error(`Błąd podczas zapisywania zmiany dla ${chatId}: ${error.message}`);
          await bot.sendMessage(chatId, 'Wystąpił błąd podczas zapisywania zmiany.', mainKeyboard);
        } finally {
          clearSession(chatId);
        }
        return;
      }
    }

    if (sess.mode === 'setprofile') {
      const [firstName, lastName, courierId] = text.split(/\s+/);
      if (!firstName || !lastName || !courierId || isNaN(courierId)) {
        return await sendErr(chatId, sess, 'Błąd formatu. Podaj imię, nazwisko i ID kuriera, oddzielone spacjami (np. Jan Kowalski 12345).');
      }
      try {
        await saveUserProfile(chatId, firstName, lastName, courierId);
        session[chatId].userProfile = { first_name: firstName, last_name: lastName, courier_id: courierId };
        await bot.sendMessage(chatId, `Zapisano profil: ${firstName} ${lastName}, ID: ${courierId}`, mainKeyboard);
        logger.info(`Ustawiono profil dla ${chatId}: ${firstName} ${lastName}, ID: ${courierId}`);
      } catch (error) {
        logger.error(`Błąd zapisywania profilu dla ${chatId}: ${error.message}`);
        await bot.sendMessage(chatId, 'Wystąpił błąd podczas zapisywania profilu.', mainKeyboard);
      } finally {
        clearSession(chatId);
      }
      return;
    }

    if (sess.mode === 'broadcast') {
      try {
        await sendBroadcast(chatId, text);
        clearSession(chatId);
      } catch (error) {
        logger.error(`Błąd podczas wysyłania broadcast: ${error.message}`);
        await bot.sendMessage(chatId, 'Wystąpił błąd podczas rozsyłania wiadomości.', mainKeyboard);
      }
      return;
    }
  } catch (err) {
    logger.error(`Błąd przetwarzania wiadomości od ${chatId}: ${err.message}`);
    await bot.sendMessage(chatId, 'Wystąpił błąd. Spróbuj ponownie.', mainKeyboard);
    clearSession(chatId);
  }
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
      await db.run(`INSERT INTO subscriptions (user_id, strefa) VALUES ($1, $2) ON CONFLICT (user_id, strefa) DO NOTHING`, [chatId, strefa]);
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
      await db.run(`DELETE FROM subscriptions WHERE user_id = $1 AND strefa = $2`, [chatId, strefa]);
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
    const profile = session[chatId]?.userProfile || await getUserProfile(chatId);
    if (!profile.first_name || !profile.last_name || !profile.courier_id) {
      await bot.sendMessage(chatId, 'Najpierw ustaw swój profil, klikając „Ustaw profil”.', returnKeyboard);
      await bot.answerCallbackQuery(query.id);
      return;
    }
    session[chatId] = { mode: 'take', shiftId: parseInt(shiftId), giverChatId, messagesToDelete: [], userMessages: [], lastActive: Date.now(), userProfile: profile };
    logger.info(`Użytkownik ${chatId} chce przejąć zmianę o ID: ${shiftId} z profilem: ${profile.first_name} ${profile.last_name}, ID: ${profile.courier_id}`);
    await handleTakeShift(chatId, shiftId, giverChatId, profile, query.from.username || 'Użytkownik');
    await bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('confirm_')) {
    const [_, shiftId, takerChatId, takerUsername] = data.split('_');
    try {
      await bot.sendMessage(takerChatId,
        `Kurier @${query.from.username} już powiadomił koordynatora. Zmiana niebawem zostanie przypisana do Twojego grafiku. W razie pytań pisz do koordynatora albo do @${query.from.username}.`);
      await bot.sendMessage(chatId, 'Dziękujemy za potwierdzenie. Osoba przejmująca zmianę została powiadomiona.', mainKeyboard);
      await updateStats(takerChatId, 'shifts_taken', 1);
      logger.info(`Użytkownik ${chatId} potwierdził powiadomienie koordynatora dla zmiany ${shiftId}, powiadomiono ${takerChatId}`);

      await db.run(`DELETE FROM shift_confirmations WHERE shift_id = $1 AND giver_chat_id = $2 AND taker_chat_id = $3`, [shiftId, chatId, takerChatId]);
    } catch (error) {
      logger.error(`Błąd podczas potwierdzania powiadomienia koordynatora dla ${chatId}: ${error.message}`);
      await bot.sendMessage(chatId, 'Wystąpił błąd. Spróbuj ponownie lub skontaktuj się z koordynatorem ręcznie.', mainKeyboard);
    }
    await bot.answerCallbackQuery(query.id);
  } else if (data.startsWith('delete_shift_')) {
    const shiftId = data.slice(13);
    try {
      const shift = await db.get(`SELECT date, time, strefa FROM shifts WHERE id = $1 AND chat_id = $2`, [shiftId, chatId]);
      if (!shift) {
        await bot.sendMessage(chatId, 'Nie znaleziono tej zmiany lub nie należy do Ciebie.', mainKeyboard);
        logger.info(`Próba usunięcia nieistniejącej zmiany ${shiftId} przez ${chatId}`);
        return;
      }

      await db.run(`DELETE FROM shifts WHERE id = $1`, [shiftId]);
      await updateStats(chatId, 'shifts_given', -1);
      await bot.sendMessage(chatId, `Usunięto zmianę: ${shift.date}, ${shift.time}, ${shift.strefa}`, mainKeyboard);
      logger.info(`Użytkownik ${chatId} usunął zmianę ID ${shiftId}`);
    } catch (error) {
      logger.error(`Błąd podczas usuwania zmiany ${shiftId} dla ${chatId}: ${error.message}`);
      await bot.sendMessage(chatId, 'Wystąpił błąd podczas usuwania zmiany.', mainKeyboard);
    }
    await bot.answerCallbackQuery(query.id);
  }
});

async function handleTakeShift(chatId, shiftId, giverChatId, profile, takerUsername) {
  try {
    const shift = await db.get(`SELECT username, chat_id, date, time, strefa FROM shifts WHERE id = $1`, [shiftId]);
    if (!shift) {
      await bot.sendMessage(chatId, 'Ta zmiana już nie jest dostępna.', mainKeyboard);
      logger.info(`Zmiana ID ${shiftId} niedostępna dla ${chatId}`);
      return;
    }

    if (!shift.chat_id || isNaN(shift.chat_id)) {
      logger.error(`Nieprawidłowy chat_id osoby oddającej zmianę: ${shift.chat_id}`);
      await bot.sendMessage(chatId, 'Błąd: Nie można skontaktować się z osobą oddającą zmianę. Skontaktuj się z nią ręcznie.', mainKeyboard);
      return;
    }

    let notificationSent = false;
    try {
     await bot.sendMessage(shift.chat_id,
  `${profile.first_name} ${profile.last_name} ${profile.courier_id} zabiera zmianę (${shift.strefa}, ${shift.time}, ${shift.date})`);
      logger.info(`Wiadomość wysłana do chatId ${shift.chat_id} (@${shift.username})`);
      notificationSent = true;

      await bot.sendMessage(shift.chat_id,
        `Musisz teraz powiadomić koordynatora, że oddajesz zmianę.`,
        { reply_markup: { inline_keyboard: [[{ text: 'Powiadomiłem koordynatora ✅', callback_data: `confirm_${shiftId}_${chatId}_${takerUsername}` }]] } }
      );

      await db.run(`INSERT INTO shift_confirmations (shift_id, giver_chat_id, taker_chat_id, taker_username) VALUES ($1, $2, $3, $4)`,
        [shiftId, shift.chat_id, chatId, `${profile.first_name} ${profile.last_name}`]);
    } catch (error) {
      logger.error(`Błąd wysyłania wiadomości do chatId ${shift.chat_id} (@${shift.username}): ${error.message}`);
      await bot.sendMessage(chatId, `Nie udało się powiadomić @${shift.username}. Skontaktuj się z nim ręcznie, aby ustalić szczegóły przejęcia zmiany.`, mainKeyboard);
    }

    if (notificationSent) {
      await bot.sendMessage(chatId, `Wiadomość o Twoim zainteresowaniu została wysłana do @${shift.username}. Skontaktuj się z nim w celu ustalenia szczegółów.`, mainKeyboard);
    }

    await db.run(`DELETE FROM shifts WHERE id = $1`, [shiftId]);
    logger.info(`Zmiana o ID ${shiftId} usunięta z bazy danych`);
    lastReminderTimes.delete(parseInt(shiftId));
  } catch (error) {
    logger.error(`Błąd podczas przekazywania zmiany dla ${chatId}: ${error.message}`);
    await bot.sendMessage(chatId, 'Wystąpił błąd podczas próby przekazania zmiany.', mainKeyboard);
  } finally {
    clearSession(chatId);
  }
}

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
