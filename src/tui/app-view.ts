import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Mode } from "../personas/types.js";
import { renderStatusLine } from "./status-line.js";

export class AppView {
  private rl: Interface | undefined;

  start(): void {
    this.rl = createInterface({ input, output });
  }

  async prompt(mode: Mode, modelLabel: string): Promise<string> {
    if (!this.rl) this.start();
    return this.rl!.question(`${renderStatusLine(mode, modelLabel)}\n> `);
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
  }
}
