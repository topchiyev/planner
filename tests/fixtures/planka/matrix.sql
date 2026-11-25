-- Exercise deduplicated bytes across an authorization boundary.
UPDATE attachment SET card_id = 9007199254740998, creator_user_id = 102 WHERE id = 604;
