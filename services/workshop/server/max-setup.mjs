import fs from 'node:fs';
import { maxApi } from './max-bot.mjs';

const config = JSON.parse(fs.readFileSync(process.env.MAX_BOT_CONFIG_FILE, 'utf8'));
const action = process.argv[2] || 'info';
if (action === 'info') {
  const bot = await maxApi(config, '/me');
  const subscriptions = await maxApi(config, '/subscriptions');
  console.log(JSON.stringify({ bot: { id: bot.user_id, name: bot.first_name, username: bot.username }, subscriptions: subscriptions.subscriptions?.map(item => ({url:item.url,update_types:item.update_types})), allowedChatIds:config.allowedChatIds }));
} else if (action === 'subscribe') {
  if (config.webhookUrl !== 'https://vm-app.ru/api/max/webhook') throw new Error('MAX_WEBHOOK_URL');
  const result = await maxApi(config, '/subscriptions', { url: config.webhookUrl, secret: config.secret, update_types: ['message_created', 'bot_added', 'bot_removed'] });
  console.log(JSON.stringify({ success: result.success }));
} else throw new Error('MAX_SETUP_ACTION');
