-- Synthetic Planner fixture schema. Load in a fresh database.
SET search_path = public, pg_catalog;
SET TIME ZONE 'UTC';
CREATE EXTENSION pg_trgm;

CREATE TABLE action (
  id bigint PRIMARY KEY,
  card_id bigint NOT NULL,
  user_id bigint,
  type text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  board_id bigint
);

CREATE TABLE attachment (
  id bigint PRIMARY KEY,
  card_id bigint NOT NULL,
  creator_user_id bigint,
  type text NOT NULL,
  data jsonb NOT NULL,
  name text NOT NULL,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE background_image (
  id bigint PRIMARY KEY,
  project_id bigint NOT NULL,
  uploaded_file_id text NOT NULL,
  extension text NOT NULL,
  size bigint NOT NULL,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE base_custom_field_group (
  id bigint PRIMARY KEY,
  project_id bigint NOT NULL,
  name text NOT NULL,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE board (
  id bigint PRIMARY KEY,
  project_id bigint NOT NULL,
  position double precision NOT NULL,
  name text NOT NULL,
  default_view text NOT NULL,
  default_card_type text NOT NULL,
  limit_card_types_to_default_one boolean NOT NULL,
  always_display_card_creator boolean NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  expand_task_lists_by_default boolean NOT NULL,
  display_card_ages boolean NOT NULL,
  show_card_counter boolean NOT NULL
);

CREATE TABLE board_membership (
  id bigint PRIMARY KEY,
  project_id bigint NOT NULL,
  board_id bigint NOT NULL,
  user_id bigint NOT NULL,
  role text NOT NULL,
  can_comment boolean,
  created_at timestamp,
  updated_at timestamp,
  CONSTRAINT board_membership_board_id_user_id_unique UNIQUE (board_id, user_id)
);

CREATE TABLE board_subscription (
  id bigint PRIMARY KEY,
  board_id bigint NOT NULL,
  user_id bigint NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  CONSTRAINT board_subscription_board_id_user_id_unique UNIQUE (board_id, user_id)
);

CREATE TABLE card (
  id bigint PRIMARY KEY,
  board_id bigint NOT NULL,
  list_id bigint NOT NULL,
  creator_user_id bigint,
  prev_list_id bigint,
  cover_attachment_id bigint,
  type text NOT NULL,
  position double precision,
  name text NOT NULL,
  description text,
  due_date timestamp,
  stopwatch jsonb,
  created_at timestamp,
  updated_at timestamp,
  list_changed_at timestamp,
  comments_total integer NOT NULL,
  is_closed boolean NOT NULL,
  is_due_completed boolean
);

CREATE TABLE card_label (
  id bigint PRIMARY KEY,
  card_id bigint NOT NULL,
  label_id bigint NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  CONSTRAINT card_label_card_id_label_id_unique UNIQUE (card_id, label_id)
);

CREATE TABLE card_membership (
  id bigint PRIMARY KEY,
  card_id bigint NOT NULL,
  user_id bigint NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  CONSTRAINT card_membership_card_id_user_id_unique UNIQUE (card_id, user_id)
);

CREATE TABLE card_subscription (
  id bigint PRIMARY KEY,
  card_id bigint NOT NULL,
  user_id bigint NOT NULL,
  is_permanent boolean NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  CONSTRAINT card_subscription_card_id_user_id_unique UNIQUE (card_id, user_id)
);

CREATE TABLE comment (
  id bigint PRIMARY KEY,
  card_id bigint NOT NULL,
  user_id bigint,
  text text NOT NULL,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE config (
  id bigint PRIMARY KEY,
  created_at timestamp,
  updated_at timestamp,
  smtp_host text,
  smtp_port integer,
  smtp_name text,
  smtp_secure boolean NOT NULL,
  smtp_tls_reject_unauthorized boolean NOT NULL,
  smtp_user text,
  smtp_password text,
  smtp_from text
);

CREATE TABLE custom_field (
  id bigint PRIMARY KEY,
  base_custom_field_group_id bigint,
  custom_field_group_id bigint,
  position double precision NOT NULL,
  name text NOT NULL,
  show_on_front_of_card boolean NOT NULL,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE custom_field_group (
  id bigint PRIMARY KEY,
  board_id bigint,
  card_id bigint,
  base_custom_field_group_id bigint,
  position double precision NOT NULL,
  name text,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE custom_field_value (
  id bigint PRIMARY KEY,
  card_id bigint NOT NULL,
  custom_field_group_id bigint NOT NULL,
  custom_field_id bigint NOT NULL,
  content text NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  CONSTRAINT custom_field_value_card_id_custom_field_group_id_custom_field_i
    UNIQUE (card_id, custom_field_group_id, custom_field_id)
);

CREATE TABLE internal_config (
  id bigint PRIMARY KEY,
  storage_limit text,
  active_users_limit integer,
  is_initialized boolean NOT NULL,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE label (
  id bigint PRIMARY KEY,
  board_id bigint NOT NULL,
  position double precision NOT NULL,
  name text,
  color text NOT NULL,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE list (
  id bigint PRIMARY KEY,
  board_id bigint NOT NULL,
  type text NOT NULL,
  position double precision,
  name text,
  color text,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE migration (
  id serial PRIMARY KEY,
  name varchar(255),
  batch integer,
  migration_time timestamptz
);

CREATE TABLE migration_lock (
  index serial PRIMARY KEY,
  is_locked integer
);

CREATE TABLE notification (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL,
  creator_user_id bigint,
  board_id bigint NOT NULL,
  card_id bigint NOT NULL,
  comment_id bigint,
  action_id bigint,
  type text NOT NULL,
  data jsonb NOT NULL,
  is_read boolean NOT NULL,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE notification_service (
  id bigint PRIMARY KEY,
  user_id bigint,
  board_id bigint,
  url text NOT NULL,
  format text NOT NULL,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE project (
  id bigint PRIMARY KEY,
  owner_project_manager_id bigint,
  background_image_id bigint,
  name text NOT NULL,
  description text,
  background_type text,
  background_gradient text,
  is_hidden boolean NOT NULL,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE project_favorite (
  id bigint PRIMARY KEY,
  project_id bigint NOT NULL,
  user_id bigint NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  CONSTRAINT project_favorite_project_id_user_id_unique UNIQUE (project_id, user_id)
);

CREATE TABLE project_manager (
  id bigint PRIMARY KEY,
  project_id bigint NOT NULL,
  user_id bigint NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  CONSTRAINT project_manager_project_id_user_id_unique UNIQUE (project_id, user_id)
);

CREATE TABLE session (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL,
  access_token text CONSTRAINT session_access_token_unique UNIQUE,
  http_only_token text,
  remote_address text NOT NULL,
  user_agent text,
  created_at timestamp,
  updated_at timestamp,
  deleted_at timestamp,
  pending_token text CONSTRAINT session_pending_token_unique UNIQUE,
  pending_token_attempts integer NOT NULL
);

CREATE TABLE storage_usage (
  id bigint PRIMARY KEY,
  total bigint NOT NULL,
  user_avatars bigint NOT NULL,
  background_images bigint NOT NULL,
  attachments bigint NOT NULL,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE task (
  id bigint PRIMARY KEY,
  task_list_id bigint NOT NULL,
  assignee_user_id bigint,
  position double precision NOT NULL,
  name text NOT NULL,
  is_completed boolean NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  linked_card_id bigint
);

CREATE TABLE task_list (
  id bigint PRIMARY KEY,
  card_id bigint NOT NULL,
  position double precision NOT NULL,
  name text NOT NULL,
  show_on_front_of_card boolean NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  hide_completed_tasks boolean NOT NULL
);

CREATE TABLE trusted_device (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL,
  token_hash text NOT NULL,
  user_agent_summary text,
  browser_name text,
  browser_version text,
  os_name text,
  os_version text,
  device_type text,
  device_vendor text,
  device_model text,
  label text,
  expires_at timestamp NOT NULL,
  last_used_at timestamp,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE uploaded_file (
  id text PRIMARY KEY,
  references_total integer,
  created_at timestamp,
  updated_at timestamp,
  type text NOT NULL,
  mime_type text,
  size bigint NOT NULL
);

CREATE TABLE user_account (
  id bigint PRIMARY KEY,
  email text NOT NULL CONSTRAINT user_account_email_unique UNIQUE,
  password text,
  role text NOT NULL,
  name text NOT NULL,
  username text,
  avatar jsonb,
  phone text,
  organization text,
  language text,
  subscribe_to_own_cards boolean NOT NULL,
  subscribe_to_card_when_commenting boolean NOT NULL,
  turn_off_recent_card_highlighting boolean NOT NULL,
  enable_favorites_by_default boolean NOT NULL,
  default_editor_mode text NOT NULL,
  default_home_view text NOT NULL,
  default_projects_order text NOT NULL,
  is_deactivated boolean NOT NULL,
  created_at timestamp,
  updated_at timestamp,
  password_changed_at timestamp,
  terms_signature text,
  terms_accepted_at timestamp,
  api_key_prefix text,
  api_key_hash text CONSTRAINT user_account_api_key_hash_unique UNIQUE,
  api_key_created_at timestamp,
  totp_secret text,
  is_totp_enabled boolean NOT NULL,
  totp_enabled_at timestamp,
  totp_recovery_codes jsonb,
  auto_logout_mode varchar(255) NOT NULL,
  CONSTRAINT user_account_username_unique
    EXCLUDE USING btree (username WITH =) WHERE (username IS NOT NULL)
);

CREATE TABLE webhook (
  id bigint PRIMARY KEY,
  board_id bigint,
  name text NOT NULL,
  url text NOT NULL,
  access_token text,
  events text[],
  excluded_events text[],
  created_at timestamp,
  updated_at timestamp,
  project_id bigint,
  user_id bigint
);

CREATE INDEX action_board_id_index ON action (board_id);
CREATE INDEX action_card_id_index ON action (card_id);
CREATE INDEX action_user_id_index ON action (user_id);
CREATE INDEX attachment_card_id_index ON attachment (card_id);
CREATE INDEX attachment_creator_user_id_index ON attachment (creator_user_id);
CREATE INDEX background_image_project_id_index ON background_image (project_id);
CREATE INDEX base_custom_field_group_project_id_index ON base_custom_field_group (project_id);
CREATE INDEX board_membership_project_id_index ON board_membership (project_id);
CREATE INDEX board_membership_user_id_index ON board_membership (user_id);
CREATE INDEX board_position_index ON board (position);
CREATE INDEX board_project_id_index ON board (project_id);
CREATE INDEX board_subscription_user_id_index ON board_subscription (user_id);
CREATE INDEX card_board_id_index ON card (board_id);
CREATE INDEX card_creator_user_id_index ON card (creator_user_id);
CREATE INDEX card_description_gin_index ON card USING gin (description gin_trgm_ops);
CREATE INDEX card_label_label_id_index ON card_label (label_id);
CREATE INDEX card_list_changed_at_index ON card (list_changed_at);
CREATE INDEX card_list_id_index ON card (list_id);
CREATE INDEX card_membership_user_id_index ON card_membership (user_id);
CREATE INDEX card_name_gin_index ON card USING gin (name gin_trgm_ops);
CREATE INDEX card_position_index ON card (position);
CREATE INDEX card_subscription_user_id_index ON card_subscription (user_id);
CREATE INDEX comment_card_id_index ON comment (card_id);
CREATE INDEX comment_user_id_index ON comment (user_id);
CREATE INDEX custom_field_base_custom_field_group_id_index ON custom_field (base_custom_field_group_id);
CREATE INDEX custom_field_custom_field_group_id_index ON custom_field (custom_field_group_id);
CREATE INDEX custom_field_group_base_custom_field_group_id_index ON custom_field_group (base_custom_field_group_id);
CREATE INDEX custom_field_group_board_id_index ON custom_field_group (board_id);
CREATE INDEX custom_field_group_card_id_index ON custom_field_group (card_id);
CREATE INDEX custom_field_group_position_index ON custom_field_group (position);
CREATE INDEX custom_field_position_index ON custom_field (position);
CREATE INDEX custom_field_value_custom_field_group_id_index ON custom_field_value (custom_field_group_id);
CREATE INDEX custom_field_value_custom_field_id_index ON custom_field_value (custom_field_id);
CREATE INDEX label_board_id_index ON label (board_id);
CREATE INDEX label_position_index ON label (position);
CREATE INDEX list_board_id_index ON list (board_id);
CREATE INDEX list_position_index ON list (position);
CREATE INDEX list_type_index ON list (type);
CREATE INDEX notification_action_id_index ON notification (action_id);
CREATE INDEX notification_card_id_index ON notification (card_id);
CREATE INDEX notification_comment_id_index ON notification (comment_id);
CREATE INDEX notification_creator_user_id_index ON notification (creator_user_id);
CREATE INDEX notification_is_read_index ON notification (is_read);
CREATE INDEX notification_service_board_id_index ON notification_service (board_id);
CREATE INDEX notification_service_user_id_index ON notification_service (user_id);
CREATE INDEX notification_user_id_index ON notification (user_id);
CREATE INDEX project_favorite_user_id_index ON project_favorite (user_id);
CREATE INDEX project_manager_user_id_index ON project_manager (user_id);
CREATE INDEX project_owner_project_manager_id_index ON project (owner_project_manager_id);
CREATE INDEX session_remote_address_index ON session (remote_address);
CREATE INDEX session_user_id_index ON session (user_id);
CREATE INDEX task_assignee_user_id_index ON task (assignee_user_id);
CREATE INDEX task_linked_card_id_index ON task (linked_card_id);
CREATE INDEX task_list_card_id_index ON task_list (card_id);
CREATE INDEX task_list_position_index ON task_list (position);
CREATE INDEX task_position_index ON task (position);
CREATE INDEX task_task_list_id_index ON task (task_list_id);
CREATE INDEX trusted_device_user_id_expires_at_index ON trusted_device (user_id, expires_at);
CREATE INDEX uploaded_file_references_total_index ON uploaded_file (references_total);
CREATE INDEX uploaded_file_type_index ON uploaded_file (type);
CREATE INDEX user_account_is_deactivated_index ON user_account (is_deactivated);
CREATE INDEX user_account_role_index ON user_account (role);
CREATE INDEX user_account_username_index ON user_account (username);
CREATE INDEX webhook_board_id_index ON webhook (board_id);
CREATE INDEX webhook_project_id_index ON webhook (project_id);
CREATE INDEX webhook_user_id_index ON webhook (user_id);
