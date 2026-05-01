import { stdin as input, stdout as output } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { emitKeypressEvents, type Key } from "node:readline";
import { renderStatusLine } from "./status-line.js";

export interface PromptOption {
  label: string;
  description?: string;
}

export interface PromptPreviewOptions {
  slashCommands: PromptOption[];
  agents: PromptOption[];
}

type PreviewKind = "/" | "@";

interface ActivePreview {
  kind: PreviewKind;
  start: number;
  query: string;
  selectedIndex: number;
  hidden: boolean;
  options: PromptOption[];
}

export class AppView {
  private rl: Interface | undefined;

  start(): void {
    if (!input.isTTY || !output.isTTY) {
      this.rl = createInterface({ input, output });
    }
  }

  async prompt(roomId: string, defaultAgent: string, previews: PromptPreviewOptions): Promise<string> {
    const statusLine = renderStatusLine(roomId, defaultAgent);

    if (!input.isTTY || !output.isTTY) {
      if (!this.rl) this.start();
      return this.rl!.question(`${statusLine}\n> `);
    }

    return this.interactivePrompt(statusLine, previews);
  }

  write(text: string): void {
    output.write(text);
  }

  line(text = ""): void {
    output.write(`${text}\n`);
  }

  close(): void {
    this.rl?.close();
    this.rl = undefined;
    if (input.isTTY) input.setRawMode(false);
  }

  private interactivePrompt(statusLine: string, previews: PromptPreviewOptions): Promise<string> {
    return new Promise((resolve) => {
      let buffer = "";
      let active: ActivePreview | null = null;
      let closed = false;
      let renderedLineCount = 0;

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        input.off("keypress", onKeypress);
        input.setRawMode(false);
        input.pause();
      };

      const clearRendered = (): void => {
        if (renderedLineCount === 0) return;

        output.write("\r");
        output.write(`\x1b[${Math.max(0, renderedLineCount - 2)}B`);
        for (let i = renderedLineCount - 1; i >= 0; i -= 1) {
          output.write("\r\x1b[2K");
          if (i > 0) output.write("\x1b[1A");
        }
        renderedLineCount = 0;
      };

      const currentMenuLines = (): string[] => {
        if (!active || active.hidden) return [];
        if (active.options.length === 0) return [`  ${active.kind}${active.query}  no matches`];

        return active.options.slice(0, 8).map((option, index) => {
          const selected = index === active!.selectedIndex;
          const marker = selected ? "›" : " ";
          const label = `${active!.kind}${option.label}`;
          const description = option.description ? ` ${option.description}` : "";
          return `${marker} ${label.padEnd(14)}${description}`;
        });
      };

      const redraw = (): void => {
        clearRendered();

        const menuLines = currentMenuLines();
        const lines = [statusLine, `> ${buffer}`, ...menuLines];
        renderedLineCount = lines.length;
        output.write(lines.join("\n"));

        if (menuLines.length > 0) output.write(`\x1b[${menuLines.length}A`);
        output.write(`\r\x1b[${2 + buffer.length}C`);
      };

      const finish = (value: string): void => {
        buffer = value;
        active = null;
        redraw();
        cleanup();
        output.write("\n");
        resolve(value);
      };

      const updatePreview = (keepHidden = false): void => {
        const slash = this.findSlashPreview(buffer, previews.slashCommands);
        const mention = this.findMentionPreview(buffer, previews.agents);
        const next = slash ?? mention;

        if (!next) {
          active = null;
          return;
        }

        const previous = active;
        const sameToken = previous !== null && previous.kind === next.kind && previous.start === next.start;
        const hidden = keepHidden && sameToken ? previous.hidden : false;
        active = {
          ...next,
          hidden,
          selectedIndex: Math.min(sameToken ? previous.selectedIndex : 0, Math.max(0, next.options.length - 1)),
        };
      };

      const applySelection = (): boolean => {
        if (!active || active.hidden || active.options.length === 0) return false;

        const current = active;
        const selected = current.options[current.selectedIndex];
        if (!selected) return false;

        const before = buffer.slice(0, current.start);
        const suffix = current.kind === "/" ? `/${selected.label}` : `@${selected.label} `;
        const next = `${before}${suffix}`;
        const changed = next !== buffer;
        buffer = next;
        active = null;
        return changed;
      };

      const moveSelection = (delta: number): void => {
        if (!active || active.hidden || active.options.length === 0) return;
        active.selectedIndex = (active.selectedIndex + delta + active.options.length) % active.options.length;
      };

      const onKeypress = (text: string, key: Key): void => {
        if (key.ctrl && key.name === "c") {
          finish("/quit");
          return;
        }

        if (key.name === "return" || key.name === "enter") {
          if (active && !active.hidden) {
            const changed = applySelection();
            if (!changed) finish(buffer);
            else redraw();
            return;
          }
          finish(buffer);
          return;
        }

        if (key.name === "tab") {
          if (active && !active.hidden) {
            applySelection();
            redraw();
          }
          return;
        }

        if (key.name === "escape") {
          if (active) active.hidden = true;
          redraw();
          return;
        }

        if (key.name === "up") {
          moveSelection(-1);
          redraw();
          return;
        }

        if (key.name === "down") {
          moveSelection(1);
          redraw();
          return;
        }

        if (key.name === "backspace" || key.name === "delete") {
          buffer = buffer.slice(0, -1);
          updatePreview(true);
          redraw();
          return;
        }

        if (key.name === "d" && key.ctrl && buffer.length === 0) {
          finish("/quit");
          return;
        }

        if (!text || key.ctrl || key.meta) return;

        buffer += text;
        updatePreview();
        redraw();
      };

      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", onKeypress);
      updatePreview();
      redraw();
    });
  }

  private findSlashPreview(buffer: string, commands: PromptOption[]): Omit<ActivePreview, "selectedIndex" | "hidden"> | null {
    const match = buffer.match(/^\/([^\s]*)$/);
    if (!match) return null;
    const query = match[1].toLowerCase();
    return {
      kind: "/",
      start: 0,
      query,
      options: commands.filter((command) => command.label.toLowerCase().startsWith(query)),
    };
  }

  private findMentionPreview(buffer: string, agents: PromptOption[]): Omit<ActivePreview, "selectedIndex" | "hidden"> | null {
    const match = buffer.match(/(^|\s)@([a-z0-9_-]*)$/i);
    if (!match || match.index === undefined) return null;
    const separator = match[1];
    const query = match[2].toLowerCase();
    const start = match.index + separator.length;

    return {
      kind: "@",
      start,
      query,
      options: agents.filter((agent) => agent.label.toLowerCase().startsWith(query)),
    };
  }
}
