import { evalInTab } from "./cdp-lib.mjs";
import { readFileSync } from "node:fs";

const targetId = readFileSync("/tmp/cdp-tab-id", "utf8").trim();
const expr = process.argv[2];
if (!expr) throw new Error("usage: cdp-eval.mjs '<js expression>'");
const result = await evalInTab(targetId, expr);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
