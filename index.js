// Антиспам-бот для MAX (ядро логики + inline-меню + фильтры + /help)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const API_BASE = 'https://botapi.max.ru';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const CAPTCHA_TIMEOUT = 3 * 60 * 1000;

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const pendingUsers = new Map();

const BAD_WORDS = ['мат1', 'мат2', 'плохое', 'ругательство'];
const LINK_REGEX = /https?:\/\/(\S+)|www\.(\S+)/gi;

function maxRequest(method, endpoint, data = {}) {
  return axios({
    method,
    url: `${API_BASE}${endpoint}`,
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    data
  });
}

async function blockUser(chatId, userId) {
  return maxRequest('PATCH', `/chats/${chatId}/members/${userId}`, { sendMessages: false });
}

async function unblockUser(chatId, userId) {
  return maxRequest('PATCH', `/chats/${chatId}/members/${userId}`, { sendMessages: true });
}

async function deleteMessage(chatId, messageId) {
  return maxRequest('DELETE', `/messages/${messageId}`);
}

async function sendCaptcha(chatId, userId) {
  const response = await maxRequest('POST', `/messages`, {
    chat_id: chatId,
    text: `Добро пожаловать! Пожалуйста, нажмите кнопку ниже, чтобы подтвердить, что вы не бот.`,
    attachments: [
      {
        type: 'inline_keyboard',
        buttons: [[{ text: 'Пройти проверку ✅', callback_data: `verify_${userId}` }]]
      }
    ]
  });

  const messageId = response.data.id;
  const timeoutId = setTimeout(async () => {
    await deleteMessage(chatId, messageId);
    await maxRequest('POST', `/messages`, {
      chat_id: chatId,
      text: `⛔ ${userId} не прошёл проверку и был удалён.`
    });
    await maxRequest('DELETE', `/chats/${chatId}/members/${userId}`);
    pendingUsers.delete(userId);
  }, CAPTCHA_TIMEOUT);

  pendingUsers.set(userId, { chatId, messageId, timeoutId });
}

async function ensureClientAndChat(userId, chatId, chatTitle) {
  await db.query(
    `INSERT INTO clients (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  await db.query(
    `INSERT INTO chats (chat_id, title, owner_id, enabled, settings)
     VALUES ($1, $2, (SELECT id FROM clients WHERE user_id = $3), true, '{}'::jsonb)
     ON CONFLICT (chat_id) DO NOTHING`,
    [chatId, chatTitle || null, userId]
  );
}

function containsBadWords(text) {
  return BAD_WORDS.some(word => text.toLowerCase().includes(word));
}

function containsLink(text) {
  return LINK_REGEX.test(text);
}

app.post('/webhook', async (req, res) => {
  const event = req.body;

  try {
    if (event.type === 'message_new' && event.chat.type === 'direct') {
      const userId = event.user.id;
      const text = event.message?.text || '';

      if (text.trim().toLowerCase() === '/help') {
        await maxRequest('POST', `/messages`, {
          chat_id: event.chat.id,
          text: `📖 Команды бота:
/start — показать меню
/help — справка

🛡 Антиспам работает автоматически после подключения:
- капча при входе в чат
- фильтр мата, ссылок, рекламы (настраивается)
- удаление нарушений

Чтобы настроить антиспам — нажмите «Мои чаты» в меню.`
        });
      } else {
        await maxRequest('POST', `/messages`, {
          chat_id: event.chat.id,
          text: '👋 Привет! Я антиспам-бот для чатов. Добавь меня в свою группу и настрой фильтры.\n\nВыберите действие:',
          attachments: [
            {
              type: 'inline_keyboard',
              buttons: [[{ text: '📋 Мои чаты', callback_data: `show_chats_${userId}` }]]
            }
          ]
        });
      }
    }

    if (event.type === 'user_joined') {
      const chatId = event.chat.id;
      const chatTitle = event.chat.title || null;
      const userId = event.user.id;
      await ensureClientAndChat(userId, chatId, chatTitle);
      await blockUser(chatId, userId);
      await sendCaptcha(chatId, userId);
    }

    if (event.type === 'message_new' && event.chat.type === 'group') {
      const chatId = event.chat.id;
      const msgText = event.message.text || '';
      const msgId = event.message.id;
      const chatSettingsRes = await db.query(`SELECT settings FROM chats WHERE chat_id = $1 AND enabled = true`, [chatId]);
      if (chatSettingsRes.rowCount === 0) return;

      const settings = chatSettingsRes.rows[0].settings;

      if ((settings.bad_words && containsBadWords(msgText)) ||
          (settings.links && containsLink(msgText))) {
        await deleteMessage(chatId, msgId);
        await maxRequest('POST', `/messages`, {
          chat_id: chatId,
          text: `⛔ Сообщение удалено: запрещённый контент.`
        });
      }
    }

    if (event.type === 'message_callback') {
      const chatId = event.chat.id;
      const userId = event.user.id;
      const payload = event.data;

      if (payload === `verify_${userId}` && pendingUsers.has(userId)) {
        await unblockUser(chatId, userId);
        const { messageId, timeoutId } = pendingUsers.get(userId);
        clearTimeout(timeoutId);
        await deleteMessage(chatId, messageId);
        await maxRequest('POST', `/messages`, {
          chat_id: chatId,
          text: `✅ Вы успешно прошли проверку, добро пожаловать!`
        });
        pendingUsers.delete(userId);
      }

      if (payload.startsWith('show_chats_')) {
        const id = payload.split('_').pop();
        const result = await db.query(
          `SELECT chat_id, title, enabled, settings FROM chats WHERE owner_id = (SELECT id FROM clients WHERE user_id = $1)`,
          [id]
        );

        if (result.rows.length === 0) {
          await maxRequest('POST', `/messages`, {
            chat_id: chatId,
            text: 'У вас пока нет чатов. Добавьте меня в группу и я появлюсь здесь.'
          });
        } else {
          const buttons = result.rows.map(chat => ([{
            text: `${chat.title || 'Без названия'} (${chat.enabled ? '✅' : '❌'})`,
            callback_data: `settings_${chat.chat_id}`
          }]));
          await maxRequest('POST', `/messages`, {
            chat_id: chatId,
            text: 'Ваши чаты:\nНажмите на чат, чтобы изменить фильтры.',
            attachments: [{ type: 'inline_keyboard', buttons }]
          });
        }
      }

      if (payload.startsWith('settings_')) {
        const chatId = payload.split('_').pop();
        const chat = await db.query(`SELECT settings FROM chats WHERE chat_id = $1`, [chatId]);
        const s = chat.rows[0].settings;
        await maxRequest('POST', `/messages`, {
          chat_id: chatId,
          text: '⚙ Настройки фильтров:',
          attachments: [
            {
              type: 'inline_keyboard',
              buttons: [
                [
                  { text: `Капча ${s.captcha ? '✅' : '❌'}`, callback_data: `toggle_captcha_${chatId}` },
                  { text: `Мат ${s.bad_words ? '✅' : '❌'}`, callback_data: `toggle_badwords_${chatId}` }
                ],
                [
                  { text: `Ссылки ${s.links ? '✅' : '❌'}`, callback_data: `toggle_links_${chatId}` }
                ]
              ]
            }
          ]
        });
      }

      if (payload.startsWith('toggle_')) {
        const [, field, chatId] = payload.split('_');
        await db.query(
          `UPDATE chats SET settings = jsonb_set(settings, $1, to_jsonb(NOT (settings->>$1)::boolean), true) WHERE chat_id = $2`,
          [`{${field}}`, chatId]
        );
        await maxRequest('POST', `/messages`, {
          chat_id: chatId,
          text: `🔄 Фильтр «${field}» переключён.`
        });
      }
    }
  } catch (err) {
    console.error('Ошибка обработки события:', err.response?.data || err.message);
  }

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log('🚀 MAX AntiSpam запущен на порту 3000');
});