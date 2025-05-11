const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const moment = require('moment-timezone');
moment.locale('pl');
const winston = require('winston');

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

lastReminderTimes.clear();
logger.info('Wyczyszczono lastReminderTimes na starcie');

const ADMIN_CHAT_ID = 606154517;
const mainKeyboard = {
  reply_markup: {
    keyboard: [
      ['Oddaj zmianę', 'Zobaczyć zmiany'],
      ['Zarządzaj subskrypcjami'],
      ['Moje statystyki', 'Usuń moją zmianę'],
      ['Ustaw profil', 'Zgłoś problem'],
      ['Edytuj zmianę'],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    persistent: true,
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
  await db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      sender_chat_id BIGINT NOT NULL,
      receiver_chat_id BIGINT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  if (!sess) return;

  if (sess?.messagesToDelete) {
    const messagesToKeep = sess.viewedShifts ? sess.messagesToDelete.filter(id => {
      return !sess.messagesToDelete.some(msgId => msgId === id && sess.viewedShifts.some(shiftId => shiftId.toString().includes(id.toString())));
    }) : sess.messagesToDelete;

    for (const id of messagesToKeep) {
      await bot.deleteMessage(chatId, id).catch(() => {});
    }
  }
  if (sess?.userMessages) {
    for (const id of sess.userMessages) {
      await bot.deleteMessage(chatId, id).catch(() => {});
    }
  }
  if (sess?.viewedShifts) {
    sess.viewedShifts = [];
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
    return `${startHour}:${startMinute}-${endHour}:${endMinute}`;
  }
  return null;
}

async function sendErr(chatId, sess, message) {
  const errMessage = await bot.sendMessage(chatId, `Błąd: ${message}`, returnKeyboard);
  sess.messagesToDelete.push(errMessage.message_id);
  logger.info(`Wysłano błąd do ${chatId}: ${message}`);
}

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

async function notifySubscribers(strefa, date, time, username, chatId) {
  try {
    const subscribers = await db.all(`SELECT user_id FROM subscriptions WHERE strefa = $1`, [strefa]);
    const shiftStart = moment(`${date} ${time.split('-')[0]}`, 'DD.MM.YYYY HH:mm');

    for (let i = 0; i < subscribers.length; i++) {
      const sub = subscribers[i];
      if (sub.user_id !== chatId && shiftStart.isAfter(moment())) {
        setTimeout(async () => {
          await bot.sendMessage(sub.user_id, `Nowa zmiana w Twojej strefie (${strefa}): ${date}, ${time} (od @${username})`);
          logger.info(`Wysłano powiadomienie do ${sub.user_id}: Nowa zmiana w ${strefa}`);
        }, i * 100);
      }
    }
  } catch (error) {
    logger.error('Błąd podczas powiadamiania subskrybentów:', error.message);
  }
}

async function sendReminder(shift, timeLabel) {
  const shiftId = shift.id;
  const shiftStart = moment.tz(`${shift.date} ${shift.time.split('-')[0]}`, 'DD.MM.YYYY HH:mm', 'Europe/Warsaw');
  const now = moment.tz('Europe/Warsaw');
  logger.info(`Próba wysłania przypomnienia (${timeLabel}) dla zmiany ID ${shiftId}: shiftStart=${shiftStart.format()}, now=${now.format()}`);

  if (shiftStart.isAfter(now)) {
    try {
      const subscribers = await db.all(`SELECT user_id FROM subscriptions WHERE strefa = $1`, [shift.strefa]);
      logger.info(`Znaleziono ${subscribers.length} subskrybentów dla strefy ${shift.strefa} dla zmiany ID ${shiftId}`);
      if (subscribers.length === 0) {
        logger.info(`Brak subskrybentów w strefie ${shift.strefa} dla zmiany ID ${shiftId}`);
        return;
      }

      let sentCount = 0;
      for (let i = 0; i < subscribers.length; i++) {
        const sub = subscribers[i];
        if (sub.user_id !== shift.chat_id) {
          logger.info(`Wysyłam przypomnienie (${timeLabel}) do ${sub.user_id} dla zmiany ID ${shiftId}`);
          try {
            await bot.sendMessage(
              sub.user_id,
              `Przypomnienie (${timeLabel} przed): Zmiana w strefie (${shift.strefa}) wciąż dostępna! ${shift.date}, ${shift.time} (od @${shift.username})`
            );
            logger.info(`Wysłano przypomnienie (${timeLabel}) o zmianie ID ${shiftId} do ${sub.user_id}`);
            sentCount++;
          } catch (err) {
            logger.error(`Błąd wysyłania przypomnienia (${timeLabel}) do ${sub.user_id}: ${err.message}`);
          }
        } else {
          logger.info(`Pomijam subskrybenta ${sub.user_id}, bo to autor zmiany ID ${shiftId}`);
        }
      }
      if (sentCount > 0) {
        logger.info(`Wysłano przypomnienia (${timeLabel}) dla ${sentCount} subskrybentów zmiany ID ${shiftId}`);
      } else {
        logger.info(`Nie wysłano żadnych przypomnień (${timeLabel}) dla zmiany ID ${shiftId}`);
      }
    } catch (error) {
      logger.error(`Błąd podczas wysyłania przypomnienia (${timeLabel}) dla zmiany ID ${shiftId}: ${error.message}`);
    }
  } else {
    logger.info(`Przypomnienie (${timeLabel}) dla zmiany ID ${shiftId} nie wysłane: zmiana już начęła się`);
  }
}

async function cleanExpiredShifts() {
  try {
    const shifts = await db.all(`SELECT id, username, chat_id, date, time, strefa, created_at FROM shifts`);
    const now = moment.tz('Europe/Warsaw');
    logger.info(`Uruchomiono cleanExpiredShifts, aktualny czas: ${now.format()}`);

    for (const shift of shifts) {
      const createdAt = moment.tz(shift.created_at, 'Europe/Warsaw');
      const shiftStart = moment.tz(`${shift.date} ${shift.time.split('-')[0]}`, 'DD.MM.YYYY HH:mm', 'Europe/Warsaw');
      logger.info(`Sprawdzam zmianę ID ${shift.id}: shiftStart=${shiftStart.format()}, now=${now.format()}`);

      let isBeingViewed = false;
      for (const chatId in session) {
        const sess = session[chatId];
        if (sess?.viewedShifts?.includes(shift.id)) {
          isBeingViewed = true;
          break;
        }
      }

      if (isBeingViewed) {
        logger.info(`Zmiana ID ${shift.id} jest wyświetlana użytkownikowi, pomijam usuwanie`);
        continue;
      }

      if (shiftStart.isSameOrBefore(now)) {
        await db.run(`DELETE FROM shifts WHERE id = $1`, [shift.id]);
        logger.info(`Usunięto zmianę ID ${shift.id} - już się rozpoczęła`);
        lastReminderTimes.delete(shift.id);
        lastReminderTimes.delete(`${shift.id}_2h`);
        continue;
      }

      if (now.diff(createdAt, 'hours') >= SHIFT_EXPIRY_HOURS) {
        await db.run(`DELETE FROM shifts WHERE id = $1`, [shift.id]);
        logger.info(`Usunięto zmianę ID ${shift.id} - wygasła`);
        lastReminderTimes.delete(shift.id);
        lastReminderTimes.delete(`${shift.id}_2h`);
        continue;
      }

      const minutesToStart = shiftStart.diff(now, 'minutes');
      logger.info(`Zmiana ID ${shift.id}: minutesToStart=${minutesToStart}, klucz 2h=${lastReminderTimes.get(`${shift.id}_2h`) || 'undefined'}`);
      if (minutesToStart <= 120 && minutesToStart > 100 && !lastReminderTimes.get(`${shift.id}_2h`)) {
        await sendReminder(shift, '2 godziny');
        lastReminderTimes.set(`${shift.id}_2h`, moment.tz('Europe/Warsaw'));
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

    const tablesWithUserId = ['subscriptions', 'stats'];
    for (const table of tablesWithUserId) {
      const rows = await db.all(`SELECT DISTINCT user_id FROM ${table}`);
      rows.forEach(row => users.add(row.user_id));
    }

    const shiftRows = await db.all(`SELECT DISTINCT chat_id FROM shifts WHERE chat_id IS NOT NULL`);
    shiftRows.forEach(row => users.add(row.chat_id));

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
  const chatId = msg.chat.id;
  clearSession(chatId);
  updateLastCommand(chatId);
  session[chatId] = { lastActive: Date.now(), userProfile: await getUserProfile(chatId), messagesToDelete: [], userMessages: [] };
  await bot.sendMessage(chatId, 'Cześć! Co chcesz zrobić?', mainKeyboard);
  logger.info(`Użytkownik ${chatId} (@${msg.from.username || 'brak'}) uruchomił /start`);
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

bot.onText(/\/admin_panel/, async (msg) => {
  const chatId = msg.chat.id;
  if (chatId !== ADMIN_CHAT_ID) {
    await bot.sendMessage(chatId, 'Nie masz uprawnień do tej komendy.', mainKeyboard);
    return;
  }
  updateLastCommand(chatId);
  session[chatId] = { mode: 'admin_panel', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
  const message = await bot.sendMessage(chatId, 'Panel admina:\n1. Przegląd użytkowników\n2. Przegląd zmian\n3. Usuń zmianę', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Przegląd użytkowników', callback_data: 'admin_users' }],
        [{ text: 'Przegląd zmian', callback_data: 'admin_shifts' }],
        [{ text: 'Usuń zmianę', callback_data: 'admin_delete_shift' }],
        [{ text: 'Powrót', callback_data: 'back_to_menu' }],
      ],
    },
  });
  session[chatId].messagesToDelete.push(message.message_id);
  logger.info(`Użytkownik ${chatId} wszedł do panelu admina`);
});

bot.on('message', async (msg) => {
  const text = msg.text?.trim();
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name || 'Użytkownik';

  if (!session[chatId] || (lastCommand[chatId] && Date.now() - lastCommand[chatId] > LAST_COMMAND_TIMEOUT)) {
    session[chatId] = { lastActive: Date.now(), userProfile: await getUserProfile(chatId), messagesToDelete: [], userMessages: [] };
    await bot.sendMessage(chatId, 'Cześć! Co chcesz zrobić?', mainKeyboard);
    logger.info(`Przywrócono menu dla ${chatId} (@${username}) po czasie bezczynności`);
    updateLastCommand(chatId);
  }

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

    if (text === 'Zarządzaj subskrypcjami') {
      updateLastCommand(chatId);
      session[chatId] = { mode: 'manage_subscriptions', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
      const message = await bot.sendMessage(chatId, 'Zarządzaj subskrypcjami:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Subskrybuj strefę', callback_data: 'subskrybuj' }],
            [{ text: 'Twoje subskrypcje', callback_data: 'twoje_subskrypcje' }],
            [{ text: 'Powrót', callback_data: 'back_to_menu' }],
          ],
        },
      });
      session[chatId].messagesToDelete.push(message.message_id);
      logger.info(`Użytkownik ${chatId} otworzył zarządzanie subskrypcjami`);
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

    if (text === 'Zgłoś problem') {
      updateLastCommand(chatId);
      session[chatId] = { mode: 'report_problem', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
      const message = await bot.sendMessage(chatId, 'Opisz problem:', returnKeyboard);
      session[chatId].messagesToDelete.push(message.message_id);
      logger.info(`Użytkownik ${chatId} rozpoczął zgłaszanie problemu`);
      return;
    }

    if (text === 'Edytuj zmianę') {
      updateLastCommand(chatId);
      session[chatId] = { mode: 'edit_shift', messagesToDelete: [], userMessages: [], lastActive: Date.now() };
      const shifts = await db.all(`SELECT id, date, time, strefa FROM shifts WHERE chat_id = $1`, [chatId]);
      if (!shifts.length) {
        await bot.sendMessage(chatId, 'Nie masz żadnych zmian do edycji.', mainKeyboard);
        clearSession(chatId);
        return;
      }
      const inlineKeyboard = shifts.map(shift => [
        { text: `${shift.date}, ${shift.time}, ${shift.strefa} (ID: ${shift.id})`, callback_data: `edit_${shift.id}` },
      ]);
      const message = await bot.sendMessage(chatId, 'Wybierz zmianę do edycji:', {
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
      session[chatId].messagesToDelete.push(message.message_id);
      logger.info(`Użytkownik ${chatId} rozpoczął edytowanie zmiany`);
      return;
    }

    if (sess.mode === 'view' && STREFY.includes(text)) {
      logger.info(`Wybór strefy ${text} w trybie widoku dla ${chatId}`);
      sess.strefa = text;
      sess.mode = 'view_filters';
      const message = await bot.sendMessage(chatId, 'Wybierz filtr:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Dzisiaj', callback_data: `filter_date_today_${text}` }],
            [{ text: 'Jutro', callback_data: `filter_date_tomorrow_${text}` }],
            [{ text: 'Rano (6:00-12:00)', callback_data: `filter_time_morning_${text}` }],
            [{ text: 'Popołudnie (12:00-18:00)', callback_data: `filter_time_afternoon_${text}` }],
            [{ text: 'Wieczór (18:00-24:00)', callback_data: `filter_time_evening_${text}` }],
            [{ text: 'Krótsze niż 6h', callback_data: `filter_duration_short_${text}` }],
            [{ text: 'Wszystkie', callback_data: `filter_all_${text}` }],
            [{ text: 'Powrót', callback_data: 'back_to_menu' }],
          ],
        },
      });
      sess.messagesToDelete.push(message.message_id);
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
          const result = await db.get(
            `INSERT INTO shifts (username, chat_id, date, time, strefa, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [username, chatId, sess.date, sess.time, sess.strefa, moment().tz('Europe/Warsaw').format()]
          );
          const shiftId = result.id;
          const shift = {
            id: shiftId,
            username,
            chat_id: chatId,
            date: sess.date,
            time: sess.time,
            strefa: sess.strefa,
            created_at: moment().tz('Europe/Warsaw').format(),
          };

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

    if (sess.mode === 'report_problem') {
      await bot.sendMessage(ADMIN_CHAT_ID, `Zgłoszenie problemu od ${chatId} (@${msg.from.username || 'brak'}):\n${text}`);
      await bot.sendMessage(chatId, 'Problem został zgłoszony do administratora. Dziękujemy!', mainKeyboard);
      clearSession(chatId);
      return;
    }

    if (sess.mode === 'edit_strefa' && STREFY.includes(text)) {
      logger.info(`Przetwarzanie trybu edit_strefa dla ${chatId}, tekst: ${text}`);
      await db.run(`UPDATE shifts SET strefa = $1 WHERE id = $2 AND chat_id = $3`, [text, sess.shiftId, chatId]);
      await bot.sendMessage(chatId, `Zaktualizowano strefę na ${text}.`, mainKeyboard);
      clearSession(chatId);
      logger.info(`Użytkownik ${chatId} zaktualizował strefę na ${text} dla zmiany ${sess.shiftId}`);
      return;
    }

    if (sess.mode === 'edit_date') {
      logger.info(`Przetwarzanie trybu edit_date dla ${chatId}, tekst: ${text}`);
      const date = parseDate(text);
      if (!date) return await sendErr(chatId, sess, 'Zły format daty. Napisz np. dzisiaj, jutro lub 05.05.2025');
      await db.run(`UPDATE shifts SET date = $1 WHERE id = $2 AND chat_id = $3`, [date, sess.shiftId, chatId]);
      await bot.sendMessage(chatId, `Zaktualizowano datę na ${date}.`, mainKeyboard);
      clearSession(chatId);
      logger.info(`Użytkownik ${chatId} zaktualizował datę na ${date} dla zmiany ${sess.shiftId}`);
      return;
    }

    if (sess.mode === 'edit_time') {
      logger.info(`Przetwarzanie trybu edit_time dla ${chatId}, tekst: ${text}`);
      const time = parseTime(text);
      if (!time) return await sendErr(chatId, sess, 'Zły format godzin. Napisz np. 11:00-19:00');
      await db.run(`UPDATE shifts SET time = $1 WHERE id = $2 AND chat_id = $3`, [time, sess.shiftId, chatId]);
      await bot.sendMessage(chatId, `Zaktualizowano czas na ${time}.`, mainKeyboard);
      clearSession(chatId);
      logger.info(`Użytkownik ${chatId} zaktualizował czas na ${time} dla zmiany ${sess.shiftId}`);
      return;
    }

    if (sess.mode === 'contact') {
      if (text === 'Zakończ czat') {
        clearTimeout(sess.chatTimeout);
        await bot.sendMessage(chatId, 'Czat zakończony.', mainKeyboard);
        await bot.sendMessage(sess.otherChatId, `Użytkownik @${username} zakończył czat.`, mainKeyboard);
        clearSession(chatId);
        return;
      }

      await db.run(`INSERT INTO chat_messages (sender_chat_id, receiver_chat_id, message) VALUES ($1, $2, $3)`, 
        [chatId, sess.otherChatId, text]);
      await bot.sendMessage(sess.otherChatId, `Wiadomość od @${username}: ${text}`, {
        reply_markup: {
          keyboard: [['Zakończ czat']],
          resize_keyboard: true,
        },
      });
      await bot.sendMessage(chatId, `Wiadomość wysłana do @${sess.otherUsername}.`, {
        reply_markup: {
          keyboard: [['Zakończ czat']],
          resize_keyboard: true,
        },
      });
      return;
    }

    await bot.sendMessage(chatId, 'Nie rozumiem. Co chcesz zrobić?', mainKeyboard);
    logger.info(`Użytkownik ${chatId} wpisał nieznaną komendę: "${text}" - pokazano menu`);
  } catch (err) {
    logger.error(`Błąd przetwarzania wiadomości od ${chatId}: ${err.message}`);
    await bot.sendMessage(chatId, 'Wystąpił błąd. Spróbuj ponownie.', mainKeyboard);
    clearSession(chatId);
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const username = query.from.username || query.from.first_name || 'Użytkownik';
  updateLastCommand(chatId);

  if (!session[chatId]) {
    session[chatId] = { lastActive: Date.now(), messagesToDelete: [], userMessages: [], userProfile: await getUserProfile(chatId) };
  }

  session[chatId] = { ...session[chatId], lastActive: Date.now(), messagesToDelete: session[chatId]?.messagesToDelete || [], userMessages: session[chatId]?.userMessages || [] };
  const sess = session[chatId];

  logger.info(`Użytkownik ${chatId} (@${username}) kliknął callback: ${data}`);

  try {
    if (data === 'subskrybuj') {
      sess.mode = 'subskrypcja';
      const message = await bot.sendMessage(chatId, 'Wybierz strefę:', {
        reply_markup: {
          inline_keyboard: STREFY.map(s => [{ text: s, callback_data: `sub_${s}` }]),
        },
      });
      sess.messagesToDelete.push(message.message_id);
      logger.info(`Użytkownik ${chatId} rozpoczął subskrypcję strefy`);
    } else if (data === 'twoje_subskrypcje') {
      logger.info(`Użytkownik ${chatId} wywołał Twoje subskrypcje`);
      const subscriptions = await db.all(`SELECT strefa FROM subscriptions WHERE user_id = $1`, [chatId]);
      if (!subscriptions.length) {
        await bot.sendMessage(chatId, 'Nie subskrybujesz żadnych stref.', mainKeyboard);
        logger.info(`Użytkownik ${chatId} nie ma subskrypcji`);
        clearSession(chatId);
        return;
      }

      const inlineKeyboard = subscriptions.map(sub => [
        { text: sub.strefa, callback_data: `unsub_${sub.strefa}` },
      ]);
      inlineKeyboard.push([{ text: 'Powrót', callback_data: 'back_to_menu' }]);
      await bot.sendMessage(chatId, 'Twoje subskrypcje (kliknij, aby odsubskrybować):', {
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
      logger.info(`Wysłano listę subskrypcji użytkownikowi ${chatId}`);
    } else if (data === 'back_to_menu') {
      clearSession(chatId);
      await bot.sendMessage(chatId, 'Cześć! Co chcesz zrobić?', mainKeyboard);
      logger.info(`Użytkownik ${chatId} wrócił do menu głównego`);
    } else if (data.startsWith('sub_')) {
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
      await handleTakeShift(chatId, shiftId, giverChatId, profile, username);
      clearSession(chatId);
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
    } else if (data === 'admin_users') {
      const users = await db.all(`
        SELECT DISTINCT user_id FROM subscriptions
        UNION
        SELECT DISTINCT chat_id FROM shifts
      `);
      let messageText = 'Lista użytkowników:\n';
      users.forEach((u, i) => messageText += `${i + 1}. ${u.user_id}\n`);
      await bot.sendMessage(chatId, messageText || 'Brak użytkowników.', mainKeyboard);
    } else if (data === 'admin_shifts') {
      const shifts = await db.all(`SELECT id, username, chat_id, date, time, strefa FROM shifts`);
      let messageText = 'Lista zmian:\n';
      const inlineKeyboard = [];
      shifts.forEach(shift => {
        messageText += `ID: ${shift.id}, ${shift.date}, ${shift.time}, ${shift.strefa} (od @${shift.username})\n`;
        inlineKeyboard.push([{ text: `Usuń zmianę ${shift.id}`, callback_data: `admin_delete_${shift.id}` }]);
      });
      inlineKeyboard.push([{ text: 'Powrót', callback_data: 'back_to_menu' }]);
      await bot.sendMessage(chatId, messageText || 'Brak zmian.', {
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } else if (data.startsWith('admin_delete_')) {
      const shiftId = data.split('_')[2];
      await db.run(`DELETE FROM shifts WHERE id = $1`, [shiftId]);
      await bot.sendMessage(chatId, `Usunięto zmianę o ID ${shiftId}.`, mainKeyboard);
      logger.info(`Admin ${chatId} usunął zmianę ID ${shiftId}`);
    } else if (data.startsWith('edit_')) {
      const shiftId = data.split('_')[1];
      sess.shiftId = shiftId;
      sess.mode = 'edit_select';
      await bot.sendMessage(chatId, 'Wybierz, co edytować:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Strefa', callback_data: `edit_strefa_${shiftId}` }],
            [{ text: 'Data', callback_data: `edit_date_${shiftId}` }],
            [{ text: 'Czas', callback_data: `edit_time_${shiftId}` }],
            [{ text: 'Powrót', callback_data: 'back_to_menu' }],
          ],
        },
      });
      logger.info(`Użytkownik ${chatId} wybrał zmianę ${shiftId} do edycji, tryb: ${sess.mode}`);
    } else if (data.startsWith('edit_strefa_')) {
      const shiftId = data.split('_')[2];
      sess.mode = 'edit_strefa';
      sess.shiftId = shiftId;
      const message = await bot.sendMessage(chatId, 'Wybierz nową strefę:', zonesKeyboard);
      sess.messagesToDelete.push(message.message_id);
      logger.info(`Użytkownik ${chatId} rozpoczął edytowanie strefy dla zmiany ${shiftId}, tryb: ${sess.mode}`);
    } else if (data.startsWith('edit_date_')) {
      const shiftId = data.split('_')[2];
      sess.mode = 'edit_date';
      sess.shiftId = shiftId;
      const message = await bot.sendMessage(chatId, 'Wybierz nową datę (np. dzisiaj, jutro, 05.05.2025):', returnKeyboard);
      sess.messagesToDelete.push(message.message_id);
      logger.info(`Użytkownik ${chatId} rozpoczął edytowanie daty dla zmiany ${shiftId}, tryb: ${sess.mode}`);
    } else if (data.startsWith('edit_time_')) {
      const shiftId = data.split('_')[2];
      sess.mode = 'edit_time';
      sess.shiftId = shiftId;
      const message = await bot.sendMessage(chatId, 'Wpisz nowy czas (np. 11:00-19:00):', returnKeyboard);
      sess.messagesToDelete.push(message.message_id);
      logger.info(`Użytkownik ${chatId} rozpoczął edytowanie czasu dla zmiany ${shiftId}, tryb: ${sess.mode}`);
    } else if (data.startsWith('filter_')) {
      const [_, filterType, filterValue, strefa] = data.split('_');
      try {
        let rows = await db.all(`SELECT id, username, chat_id, date, time FROM shifts WHERE strefa = $1 ORDER BY created_at DESC`, [strefa]);
        const now = moment();

        if (filterType === 'date') {
          const today = moment().startOf('day');
          const tomorrow = moment().add(1, 'day').startOf('day');
          rows = rows.filter(row => {
            const shiftDate = moment(row.date, 'DD.MM.YYYY');
            if (filterValue === 'today') return shiftDate.isSame(today, 'day');
            if (filterValue === 'tomorrow') return shiftDate.isSame(tomorrow, 'day');
            return true;
          });
        }

        if (filterType === 'time') {
          rows = rows.filter(row => {
            const startHour = parseInt(row.time.split('-')[0].split(':')[0]);
            if (filterValue === 'morning') return startHour >= 6 && startHour < 12;
            if (filterValue === 'afternoon') return startHour >= 12 && startHour < 18;
            if (filterValue === 'evening') return startHour >= 18 && startHour < 24;
            return true;
          });
        }

        if (filterType === 'duration') {
          rows = rows.filter(row => {
            const [start, end] = row.time.split('-');
            const startTime = moment(start, 'HH:mm');
            const endTime = moment(end, 'HH:mm');
            const duration = endTime.diff(startTime, 'hours', true);
            if (filterValue === 'short') return duration < 6;
            return true;
          });
        }

        sess.viewedShifts = rows.map(row => row.id);

        if (!rows.length) {
          const msg2 = await bot.sendMessage(chatId, 'Brak dostępnych zmian po zastosowaniu filtra.', mainKeyboard);
          sess.messagesToDelete.push(msg2.message_id);
          logger.info(`Brak zmian po filtrze ${filterType}_${filterValue} w strefie ${strefa} dla ${chatId}`);
          sess.viewedShifts = [];
        } else {
          for (const row of rows) {
            const shiftStart = moment(`${row.date} ${row.time.split('-')[0]}`, 'DD.MM.YYYY HH:mm');
            if (shiftStart.isAfter(now)) {
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
        // Nie czyścimy sesji od razu
      } catch (err) {
        logger.error(`Błąd podczas filtrowania zmian w strefie ${strefa}: ${err.message}`);
        await bot.sendMessage(chatId, 'Wystąpił błąd podczas filtrowania zmian.', mainKeyboard);
        clearSession(chatId);
      }
    } else if (data.startsWith('contact_')) {
      const [_, otherChatId, otherUsername] = data.split('_');
      sess.mode = 'contact';
      sess.otherChatId = parseInt(otherChatId);
      sess.otherUsername = otherUsername;
      await bot.sendMessage(chatId, `Rozpoczęto czat z @${otherUsername}. Napisz wiadomość (czat wygasa po 10 minutach):`, {
        reply_markup: {
          keyboard: [['Zakończ czat']],
          resize_keyboard: true,
        },
      });
      sess.chatTimeout = setTimeout(async () => {
        await bot.sendMessage(chatId, 'Czat wygasł po 10 minutach.', mainKeyboard);
        await bot.sendMessage(otherChatId, 'Czat wygasł po 10 minutach.', mainKeyboard);
        clearSession(chatId);
      }, 10 * 60 * 1000);
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    logger.error(`Błąd podczas przetwarzania callback od ${chatId}: ${err.message}`);
    await bot.sendMessage(chatId, 'Wystąpił błąd. Spróbuj ponownie.', mainKeyboard);
    clearSession(chatId);
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
        `Musisz teraz zgłosić zmianę w formularzu Pyszne.pl.`,
        { 
          reply_markup: { 
            inline_keyboard: [
              [{ text: 'Wysłać formularz 📝', url: 'https://docs.google.com/forms/d/e/1FAIpQLSenjgRS5ik8m61MK1jab4k1p1AYisscQ5fDC6EsFf8BkGk1og/viewform' }],
              [{ text: 'Skontaktuj się z przejmującym', callback_data: `contact_${chatId}_${takerUsername}` }],
            ]
          }