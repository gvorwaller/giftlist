import { sendEmail, isEmailConfigured } from './notify-email';
import { sendTelegram, isTelegramConfigured } from './notify-telegram';

export interface NotificationInput {
	subject: string;
	text: string;
	html?: string;
}

export interface ChannelResult {
	channel: 'email' | 'telegram';
	configured: boolean;
	delivered: boolean;
	detail: string;
}

export interface ConfiguredChannels {
	email: boolean;
	telegram: boolean;
}

export function configuredChannels(): ConfiguredChannels {
	return {
		email: isEmailConfigured(),
		telegram: isTelegramConfigured()
	};
}

/** Fans out to every configured channel; unconfigured channels no-op. */
export async function deliverNotification(input: NotificationInput): Promise<ChannelResult[]> {
	const results: ChannelResult[] = [];
	results.push(await sendEmail(input));
	results.push(await sendTelegram(input));
	return results;
}
