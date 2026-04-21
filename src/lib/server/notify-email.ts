import type { ChannelResult, NotificationInput } from './notify';

/**
 * Email channel. Wires up nodemailer lazily when SMTP_HOST is present so
 * unconfigured installs don't pay the import cost. Current MVP behaviour:
 * if not configured, logs the notification to stdout and reports not-
 * delivered (channel: email, configured: false).
 *
 * To wire real delivery, set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
 * SMTP_FROM, and SMTP_TO in .env.
 */
export function isEmailConfigured(): boolean {
	return Boolean(process.env.SMTP_HOST && process.env.SMTP_TO && process.env.SMTP_FROM);
}

export async function sendEmail(input: NotificationInput): Promise<ChannelResult> {
	if (!isEmailConfigured()) {
		console.log('[notify-email] (not configured) subject:', input.subject);
		return {
			channel: 'email',
			configured: false,
			delivered: false,
			detail: 'SMTP_HOST/SMTP_FROM/SMTP_TO not set — skipped'
		};
	}

	// Dynamic import so installs without nodemailer/SMTP don't error out.
	let nodemailer: typeof import('nodemailer');
	try {
		nodemailer = await import('nodemailer');
	} catch {
		return {
			channel: 'email',
			configured: true,
			delivered: false,
			detail: 'nodemailer not installed — add it to send email'
		};
	}

	const transporter = nodemailer.createTransport({
		host: process.env.SMTP_HOST,
		port: Number(process.env.SMTP_PORT ?? 587),
		secure: process.env.SMTP_SECURE === 'true',
		auth:
			process.env.SMTP_USER && process.env.SMTP_PASS
				? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
				: undefined
	});

	try {
		const info = await transporter.sendMail({
			from: process.env.SMTP_FROM,
			to: process.env.SMTP_TO,
			subject: input.subject,
			text: input.text,
			html: input.html
		});
		return {
			channel: 'email',
			configured: true,
			delivered: true,
			detail: `Message ID ${info.messageId ?? '?'}`
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			channel: 'email',
			configured: true,
			delivered: false,
			detail: `SMTP error: ${message}`
		};
	}
}
