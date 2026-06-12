import test from "node:test";
import assert from "node:assert/strict";
import { classifyVoiceTurn, completionChunk, completionDone, completionPayload, isStreamingRequest, modelListPayload } from "../src/app/voice-bridge.ts";

function request(messages: Array<{ role: string; content: string }>, stream = true): unknown {
  return { model: "gaia", messages, stream, temperature: 0.7 };
}

test("classifies unmute's synthetic greeting turn", () => {
  const turn = classifyVoiceTurn(
    request([
      { role: "system", content: "unmute system prompt" },
      { role: "user", content: "Hello." },
    ]),
  );
  assert.equal(turn?.kind, "greeting");
  assert.equal(turn?.userText, "");
  assert.match(turn?.agentMessage ?? "", /voice call/i);
});

test("a literal 'Hello.' later in the call is a real user turn", () => {
  const turn = classifyVoiceTurn(
    request([
      { role: "system", content: "prompt" },
      { role: "user", content: "Hey there" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "Hello." },
    ]),
  );
  assert.equal(turn?.kind, "user");
  assert.equal(turn?.userText, "Hello.");
});

test("classifies the silence marker as a nudge, not a user message", () => {
  const turn = classifyVoiceTurn(
    request([
      { role: "system", content: "prompt" },
      { role: "user", content: "Hello." },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "..." },
    ]),
  );
  assert.equal(turn?.kind, "silence");
  assert.equal(turn?.userText, "");
});

test("classifies a normal spoken turn", () => {
  const turn = classifyVoiceTurn(
    request([
      { role: "system", content: "prompt" },
      { role: "user", content: "Hello." },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "what files are in this project" },
    ]),
  );
  assert.equal(turn?.kind, "user");
  assert.equal(turn?.userText, "what files are in this project");
  assert.equal(turn?.agentMessage, "what files are in this project");
});

test("returns undefined when there is no user message", () => {
  assert.equal(classifyVoiceTurn(request([{ role: "system", content: "prompt" }])), undefined);
  assert.equal(classifyVoiceTurn({}), undefined);
  assert.equal(classifyVoiceTurn(undefined), undefined);
});

test("detects streaming requests", () => {
  assert.equal(isStreamingRequest(request([], true)), true);
  assert.equal(isStreamingRequest(request([], false)), false);
  assert.equal(isStreamingRequest({}), false);
});

test("model list payload offers exactly one model for unmute autoselection", () => {
  const payload = modelListPayload() as { object: string; data: Array<{ id: string }> };
  assert.equal(payload.object, "list");
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0]?.id, "gaia");
});

test("streams OpenAI-compatible chunks", () => {
  const chunk = completionChunk("chatcmpl_x", "hi", null);
  assert.match(chunk, /^data: /);
  assert.match(chunk, /\n\n$/);
  const parsed = JSON.parse(chunk.slice("data: ".length));
  assert.equal(parsed.object, "chat.completion.chunk");
  assert.equal(parsed.choices[0].delta.content, "hi");
  assert.equal(parsed.choices[0].finish_reason, null);

  const finish = JSON.parse(completionChunk("chatcmpl_x", undefined, "stop").slice("data: ".length));
  assert.deepEqual(finish.choices[0].delta, {});
  assert.equal(finish.choices[0].finish_reason, "stop");

  assert.equal(completionDone(), "data: [DONE]\n\n");
});

test("builds a non-streaming completion payload", () => {
  const payload = completionPayload("chatcmpl_x", "hello there") as { choices: Array<{ message: { content: string }; finish_reason: string }> };
  assert.equal(payload.choices[0]?.message.content, "hello there");
  assert.equal(payload.choices[0]?.finish_reason, "stop");
});
