const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const moment = require('moment-timezone');
moment.locale('pl');
const winston = require('winston');

dotenv.config();
const token = process.env.TELEGRAM_TOKEN || process.exit(1);
const dbUrl = process.env.DATABASE_URL || process.exit(1);

const bot = new TelegramBot(token, { polling: true });
const app = express();
const PORT = process.env.PORT || 10000;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
  ),
  transports: [new winston.transports.File({ filename: 'bot.log' }), new winston.transports.Console()],
});

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
pool.on('connect', () => logger.info('Połączono z bazą danych'));
pool.on('error', (err) => logger.error('Błąd bazy:', err.message));

const db = {
  run: async (query, params = []) => {
    const client = await pool.connect();
    try { await client.query(query, params); } catch (err) { throw err; } finally { client.release(); }
  },
  get: async (query, params = []) => {
    const client = await pool.connect();
    try { const res = await client.query(query, params); return res.rows[0] || null; } catch (err) { throw err; } finally { client.release(); }
  },
  all: async (query, params = []) => {
    const client = await pool.connect();
    try { const res = await client.query(query, params); return res.rows; } catch (err) { throw err; } finally { client.release(); }
  },
};

const STREFY = ['Centrum', 'Ursus', 'Bemowo/Bielany', 'Białołęka/Tarchomin', 'Praga', 'Rembertów', 'Wawer', 'Służew/Ursynów', 'Wilanów', 'Marki', 'Legionowo', 'Łomianki', 'Piaseczno', 'Pruszków'];
const session = {};
const lastCommand = {};
const lastReminderTimes = new Map();
const ADMIN_CHAT_ID = 606154517;

const mainKeyboard = { reply_markup: { keyboard: [['Oddaj zmianę', 'Zobaczyć zmiany'], ['Zarządzaj subskrypcjami'], ['Moje statystyki', 'Usuń moją zmianę'], ['Ustaw profil', 'Zgłoś problem'], ['Edytuj zmianę']], resize_keyboard: true } };
const zonesKeyboard = { reply_markup: { keyboard: [...STREFY.map(s => [s]), ['Powrót']], resize_keyboard: true } };
const returnKeyboard = { reply_markup: { keyboard: [['Powrót']], resize_keyboard: true } };

async function initDB() {
  logger.info('Inicjalizacja bazy...');
  await db.run(`CREATE TABLE IF NOT EXISTS shifts (id SERIAL PRIMARY KEY, username TEXT, chat_id BIGINT, date TEXT, time TEXT, strefa TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await db.run(`CREATE TABLE IF NOT EXISTS subscriptions (id SERIAL PRIMARY KEY, user_id BIGINT, strefa TEXT, UNIQUE (user_id, strefa))`);
  await db.run(`CREATE TABLE IF NOT EXISTS stats (user_id BIGINT PRIMARY KEY, shifts_given INTEGER DEFAULT 0, shifts_taken INTEGER DEFAULT 0, subscriptions INTEGER DEFAULT 0)`);
  await db.run(`CREATE TABLE IF NOT EXISTS user_profiles (chat_id BIGINT PRIMARY KEY, first_name TEXT, last_name TEXT, courier_id TEXT)`);
  await db.run(`CREATE TABLE IF NOT EXISTS chat_messages (id SERIAL PRIMARY KEY, sender_chat_id BIGINT, receiver_chat_id BIGINT, message TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  logger.info('Baza zainicjalizowana');
}
initDB();

process.on('SIGINT', async () => { await pool.end(); process.exit(0); });

async function clearSession(chatId) {
  const sess = session[chatId];
  if (!sess) return;
  [sess.messagesToDelete, sess.userMessages].forEach(ids => ids?.forEach(id => bot.deleteMessage(chatId, id).catch(() => {})));
  if (sess.viewedShifts) sess.viewedShifts = [];
  delete session[chatId];
}

function updateLastCommand(chatId) { lastCommand[chatId] = Date.now(); }
async function checkLastCommand(chatId) { if (lastCommand[chatId] && Date.now() - lastCommand[chatId] > 300000) { await bot.sendMessage(chatId, 'Czas minął. Menu?', mainKeyboard); delete session[chatId]; return false; } return true; }

function parseDate(text) {
  const [today, tomorrow] = [moment().startOf('day'), moment().add(1, 'day').startOf('day')];
  return { dzisiaj: today, jutro: tomorrow, pojutrze: moment().add(2, 'day') }[text.toLowerCase()]?.format('DD.MM.YYYY') || (moment(text, ['DD.MM', 'DD.MM.YYYY'], true).isAfter(today) ? moment(text, ['DD.MM', 'DD.MM.YYYY']).format('DD.MM.YYYY') : null);
}

function parseTime(text) { return text.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/)?.[0] || null; }

async function sendErr(chatId, sess, message) {
  const msg = await bot.sendMessage(chatId, `Błąd: ${message}`, returnKeyboard);
  sess.messagesToDelete.push(msg.message_id);
}

async function getUserProfile(chatId) { return (await db.get(`SELECT first_name, last_name, courier_id FROM user_profiles WHERE chat_id = $1`, [chatId])) || { first_name: null, last_name: null, courier_id: null }; }
async function saveUserProfile(chatId, firstName, lastName, courierId) { await db.run(`INSERT INTO user_profiles (chat_id, first_name, last_name, courier_id) VALUES ($1, $2, $3, $4) ON CONFLICT (chat_id) DO UPDATE SET first_name = $2, last_name = $3, courier_id = $4`, [chatId, firstName, lastName, courierId]); }
async function notifySubscribers(strefa, date, time, username, chatId) { (await db.all(`SELECT user_id FROM subscriptions WHERE strefa = $1`, [strefa])).forEach((sub, i) => { if (sub.user_id !== chatId && moment(`${date} ${time.split('-')[0]}`).isAfter(moment())) setTimeout(() => bot.sendMessage(sub.user_id, `Nowa zmiana (${strefa}): ${date}, ${time} (@${username})`).catch(() => {}), i * 100); }); }
async function sendReminder(shift, timeLabel) { if (moment.tz(`${shift.date} ${shift.time.split('-')[0]}`, 'Europe/Warsaw').isAfter(moment.tz('Europe/Warsaw'))) (await db.all(`SELECT user_id FROM subscriptions WHERE strefa = $1`, [shift.strefa])).forEach(sub => { if (sub.user_id !== shift.chat_id) bot.sendMessage(sub.user_id, `Przypomnienie (${timeLabel}): ${shift.strefa}, ${shift.date}, ${shift.time} (@${shift.username})`).catch(() => {}); }); }
async function cleanExpiredShifts() { (await db.all(`SELECT id, chat_id, date, time, created_at, strefa FROM shifts`)).forEach(async shift => { const now = moment.tz('Europe/Warsaw'); if (moment.tz(`${shift.date} ${shift.time.split('-')[0]}`, 'Europe/Warsaw').isSameOrBefore(now) || moment.tz(shift.created_at).diff(now, 'hours') >= 168) await db.run(`DELETE FROM shifts WHERE id = $1`, [shift.id]); }); }
async function updateStats(userId, field, increment = 1) { await db.run(`INSERT INTO stats (user_id, shifts_given, shifts_taken, subscriptions) VALUES ($1, 0, 0, 0) ON CONFLICT DO NOTHING`, [userId]); await db.run(`UPDATE stats SET ${field} = ${field} + $1 WHERE user_id = $2`, [increment, userId]); }
async function sendBroadcast(chatId, message) { (await db.all(`SELECT DISTINCT user_id FROM subscriptions UNION SELECT DISTINCT chat_id FROM shifts WHERE chat_id IS NOT NULL`)).forEach(user => bot.sendMessage(user.user_id || user.chat_id, message).catch(() => {})); await bot.sendMessage(chatId, 'Wiadomość rozesłana.', mainKeyboard); }

async function handleTakeShift(chatId, shiftId, giverChatId, profile, takerUsername) {
  const shift = await db.get(`SELECT username, chat_id, date, time, strefa FROM shifts WHERE id = $1`, [shiftId]);
  if (!shift || !shift.chat_id || isNaN(shift.chat_id)) return bot.sendMessage(chatId, 'Zmiana niedostępna lub błąd.', mainKeyboard);
  await bot.sendMessage(shift.chat_id, `${profile.first_name} ${profile.last_name} ${profile.courier_id} przejął zmianę (${shift.strefa}, ${shift.time}, ${shift.date})`);
  await bot.sendMessage(shift.chat_id, 'Zgłoś zmianę w formularzu.', { reply_markup: { inline_keyboard: [[{ text: 'Formularz', url: 'https://docs.google.com/forms/d/e/1FAIpQLSenjgRS5ik8m61MK1jab4k1p1AYisscQ5fDC6EsFf8BkGk1og/viewform' }]] } });
  await db.run(`DELETE FROM shifts WHERE id = $1`, [shiftId]);
  await updateStats(chatId, 'shifts_taken', 1);
  await updateStats(giverChatId, 'shifts_given', -1);
  await bot.sendMessage(chatId, `Przejęto: ${shift.date}, ${shift.time}, ${shift.strefa}`, mainKeyboard);
}

bot.onText(/\/start/, (msg) => { clearSession(msg.chat.id); updateLastCommand(msg.chat.id); session[msg.chat.id] = { messagesToDelete: [], userMessages: [] }; bot.sendMessage(msg.chat.id, 'Cześć! Co robisz?', mainKeyboard); });
bot.onText(/\/broadcast/, (msg) => { if (msg.chat.id === ADMIN_CHAT_ID) { session[msg.chat.id] = { mode: 'broadcast', messagesToDelete: [] }; bot.sendMessage(msg.chat.id, 'Treść?', returnKeyboard); } });
bot.onText(/\/admin_panel/, (msg) => { if (msg.chat.id === ADMIN_CHAT_ID) { session[msg.chat.id] = { mode: 'admin_panel', messagesToDelete: [] }; bot.sendMessage(msg.chat.id, 'Panel admina:\n1. Użytkownicy\n2. Zmiany\n3. Usuń', { reply_markup: { inline_keyboard: [[{ text: 'Użytkownicy', callback_data: 'admin_users' }], [{ text: 'Zmiany', callback_data: 'admin_shifts' }], [{ text: 'Usuń', callback_data: 'admin_delete_shift' }], [{ text: 'Powrót', callback_data: 'back_to_menu' }]] } }); } });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id, text = msg.text?.trim(), username = msg.from.username || msg.from.first_name || 'Użytkownik';
  if (!session[chatId] || (lastCommand[chatId] && Date.now() - lastCommand[chatId] > 300000)) { session[chatId] = { messagesToDelete: [], userMessages: [] }; bot.sendMessage(chatId, 'Menu?', mainKeyboard); updateLastCommand(chatId); }
  if (!await checkLastCommand(chatId)) return;

  session[chatId] = { ...session[chatId], userMessages: [...(session[chatId]?.userMessages || []), msg.message_id] };
  const sess = session[chatId];

  if (text === 'Powrót') { clearSession(chatId); return bot.sendMessage(chatId, 'Menu?', mainKeyboard); }
  if (text === 'Oddaj zmianę') { sess.mode = 'oddaj'; return bot.sendMessage(chatId, 'Strefa?', zonesKeyboard); }
  if (text.toLowerCase().includes('zobaczyć zmiany')) { sess.mode = 'view'; return bot.sendMessage(chatId, 'Strefa?', zonesKeyboard); }
  if (text === 'Zarządzaj subskrypcjami') { sess.mode = 'manage_subscriptions'; return bot.sendMessage(chatId, 'Wybierz:', { reply_markup: { inline_keyboard: [[{ text: 'Subskrybuj', callback_data: 'subskrybuj' }], [{ text: 'Twoje', callback_data: 'twoje_subskrypcje' }], [{ text: 'Powrót', callback_data: 'back_to_menu' }]] } }); }
  if (text === 'Usuń moją zmianę') { const shifts = await db.all(`SELECT id, date, time, strefa FROM shifts WHERE chat_id = $1`, [chatId]); if (!shifts.length) return bot.sendMessage(chatId, 'Brak zmian.', mainKeyboard); bot.sendMessage(chatId, 'Wybierz:', { reply_markup: { inline_keyboard: shifts.map(s => [{ text: `${s.date}, ${s.time}, ${s.strefa}`, callback_data: `delete_shift_${s.id}` }]) } }); }
  if (text === 'Moje statystyki') { const stats = await db.get(`SELECT shifts_given, shifts_taken, subscriptions FROM stats WHERE user_id = $1`, [chatId]) || {}; bot.sendMessage(chatId, `Statystyki:\nOddane: ${stats.shifts_given}\nPrzejęte: ${stats.shifts_taken}\nSubskrypcje: ${stats.subscriptions}`, mainKeyboard); }
  if (text === 'Ustaw profil') { sess.mode = 'setprofile'; bot.sendMessage(chatId, 'Imię, nazwisko, ID (np. Jan Kowalski 12345)?', returnKeyboard); }
  if (text === 'Zgłoś problem') { sess.mode = 'report_problem'; bot.sendMessage(chatId, 'Opisz:', returnKeyboard); }
  if (text === 'Edytuj zmianę') { const shifts = await db.all(`SELECT id, date, time, strefa FROM shifts WHERE chat_id = $1`, [chatId]); if (!shifts.length) { clearSession(chatId); return bot.sendMessage(chatId, 'Brak zmian.', mainKeyboard); } bot.sendMessage(chatId, 'Wybierz:', { reply_markup: { inline_keyboard: shifts.map(s => [{ text: `${s.date}, ${s.time}, ${s.strefa} (ID: ${s.id})`, callback_data: `edit_${s.id}` }]) } }); }

  if (sess.mode === 'view' && STREFY.includes(text)) { sess.strefa = text; sess.mode = 'view_filters'; bot.sendMessage(chatId, 'Filtr?', { reply_markup: { inline_keyboard: [[{ text: 'Dzisiaj', callback_data: `filter_date_today_${text}` }], [{ text: 'Jutro', callback_data: `filter_date_tomorrow_${text}` }], [{ text: 'Rano', callback_data: `filter_time_morning_${text}` }], [{ text: 'Popołudnie', callback_data: `filter_time_afternoon_${text}` }], [{ text: 'Wieczór', callback_data: `filter_time_evening_${text}` }], [{ text: '<6h', callback_data: `filter_duration_short_${text}` }], [{ text: 'Wszystkie', callback_data: `filter_all_${text}` }], [{ text: 'Powrót', callback_data: 'back_to_menu' }]] } }); }
  if (sess.mode === 'oddaj') { 
    if (!sess.strefa && STREFY.includes(text)) { sess.strefa = text; return bot.sendMessage(chatId, 'Data? (np. dzisiaj)', returnKeyboard); }
    if (sess.strefa && !sess.date) { const date = parseDate(text); if (!date) return sendErr(chatId, sess, 'Zły format daty.'); sess.date = date; return bot.sendMessage(chatId, 'Godziny? (np. 11:00-19:00)', returnKeyboard); }
    if (sess.date && !sess.time) { 
      const time = parseTime(text); 
      if (!time) return sendErr(chatId, sess, 'Zły format godzin.'); 
      if (await db.get(`SELECT id FROM shifts WHERE username = $1 AND date = $2 AND time = $3 AND strefa = $4`, [username, sess.date, time, sess.strefa])) return sendErr(chatId, sess, 'Duplikat zmiany.'); 
      await db.run(`INSERT INTO shifts (username, chat_id, date, time, strefa, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [username, chatId, sess.date, time, sess.strefa, moment().tz('Europe/Warsaw').format()]); 
      await updateStats(chatId, 'shifts_given'); 
      bot.sendMessage(chatId, `Zapisano: ${sess.date}, ${time}, ${sess.strefa}`, mainKeyboard); 
      await notifySubscribers(sess.strefa, sess.date, time, username, chatId); 
      clearSession(chatId); 
    }
  }
  if (sess.mode === 'setprofile') { const [firstName, lastName, courierId] = text.split(/\s+/); if (!firstName || !lastName || !courierId || isNaN(courierId)) return sendErr(chatId, sess, 'Błąd formatu.'); await saveUserProfile(chatId, firstName, lastName, courierId); session[chatId].userProfile = { first_name: firstName, last_name: lastName, courier_id: courierId }; bot.sendMessage(chatId, `Profil: ${firstName} ${lastName}, ID: ${courierId}`, mainKeyboard); clearSession(chatId); }
  if (sess.mode === 'broadcast') { await sendBroadcast(chatId, text); clearSession(chatId); }
  if (sess.mode === 'report_problem') { await bot.sendMessage(ADMIN_CHAT_ID, `Problem od ${chatId} (@${username}):\n${text}`); bot.sendMessage(chatId, 'Zgłoszono. Dziękujemy!', mainKeyboard); clearSession(chatId); }
  if (['edit_strefa', 'edit_date', 'edit_time'].includes(sess.mode)) { 
    const update = { edit_strefa: ['strefa', text], edit_date: ['date', parseDate(text)], edit_time: ['time', parseTime(text)] }[sess.mode]; 
    if (!update[1]) return sendErr(chatId, sess, `Błąd formatu ${sess.mode === 'edit_strefa' ? 'strefy' : sess.mode === 'edit_date' ? 'daty' : 'czasu'}.`); 
    await db.run(`UPDATE shifts SET ${update[0]} = $1 WHERE id = $2 AND chat_id = $3`, [update[1], sess.shiftId, chatId]); 
    bot.sendMessage(chatId, `Zaktualizowano ${update[0]} na ${update[1]}.`, mainKeyboard); 
    clearSession(chatId); 
  }
  if (sess.mode === 'contact' && text !== 'Zakończ czat') { await db.run(`INSERT INTO chat_messages (sender_chat_id, receiver_chat_id, message) VALUES ($1, $2, $3)`, [chatId, sess.otherChatId, text]); bot.sendMessage(sess.otherChatId, `Od @${username}: ${text}`, { reply_markup: { keyboard: [['Zakończ czat']], resize_keyboard: true } }); bot.sendMessage(chatId, 'Wysłano.', { reply_markup: { keyboard: [['Zakończ czat']], resize_keyboard: true } }); }
  if (text === 'Zakończ czat') { clearTimeout(sess.chatTimeout); bot.sendMessage(chatId, 'Czat zakończony.', mainKeyboard); bot.sendMessage(sess.otherChatId, `Czat z @${username} zakończony.`, mainKeyboard); clearSession(chatId); }
  bot.sendMessage(chatId, 'Nie rozumiem. Menu?', mainKeyboard);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id, data = query.data, username = query.from.username || query.from.first_name || 'Użytkownik';
  updateLastCommand(chatId);
  if (!session[chatId]) session[chatId] = { messagesToDelete: [], userMessages: [] };
  const sess = session[chatId];

  if (data === 'subskrybuj') { sess.mode = 'subskrypcja'; bot.sendMessage(chatId, 'Strefa?', { reply_markup: { inline_keyboard: STREFY.map(s => [{ text: s, callback_data: `sub_${s}` }]) } }); }
  else if (data === 'twoje_subskrypcje') { const subs = await db.all(`SELECT strefa FROM subscriptions WHERE user_id = $1`, [chatId]); if (!subs.length) { bot.sendMessage(chatId, 'Brak subskrypcji.', mainKeyboard); clearSession(chatId); } else bot.sendMessage(chatId, 'Odsubskrybuj:', { reply_markup: { inline_keyboard: [...subs.map(s => [{ text: s.strefa, callback_data: `unsub_${s.strefa}` }]), [{ text: 'Powrót', callback_data: 'back_to_menu' }]] } }); }
  else if (data === 'back_to_menu') { clearSession(chatId); bot.sendMessage(chatId, 'Menu?', mainKeyboard); }
  else if (data.startsWith('sub_')) { const strefa = data.slice(4); await db.run(`INSERT INTO subscriptions (user_id, strefa) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [chatId, strefa]); await updateStats(chatId, 'subscriptions'); bot.sendMessage(chatId, `Subskrypcja: ${strefa}`, mainKeyboard); clearSession(chatId); }
  else if (data.startsWith('unsub_')) { const strefa = data.slice(6); await db.run(`DELETE FROM subscriptions WHERE user_id = $1 AND strefa = $2`, [chatId, strefa]); await updateStats(chatId, 'subscriptions', -1); bot.sendMessage(chatId, `Odsubskrybowano: ${strefa}`, mainKeyboard); }
  else if (data.startsWith('take_')) { const [_, shiftId, giverChatId] = data.split('_'); const profile = await getUserProfile(chatId); if (!profile.first_name || !profile.last_name || !profile.courier_id) return bot.sendMessage(chatId, 'Ustaw profil.', returnKeyboard); await handleTakeShift(chatId, shiftId, giverChatId, profile, username); clearSession(chatId); }
  else if (data.startsWith('delete_shift_')) { const shiftId = data.slice(13); const shift = await db.get(`SELECT date, time, strefa FROM shifts WHERE id = $1 AND chat_id = $2`, [shiftId, chatId]); if (shift) { await db.run(`DELETE FROM shifts WHERE id = $1`, [shiftId]); await updateStats(chatId, 'shifts_given', -1); bot.sendMessage(chatId, `Usunięto: ${shift.date}, ${shift.time}, ${shift.strefa}`, mainKeyboard); } }
  else if (data === 'admin_users') { const users = await db.all(`SELECT DISTINCT user_id FROM subscriptions UNION SELECT DISTINCT chat_id FROM shifts`); bot.sendMessage(chatId, users.length ? 'Użytkownicy:\n' + users.map((u, i) => `${i + 1}. ${u.user_id}`).join('\n') : 'Brak.', mainKeyboard); }
  else if (data === 'admin_shifts') { const shifts = await db.all(`SELECT id, username, chat_id, date, time, strefa FROM shifts`); bot.sendMessage(chatId, shifts.length ? 'Zmiany:\n' + shifts.map(s => `ID: ${s.id}, ${s.date}, ${s.time}, ${s.strefa} (@${s.username})`).join('\n') : 'Brak.', { reply_markup: { inline_keyboard: [...shifts.map(s => [{ text: `Usuń ${s.id}`, callback_data: `admin_delete_${s.id}` }]), [{ text: 'Powrót', callback_data: 'back_to_menu' }]] } }); }
  else if (data.startsWith('admin_delete_')) { await db.run(`DELETE FROM shifts WHERE id = $1`, [data.split('_')[2]]); bot.sendMessage(chatId, `Usunięto ID ${data.split('_')[2]}.`, mainKeyboard); }
  else if (data.startsWith('edit_')) { sess.shiftId = data.split('_')[1]; sess.mode = 'edit_select'; bot.sendMessage(chatId, 'Co edytować?', { reply_markup: { inline_keyboard: [[{ text: 'Strefa', callback_data: `edit_strefa_${sess.shiftId}` }], [{ text: 'Data', callback_data: `edit_date_${sess.shiftId}` }], [{ text: 'Czas', callback_data: `edit_time_${sess.shiftId}` }], [{ text: 'Powrót', callback_data: 'back_to_menu' }]] } }); }
  else if (data.startsWith('edit_strefa_')) { sess.mode = 'edit_strefa'; sess.shiftId = data.split('_')[2]; bot.sendMessage(chatId, 'Nowa strefa?', zonesKeyboard); }
  else if (data.startsWith('edit_date_')) { sess.mode = 'edit_date'; sess.shiftId = data.split('_')[2]; bot.sendMessage(chatId, 'Nowa data? (np. dzisiaj)', returnKeyboard); }
  else if (data.startsWith('edit_time_')) { sess.mode = 'edit_time'; sess.shiftId = data.split('_')[2]; bot.sendMessage(chatId, 'Nowy czas? (np. 11:00-19:00)', returnKeyboard); }
  else if (data.startsWith('filter_')) { 
    const [_, filterType, filterValue, strefa] = data.split('_'); 
    const rows = await db.all(`SELECT id, username, chat_id, date, time FROM shifts WHERE strefa = $1 ORDER BY created_at DESC`, [strefa]); 
    const now = moment(); 
    const filtered = rows.filter(row => { 
      if (filterType === 'date' && filterValue !== 'all') { 
        const shiftDate = moment(row.date, 'DD.MM.YYYY'); 
        return filterValue === 'today' ? shiftDate.isSame(moment().startOf('day'), 'day') : filterValue === 'tomorrow' ? shiftDate.isSame(moment().add(1, 'day'), 'day') : true; 
      } 
      if (filterType === 'time') { 
        const startHour = parseInt(row.time.split('-')[0].split(':')[0]); 
        return filterValue === 'morning' ? startHour >= 6 && startHour < 12 : filterValue === 'afternoon' ? startHour >= 12 && startHour < 18 : filterValue === 'evening' ? startHour >= 18 && startHour < 24 : true; 
      } 
      if (filterType === 'duration' && filterValue === 'short') { 
        const [start, end] = row.time.split('-'); 
        return moment(end, 'HH:mm').diff(moment(start, 'HH:mm'), 'hours', true) < 6; 
      } 
      return true; 
    }).filter(row => moment(`${row.date} ${row.time.split('-')[0]}`, 'DD.MM.YYYY HH:mm').isAfter(now)); 
    sess.viewedShifts = filtered.map(r => r.id); 
    if (!filtered.length) { 
      const msg = await bot.sendMessage(chatId, 'Brak zmian.', mainKeyboard); 
      sess.messagesToDelete.push(msg.message_id); 
    } else filtered.forEach(row => { 
      const msg = bot.sendMessage(chatId, `ID: ${row.id}\n${row.date}, ${row.time}\n@${row.username}\nPrzejmij?`, { reply_markup: { inline_keyboard: [[{ text: 'Przejmij', callback_data: `take_${row.id}_${row.chat_id}` }]] } }); 
      sess.messagesToDelete.push(msg.message_id); 
    }); 
  }
  else if (data.startsWith('contact_')) { const [_, otherChatId, otherUsername] = data.split('_'); sess.mode = 'contact'; sess.otherChatId = parseInt(otherChatId); sess.otherUsername = otherUsername; bot.sendMessage(chatId, `Czat z @${otherUsername} (10 min):`, { reply_markup: { keyboard: [['Zakończ czat']], resize_keyboard: true } }); sess.chatTimeout = setTimeout(() => { bot.sendMessage(chatId, 'Czat wygasł.', mainKeyboard); bot.sendMessage(otherChatId, 'Czat wygasł.', mainKeyboard); clearSession(chatId); }, 600000); }
  bot.answerCallbackQuery(query.id).catch(() => {});
});

setInterval(cleanExpiredShifts, 60000);
app.get('/', (req, res) => res.send('Bot działa!'));
app.listen(PORT, () => logger.info(`Serwer na ${PORT}`));