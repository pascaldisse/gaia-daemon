// Shared client-side type vocabulary. Daemon wire types come in as JSDoc
// comment imports from src2 (never runtime imports — the no-build rule);
// payload shapes the daemon does not export are defined locally here.

/** @typedef {import("../../src2/core/types.js").RoomEvent} RoomEvent */
/** @typedef {import("../../src2/core/types.js").UserRoomEvent} UserRoomEvent */
/** @typedef {import("../../src2/core/types.js").AgentRoomEvent} AgentRoomEvent */
/** @typedef {import("../../src2/core/types.js").EventDetails} EventDetails */
/** @typedef {import("../../src2/core/types.js").ToolDetail} ToolDetail */
/** @typedef {import("../../src2/core/types.js").Task} Task */
/** @typedef {import("../../src2/core/types.js").Snapshot} Snapshot */
/** @typedef {import("../../src2/core/types.js").AgentStatus} AgentStatus */
/** @typedef {import("../../src2/core/types.js").RoomSummary} RoomSummary */
/** @typedef {import("../../src2/core/types.js").SlashCommandDefinition} SlashCommandDefinition */
/** @typedef {import("../../src2/core/types.js").VoiceCallInfo} VoiceCallInfo */
/** @typedef {import("../../src2/core/types.js").UiEvent} UiEvent */

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
 * @property {"select"|"multiselect"|"number"|"boolean"|"text"} input
 * @property {boolean} [optional]
 * @property {FieldHintOption[]} [options]
 * @property {string} [groupBy]
 * @property {boolean} [hidden]
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
