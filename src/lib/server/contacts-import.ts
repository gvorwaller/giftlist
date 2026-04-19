import { google } from 'googleapis';
import { getDb } from './db';
import { getClientForUser } from './google-auth';
import { logAudit } from './audit';
import { createPersonBirthday } from './occasions';
import type { Person } from './types';

/** A normalized view of a single Google Contact with a birthday. */
export interface NormalizedContact {
	resource_name: string;
	display_name: string;
	full_name: string | null;
	birthday: { month: number; day: number; year: number | null };
	shipping_address: string | null;
	biography: string | null;
	primary_email: string | null;
}

export interface ContactsPreview {
	fetchedAt: string;
	newContacts: NormalizedContact[];
	alreadyImported: Array<{ contact: NormalizedContact; person: Person }>;
	skippedNoBirthday: number;
	totalFetched: number;
}

export interface ImportResult {
	peopleCreated: number;
	birthdaysAssigned: number;
}

function requireMonthDay(
	birthdays: Array<{ date?: { year?: number | null; month?: number | null; day?: number | null } | null }> | undefined
): NormalizedContact['birthday'] | null {
	if (!birthdays || birthdays.length === 0) return null;
	for (const b of birthdays) {
		const d = b.date;
		if (d && typeof d.month === 'number' && typeof d.day === 'number' && d.month >= 1 && d.day >= 1) {
			return { month: d.month, day: d.day, year: typeof d.year === 'number' ? d.year : null };
		}
	}
	return null;
}

function pickName(
	names: Array<{ displayName?: string | null; givenName?: string | null; familyName?: string | null }> | undefined
): { display_name: string; full_name: string | null } | null {
	if (!names || names.length === 0) return null;
	const primary = names[0];
	const display =
		primary.displayName?.trim() ||
		[primary.givenName, primary.familyName].filter(Boolean).join(' ').trim() ||
		null;
	if (!display) return null;
	const full = primary.displayName?.trim() || display;
	return { display_name: display, full_name: full };
}

function pickAddress(
	addresses: Array<{ formattedValue?: string | null; streetAddress?: string | null; city?: string | null; region?: string | null; postalCode?: string | null; country?: string | null }> | undefined
): string | null {
	if (!addresses || addresses.length === 0) return null;
	const a = addresses[0];
	if (a.formattedValue) return a.formattedValue.trim();
	const parts = [a.streetAddress, a.city, a.region, a.postalCode, a.country].filter(Boolean);
	return parts.length > 0 ? parts.join(', ') : null;
}

function pickEmail(
	emails: Array<{ value?: string | null; metadata?: { primary?: boolean | null } | null }> | undefined
): string | null {
	if (!emails || emails.length === 0) return null;
	const primary = emails.find((e) => e.metadata?.primary) ?? emails[0];
	return primary.value?.trim() ?? null;
}

/** Page through connections until exhausted, returning only those with a birthday. */
export async function fetchBirthdayContacts(
	userId: number
): Promise<{ contacts: NormalizedContact[]; totalFetched: number; skippedNoBirthday: number }> {
	const auth = getClientForUser(userId);
	const people = google.people({ version: 'v1', auth });

	const personFields = 'names,birthdays,emailAddresses,addresses,biographies,metadata';
	const all: NormalizedContact[] = [];
	let total = 0;
	let skipped = 0;
	let pageToken: string | undefined;

	do {
		const { data } = await people.people.connections.list({
			resourceName: 'people/me',
			personFields,
			pageSize: 1000,
			pageToken
		});

		for (const c of data.connections ?? []) {
			total += 1;
			const resource = c.resourceName;
			if (!resource) continue;
			const name = pickName(c.names ?? undefined);
			if (!name) {
				skipped += 1;
				continue;
			}
			const birthday = requireMonthDay(c.birthdays ?? undefined);
			if (!birthday) {
				skipped += 1;
				continue;
			}
			all.push({
				resource_name: resource,
				display_name: name.display_name,
				full_name: name.full_name,
				birthday,
				shipping_address: pickAddress(c.addresses ?? undefined),
				biography: c.biographies?.[0]?.value?.trim() ?? null,
				primary_email: pickEmail(c.emailAddresses ?? undefined)
			});
		}

		pageToken = data.nextPageToken ?? undefined;
	} while (pageToken);

	return { contacts: all, totalFetched: total, skippedNoBirthday: skipped };
}

export async function previewImport(userId: number): Promise<ContactsPreview> {
	const { contacts, totalFetched, skippedNoBirthday } = await fetchBirthdayContacts(userId);
	const db = getDb();

	const newContacts: NormalizedContact[] = [];
	const alreadyImported: ContactsPreview['alreadyImported'] = [];

	const byResource = db.prepare<[string], Person>(
		'SELECT * FROM people WHERE google_resource_name = ?'
	);
	const byFullName = db.prepare<[string], Person>(
		'SELECT * FROM people WHERE full_name = ? AND google_resource_name IS NULL'
	);

	for (const contact of contacts) {
		const existingByResource = byResource.get(contact.resource_name);
		if (existingByResource) {
			alreadyImported.push({ contact, person: existingByResource });
			continue;
		}
		// Heuristic: a manually-created person with the same full_name is likely
		// the same human — surface them as "already on file" so we don't duplicate.
		if (contact.full_name) {
			const existingByName = byFullName.get(contact.full_name);
			if (existingByName) {
				alreadyImported.push({ contact, person: existingByName });
				continue;
			}
		}
		newContacts.push(contact);
	}

	// Stable sort: upcoming birthdays first so the list feels actionable.
	const now = new Date();
	const todayDayOfYear = daysIntoYear(now);
	newContacts.sort((a, b) => {
		const ad = (daysIntoYearForBirthday(a.birthday) - todayDayOfYear + 366) % 366;
		const bd = (daysIntoYearForBirthday(b.birthday) - todayDayOfYear + 366) % 366;
		if (ad !== bd) return ad - bd;
		return a.display_name.localeCompare(b.display_name);
	});

	return {
		fetchedAt: new Date().toISOString(),
		newContacts,
		alreadyImported,
		skippedNoBirthday,
		totalFetched
	};
}

function daysIntoYear(d: Date): number {
	const start = new Date(d.getFullYear(), 0, 0);
	return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

function daysIntoYearForBirthday(b: { month: number; day: number }): number {
	return daysIntoYear(new Date(2000, b.month - 1, b.day));
}

/**
 * Creates people + birthday occasions for the given contacts. Skips any whose
 * resource_name is already on file. Adopts existing full_name matches and
 * backfills their google_resource_name instead of creating a duplicate.
 */
export function commitImport(
	userId: number,
	contactsToImport: NormalizedContact[],
	actorUserId: number
): ImportResult {
	const db = getDb();
	let peopleCreated = 0;
	let birthdaysAssigned = 0;

	const byResource = db.prepare<[string], Person>(
		'SELECT * FROM people WHERE google_resource_name = ?'
	);
	const byFullName = db.prepare<[string], Person>(
		'SELECT * FROM people WHERE full_name = ? AND google_resource_name IS NULL'
	);
	const insertPerson = db.prepare(
		`INSERT INTO people (display_name, full_name, default_shipping_address, notes, google_resource_name)
		 VALUES (?, ?, ?, ?, ?)`
	);
	const adoptExisting = db.prepare(
		'UPDATE people SET google_resource_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
	);
	const hasBirthday = db.prepare(
		`SELECT 1 AS x FROM person_occasions po
		   JOIN occasions o ON o.id = po.occasion_id
		  WHERE po.person_id = ? AND o.kind = 'birthday' LIMIT 1`
	);

	const tx = db.transaction(() => {
		for (const c of contactsToImport) {
			let personId: number;

			const alreadyByResource = byResource.get(c.resource_name);
			if (alreadyByResource) {
				personId = alreadyByResource.id;
			} else {
				const byName = c.full_name ? byFullName.get(c.full_name) : undefined;
				if (byName) {
					adoptExisting.run(c.resource_name, byName.id);
					logAudit({
						actorUserId,
						entityType: 'person',
						entityId: byName.id,
						action: 'link_google',
						summary: `Linked "${byName.display_name}" to Google contact ${c.resource_name}`
					});
					personId = byName.id;
				} else {
					const info = insertPerson.run(
						c.display_name,
						c.full_name,
						c.shipping_address,
						c.biography,
						c.resource_name
					);
					personId = Number(info.lastInsertRowid);
					peopleCreated += 1;
					logAudit({
						actorUserId,
						entityType: 'person',
						entityId: personId,
						action: 'import_create',
						summary: `Imported "${c.display_name}" from Google Contacts`
					});
				}
			}

			const exists = hasBirthday.get(personId) as { x: number } | undefined;
			if (!exists) {
				createPersonBirthday(personId, c.birthday.month, c.birthday.day, actorUserId, {
					title: 'Birthday'
				});
				birthdaysAssigned += 1;
			}
		}
	});

	tx();
	void userId;
	return { peopleCreated, birthdaysAssigned };
}
