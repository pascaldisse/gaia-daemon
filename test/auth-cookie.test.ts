import { test } from "bun:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { cookieHeader, secureCookieForRequest } from "../src/core/http.js";

function request(host?: string, encrypted = false, forwarded?: string): IncomingMessage {
  return { headers: { host, "x-forwarded-proto": forwarded }, socket: { encrypted } } as unknown as IncomingMessage;
}

test("cookies: Secure default; explicit HTTP opt-out preserves other protections", () => {
  assert.match(cookieHeader("gaia_user", "token", 60), /; Secure$/);
  assert.equal(cookieHeader("gaia_user", "token", 60, false), "gaia_user=token; Path=/; HttpOnly; SameSite=Lax; Max-Age=60");
  assert.match(cookieHeader("gaia_user", "", 0), /Max-Age=0; Secure$/);
});

test("cookies: localhost HTTP exception; remote and unknown hosts secure by default", () => {
  const previous = process.env.GAIA_SECURE_COOKIES;
  delete process.env.GAIA_SECURE_COOKIES;
  try {
    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) assert.equal(secureCookieForRequest(request(host)), false);
    for (const host of ["gaia.example", "localhost.evil", "192.168.1.2:8787", "", undefined]) assert.equal(secureCookieForRequest(request(host)), true);
  } finally {
    if (previous === undefined) delete process.env.GAIA_SECURE_COOKIES; else process.env.GAIA_SECURE_COOKIES = previous;
  }
});

test("cookies: TLS and forwarded HTTPS override opt-out; forwarded HTTP cannot weaken policy", () => {
  assert.equal(secureCookieForRequest(request("localhost", true), false), true);
  assert.equal(secureCookieForRequest(request("localhost", false, "https"), false), true);
  assert.equal(secureCookieForRequest(request("localhost", false, "https, http"), false), true);
  assert.equal(secureCookieForRequest(request("gaia.example", false, "http"), true), true);
  assert.equal(secureCookieForRequest(request("localhost"), true), true);
  assert.equal(secureCookieForRequest(request("gaia.example"), false), false);
});

test("cookies: GAIA_SECURE_COOKIES controls HTTP policy", () => {
  const previous = process.env.GAIA_SECURE_COOKIES;
  try {
    process.env.GAIA_SECURE_COOKIES = "true";
    assert.equal(secureCookieForRequest(request("localhost")), true);
    process.env.GAIA_SECURE_COOKIES = "false";
    assert.equal(secureCookieForRequest(request("gaia.example")), false);
    assert.equal(secureCookieForRequest(request("gaia.example", true)), true);
  } finally {
    if (previous === undefined) delete process.env.GAIA_SECURE_COOKIES; else process.env.GAIA_SECURE_COOKIES = previous;
  }
});
