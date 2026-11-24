-- Common invented cases. Each release supplies its own workspace label and asset bytes.
INSERT INTO user_account (
  id, email, role, name, username, avatar, language, subscribe_to_own_cards,
  subscribe_to_card_when_commenting, turn_off_recent_card_highlighting, enable_favorites_by_default,
  default_editor_mode, default_home_view, default_projects_order, is_deactivated,
  created_at, is_totp_enabled, auto_logout_mode
) VALUES
  (101, 'iris@planner-fixture.invalid', 'admin', 'Iris Fixture', 'iris-fixture', NULL, 'en-US',
   true, true, false, false, 'markup', 'groupedProjects', 'byDefault', false,
   '2026-02-11 08:09:10.123456', true, '30m'),
  (102, 'rowan@planner-fixture.invalid', 'projectOwner', 'Rowan Fixture', NULL,
   '{"uploadedFileId":"03000000-0000-4000-8000-000000000001","extension":"png","size":311}',
   NULL, false, false, false, false, 'wysiwyg', 'gridProjects', 'alphabetically', false,
   NULL, false, 'never'),
  (103, 'sage@planner-fixture.invalid', 'boardUser', 'Sage Fixture', 'sage-fixture', NULL, NULL,
   false, true, true, false, 'markup', 'groupedProjects', 'byDefault', false,
   NULL, false, 'never'),
  (104, 'teal@planner-fixture.invalid', 'boardUser', 'Teal Fixture', NULL, NULL, NULL,
   false, false, false, false, 'markup', 'groupedProjects', 'byDefault', false,
   NULL, false, 'never'),
  (105, 'yarrow@planner-fixture.invalid', 'boardUser', 'Yarrow Fixture', 'yarrow-fixture', NULL, NULL,
   false, false, false, false, 'markup', 'groupedProjects', 'byDefault', true,
   NULL, false, 'never');

INSERT INTO project (
  id, owner_project_manager_id, background_image_id, name, description, background_type, is_hidden
) VALUES
  (201, NULL, 211, :'fixture_workspace', 'Synthetic observation schedules.', 'image', false),
  (202, 222, NULL, 'Night optics annex', NULL, NULL, true);
INSERT INTO project_manager (id, project_id, user_id) VALUES (221, 201, 102), (222, 202, 102);
INSERT INTO project_favorite (id, project_id, user_id) VALUES (231, 201, 103);
INSERT INTO background_image (id, project_id, uploaded_file_id, extension, size)
VALUES (211, 201, '03000000-0000-4000-8000-000000000002', 'png', 419);

INSERT INTO board (
  id, project_id, position, name, default_view, default_card_type, limit_card_types_to_default_one,
  always_display_card_creator, expand_task_lists_by_default, display_card_ages, show_card_counter
) VALUES
  (301, 201, 1024, 'Prism calibration', 'kanban', 'project', false, true, false, true, true),
  (302, 202, 2048, 'Lens storage', 'list', 'story', true, false, true, false, false);
INSERT INTO board_membership (id, project_id, board_id, user_id, role, can_comment) VALUES
  (311, 201, 301, 102, 'editor', NULL),
  (312, 201, 301, 101, 'editor', NULL),
  (313, 201, 301, 103, 'viewer', true),
  (314, 201, 301, 104, 'viewer', false),
  (315, 202, 302, 102, 'editor', NULL);
INSERT INTO board_subscription (id, board_id, user_id) VALUES (321, 301, 103);

INSERT INTO list (id, board_id, type, position, name, color) VALUES
  (401, 301, 'active', 1024, 'Align', 'lagoon-blue'),
  (402, 301, 'closed', 2048, 'Measured', 'bright-moss'),
  (403, 301, 'archive', NULL, NULL, NULL),
  (404, 301, 'trash', NULL, NULL, NULL),
  (405, 302, 'active', 1024, 'Stored', NULL),
  (406, 302, 'archive', NULL, NULL, NULL),
  (407, 302, 'trash', NULL, NULL, NULL);

INSERT INTO card (
  id, board_id, list_id, creator_user_id, prev_list_id, cover_attachment_id,
  type, position, name, description, due_date, stopwatch, created_at, list_changed_at,
  comments_total, is_closed, is_due_completed
) VALUES
  (9007199254740993, 301, 401, 102, NULL, 601, 'project', 1024, 'Rotate the test prism',
   'Ask @[Teal Fixture](104) and retain @[Past Observer](999).', '2026-02-12 08:09:10.654321',
   '{"startedAt":null,"total":0}', '2026-02-11 08:09:10.123456', NULL, 1, false, false),
  (9007199254740994, 301, 401, 101, NULL, NULL, 'story', 1024, 'Log the wavelength drift',
   NULL, NULL, NULL, '2026-02-11 08:09:10.123457', NULL, 0, false, NULL),
  (9007199254740995, 301, 402, 102, 401, NULL, 'story', 2048, 'Seal the diffraction record',
   NULL, '2026-02-13 08:09:10.000001', NULL, NULL, NULL, 0, true, true),
  (9007199254740996, 301, 403, 102, 499, NULL, 'project', NULL, 'Prior grating setup',
   NULL, NULL, NULL, NULL, '2026-02-14 08:09:10.000001', 0, true, NULL),
  (9007199254740997, 301, 404, NULL, 401, NULL, 'project', NULL, 'Retired alignment notes',
   NULL, NULL, NULL, NULL, '2026-02-14 08:09:10.000002', 0, false, NULL),
  (9007199254740998, 302, 405, 102, NULL, NULL, 'story', 1024, 'Box the spare refractor',
   NULL, NULL, NULL, NULL, NULL, 0, false, NULL);

INSERT INTO label (id, board_id, position, name, color) VALUES (501, 301, 1024, NULL, 'lagoon-blue');
INSERT INTO card_label (id, card_id, label_id) VALUES (511, 9007199254740993, 501);
INSERT INTO card_membership (id, card_id, user_id) VALUES (521, 9007199254740993, 102);
INSERT INTO card_subscription (id, card_id, user_id, is_permanent)
VALUES (531, 9007199254740993, 103, true);

INSERT INTO task_list (id, card_id, position, name, show_on_front_of_card, hide_completed_tasks)
VALUES (541, 9007199254740993, 1024, 'Bench checks', true, true);
INSERT INTO task (id, task_list_id, assignee_user_id, position, name, is_completed, linked_card_id) VALUES
  (551, 541, NULL, 1024, 'Seal the diffraction record', true, 9007199254740995),
  (552, 541, NULL, 2048, 'Box the spare refractor', false, 9007199254740998),
  (553, 541, 102, 3072, 'Set aside the spacer', false, NULL);

INSERT INTO base_custom_field_group (id, project_id, name)
VALUES (561, 201, 'Spectral notes');
INSERT INTO custom_field_group (id, board_id, card_id, base_custom_field_group_id, position, name) VALUES
  (571, 301, NULL, 561, 1024, NULL),
  (572, NULL, 9007199254740993, 561, 2048, NULL);
INSERT INTO custom_field (
  id, base_custom_field_group_id, custom_field_group_id, position, name, show_on_front_of_card
) VALUES (581, 561, NULL, 1024, 'Filter mark', true);
INSERT INTO custom_field_value (id, card_id, custom_field_group_id, custom_field_id, content) VALUES
  (591, 9007199254740993, 571, 581, '  blue / λ  '),
  (592, 9007199254740993, 572, 581, '0');

INSERT INTO uploaded_file (id, references_total, type, mime_type, size) VALUES
  ('9007199254741220', 2, 'attachment', 'image/png', :fixture_image_size),
  ('9007199254741221', 1, 'attachment', NULL, :fixture_note_size),
  ('9007199254741222', 1, 'attachment', NULL, :fixture_note_size),
  ('03000000-0000-4000-8000-000000000001', 1, 'userAvatar', 'image/png', 311),
  ('03000000-0000-4000-8000-000000000002', 1, 'backgroundImage', 'image/png', 419);

INSERT INTO attachment (id, card_id, creator_user_id, type, data, name) VALUES
  (601, 9007199254740993, 102, 'file', jsonb_build_object(
    'uploadedFileId', '9007199254741220', 'filename', U&'Re\0301seau Tile.png', 'mimeType', 'image/png',
    'size', :fixture_image_size, 'encoding', '7bit',
    'image', '{"width":3,"height":2,"thumbnailsExtension":"png"}'::jsonb), 'Cover study'),
  (602, 9007199254740994, 101, 'file', jsonb_build_object(
    'uploadedFileId', '9007199254741220', 'filename', U&'Re\0301seau Tile.png', 'mimeType', 'image/png',
    'size', :fixture_image_size, 'encoding', '7bit',
    'image', '{"width":3,"height":2,"thumbnailsExtension":"png"}'::jsonb), 'Same stored study'),
  (603, 9007199254740993, 102, 'file', jsonb_build_object(
    'uploadedFileId', '9007199254741221', 'filename', 'Fixture Deck.txt', 'mimeType', NULL,
    'size', :fixture_note_size, 'encoding', '7bit', 'image', NULL), 'Observation sequence'),
  (604, 9007199254740994, 101, 'file', jsonb_build_object(
    'uploadedFileId', '9007199254741222', 'filename', 'Alternate Deck.txt', 'mimeType', NULL,
    'size', :fixture_note_size, 'encoding', '7bit', 'image', NULL), 'Duplicate bytes'),
  (605, 9007199254740993, 102, 'link',
    '{"url":"https://handbook.fixture.invalid/optics","hostname":"handbook.fixture.invalid"}',
    'Reference URL'),
  (606, 9007199254740994, 101, 'link',
    '{"url":"http://127.0.0.1/fixture-only","hostname":"127.0.0.1"}', 'Inert local URL');

INSERT INTO comment (id, card_id, user_id, text, created_at)
VALUES (701, 9007199254740993, 103, 'Measured twice.', '2026-02-11 09:00:00.006789');
INSERT INTO action (id, board_id, card_id, user_id, type, data, created_at) VALUES
  (711, NULL, 9007199254740996, 102, 'moveCard',
    '{"fromList":{"id":"499","type":"closed","name":"Earlier batch"},
      "toList":{"id":"403","type":"archive","name":null}}', '2026-02-14 08:09:10.000001'),
  (712, 301, 9007199254740993, 102, 'createCard',
    '{"card":{"name":"Rotate the test prism"},"list":{"id":"401","type":"active","name":"Align"}}',
    '2026-02-11 08:09:10.123456');
INSERT INTO notification (
  id, user_id, creator_user_id, board_id, card_id, comment_id, action_id, type, data, is_read
) VALUES
  (721, 103, 102, 301, 9007199254740999, NULL, 799, 'moveCard',
    '{"fromList":{"id":"499","type":"closed","name":"Earlier batch"},
      "toList":{"id":"403","type":"archive","name":null}}', false),
  (722, 102, 103, 301, 9007199254740993, 701, NULL, 'commentCard',
    '{"card":{"name":"Rotate the test prism"},"text":"Measured twice."}', true);

INSERT INTO session (id, user_id, remote_address, pending_token_attempts)
VALUES (801, 102, '192.0.2.72', 0);
INSERT INTO config (id, smtp_host, smtp_port, smtp_secure, smtp_tls_reject_unauthorized)
VALUES (811, 'mail.fixture.invalid', 465, true, true);
INSERT INTO internal_config (id, storage_limit, active_users_limit, is_initialized)
VALUES (821, '5GB', 20, true);
INSERT INTO notification_service (id, board_id, url, format)
VALUES (831, 301, 'https://notify.fixture.invalid/optics', 'text');
INSERT INTO webhook (id, board_id, name, url, events)
VALUES (841, 301, 'Fixture callback', 'https://hooks.fixture.invalid/optics', ARRAY['cardCreate']);
INSERT INTO storage_usage (id, total, user_avatars, background_images, attachments)
VALUES (851, 311 + 419 + :fixture_image_size + 2 * :fixture_note_size, 311, 419,
        :fixture_image_size + 2 * :fixture_note_size);
