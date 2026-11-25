export interface OwnedIndex {
  name: string;
  keys: [string, 1 | -1][];
  unique?: true;
  expireAfterSeconds?: number;
  installOnUse?: true;
  partialFilterExpression?: Record<string, unknown>;
}

function index(
  name: string, fields: readonly (string | [string, -1])[],
  options: Pick<OwnedIndex, 'unique' | 'partialFilterExpression' | 'installOnUse'> = {},
): OwnedIndex {
  return {
    name,
    keys: [['generationId', 1], ...fields.map((field): [string, 1 | -1] =>
      typeof field === 'string' ? [field, 1] : field)],
    ...options,
  };
}

const unique = { unique: true } as const;
const publicId = index('generation_public_id', ['id'], unique);

export const collectionIndexes = {
  users: [
    index('email', ['normalizedEmail'], unique),
    index('username', ['normalizedUsername'], { ...unique, partialFilterExpression: { normalizedUsername: { $type: 'string' } } }),
    index('avatar_digest', ['avatarBlobDigest']),
  ],
  projects: [index('placement', ['rank', 'id'])],
  projectManagers: [
    index('project_user', ['projectId', 'userId'], unique),
    index('user_projects', ['userId', 'projectId']),
  ],
  projectFavorites: [
    index('project_user', ['projectId', 'userId'], unique),
    index('user_projects', ['userId', 'projectId']),
  ],
  boards: [index('project_placement', ['projectId', 'rank', 'id'])],
  boardMembers: [
    index('board_user', ['boardId', 'userId'], unique),
    index('user_boards', ['userId', 'boardId']),
  ],
  boardPreferences: [index('board_options', ['boardId'], unique)],
  lists: [
    index('board_placement', ['boardId', 'rank', 'id']),
    index('board_system_kind', ['boardId', 'kind'], { ...unique, partialFilterExpression: { kind: { $in: ['archive', 'trash'] } } }),
  ],
  cards: [
    index('list_placement', ['listId', 'rank', 'id']),
    index('list_history', ['listId', ['listChangedAt', -1], ['historySequence', -1], ['id', -1]]),
    index('board_kind', ['boardId', 'kind', 'id']),
    index('board_search', ['boardId', 'searchText', 'id']),
  ],
  labels: [index('board_placement', ['boardId', 'rank', 'id'])],
  cardLabels: [index('card_label', ['cardId', 'labelId'], unique)],
  cardAssignees: [index('card_user', ['cardId', 'userId'], unique)],
  checklists: [index('card_placement', ['cardId', 'rank', 'id'])],
  tasks: [
    index('checklist_placement', ['checklistId', 'rank', 'id']),
    index('linked_card', ['linkedCardId', 'id']),
  ],
  fieldGroups: [index('scope_placement', ['scopeType', 'scopeId', 'rank', 'id'])],
  fieldDefinitions: [index('group_placement', ['fieldGroupId', 'rank', 'id'])],
  fieldValues: [index('card_group_definition', ['cardId', 'fieldGroupId', 'fieldDefinitionId'], unique)],
  comments: [
    index('card_feed', ['cardId', ['createdAt', -1], ['id', -1]]),
    index('board_feed', ['boardId', ['createdAt', -1], ['id', -1]]),
  ],
  activities: [
    index('card_feed', ['cardId', ['createdAt', -1], ['id', -1]]),
    index('board_feed', ['boardId', ['createdAt', -1], ['id', -1]]),
  ],
  auditEntries: [
    index('actor_feed', ['actorId', ['createdAt', -1], ['id', -1]]),
    index('resource_feed', ['resourceType', 'resourceId', ['createdAt', -1], ['id', -1]]),
  ],
  boardFollows: [index('board_user', ['boardId', 'userId'], unique)],
  cardFollows: [index('card_user', ['cardId', 'userId'], unique)],
  notifications: [index('recipient_read_feed', ['recipientId', 'readAt', ['createdAt', -1], ['id', -1]])],
  attachments: [
    index('card_files', ['cardId', ['createdAt', -1], ['id', -1]]),
    index('blob_reference', ['blobDigest']),
  ],
  projectBackgrounds: [
    index('project_files', ['projectId', ['createdAt', -1], ['id', -1]]),
    index('blob_reference', ['blobDigest']),
  ],
  blobs: [
    index('digest', ['digest'], unique),
    index('lifecycle', ['lifecycleState', 'byteLength', 'id']),
  ],
  sessions: [
    index('token_digest', ['tokenDigest'], unique),
    index('user_revocation', ['userId', 'revokedAt']),
    index('expiry', ['expiresAt']),
  ],
  recoveryGrants: [
    index('token_digest', ['tokenDigest'], unique),
    index('user_consumption', ['userId', 'consumedAt']),
    index('expiry', ['expiresAt']),
  ],
  trustedDevices: [
    index('token_digest', ['tokenDigest'], unique),
    index('user_revocation', ['userId', 'revokedAt']),
    index('expiry', ['expiresAt']),
  ],
  oauthArtifacts: [
    index('provider_artifact', ['kind', 'artifactId'], unique),
    index('user_client', ['userId', 'clientId']),
    index('expiry_consumption', ['expiresAt', 'consumedAt']),
    index('provider_uid', ['kind', 'providerUid'], { installOnUse: true }),
    index('provider_user_code', ['kind', 'providerUserCode'], { installOnUse: true }),
    index('provider_grant_artifacts', ['providerGrantId'], { installOnUse: true }),
    { name: 'provider_expiry', keys: [['expiresAt', 1]], expireAfterSeconds: 0, installOnUse: true },
  ],
  oauthConnections: [
    index('provider_grant', ['providerGrantId'], {
      ...unique, partialFilterExpression: { providerGrantId: { $type: 'string' } },
    }),
    index('user_client_revocation', ['userId', 'clientId', 'revokedAt']),
    index('expiry', ['expiresAt']),
  ],
  commands: [
    index('idempotency', ['actorId', 'operationId', 'idempotencyKey'], unique),
    index('recovery', ['status', 'recoverySequence', 'id']),
  ],
  commandEffectBatches: [index('command_batch', ['commandId', 'batch'], unique)],
  events: [index('board_sequence', ['boardId', 'sequence'], unique)],
  importRuns: [index('state_checkpoint', ['state', 'checkpoint.table', 'checkpoint.lastSourceId', 'id'])],
  importIds: [index('entity_source', ['entity', 'sourceId'], unique)],
  importQuarantine: [index('run_reason', ['runId', 'reason', 'id'])],
} satisfies Record<string, OwnedIndex[]>;

export type WorkspaceCollection = keyof typeof collectionIndexes;
export const workspaceCollections = Object.keys(collectionIndexes) as WorkspaceCollection[];

export function ownedIndexes(collection: WorkspaceCollection): readonly OwnedIndex[] {
  return [publicId, ...collectionIndexes[collection]];
}
