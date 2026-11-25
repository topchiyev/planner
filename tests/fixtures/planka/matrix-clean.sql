INSERT INTO list (id, board_id, type, position, name, color)
VALUES (499, 301, 'closed', 3072, 'Earlier batch', NULL);
UPDATE action SET board_id = 301 WHERE id = 711;
UPDATE notification SET card_id = 9007199254740996, action_id = 711 WHERE id = 721;
