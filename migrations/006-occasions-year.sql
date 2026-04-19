-- Optional start year for annual occasions (birth year for 'birthday',
-- wedding year for 'anniversary'). NULL for shared holidays and for
-- birthdays whose year wasn't in the source data.

ALTER TABLE occasions ADD COLUMN year INTEGER;
