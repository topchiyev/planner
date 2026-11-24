-- Fault injection for a source link whose scheme is outside HTTP(S).
INSERT INTO public.attachment (id, card_id, creator_user_id, type, data, name)
VALUES (607, 9007199254740994, 101, 'link',
        '{"url":"urn:planner-fixture:unsupported-link","hostname":""}', 'Unsupported link scheme');
