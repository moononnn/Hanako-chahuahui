import test from "node:test";
import assert from "node:assert/strict";

import { parseUsersJson, parsePreferencesJson } from "../lib/host-user.js";

test("users.json：取 defaultUserId 那位的名字", () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    defaultUserId: "user_b",
    users: [
      { userId: "user_a", displayName: "甲", username: "a" },
      { userId: "user_b", displayName: "阿舟", username: "moon" },
    ],
  });
  assert.equal(parseUsersJson(raw), "阿舟");
});

test("users.json：认不出 defaultUserId 就退到第一条，总比没名字强", () => {
  const raw = { defaultUserId: "user_missing", users: [{ userId: "user_a", displayName: "甲" }] };
  assert.equal(parseUsersJson(raw), "甲");
});

test("users.json：displayName 空就往下取 username；都没有才算没有", () => {
  assert.equal(parseUsersJson({ users: [{ displayName: "  ", username: "moon" }] }), "moon");
  assert.equal(parseUsersJson({ users: [{ userId: "u1" }] }), "");
  assert.equal(parseUsersJson({ users: [] }), "");
  assert.equal(parseUsersJson("{坏掉的 json"), "");
  assert.equal(parseUsersJson(null), "");
});

test("preferences.json：取 userName，顺带挡掉空字符串", () => {
  assert.equal(parsePreferencesJson('{"userName":"阿舟"}'), "阿舟");
  assert.equal(parsePreferencesJson({ userName: "  " }), "");
  assert.equal(parsePreferencesJson("不是 json"), "");
});
