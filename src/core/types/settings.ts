// ---------------------------------------------------------------------------
// Settings editor wire shapes (services/hints.ts ↔ the web settings UI). The
// hints are derived server-side and rendered generically by the client, so
// these cross the wire verbatim.

export type FieldInput = "select" | "multiselect" | "number" | "boolean" | "text" | "json";

export interface FieldHintOption {
  value: string;
  label?: string;
  description?: string;
  /** Group key: dependent selects filter by it (FieldHint.groupBy); a
   * multiselect renders one collapsible section per group. */
  group?: string;
  /** Small inline tag shown after the label (e.g. "native" for a harness builtin). */
  badge?: string;
}

export interface FieldHint {
  input: FieldInput;
  /** Optional fields render an explicit "(not set)" choice; empty omits the key on save. */
  optional?: boolean;
  options?: FieldHintOption[];
  /** Value shown by the settings form when this field is absent from the raw
   * file. The first edit writes an ordinary per-agent override. */
  defaultValue?: unknown;
  /** Per-role defaults for an inheritable field (currently tools and skills). */
  roleDefaults?: Record<string, unknown>;
  /** JSON path of another field whose current value filters options by their `group`. */
  groupBy?: string;
  /** Hint is applicable but currently hidden by another field's value (e.g. tools hidden for codex harness). */
  hidden?: boolean;
  /** Friendly field name shown in the settings UI in place of the raw JSON key
   * (e.g. "Voice mode" for `ttsEngine`). Falls back to the key when absent. */
  label?: string;
  /** Shown as visible help text under the field — what the setting does / example value. */
  description?: string;
}

/** Metadata the server attaches to hints so the frontend can react to harness changes without reloading. */
export interface HarnessHintsMeta {
  configs: Record<
    string,
    {
      lockedProvider?: string;
      modelProviderIds?: string[];
      modelNameOptions?: string[];
      permissionModes?: string[];
      /** UI noun for this harness's account records ("Claude account"); absent = no account support. */
      accountsLabel?: string;
      /** Select options (stored account id/label) for THIS harness's accounts. */
      accountOptions?: FieldHintOption[];
      hiddenFields: string[];
    }
  >;
}

export interface FileHints {
  [key: string]: FieldHint | HarnessHintsMeta | undefined;
  _harness?: HarnessHintsMeta;
}

export type EditableScope = "global" | "workspace";

// What a file *is*, computed where the directory layout is known (the editable
// -file catalog), so the frontend can group files without parsing label paths.
export type EditableCategory = "general" | "voice" | "config" | "persona" | "memory";

export interface EditableFileDescriptor {
  id: string;
  scope: EditableScope;
  label: string;
  path: string;
  kind: "markdown" | "json" | "text";
  /** Owning agent for files under the global agents directory. */
  agentId?: string;
  category?: EditableCategory;
}

export interface EditableFileContent extends EditableFileDescriptor {
  content: string;
}

