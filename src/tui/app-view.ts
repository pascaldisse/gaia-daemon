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

export class AppView {
  private rl: Interface | undefined;

  start(): void {
    if (!input.isTTY || !output.isTTY) {
      this.rl = createInterface({ input, output });
    }
  }

  async prompt(roomId: string, defaultAgent: string, previews: PromptPreviewOptions): Promise<string> {
    const promptText = `${renderStatusLine(roomId, defaultAgent)}\n> `;

    if (!input.isTTY || !output.isTTY) {
      if (!this.rl) this.start();
      return this.rl!.question(promptText);
    }

    return this.interactivePrompt(promptText, previews);
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

  private interactivePrompt(promptText: string, previews: PromptPreviewOptions): Promise<string> {
    return new Promise((resolve) => {
      let buffer = "";
      let closed = false;

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        input.off("keypress", onKeypress);
        input.setRawMode(false);
        input.pause();
      };

      const finish = (value: string): void => {
        cleanup();
        output.write("\n");
        resolve(value);
      };

      const redraw = (): void => {
        output.write(`${promptText}${buffer}`);
      };

      const showPreview = (kind: "/" | "@"): void => {
        const options = kind === "/" ? previews.slashCommands : previews.agents;
        const title = kind === "/" ? "Commands" : "Agents";
        const lines = options.length === 0 ? ["  (none)"] : options.map((option) => this.renderOption(kind, option));
        output.write(`\n${title}:\n${lines.join("\n")}\n`);
        redraw();
      };

      const onKeypress = (text: string, key: Key): void => {
        if (key.ctrl && key.name === "c") {
          finish("/quit");
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          finish(buffer);
          return;
        }
        if (key.name === "backspace" || key.name === "delete") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            output.write("\b \b");
          }
          return;
        }
        if (key.name === "d" && key.ctrl && buffer.length === 0) {
          finish("/quit");
          return;
        }
        if (!text || key.ctrl || key.meta) return;

        buffer += text;
        output.write(text);

        if (text === "/" && buffer === "/") showPreview("/");
        if (text === "@") showPreview("@");
      };

      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      input.on("keypress", onKeypress);
      output.write(promptText);
    });
  }

  private renderOption(prefix: "/" | "@", option: PromptOption): string {
    const label = `${prefix}${option.label}`;
    return option.description ? `  ${label.padEnd(14)} ${option.description}` : `  ${label}`;
  }
}
