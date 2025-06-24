const TelegramBot = require('node-telegram-bot-api');
const { pool } = require('./db');
require('dotenv').config();

module.exports = function startBot() {
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
  const ADMIN_ID = process.env.ADMIN_ID;

  // Utility: check if user is admin
  function isAdmin(id) {
    return id.toString() === ADMIN_ID;
  }

  // Ensure user exists in DB
  async function ensureUser(msg) {
    const { id, username } = msg.from;
    try {
      await pool.query(
        'INSERT INTO users (id, username) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        [id, username || 'unknown']
      );
    } catch (error) {
      console.error('Error ensuring user:', error);
      bot.sendMessage(ADMIN_ID, `⚠️ Error registering user ${id}: ${error.message}`);
    }
  }

  // Check if user has bank details
  async function hasBankDetails(userId) {
    try {
      const res = await pool.query('SELECT bank_name, account_number FROM users WHERE id = $1', [userId]);
      const { bank_name, account_number } = res.rows[0] || {};
      return bank_name && account_number;
    } catch (error) {
      console.error('Error checking bank details:', error);
      return false;
    }
  }

  // Format transactions for display
  function formatTransactions(transactions, isAdmin = false) {
    if (!transactions.length) return '📭 No transactions found.';
    let text = isAdmin ? '📋 *Pending Transactions:*\n\n' : '📋 *Your Recent Transactions:*\n\n';
    for (const tx of transactions) {
      text += `🆔 *#${tx.id}*\n` +
        `• User: @${tx.username || 'unknown'} (ID: ${tx.user_id})\n` +
        `• Type: ${tx.type.toUpperCase()}\n` +
        `• Amount: Rs. ${tx.amount || 'N/A'}\n` +
        `• Status: ${tx.status}\n` +
        `• Date: ${tx.date}\n`;
      if (tx.bank_name) text += `• Bank: ${tx.bank_name}\n`;
      if (tx.account_number) text += `• Account: ${tx.account_number}\n`;
      if (tx.reason) text += `• Reason: ${tx.reason}\n`;
      text += '\n';
    }
    return text;
  }

  // Commands list
  const userCommands = [
    { cmd: '/start', desc: 'Start the bot and register' },
    { cmd: '/help', desc: 'Show this help message' },
    { cmd: '/balance', desc: 'Check your balance' },
    { cmd: '/deposit', desc: 'Get deposit instructions' },
    { cmd: '/withdraw {amount}', desc: 'Request withdrawal' },
    { cmd: '/transactions', desc: 'List your recent transactions' },
    { cmd: '/bank {Bank Name}', desc: 'Set your bank name' },
    { cmd: '/account {account number}', desc: 'Set your account number' },
    { cmd: '/profile', desc: 'View your profile details' },
  ];

  const adminCommands = [
    { cmd: '/qr {imageURL}', desc: 'Set deposit account qr code image URL' },
    { cmd: '/approve {amount} = {id}', desc: 'Approve a transaction by ID' },
    { cmd: '/reject {id} = {reason}', desc: 'Reject a transaction with reason' },
    { cmd: '/pending', desc: 'List all pending transactions' },
    { cmd: '/dashboard', desc: 'Show summary of users and transactions' },
  ];

  // Send help message according to user role
  bot.onText(/\/help/, async (msg) => {
    const isUserAdmin = isAdmin(msg.from.id);
    let helpText = '*Available Commands:*\n\n';

    const commandsToShow = isUserAdmin ? [...userCommands, ...adminCommands] : userCommands;

    for (const cmd of commandsToShow) {
      helpText += `• \`${cmd.cmd}\` — ${cmd.desc}\n`;
    }

    bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
  });

  // Start command
  bot.onText(/\/start/, async (msg) => {
    await ensureUser(msg);
    bot.sendMessage(
      msg.chat.id,
      `👋 Hello *${msg.from.first_name || ''}*!\nWelcome to PayMe Bot.\n` +
      `Please set your bank details using /bank and /account before making transactions.\nUse /help to see available commands.`,
      { parse_mode: 'Markdown' }
    );
  });

  // Balance command
  bot.onText(/\/balance/, async (msg) => {
    await ensureUser(msg);
    try {
      const res = await pool.query('SELECT balance FROM users WHERE id = $1', [msg.from.id]);
      const balance = res.rows[0]?.balance || 0;
      bot.sendMessage(msg.chat.id, `💰 Your current balance is: *Rs. ${balance}*`, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error fetching balance. Please try again later.');
      console.error('Balance error:', error);
    }
  });

  // Set bank name command
  bot.onText(/\/bank (.+)/, async (msg, match) => {
    await ensureUser(msg);
    const bankName = match[1].trim();
    if (!bankName || bankName.length > 100) {
      return bot.sendMessage(msg.chat.id, '❌ Please provide a valid bank name (1-100 characters).');
    }

    try {
      await pool.query('UPDATE users SET bank_name = $1 WHERE id = $2', [bankName, msg.from.id]);
      bot.sendMessage(msg.chat.id, `🏦 Bank name set to: *${bankName}*`, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error setting bank name.');
      console.error('Set bank name error:', error);
    }
  });

  // Set account number command
  bot.onText(/\/account (\d+)/, async (msg, match) => {
    await ensureUser(msg);
    const accountNumber = match[1].trim();
    if (!/^\d{8,20}$/.test(accountNumber)) {
      return bot.sendMessage(msg.chat.id, '❌ Please provide a valid account number (8-20 digits).');
    }

    try {
      await pool.query('UPDATE users SET account_number = $1 WHERE id = $2', [accountNumber, msg.from.id]);
      bot.sendMessage(msg.chat.id, `🏧 Account number set to: *${accountNumber}*`, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error setting account number.');
      console.error('Set account number error:', error);
    }
  });

  // Profile command
  bot.onText(/\/profile/, async (msg) => {
    await ensureUser(msg);
    const userId = msg.from.id;
    try {
      const res = await pool.query(
        'SELECT username, balance, bank_name, account_number FROM users WHERE id = $1',
        [userId]
      );
      const { username, balance, bank_name, account_number } = res.rows[0] || {};

      const profileText = `*👤 Your Profile*\n\n` +
        `• User ID: ${userId}\n` +
        `• Username: @${username || 'unknown'}\n` +
        `• Balance: Rs. ${balance || 0}\n` +
        `• Bank Name: ${bank_name || 'Not set'}\n` +
        `• Account Number: ${account_number || 'Not set'}\n\n` +
        `Use /bank and /account to update your bank details.`;

      bot.sendMessage(msg.chat.id, profileText, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error fetching profile.');
      console.error('Profile error:', error);
    }
  });

  // Deposit command - fetch image from config
  bot.onText(/\/deposit/, async (msg) => {
    await ensureUser(msg);
    const userId = msg.from.id;

    if (!(await hasBankDetails(userId))) {
      return bot.sendMessage(
        msg.chat.id,
        '❌ Please set your bank name (/bank) and account number (/account) before making transactions.'
      );
    }

    try {
      const result = await pool.query(`SELECT value FROM config WHERE key = 'deposit_image_url'`);
      const imageUrl = result.rows[0]?.value;
      if (!imageUrl) {
        return bot.sendMessage(msg.chat.id, '⚠️ Deposit image not set by admin yet.');
      }
      bot.sendPhoto(msg.chat.id, imageUrl, {
        caption: '📥 Please send your payment receipt here as a photo.\nYou can reply to this message with your screenshot.',
      });
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error fetching deposit instructions.');
      console.error('Deposit error:', error);
    }
  });

  // Withdraw command
  bot.onText(/\/withdraw (\d+)/, async (msg, match) => {
    await ensureUser(msg);
    const userId = msg.from.id;

    if (!(await hasBankDetails(userId))) {
      return bot.sendMessage(
        msg.chat.id,
        '❌ Please set your bank name (/bank) and account number (/account) before making transactions.'
      );
    }

    const amount = parseFloat(match[1]);
    if (amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Please enter a valid withdrawal amount.');

    try {
      const res = await pool.query('SELECT balance, bank_name, account_number FROM users WHERE id = $1', [userId]);
      const { balance, bank_name, account_number } = res.rows[0] || {};

      if (balance < amount) {
        return bot.sendMessage(msg.chat.id, '❌ Insufficient balance for withdrawal.');
      }

      const result = await pool.query(
        'INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, $2, $3, $4) RETURNING id',
        [userId, 'withdraw', amount, 'pending']
      );

      bot.sendMessage(msg.chat.id, `📤 Withdraw request for Rs. *${amount}* submitted (ID: ${result.rows[0].id}). Please wait for admin approval.`, {
        parse_mode: 'Markdown',
      });
      bot.sendMessage(
        ADMIN_ID,
        `⚠️ Withdraw Request\nUser: @${msg.from.username || 'unknown'}\nUser ID: ${userId}\n` +
        `Transaction ID: ${result.rows[0].id}\nAmount: Rs. ${amount}\n` +
        `Bank: ${bank_name || 'Not set'}\nAccount: ${account_number || 'Not set'}\n\n` +
        `Reply with the payment receipt photo or use /approve ${amount} = ${result.rows[0].id} or /reject ${result.rows[0].id} = {reason}.`
      );
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error processing withdrawal request.');
      console.error('Withdraw error:', error);
    }
  });

  // Handle photos (for deposit receipt or admin approval of withdraw)
  bot.on('photo', async (msg) => {
    const userId = msg.from.id;
    const isUserAdmin = isAdmin(userId);

    try {
      if (isUserAdmin) {
        // Admin sending receipt to approve withdraw
        const replied = msg.reply_to_message;
        if (replied?.text?.includes('Withdraw Request')) {
          const transactionId = parseInt(replied.text.match(/Transaction ID: (\d+)/)[1]);
          const withdrawUserId = parseInt(replied.text.match(/User ID: (\d+)/)[1]);
          const amount = parseFloat(replied.text.match(/Amount: Rs. (\d+)/)[1]);
          const fileId = msg.photo[msg.photo.length - 1].file_id;

          await pool.query('UPDATE transactions SET status = $1 WHERE id = $2', ['approved', transactionId]);
          await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, withdrawUserId]);

          bot.sendPhoto(withdrawUserId, fileId, {
            caption: `✅ Your withdrawal of Rs. ${amount} (ID: ${transactionId}) has been approved. Receipt attached.`,
          });
          bot.sendMessage(ADMIN_ID, `✅ Withdrawal #${transactionId} approved and user balance updated.`);
          return;
        }
      }

      // User sending deposit receipt photo (reply to deposit image prompt)
      if (msg.reply_to_message?.caption?.includes('payment receipt')) {
        await ensureUser(msg);
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const res = await pool.query(
          'INSERT INTO transactions (user_id, type, status) VALUES ($1, $2, $3) RETURNING id',
          [userId, 'deposit', 'pending']
        );
        const transactionId = res.rows[0].id;
        const userRes = await pool.query('SELECT bank_name, account_number FROM users WHERE id = $1', [userId]);
        const { bank_name, account_number } = userRes.rows[0] || {};

        bot.sendPhoto(ADMIN_ID, fileId, {
          caption: `📩 New Deposit Request\nUser: @${msg.from.username || 'unknown'}\nUser ID: ${userId}\n` +
            `Transaction ID: ${transactionId}\nBank: ${bank_name || 'Not set'}\nAccount: ${account_number || 'Not set'}\n\n` +
            `Reply with:\n/approve {amount} = ${transactionId} or /reject ${transactionId} = {reason}`,
        });
        bot.sendMessage(userId, `🧾 Your receipt has been sent to the admin (ID: ${transactionId}). Awaiting approval.`);
      }
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error processing photo.');
      console.error('Photo handling error:', error);
    }
  });

  // Approve deposit command (admin only)
  bot.onText(/\/approve (\d+) = (\d+)/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 Admin only command.');

    const amount = parseFloat(match[1]);
    const transactionId = parseInt(match[2]);

    try {
      const res = await pool.query('SELECT user_id, type FROM transactions WHERE id = $1 AND status = $2', [transactionId, 'pending']);
      if (!res.rows.length) {
        return bot.sendMessage(ADMIN_ID, `⚠️ Transaction #${transactionId} not found or already processed.`);
      }

      const { user_id, type } = res.rows[0];

      await pool.query('UPDATE transactions SET status = $1, amount = $2 WHERE id = $3', ['approved', amount, transactionId]);
      const balanceUpdateQuery = type === 'deposit'
        ? 'UPDATE users SET balance = balance + $1 WHERE id = $2'
        : 'UPDATE users SET balance = balance - $1 WHERE id = $2';
      await pool.query(balanceUpdateQuery, [amount, user_id]);

      bot.sendMessage(user_id, `✅ Your ${type} of Rs. ${amount} (ID: ${transactionId}) has been approved!`);
      bot.sendMessage(ADMIN_ID, `💸 ${type.charAt(0).toUpperCase() + type.slice(1)} #${transactionId} approved and balance updated.`);
    } catch (error) {
      bot.sendMessage(ADMIN_ID, `⚠️ Error approving transaction #${transactionId}.`);
      console.error('Approve error:', error);
    }
  });

  // Reject command with reason (admin only)
  bot.onText(/\/reject (\d+) = (.+)/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 Admin only command.');

    const transactionId = parseInt(match[1]);
    const reason = match[2].trim();

    try {
      const res = await pool.query(
        'UPDATE transactions SET status = $1, reason = $2 WHERE id = $3 AND status = $4 RETURNING user_id, type',
        ['rejected', reason, transactionId, 'pending']
      );

      if (!res.rows.length) return bot.sendMessage(ADMIN_ID, `⚠️ Transaction #${transactionId} not found or already processed.`);

      const { user_id, type } = res.rows[0];

      bot.sendMessage(user_id, `❌ Your ${type} request (ID: ${transactionId}) was rejected. Reason: ${reason}`);
      bot.sendMessage(ADMIN_ID, `🚫 Transaction #${transactionId} rejected with reason: ${reason}`);
    } catch (error) {
      bot.sendMessage(ADMIN_ID, `⚠️ Error rejecting transaction #${transactionId}.`);
      console.error('Reject error:', error);
    }
  });

  // List pending transactions (admin only)
  bot.onText(/\/pending/, async (msg) => {
    if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 Admin only command.');

    try {
      const res = await pool.query(
        `SELECT t.id, t.user_id, u.username, t.type, t.amount, t.status, t.reason,
                to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS date,
                u.bank_name, u.account_number
         FROM transactions t
         JOIN users u ON t.user_id = u.id
         WHERE t.status = $1
         ORDER BY t.created_at DESC`,
        ['pending']
      );

      const text = formatTransactions(res.rows, true);
      bot.sendMessage(ADMIN_ID, text, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(ADMIN_ID, '⚠️ Error fetching pending transactions.');
      console.error('Pending transactions error:', error);
    }
  });

  // Dashboard command (admin only)
  bot.onText(/\/dashboard/, async (msg) => {
    if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 Admin only command.');

    try {
      const userStats = await pool.query(
        `SELECT COUNT(*) AS total_users, 
                SUM(balance) AS total_balance,
                COUNT(*) FILTER (WHERE bank_name IS NOT NULL AND account_number IS NOT NULL) AS users_with_bank_details
         FROM users`
      );
      const txStats = await pool.query(
        `SELECT 
           COUNT(*) FILTER (WHERE type = 'deposit' AND status = 'approved') AS approved_deposits,
           COUNT(*) FILTER (WHERE type = 'withdraw' AND status = 'approved') AS approved_withdrawals,
           COUNT(*) FILTER (WHERE status = 'pending') AS pending_transactions
         FROM transactions`
      );

      const { total_users, total_balance, users_with_bank_details } = userStats.rows[0];
      const { approved_deposits, approved_withdrawals, pending_transactions } = txStats.rows[0];

      const dashboardText = `*📊 Admin Dashboard*\n\n` +
        `👥 *Users*\n` +
        `• Total Users: ${total_users}\n` +
        `• Users with Bank Details: ${users_with_bank_details}\n` +
        `• Total Balance: Rs. ${total_balance || 0}\n\n` +
        `💸 *Transactions*\n` +
        `• Approved Deposits: ${approved_deposits}\n` +
        `• Approved Withdrawals: ${approved_withdrawals}\n` +
        `• Pending Transactions: ${pending_transactions}\n\n` +
        `Use /pending to view pending transactions.`;

      bot.sendMessage(ADMIN_ID, dashboardText, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(ADMIN_ID, '⚠️ Error generating dashboard.');
      console.error('Dashboard error:', error);
    }
  });

  // List transactions for user
  bot.onText(/\/transactions/, async (msg) => {
    await ensureUser(msg);
    const userId = msg.from.id;

    try {
      const res = await pool.query(
        `SELECT t.id, t.user_id, u.username, t.type, t.amount, t.status, t.reason, 
                to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS date,
                u.bank_name, u.account_number
         FROM transactions t
         JOIN users u ON t.user_id = u.id
         WHERE t.user_id = $1
         ORDER BY t.created_at DESC
         LIMIT 10`,
        [userId]
      );

      const text = formatTransactions(res.rows);
      bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, '⚠️ Error fetching transactions.');
      console.error('User transactions error:', error);
    }
  });

  // Admin sets deposit account image
  bot.onText(/\/qr (.+)/, async (msg, match) => {
    if (!isAdmin(msg.chat.id)) return bot.sendMessage(msg.chat.id, '🚫 Admin only command.');

    const url = match[1].trim();

    if (!/\.(jpg|jpeg|png|webp)$/i.test(url)) {
      return bot.sendMessage(msg.chat.id, `❌ Please provide a direct image URL (ending with .jpg, .png, etc.)`);
    }

    try {
      await pool.query(
        `INSERT INTO config (key, value) VALUES ('deposit_image_url', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [url]
      );

      bot.sendMessage(ADMIN_ID, `✅ Deposit image URL has been updated.`);
    } catch (error) {
      bot.sendMessage(ADMIN_ID, '⚠️ Error updating deposit image URL.');
      console.error('Account image error:', error);
    }
  });

  // Forward user messages (non-command, non-admin) to admin
  bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const isUserAdmin = isAdmin(userId);

    if (msg.text?.startsWith('/') || isUserAdmin) return; // skip commands and admin msgs

    // Skip photos that are replies to deposit command
    if (msg.photo && msg.reply_to_message?.caption?.includes('payment receipt')) {
      console.log(`Skipped forwarding photo from user ${userId} as it's a deposit receipt.`);
      return;
    }

    await ensureUser(msg);

    const userName = msg.from.username || `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || 'unknown';

    try {
      if (msg.text) {
        bot.forwardMessage(ADMIN_ID, msg.chat.id, msg.message_id);
        bot.sendMessage(ADMIN_ID, `📩 From @${userName} (ID: ${userId}):\n${msg.text}`);
      } else if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        bot.sendPhoto(ADMIN_ID, fileId, {
          caption: `📸 Photo from @${userName} (ID: ${userId})`,
        });
      } else if (msg.document) {
        bot.sendDocument(ADMIN_ID, msg.document.file_id, {
          caption: `📄 Document from @${userName} (ID: ${userId})`,
        });
      }
    } catch (error) {
      console.error('Forward message error:', error);
    }
  });

  // Admin replies forwarded user messages — relay back to user
  bot.on('message', async (msg) => {
    if (!isAdmin(msg.chat.id) || !msg.reply_to_message) return;

    // Skip if the admin's reply is a command
    if (msg.text?.startsWith('/')) {
      console.log(`Skipped admin reply from ${msg.chat.id} as it's a command: ${msg.text}`);
      return;
    }

    const repliedText = msg.reply_to_message.caption || msg.reply_to_message.text;
    const userIdMatch = repliedText?.match(/ID: (\d+)/);
    if (!userIdMatch) return;

    const targetUserId = parseInt(userIdMatch[1]);

    try {
      if (msg.text) {
        bot.sendMessage(targetUserId, `📬 Admin replied:\n${msg.text}`);
      } else if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        bot.sendPhoto(targetUserId, fileId, {
          caption: msg.caption || '📬 Admin sent you a photo.',
        });
      } else if (msg.document) {
        bot.sendDocument(targetUserId, msg.document.file_id, {
          caption: msg.caption || '📬 Admin sent you a document.',
        });
      }
    } catch (error) {
      bot.sendMessage(ADMIN_ID, `⚠️ Error replying to user ${targetUserId}.`);
      console.error('Admin reply error:', error);
    }
  });

  console.log('🤖 PayMe Telegram Bot is up and running!');
};