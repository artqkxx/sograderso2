const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret_upgrader_key';
const DB_PATH = path.join(__dirname, 'db.json');

// Конфигурация Telegram Bot API
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8900159068:AAEUHEDg_Bbya7Xl-XN8voPXpXrpf822A4c';
const STARS_TO_GOLD_RATE = 1; // 1 Star = 1 Gold

app.use(cors());
app.use(express.json());

// Отдача статики (HTML, CSS, картинки)
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Вспомогательные функции работы с JSON-БД ---
function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify({ users: [] }, null, 2), 'utf8');
    }
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Ошибка чтения db.json:', err);
    return { users: [] };
  }
}

function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Ошибка записи в db.json:', err);
  }
}

function findUserById(id) {
  return readDB().users.find(u => u.id === id);
}

function findUserByUsername(username) {
  return readDB().users.find(u => u.username === username);
}

function saveUser(user) {
  const db = readDB();
  const index = db.users.findIndex(u => u.id === user.id);
  if (index !== -1) {
    db.users[index] = user;
  } else {
    db.users.push(user);
  }
  writeDB(db);
}

// --- Список товаров ---
const storeSkins = [
  { id: 'st_1', name: 'M4A1 Dragon', price: 1500, rarity: 'arcane', image: '/img/m4a1_dragon.png' },
  { id: 'st_2', name: 'Karambit Gold', price: 12000, rarity: 'nameless', image: '/img/karambit_gold.png' },
  { id: 'st_3', name: 'AKR Treasure', price: 4500, rarity: 'arcane', image: '/img/akr_treasure.png' },
  { id: 'st_4', name: 'AWM Sport', price: 850, rarity: 'legendary', image: '/img/awm_sport.png' },
  { id: 'st_5', name: 'G22 Relic', price: 250, rarity: 'epic', image: '/img/g22_relic.png' },
  { id: 'st_6', name: 'Butterfly Star', price: 8900, rarity: 'nameless', image: '/img/butterfly_star.png' }
];

// --- Middleware авторизации ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Нет авторизации' });

  jwt.verify(token, JWT_SECRET, (err, userPayload) => {
    if (err) return res.status(403).json({ success: false, message: 'Недействительный токен' });
    
    const user = findUserById(userPayload.id);
    if (!user) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    
    req.user = user;
    next();
  });
}

// --- ЭНДПОИНТЫ TELEGRAM STARS ---

// Создание ссылки на оплату через Telegram Stars
app.post('/api/payment/create-stars-invoice', authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;
    const goldAmount = parseFloat(amount);

    if (isNaN(goldAmount) || goldAmount <= 0) {
      return res.json({ success: false, message: 'Укажите корректную сумму' });
    }

    // Рассчитываем количество звёзд (1 Star = 1 Gold)
    const starsAmount = Math.ceil(goldAmount / STARS_TO_GOLD_RATE);

    const payload = JSON.stringify({
      userId: req.user.id,
      goldAmount: goldAmount,
      timestamp: Date.now()
    });

    const invoiceData = {
      title: `Пополнение баланса SOGRADER`,
      description: `Зачисление ${goldAmount} G на аккаунт ${req.user.username}`,
      payload: payload,
      currency: 'XTR', // Код валюты Telegram Stars
      prices: [{ label: `${goldAmount} Gold`, amount: starsAmount }]
    };

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invoiceData)
    });

    const data = await response.json();

    if (data.ok) {
      res.json({ success: true, invoiceUrl: data.result });
    } else {
      console.error('Ошибка Telegram API:', data);
      res.json({ success: false, message: 'Не удалось создать счет для оплаты' });
    }
  } catch (err) {
    console.error('Ошибка сервера при создании счета:', err);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// Обработка вебхука от Telegram при успешной оплате
app.post('/api/telegram/webhook', (req, res) => {
  try {
    const update = req.body;

    // Подтверждение платежа перед списанием (PreCheckoutQuery)
    if (update.pre_checkout_query) {
      const queryId = update.pre_checkout_query.id;
      fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: queryId, ok: true })
      });
      return res.sendStatus(200);
    }

    // Обработка проведенной оплаты
    if (update.message && update.message.successful_payment) {
      const payment = update.message.successful_payment;
      const payload = JSON.parse(payment.invoice_payload);

      const user = findUserById(payload.userId);
      if (user) {
        user.balance += payload.goldAmount;
        saveUser(user);
        console.log(`[STARS PAYMENT] Пользователь ${user.username} (ID: ${user.id}) успешно пополнил баланс на ${payload.goldAmount} G!`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка вебхука Telegram:', err);
    res.sendStatus(500);
  }
});


// --- ЭНДПОИНТЫ API АВТОРИЗАЦИИ И ИГРЫ ---

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: 'Заполните все поля' });

  if (findUserByUsername(username)) {
    return res.json({ success: false, message: 'Имя уже занято' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: Math.floor(100000 + Math.random() * 900000),
    username,
    password: hashedPassword,
    balance: 500,
    inventory: [
      { id: 'inv_' + Date.now() + '_1', name: 'G22 Relic', price: 250, image: '/img/g22_relic.png' }
    ],
    upgradesCount: 0,
    bestDrop: null
  };

  saveUser(newUser);

  const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET);
  res.json({ success: true, token, user: newUser });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = findUserByUsername(username);
  if (!user) return res.json({ success: false, message: 'Неверные данные' });

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) return res.json({ success: false, message: 'Неверные данные' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
  res.json({ success: true, token, user });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.post('/api/shop/buy', authenticateToken, (req, res) => {
  const { skinId, count = 1 } = req.body;
  const quantity = parseInt(count, 10);

  if (isNaN(quantity) || quantity <= 0) {
    return res.json({ success: false, message: 'Некорректное количество' });
  }

  const skin = storeSkins.find(s => s.id === skinId);
  if (!skin) return res.json({ success: false, message: 'Скин не найден' });

  const totalPrice = skin.price * quantity;

  if (req.user.balance < totalPrice) {
    return res.json({ success: false, message: 'Недостаточно средств' });
  }

  req.user.balance -= totalPrice;

  for (let i = 0; i < quantity; i++) {
    const newInventoryItem = {
      ...skin,
      id: 'inv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)
    };
    req.user.inventory.push(newInventoryItem);
  }

  saveUser(req.user);

  res.json({ success: true, user: req.user });
});

app.post('/api/user/promo', authenticateToken, (req, res) => {
  const { code } = req.body;
  if (code.toUpperCase() === 'FREE100') {
    req.user.balance += 100;
    saveUser(req.user);
    return res.json({ success: true, added: 100, newBalance: req.user.balance });
  }
  res.json({ success: false, message: 'Неверный промокод' });
});

app.post('/api/upgrade', authenticateToken, (req, res) => {
  const { selectedItemIds, targetItem } = req.body;
  if (!selectedItemIds || !selectedItemIds.length || !targetItem) {
    return res.json({ success: false, message: 'Некорректные данные' });
  }

  const selectedSkins = req.user.inventory.filter(i => selectedItemIds.includes(i.id));
  if (selectedSkins.length !== selectedItemIds.length) {
    return res.json({ success: false, message: 'Предметы не найдены в инвентаре' });
  }

  const totalInputSum = selectedSkins.reduce((sum, item) => sum + item.price, 0);
  const chance = (totalInputSum / targetItem.price) * 100;

  if (chance > 70) {
    return res.json({ success: false, message: 'Шанс превышает допустимые 70%' });
  }

  req.user.inventory = req.user.inventory.filter(i => !selectedItemIds.includes(i.id));
  req.user.upgradesCount = (req.user.upgradesCount || 0) + 1;

  const rolled = Math.random() * 100;
  const isWin = rolled <= chance;

  if (isWin) {
    const newItem = {
      ...targetItem,
      id: 'inv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)
    };
    req.user.inventory.push(newItem);

    if (!req.user.bestDrop || newItem.price > req.user.bestDrop.price) {
      req.user.bestDrop = newItem;
    }
  }

  saveUser(req.user);

  res.json({
    success: true,
    isWin,
    rolled,
    updatedInventory: req.user.inventory,
    bestDrop: req.user.bestDrop
  });
});

app.listen(PORT, () => {
  console.log(`Сервер успешно запущен на порту ${PORT}`);
});