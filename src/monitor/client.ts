import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { UpdateConnectionState } from 'telegram/network/index.js';
import { logger } from '../utils/logger.js';

export async function createMonitorClient(
  apiId: number,
  apiHash: string,
  session: string,
): Promise<TelegramClient> {
  const stringSession = new StringSession(session);

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => {
      throw new Error(
        'Session expired or missing. Run `npm run auth` to generate a new session string.',
      );
    },
    password: async () => {
      throw new Error('Session expired. Run `npm run auth` to re-authenticate.');
    },
    phoneCode: async () => {
      throw new Error('Session expired. Run `npm run auth` to re-authenticate.');
    },
    onError: (err) => {
      logger.error('GramJS auth error', { error: err.message });
    },
  });

  // Monitor connection state changes
  client.addEventHandler((update: any) => {
    if (update instanceof UpdateConnectionState) {
      const state = update.state === -1 ? 'disconnected' : update.state === 0 ? 'broken' : 'connected';
      logger.info('GramJS connection state changed', { state });
    }
  });

  // Force Telegram to refresh update state by fetching dialogs.
  // Without this, the server may not push channel updates after a restart
  // because GramJS's catchUp() is unimplemented and the session's pts/qts
  // can go stale.
  try {
    const dialogs = await client.getDialogs({ limit: 50 });
    logger.info('Fetched dialogs to refresh update state', {
      dialogCount: dialogs.length,
    });
  } catch (err) {
    logger.warn('Failed to fetch dialogs for update refresh', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('GramJS client connected');
  return client;
}
