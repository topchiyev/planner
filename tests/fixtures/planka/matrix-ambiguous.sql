INSERT INTO attachment (id, card_id, creator_user_id, type, data, name)
SELECT 608, card_id, creator_user_id, type, jsonb_set(data, '{filename}', '"Alternate Study.png"'), 'Conflicting original'
FROM attachment WHERE id = 601;
UPDATE uploaded_file SET references_total = 3 WHERE id = '9007199254741220';
