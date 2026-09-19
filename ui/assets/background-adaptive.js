const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function channel(value) { return Math.round(clamp(value, 0, 255)); }
function rgbText(rgb) { return `rgb(${channel(rgb.r)}, ${channel(rgb.g)}, ${channel(rgb.b)})`; }

function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (!delta) return { h: 150, s: 0, l: lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return { h: (hue * 60 + 360) % 360, s: saturation, l: lightness };
}

function hslToRgb({ h, s, l }) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = h / 60;
  const x = chroma * (1 - Math.abs(segment % 2 - 1));
  const match = l - chroma / 2;
  const rgb = segment < 1 ? [chroma, x, 0] : segment < 2 ? [x, chroma, 0] : segment < 3 ? [0, chroma, x] : segment < 4 ? [0, x, chroma] : segment < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return { r: (rgb[0] + match) * 255, g: (rgb[1] + match) * 255, b: (rgb[2] + match) * 255 };
}

function relativeLuminance({ r, g, b }) {
  const linear = (value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(first, second) {
  const light = Math.max(relativeLuminance(first), relativeLuminance(second));
  const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (light + 0.05) / (dark + 0.05);
}

function readableForeground(background) {
  const light = { r: 255, g: 253, b: 248 };
  const dark = { r: 41, g: 76, b: 59 };
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? "#fffdf8" : "#294c3b";
}

/** 在本地取背景主色：图片不上传，也不调用模型。 */
export function analyzeBackgroundUrl(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, 32, 32);
        const pixels = context.getImageData(0, 0, 32, 32).data;
        let weight = 0;
        let red = 0;
        let green = 0;
        let blue = 0;
        let luminance = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3] / 255;
          if (!alpha) continue;
          red += pixels[i] * alpha;
          green += pixels[i + 1] * alpha;
          blue += pixels[i + 2] * alpha;
          luminance += (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) * alpha;
          weight += alpha;
        }
        if (!weight) return resolve(null);
        resolve({
          red: red / weight,
          green: green / weight,
          blue: blue / weight,
          brightness: luminance / weight / 255,
        });
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** 从背景主色生成协调的发送按钮色，同时保证按钮文字可读。 */
export function buttonThemeFromSample(sample) {
  if (!sample) return null;
  const base = { r: sample.red, g: sample.green, b: sample.blue };
  const hue = rgbToHsl(base);
  const darkBackground = sample.brightness < 0.42;
  // 颜色取背景的色相，饱和度单独提亮；不再整体乘系数把颜色压灰。
  const saturation = clamp(Math.max(hue.s * 1.35, 0.58), 0.58, 0.84);
  const lightness = darkBackground ? 0.58 : 0.48;
  const rgb = hslToRgb({ h: hue.h, s: saturation, l: lightness });
  const buttonBrightness = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  // 提示气泡沿用按钮色相，但降低饱和度、抬高明度，和发送按钮同一套背景适配又不撞色。
  const noticeRgb = hslToRgb({
    h: hue.h,
    s: clamp(Math.max(hue.s * 0.72, 0.28), 0.28, 0.52),
    l: darkBackground ? 0.72 : 0.8,
  });
  const bubbleSaturation = clamp(Math.max(hue.s * 0.82, 0.3), 0.3, 0.62);
  const bubbleMe = hslToRgb({ h: hue.h, s: bubbleSaturation, l: darkBackground ? 0.28 : 0.82 });
  const bubbleTa = hslToRgb({ h: (hue.h + 18) % 360, s: bubbleSaturation * 0.82, l: darkBackground ? 0.2 : 0.92 });
  return {
    background: rgbText(rgb),
    foreground: buttonBrightness > 0.62 ? "#294c3b" : "#fffdf8",
    border: rgbText({ r: rgb.r * 0.9, g: rgb.g * 0.9, b: rgb.b * 0.9 }),
    noticeBackground: rgbText(noticeRgb),
    noticeForeground: "#294c3b",
    noticeBorder: rgbText({ r: noticeRgb.r * 0.84, g: noticeRgb.g * 0.84, b: noticeRgb.b * 0.84 }),
    bubbleMeBackground: rgbText(bubbleMe),
    bubbleMeBorder: rgbText(hslToRgb({ h: hue.h, s: bubbleSaturation, l: darkBackground ? 0.36 : 0.74 })),
    bubbleTaBackground: rgbText(bubbleTa),
    bubbleTaBorder: rgbText(hslToRgb({ h: (hue.h + 18) % 360, s: bubbleSaturation * 0.82, l: darkBackground ? 0.3 : 0.84 })),
    bubbleMeForeground: readableForeground(bubbleMe),
    bubbleTaForeground: readableForeground(bubbleTa),
  };
}
