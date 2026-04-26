import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { getClientForUser } from './google-auth';

export interface GmailMessageSummary {
	id: string;
	threadId: string;
	snippet: string;
	internalDate: string;
	subject: string | null;
	from: string | null;
	receivedAt: string | null;
	labelIds: string[];
}

export interface GmailMessageFull extends GmailMessageSummary {
	bodyText: string;
	bodyHtml: string;
}

export class GmailLabelNotFound extends Error {
	constructor(labelName: string) {
		super(`Gmail label not found: ${labelName}`);
	}
}

function makeGmail(auth: OAuth2Client): gmail_v1.Gmail {
	return google.gmail({ version: 'v1', auth });
}

async function resolveLabelId(gmail: gmail_v1.Gmail, name: string): Promise<string> {
	const res = await gmail.users.labels.list({ userId: 'me' });
	const target = res.data.labels?.find(
		(l) => l.name === name || l.name === name.replace(/\//g, '-')
	);
	if (!target?.id) throw new GmailLabelNotFound(name);
	return target.id;
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | null {
	if (!headers) return null;
	const lower = name.toLowerCase();
	const found = headers.find((h) => h.name?.toLowerCase() === lower);
	return found?.value ?? null;
}

function decodePart(data: string): string {
	// Gmail returns base64url-encoded part data.
	return Buffer.from(data, 'base64url').toString('utf8');
}

function extractBodies(payload: gmail_v1.Schema$MessagePart | undefined): {
	text: string;
	html: string;
} {
	let text = '';
	let html = '';
	function walk(part: gmail_v1.Schema$MessagePart | undefined): void {
		if (!part) return;
		const mime = part.mimeType ?? '';
		const body = part.body?.data;
		if (body) {
			if (mime === 'text/plain') text += decodePart(body);
			else if (mime === 'text/html') html += decodePart(body);
		}
		if (part.parts) {
			for (const p of part.parts) walk(p);
		}
	}
	walk(payload);
	return { text, html };
}

function stripHtml(html: string): string {
	// Crude but good enough for Amazon templates: strip tags, collapse whitespace,
	// decode a few HTML entities.
	const noTags = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
	const decoded = noTags
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
	return decoded.replace(/\s+/g, ' ').trim();
}

/** Lists message summaries (id + label set + subject + from + snippet) for a named label. */
export async function listLabelMessages(
	userId: number,
	labelName: string,
	opts?: { maxResults?: number }
): Promise<GmailMessageSummary[]> {
	const auth = getClientForUser(userId);
	const gmail = makeGmail(auth);
	const labelId = await resolveLabelId(gmail, labelName);

	const summaries: GmailMessageSummary[] = [];
	let pageToken: string | undefined;
	const pageSize = 100;
	const cap = opts?.maxResults ?? 500;

	while (summaries.length < cap) {
		const { data } = await gmail.users.messages.list({
			userId: 'me',
			labelIds: [labelId],
			maxResults: Math.min(pageSize, cap - summaries.length),
			pageToken
		});
		const ids = data.messages?.map((m) => m.id).filter((x): x is string => Boolean(x)) ?? [];
		if (ids.length === 0) break;

		// Fetch metadata for this page in parallel.
		const results = await Promise.all(
			ids.map((id) =>
				gmail.users.messages.get({
					userId: 'me',
					id,
					format: 'metadata',
					metadataHeaders: ['Subject', 'From', 'Date']
				})
			)
		);
		for (const res of results) {
			const m = res.data;
			if (!m.id) continue;
			summaries.push({
				id: m.id,
				threadId: m.threadId ?? '',
				snippet: m.snippet ?? '',
				internalDate: m.internalDate ?? '',
				subject: headerValue(m.payload?.headers, 'Subject'),
				from: headerValue(m.payload?.headers, 'From'),
				receivedAt: m.internalDate
					? new Date(Number(m.internalDate)).toISOString()
					: null,
				labelIds: m.labelIds ?? []
			});
		}

		if (!data.nextPageToken) break;
		pageToken = data.nextPageToken;
	}

	return summaries;
}

/** Fetches full body (text + html) for a single message. */
export async function getFullMessage(userId: number, messageId: string): Promise<GmailMessageFull> {
	const auth = getClientForUser(userId);
	const gmail = makeGmail(auth);
	const { data } = await gmail.users.messages.get({
		userId: 'me',
		id: messageId,
		format: 'full'
	});
	const bodies = extractBodies(data.payload ?? undefined);
	return {
		id: data.id ?? messageId,
		threadId: data.threadId ?? '',
		snippet: data.snippet ?? '',
		internalDate: data.internalDate ?? '',
		subject: headerValue(data.payload?.headers, 'Subject'),
		from: headerValue(data.payload?.headers, 'From'),
		receivedAt: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : null,
		labelIds: data.labelIds ?? [],
		bodyText: bodies.text || stripHtml(bodies.html),
		bodyHtml: bodies.html
	};
}

export async function moveToLabel(
	userId: number,
	messageId: string,
	fromLabel: string,
	toLabel: string
): Promise<void> {
	const auth = getClientForUser(userId);
	const gmail = makeGmail(auth);
	const [fromId, toId] = await Promise.all([
		resolveLabelId(gmail, fromLabel),
		resolveLabelId(gmail, toLabel)
	]);
	await gmail.users.messages.modify({
		userId: 'me',
		id: messageId,
		requestBody: {
			addLabelIds: [toId],
			removeLabelIds: [fromId]
		}
	});
}

/**
 * Bulk-moves up to 1000 messages per call via Gmail's batchModify endpoint.
 * Single round trip regardless of message count — massively faster than calling
 * moveToLabel in a loop. Silently no-ops when messageIds is empty.
 */
export async function batchMoveToLabel(
	userId: number,
	messageIds: string[],
	fromLabel: string,
	toLabel: string
): Promise<void> {
	if (messageIds.length === 0) return;
	const auth = getClientForUser(userId);
	const gmail = makeGmail(auth);
	const [fromId, toId] = await Promise.all([
		resolveLabelId(gmail, fromLabel),
		resolveLabelId(gmail, toLabel)
	]);
	const CHUNK = 1000;
	for (let i = 0; i < messageIds.length; i += CHUNK) {
		await gmail.users.messages.batchModify({
			userId: 'me',
			requestBody: {
				ids: messageIds.slice(i, i + CHUNK),
				addLabelIds: [toId],
				removeLabelIds: [fromId]
			}
		});
	}
}

export async function trashMessage(userId: number, messageId: string): Promise<void> {
	const auth = getClientForUser(userId);
	const gmail = makeGmail(auth);
	await gmail.users.messages.trash({ userId: 'me', id: messageId });
}

/** Bulk trash messages that currently carry the given label. */
export async function trashMessagesUnderLabel(
	userId: number,
	labelName: string,
	opts?: { olderThanDays?: number }
): Promise<number> {
	const auth = getClientForUser(userId);
	const gmail = makeGmail(auth);
	const labelId = await resolveLabelId(gmail, labelName);

	const q = opts?.olderThanDays ? `label:${labelName} older_than:${opts.olderThanDays}d` : undefined;
	const ids: string[] = [];
	let pageToken: string | undefined;
	do {
		const { data } = await gmail.users.messages.list({
			userId: 'me',
			labelIds: q ? undefined : [labelId],
			q,
			maxResults: 500,
			pageToken
		});
		for (const m of data.messages ?? []) if (m.id) ids.push(m.id);
		pageToken = data.nextPageToken ?? undefined;
	} while (pageToken);

	// Gmail supports batchModify but not batchTrash — iterate with limited concurrency.
	const concurrency = 5;
	let done = 0;
	for (let i = 0; i < ids.length; i += concurrency) {
		await Promise.all(
			ids.slice(i, i + concurrency).map((id) =>
				gmail.users.messages.trash({ userId: 'me', id })
			)
		);
		done += Math.min(concurrency, ids.length - i);
	}
	return done;
}
