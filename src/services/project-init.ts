/** Model prompt behind `/init`; the transcript deliberately retains only `/init`. */
export const PROJECT_INIT_PROMPT = `Analyze this project and create or update AGENTS.md at the project root.

Work autonomously. Recursively map every relevant project directory, then inspect representative source files and the files that define how the project works: any existing AGENTS.md, README and contributor docs, package/build manifests, test and lint configuration, CI, entry points, and major modules. Honor ignore files. Do not inspect .git, .gaia, dependency/vendor directories, generated files, build output, caches, binaries, or likely secret material such as .env files, credentials, tokens, private keys, and certificates—even when tracked. Never copy secret values into AGENTS.md or your reply.

Read an existing AGENTS.md before editing it. Preserve its useful project-specific instructions and constraints; update stale project context in place rather than replacing the file with generic advice. If it does not exist, create it. Record only verified, durable facts an agent needs to work here: purpose, repository map, architecture and data flow, build/test/lint/run commands, conventions, constraints, hazards, and pointers to deeper docs. Keep it concise, structured, and project-specific. Do not duplicate the same rule in different words.

Write the file, review the final diff or contents for accuracy and accidental secrets, then briefly report what you changed.`;
