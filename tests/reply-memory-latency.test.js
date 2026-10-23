import test from "node:test";
import assert from "node:assert/strict";
import { bootChahuahui } from "./helpers/app-harness.js";
import { DAILY_SYSTEM } from "../lib/summarize.js";

const send = (app, text) => app.request("POST", "/turns", { json: { agentId: "nova", watching: true, text } });
const isChat = (entry) => String(entry?.systemPrompt ?? "").includes("茶话会");

test("旧日账不挡第一轮；后台日账未结束时下一轮仍能生成，失败后不逐消息重试", async () => {
  const app = await bootChahuahui({ seed(store) {
    store.setPartnerSettings("nova", { phone: { holding: true, untilMs: Date.now() + 3600000 }, voice: { enabled: false } });
    store.appendMessage("nova", { role: "user", text: "旧日的聊天", at: new Date(Date.now() - 86400000).toISOString() });
    store.appendMessage("nova", { role: "assistant", text: "旧日的回应", at: new Date(Date.now() - 86399000).toISOString() });
  } });
  await send(app, "今天接着聊");
  const first = await app.models.waitForCall(0);
  assert.notEqual(first.request.systemPrompt, DAILY_SYSTEM, "眼前回复前不能先等待旧日账");
  app.models.release(first, "接着说嘛");
  const ledger = await app.models.waitForCallWhere((request) => request.systemPrompt === DAILY_SYSTEM, "后台日账");
  await send(app, "还有一个补充");
  const second = await app.models.waitForCallWhere((request) => request !== first.request && request.systemPrompt !== DAILY_SYSTEM, "下一轮聊天");
  assert.equal(ledger.settled, false, "旧日账仍挂着，聊天却已出站");
  app.models.releaseError(ledger, "APP_MODEL_PROVIDER_ERROR", "provider temporary failure");
  app.models.release(second, "这个也一起说");
  // 后台关系档案等可以正常失败收尾，避免测试把未结束的其它作业误认成日账重试。
  app.models.answer((request) => request.systemPrompt !== DAILY_SYSTEM && !isChat(request), "");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const count = app.models.calls.filter((entry) => entry.request.systemPrompt === DAILY_SYSTEM).length;
  assert.equal(count, 1);
  await send(app, "再补一句");
  const third = await app.models.waitForCallWhere((request) => request !== first.request && request !== second.request && isChat(request), "第三轮聊天");
  app.models.release(third, "听到了");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(app.models.calls.filter((entry) => entry.request.systemPrompt === DAILY_SYSTEM).length, 1);
});
