import type { ChannelResult, NotificationInput } from './notify';

/**
 * Telegram channel. Uses the bot HTTP API directly (no SDK), so no extra
 * dependency needed. Configure with TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
 * If not configured, logs to stdout and reports not-delivered.
 */
export function isTelegramConfigured(): boolean {
	return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function sendTelegram(input: NotificationInput): Promise<ChannelResult> {
	if (!isTelegramConfigured()) {
		console.log('[notify-telegram] (not configured) subject:', input.subject);
		return {
			channel: 'telegram',
			configured: false,
			delivered: false,
			detail: 'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — skipped'
		};
	}

	const token = process.env.TELEGRAM_BOT_TOKEN!;
	const chatId = process.env.TELEGRAM_CHAT_ID!;
	const body = `*${input.subject}*\n\n${input.text}`;

	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: body,
				parse_mode: 'Markdown',
				disable_web_page_preview: true
			})
		});
		if (!res.ok) {
			const detail = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
			return { channel: 'telegram', configured: true, delivered: false, detail };
		}
		return {
			channel: 'telegram',
			configured: true,
			delivered: true,
			detail: 'sendMessage ok'
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			channel: 'telegram',
			configured: true,
			delivered: false,
			detail: `fetch error: ${message}`
		};
	}
}
