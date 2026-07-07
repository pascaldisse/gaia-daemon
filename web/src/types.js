// Shared client-side type vocabulary. Daemon wire types come in as JSDoc
// comment imports from src (never runtime imports — the no-build rule);
// payload shapes the daemon does not export are defined locally here.

/** @typedef {import("../../src/core/types.js").RoomEvent} RoomEvent */
/** @typedef {import("../../src/core/types.js").MessageAttachment} MessageAttachment */
/** @typedef {import("../../src/core/types.js").UserRoomEvent} UserRoomEvent */
/** @typedef {import("../../src/core/types.js").AgentRoomEvent} AgentRoomEvent */
/** @typedef {import("../../src/core/types.js").EventDetails} EventDetails */
/** @typedef {import("../../src/core/types.js").MessageBlock} MessageBlock */
/** @typedef {import("../../src/core/types.js").ToolDetail} ToolDetail */
/** @typedef {import("../../src/core/types.js").Task} Task */
/** @typedef {import("../../src/core/types.js").Snapshot} Snapshot */
/** @typedef {import("../../src/core/types.js").AgentStatus} AgentStatus */
/** @typedef {import("../../src/core/types.js").RoomSummary} RoomSummary */
/** @typedef {import("../../src/core/types.js").SlashCommandDefinition} SlashCommandDefinition */
/** @typedef {import("../../src/core/types.js").VoiceCallInfo} VoiceCallInfo */
/** @typedef {import("../../src/core/types.js").UiEvent} UiEvent */
/** @typedef {import("../../src/core/types.js").SanitizeProposal} SanitizeProposal */
/** @typedef {import("../../src/core/types.js").SanitizeSuggestion} SanitizeSuggestion */
/** @typedef {import("../../src/core/types.js").SanitizeOption} SanitizeOption */
/** @typedef {import("../../src/core/types.js").ContextGatePending} ContextGatePending */
/** @typedef {import("../../src/core/types.js").ChatSearchHit} ChatSearchHit */
/** @typedef {import("../../src/core/types.js").ChatSearchResult} ChatSearchResult */
/** @typedef {import("../../src/core/types.js").UsageLimits} UsageLimits */
/** @typedef {import("../../src/core/types.js").UsageWindow} UsageWindow */

/**
 * One SSE payload, narrowed by its `type` tag.
 * @template {UiEvent["type"]} T
 * @typedef {Extract<UiEvent, { type: T }>} Ev
 */

/**
 * A workspace known to the daemon (~/.gaia/app.json recents).
 * @typedef {Object} WorkspaceRecord
 * @property {string} id
 * @property {string} path
 * @property {string} name
 * @property {string} lastOpenedAt
 * @property {boolean} isInitialized
 */

/**
 * An editable settings file, as listed (no content).
 * @typedef {Object} FileDescriptor
 * @property {string} id
 * @property {"global"|"workspace"} scope
 * @property {string} label
 * @property {string} path
 * @property {"markdown"|"json"|"text"} kind
 * @property {string} [agentId]
 * @property {"general"|"voice"|"config"|"persona"|"memory"} [category]
 */

/** @typedef {FileDescriptor & { content: string, hints?: FileHints }} EditableFile */

/**
 * @typedef {Object} FieldHintOption
 * @property {string} value
 * @property {string} [label]
 * @property {string} [description]
 * @property {string} [group]
 */

/**
 * Server-computed editing hint for one JSON path ("model.provider", "tools").
 * @typedef {Object} FieldHint
 * @property {"select"|"multiselect"|"number"|"boolean"|"text"|"json"} input
 * @property {boolean} [optional]
 * @property {FieldHintOption[]} [options]
 * @property {string} [groupBy]
 * @property {boolean} [hidden]
 * @property {string} [label]
 * @property {string} [description]
 */

/**
 * @typedef {Object} HarnessConfigMeta
 * @property {string} [lockedProvider]
 * @property {string[]} [modelProviderIds]
 * @property {string[]} [modelNameOptions]
 * @property {string[]} hiddenFields
 */

/**
 * @typedef {Object} HarnessHintsMeta
 * @property {Record<string, HarnessConfigMeta>} configs
 */

/** @typedef {{ [key: string]: FieldHint | HarnessHintsMeta | undefined, _harness?: HarnessHintsMeta }} FileHints */

/**
 * GET /api/app response.
 * @typedef {Object} AppPayload
 * @property {WorkspaceRecord[]} workspaces
 * @property {string} [currentWorkspaceId]
 * @property {FileDescriptor[]} globalFiles
 * @property {Snapshot} [snapshot]
 * @property {FileDescriptor[]} [workspaceFiles]
 * @property {VoiceCallInfo|null} [voice]
 */

/**
 * Response of snapshot / room-select / default-agent / role endpoints.
 * @typedef {Object} SnapshotPayload
 * @property {Snapshot} snapshot
 * @property {FileDescriptor[]} [workspaceFiles]
 * @property {VoiceCallInfo|null} [voice]
 * @property {string} [message]
 */

/**
 * A file pasted into the composer, held locally until send (uploads happen on
 * submit, so an abandoned paste never litters the room's files dir).
 * @typedef {Object} PendingAttachment
 * @property {File} file
 * @property {string} name
 * @property {string} mime
 * @property {number} size
 * @property {string|null} previewUrl object URL for image thumbnails
 */

/**
 * The upload route's response: the server-issued id the message send echoes.
 * @typedef {Object} UploadedAttachment
 * @property {string} id
 * @property {string} name
 * @property {string} mime
 * @property {number} size
 */

/**
 * An in-flight agent reply, keyed by the transcript event id the server
 * reserved for it (v2 streaming deltas carry `eventId`). Committed as a
 * room-event with the same id, at which point the entry is dropped.
 * @typedef {Object} StreamEntry
 * @property {string} id
 * @property {string} taskId
 * @property {string} author
 * @property {string} startedAt
 * @property {string} text
 * @property {EventDetails} details
 * @property {number} version bumped on every mutation; drives keyed patching
 */

export {};
