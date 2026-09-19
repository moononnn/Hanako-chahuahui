import test from "node:test";
import assert from "node:assert/strict";

import { buttonThemeFromSample } from "../ui/assets/background-adaptive.js";

function rgbParts(value) {
  return value.match(/rgb\((\d+), (\d+), (\d+)\)/).slice(1).map(Number);
}

function luminance(rgb) {
  return rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(background, foreground) {
  const light = Math.max(luminance(background), luminance(foreground));
  const dark = Math.min(luminance(background), luminance(foreground));
  return (light + 0.05) / (dark + 0.05);
}

const LIGHT = [255, 253, 248];
const DARK = [41, 76, 59];

test("背景主题同时生成两种有区分的消息气泡颜色", () => {
  const theme = buttonThemeFromSample({ red: 210, green: 235, blue: 220, brightness: 0.84 });
  assert.match(theme.bubbleMeBackground, /^rgb\(/);
  assert.match(theme.bubbleTaBackground, /^rgb\(/);
  assert.notEqual(theme.bubbleMeBackground, theme.bubbleTaBackground);
  assert.notEqual(theme.bubbleMeBorder, theme.bubbleTaBorder);
  assert.equal(theme.bubbleMeForeground, "#294c3b");
  assert.equal(theme.bubbleTaForeground, "#294c3b");
  assert.ok(contrast(rgbParts(theme.bubbleMeBackground), DARK) >= 4.5);
  assert.ok(contrast(rgbParts(theme.bubbleTaBackground), DARK) >= 4.5);
});

test("深色背景的每个气泡都按最终底色选择可读文字", () => {
  for (const sample of [
    { red: 28, green: 54, blue: 46, brightness: 0.17 },
    { red: 0, green: 120, blue: 80, brightness: 0.37 },
    { red: 30, green: 100, blue: 200, brightness: 0.3 },
  ]) {
    const theme = buttonThemeFromSample(sample);
    const meForeground = theme.bubbleMeForeground === "#fffdf8" ? LIGHT : DARK;
    const taForeground = theme.bubbleTaForeground === "#fffdf8" ? LIGHT : DARK;
    assert.ok(contrast(rgbParts(theme.bubbleMeBackground), meForeground) >= 4.5);
    assert.ok(contrast(rgbParts(theme.bubbleTaBackground), taForeground) >= 4.5);
  }
});

test("没有背景样本时不生成自适应主题", () => {
  assert.equal(buttonThemeFromSample(null), null);
  assert.equal(buttonThemeFromSample(undefined), null);
});
