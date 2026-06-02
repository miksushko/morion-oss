-- Fold note titles into the body's first line (Apple Notes parity).
-- After this migration, `notes.title` is a cached/derived column recomputed
-- from the first line of `body` on every write by the JS deriveTitleFromBody().

-- Step 1: For notes where body does NOT already start with the title text,
-- prepend `# title\n\n` to body. Notes whose body already begins with the
-- title (common for imported markdown) are left alone (idempotent).
UPDATE notes
SET body = '# ' || TRIM(title) || char(10) || char(10) || body
WHERE TRIM(title) != ''
  AND TRIM(body) != ''
  AND body NOT LIKE (REPLACE(REPLACE(TRIM(title), '%', '\%'), '_', '\_') || '%') ESCAPE '\'
  AND body NOT LIKE ('# ' || REPLACE(REPLACE(TRIM(title), '%', '\%'), '_', '\_') || '%') ESCAPE '\'
  AND body NOT LIKE ('## ' || REPLACE(REPLACE(TRIM(title), '%', '\%'), '_', '\_') || '%') ESCAPE '\'
  AND body NOT LIKE ('### ' || REPLACE(REPLACE(TRIM(title), '%', '\%'), '_', '\_') || '%') ESCAPE '\';

-- Handle notes with a title but empty body: body becomes the title
UPDATE notes
SET body = TRIM(title)
WHERE TRIM(title) != '' AND TRIM(body) = '';

-- Step 2: Recompute the cached title from the first line of the merged body.
-- This is a simplified SQL approximation — the JS deriveTitleFromBody() will
-- recompute the exact value on the next write. We just strip `# ` prefix
-- from the first line and truncate to 100 chars.
UPDATE notes
SET title = SUBSTR(
  TRIM(
    CASE
      WHEN TRIM(body) = '' THEN ''
      WHEN INSTR(body, char(10)) > 0 THEN
        CASE
          WHEN SUBSTR(body, 1, 2) = '# ' THEN SUBSTR(body, 3, INSTR(body, char(10)) - 3)
          ELSE SUBSTR(body, 1, INSTR(body, char(10)) - 1)
        END
      ELSE
        CASE
          WHEN SUBSTR(body, 1, 2) = '# ' THEN SUBSTR(body, 3)
          ELSE body
        END
    END
  ),
  1,
  100
);
