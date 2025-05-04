const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();

dotenv.config();
const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error('Ошибка: TELEGRAM_TOKEN не найден в .env');
  process.exit(1);
}
const bot = new TelegramBot(token, { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к базе данных
const db = new sqlite3.Database('shifts.db', (err) => {
  if (err) {
    console.error('Ошибка подключения к базе данных:', err);
    process.exit(1);
  }
  console.log('Подключено к базе данных shifts.db');
});

// Создание таблиц
db.run(`
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    chat_id TEXT,
    date TEXT,
    time TEXT,
    strefa TEXT,
    taker_username TEXT,
    taker_id TEXT,
    taker_fullname TEXT
  )
`, (err) => {
  if (err) console.error('Ошибка при создании таблицы shifts:', err);
});

db.run(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    chat_id TEXT,
    strefa TEXT,
    PRIMARY KEY (chat_id, strefa)
  )
`, (err) => {
  if (err) console.error('Ошибка при создании таблицы subscriptions:', err);
});

// Список зон
const STREFY = [
  'centrum', 'ursus', 'bemowo/bielany', 'białołęka/tarchomin', 'praga',
  'rembertów', 'wawer', 'służew', 'ursynów', 'wilanów', 'marki',
  'legionowo', 'łomianki'
];

// Хранилище состояний пользователей
const userState = {};

// Функция для очистки состояния пользователя
function clearUserState(chatId) {
  delete userState[chatId];
}

// Функция для удаления сообщений
async function deleteMessages(chatId, messageIds) {
  for (const msgId of messageIds) {
    try {
      await bot.deleteMessage(chatId, msgId);
    } catch (err) {
      console.error(`Ошибка при удалении сообщения ${msgId}:`, err);
    }
  }
}

// Валидация даты
function znajdzDate(text) {
  const dzisiaj = new Date();
  const jutro = new Date(Date.now() + 86400000);
  if (text.includes('dziś') || text.includes('dzisiaj')) return dzisiaj.toISOString().split('T')[0];
  if (text.includes('jutro')) return jutro.toISOString().split('T')[0];
  const regex = /(\d{1,2})[.\-/](\d{1,2})/;
  const match = text.match(regex);
  if (match) {
    const rok = new Date().getFullYear();
    const [_, d, m] = match;
    const day = parseInt(d);
    const month = parseInt(m);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    const dateStr = `${rok}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;
    return dateStr;
  }
  return null;
}

// Валидация времени
function znajdzGodziny(text) {
  const regex = /(\d{1,2})[:.]?(\d{0,2})\D+(\d{1,2})[:.]?(\d{0,2})/;
  const match = text.match(regex);
  if (!match) return null;
  const [, h1, m1, h2, m2] = match;
  const hours1 = parseInt(h1);
  const minutes1 = m1 ? parseInt(m1) : 0;
  const hours2 = parseInt(h2);
  const minutes2 = m2 ? parseInt(m2) : 0;

  if (hours1 > 23 || minutes1 > 59 || hours2 > 23 || minutes2 > 59) return null;

  const format = (h, m) => `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  return `${format(hours1, minutes1)}–${format(hours2, minutes2)}`;
}

// Отправка главного меню
async function sendMainMenu(chatId, message = 'Cześć! Wyбierz akcję:') {
  clearUserState(chatId);
  const msg = await bot.sendMessage(chatId, message, {
    reply_markup: {
      keyboard: [
        ['Zobaczyć zmiany', 'Oddaj zmianę'],
        ['Subskrypcja'],
        ['Zacznij od nowa']
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
  userState[chatId] = { step: 'main', messages: [msg.message_id] };
}

// Отправка списка зон
async function sendStrefy(chatId, message = 'Wybierz strefę:', prevStep, action) {
  const buttons = STREFY.map(strefa => [{ text: strefa, callback_data: `strefa_${strefa}_${action}` }]);
  buttons.push([{ text: '⏪ Cofnij', callback_data: 'cofnij' }, { text: 'Zacznij od nowa', callback_data: 'reset' }]);
  const msg = await bot.sendMessage(chatId, message, {
    reply_markup: { inline_keyboard: buttons }
  });
  userState[chatId].messages.push(msg.message_id);
  userState[chatId].step = `choose_strefa_${action}`;
  userState[chatId].prevStep = prevStep;
}

// Обработка команды /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  console.log(`Команда /start от ${msg.from.username || msg.from.first_name} (chatId: ${chatId})`);
  await sendMainMenu(chatId);
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
  if (msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text = msg.text.toLowerCase();
  const user = msg.from.username || msg.from.first_name;
  console.log(`Сообщение от ${user} (chatId: ${chatId}): ${msg.text}`);

  if (!userState[chatId]) {
    await sendMainMenu(chatId, 'Wybierz akcję:');
    return;
  }

  const state = userState[chatId];

  // Обработка кнопки "Zacznij od nowa"
  if (text.includes('zacznij od nowa')) {
    await deleteMessages(chatId, state.messages);
    await sendMainMenu(chatId);
    return;
  }

  // Модуль "Oddaj zmianę"
  if (state.step === 'main' && text.includes('oddaj zmianę')) {
    await deleteMessages(chatId, state.messages);
    await sendStrefy(chatId, 'Wybierz strefę:', 'main', 'oddaj');
    return;
  }

  if (state.step === 'oddaj_date') {
    const date = znajdzDate(text);
    if (!date) {
      const msg = await bot.sendMessage(chatId, 'Niepoprawna data. Spróbuj np. dzisiaj, jutro, 07.05');
      state.messages.push(msg.message_id);
      return;
    }
    state.date = date;
    state.step = 'oddaj_time';
    const msg = await bot.sendMessage(chatId, 'O jakich godzinach? (np. 11–20 albo 15:00–01:00)', {
      reply_markup: {
        keyboard: [['⏪ Cofnij', 'Zacznij od nowa']],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    await deleteMessages(chatId, state.messages);
    state.messages = [msg.message_id];
    return;
  }

  if (state.step === 'oddaj_time') {
    const time = znajdzGodziny(text);
    if (!time) {
      const msg = await bot.sendMessage(chatId, 'Niepoprawny format godzin. Spróbuj np. 11–20 albo 15:00–01:00');
      state.messages.push(msg.message_id);
      return;
    }
    state.time = time;
    db.run('INSERT INTO shifts (username, chat_id, date, time, strefa) VALUES (?, ?, ?, ?, ?)',
      [user, chatId, state.date, time, state.strefa], async (err) => {
        if (err) {
          console.error('Ошибка при записи смены:', err);
          const msg = await bot.sendMessage(chatId, 'Błąd zapisu. Spróbuj później.');
          state.messages.push(msg.message_id);
          return;
        }
        // Уведомление подписчиков
        db.all('SELECT chat_id FROM subscriptions WHERE strefa = ?', [state.strefa], async (err, rows) => {
          if (err) console.error('Ошибка при получении подписчиков:', err);
          for (const row of rows) {
            try {
              await bot.sendMessage(row.chat_id, `Nowa zmiana w strefie ${state.strefa}: ${state.date} ${time}`);
            } catch (err) {
              console.error(`Ошибка при отправке уведомления ${row.chat_id}:`, err);
            }
          }
        });
        await deleteMessages(chatId, state.messages);
        await sendMainMenu(chatId, `Zapisano: ${state.date} ${time}, ${state.strefa}`);
      });
    return;
  }

  // Модуль "Zobaczyć zmiany"
  if (state.step === 'main' && text.includes('zobaczyć zmiany')) {
    await deleteMessages(chatId, state.messages);
    await sendStrefy(chatId, 'Wybierz strefę:', 'main', 'zobacz');
    return;
  }

  // Модуль "Subskrypcja"
  if (state.step === 'main' && text.includes('subskrypcja')) {
    await deleteMessages(chatId, state.messages);
    const buttons = STREFY.map(strefa => [{
      text: strefa,
      callback_data: `sub_${strefa}`
    }]);
    buttons.push([{ text: '⏪ Cofnij', callback_data: 'cofnij' }, { text: 'Zacznij od nowa', callback_data: 'reset' }]);
    const msg = await bot.sendMessage(chatId, 'Wybierz strefy do subskrypcji:', {
      reply_markup: { inline_keyboard: buttons }
    });
    state.step = 'subskrypcja';
    state.messages = [msg.message_id];
    return;
  }

  // Обработка некорректного ввода
  const msg = await bot.sendMessage(chatId, 'Nie rozumiem. Wybierz akcję z menu.');
  state.messages.push(msg.message_id);
});

// Обработка callback-запросов
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = userState[chatId] || { messages: [] };

  // Обработка "Zacznij od nowa"
  if (data === 'reset') {
    await deleteMessages(chatId, state.messages);
    await sendMainMenu(chatId);
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Обработка "Cofnij"
  if (data === 'cofnij') {
    await deleteMessages(chatId, state.messages);
    if (state.prevStep === 'main') {
      await sendMainMenu(chatId);
    } else if (state.prevStep === 'oddaj_strefa') {
      await sendStrefy(chatId, 'Wybierz strefę:', 'main', 'oddaj');
    } else if (state.prevStep === 'oddaj_date') {
      state.step = 'oddaj_date';
      const msg = await bot.sendMessage(chatId, 'Kiedy? (np. dzisiaj, jutro, albo 07.05)', {
        reply_markup: {
          keyboard: [['⏪ Cofnij', 'Zacznij od nowa']],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
      state.messages = [msg.message_id];
      state.prevStep = 'oddaj_strefa';
    }
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Обработка выбора зоны для "Oddaj zmianę"
  if (data.startsWith('strefa_') && data.includes('_oddaj')) {
    const strefa = data.split('_')[1];
    state.strefa = strefa;
    state.step = 'oddaj_date';
    state.prevStep = 'oddaj_strefa';
    await deleteMessages(chatId, state.messages);
    const msg = await bot.sendMessage(chatId, 'Kiedy? (np. dzisiaj, jutro, albo 07.05)', {
      reply_markup: {
        keyboard: [['⏪ Cofnij', 'Zacznij od nowa']],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    state.messages = [msg.message_id];
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Обработка выбора зоны для "Zobaczyć zmiany"
  if (data.startsWith('strefa_') && data.includes('_zobacz')) {
    const strefa = data.split('_')[1];
    db.all('SELECT id, username, date, time FROM shifts WHERE strefa = ?', [strefa], async (err, rows) => {
      if (err) {
        console.error('Ошибка при запросе смен:', err);
        const msg = await bot.sendMessage(chatId, 'Błąd. Spróbuj później.');
        state.messages.push(msg.message_id);
        return;
      }
      await deleteMessages(chatId, state.messages);
      if (!rows || !rows.length) {
        const msg = await bot.sendMessage(chatId, 'Brak zmian w tej strefie.', {
          reply_markup: {
            keyboard: [['⏪ Cofnij', 'Zacznij od nowa']],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        });
        state.messages = [msg.message_id];
        state.step = 'zobacz';
        state.prevStep = 'main';
        return;
      }
      const buttons = rows.map(row => [{
        text: `${row.date} ${row.time} (${row.username})`,
        callback_data: `take_${row.id}`
      }]);
      buttons.push([{ text: '⏪ Cofnij', callback_data: 'cofnij' }, { text: 'Zacznij od nowa', callback_data: 'reset' }]);
      const msg = await bot.sendMessage(chatId, `Dostępne zmiany w strefie ${strefa}:`, {
        reply_markup: { inline_keyboard: buttons }
      });
      state.messages = [msg.message_id];
      state.step = 'zobacz';
      state.prevStep = 'main';
    });
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Обработка выбора смены
  if (data.startsWith('take_')) {
    const shiftId = parseInt(data.split('_')[1]);
    db.get('SELECT * FROM shifts WHERE id = ?', [shiftId], async (err, row) => {
      if (err) {
        console.error('Ошибка при запросе смены:', err);
        const msg = await bot.sendMessage(chatId, 'Błąd. Spróbuj później.');
        state.messages.push(msg.message_id);
        return;
      }
      if (!row) {
        const msg = await bot.sendMessage(chatId, 'Zmiana nie istnieje.');
        state.messages.push(msg.message_id);
        return;
      }
      state.step = 'take_shift';
      state.shiftId = shiftId;
      state.giverChatId = row.chat_id;
      await deleteMessages(chatId, state.messages);
      const msg = await bot.sendMessage(chatId, 'Podaj swoje imię, nazwisko i ID (np. Jan Kowalski 12345)', {
        reply_markup: {
          keyboard: [['⏪ Cofnij', 'Zacznij od nowa']],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
      state.messages = [msg.message_id];
      state.prevStep = 'zobacz';
    });
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Обработка подтверждения координатора
  if (data.startsWith('potwierdz_')) {
    const takerChatId = data.split('_')[1];
    await bot.sendMessage(takerChatId, 'Właściciel zmiany napisał do koordynatora. Sprawdź aplikację!');
    bot.answerCallbackQuery(query.id, { text: 'Dzięki!' });
    return;
  }

  // Обработка подписки
  if (data.startsWith('sub_')) {
    const strefa = data.split('_')[1];
    db.run('INSERT OR IGNORE INTO subscriptions (chat_id, strefa) VALUES (?, ?)', [chatId, strefa], async (err) => {
      if (err) {
        console.error('Ошибка при подписке:', err);
        const msg = await bot.sendMessage(chatId, 'Błąd. Spróbuj później.');
        state.messages.push(msg.message_id);
        return;
      }
      const msg = await bot.sendMessage(chatId, `Zasubskrybowano strefę ${strefa}.`, {
        reply_markup: {
          keyboard: [['⏪ Cofnij', 'Zacznij od nowa']],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
      state.messages.push(msg.message_id);
    });
    bot.answerCallbackQuery(query.id);
    return;
  }
});

// Обработка ввода данных для взятия смены
bot.on('message', async (msg) => {
  if (msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text = msg.text;
  const state = userState[chatId];
  if (!state || state.step !== 'take_shift') return;

  const [imie, nazwisko, idKuriera] = text.split(' ');
  if (!imie || !nazwisko || !idKuriera) {
    const msg = await bot.sendMessage(chatId, 'Podaj dane w formacie: Imię Nazwisko ID');
    state.messages.push(msg.message_id);
    return;
  }

  db.get('SELECT * FROM shifts WHERE id = ?', [state.shiftId], async (err, row) => {
    if (err) {
      console.error('Ошибка при запросе смены:', err);
      const msg = await bot.sendMessage(chatId, 'Błąd. Spróbuj później.');
      state.messages.push(msg.message_id);
      return;
    }
    if (!row) {
      const msg = await bot.sendMessage(chatId, 'Zmiana nie istnieje.');
      state.messages.push(msg.message_id);
      return;
    }
    await deleteMessages(chatId, state.messages);
    const msg = await bot.sendMessage(state.giverChatId, `Ktoś chce przejąć Twoją zmianę!\nImię i nazwisko: ${imie} ${nazwisko}\nID: ${idKuriera}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Napisałem do koordynatora', callback_data: `potwierdz_${chatId}` }
        ]]
      }
    });
    await sendMainMenu(chatId, 'Dzięki! Właściciel zmiany otrzymał Twoje dane.');
  });
});

// Закрытие базы данных при завершении
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error('Ошибка при закрытии БД:', err);
      process.exit(1);
    }
    console.log('Соединение с БД закрыто.');
    process.exit(0);
  });
});

app.get('/', (req, res) => res.send('Bot działa.'));
app.listen(PORT, () => console.log(`Serwer działa na porcie ${PORT}`));