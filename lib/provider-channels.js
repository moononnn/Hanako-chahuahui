// 模型商（provider）名目。
//
// 同一个模型名可能挂在好几家名下：DeepSeek 的 flash，官方 API 和各家转发的同名模型并存，
// 光看模型名挑不出是哪家，选下去才发现走错了通道。设置页的下拉按厂商分组，组标题就是厂商名；
// 同一家名下有多条通道时，再给每条标上通道名（官方接口 / Coding 套餐 / Token 计划…）。
//
// 抄自知意那套（lib/ask-model.js），两边各存一份：两个应用不共享代码，也不该为这个互相牵。
// 没收录的照 provider 原值显示——自建通道的名字常是中文或自取的，替它猜一个反而认不出。

const PROVIDER_CHANNELS = {
  agnes: ["Agnes", ""],
  anthropic: ["Anthropic", ""],
  baichuan: ["百川", ""],
  "baidu-cloud": ["百度智能云", ""],
  dashscope: ["阿里通义", "官方接口"],
  "dashscope-coding": ["阿里通义", "Coding 套餐"],
  "dashscope-token-plan": ["阿里通义", "Token 计划"],
  deepseek: ["DeepSeek", ""],
  fireworks: ["Fireworks", ""],
  gemini: ["Google Gemini", ""],
  groq: ["Groq", ""],
  hunyuan: ["腾讯混元", ""],
  infini: ["无限智能", ""],
  "kimi-coding": ["Moonshot Kimi", "Coding 套餐"],
  mimo: ["小米 MiMo", "官方接口"],
  "mimo-token-plan": ["小米 MiMo", "Token 计划"],
  minimax: ["MiniMax", "官方接口"],
  "minimax-token-plan": ["MiniMax", "Token 计划"],
  "minimax-voice": ["MiniMax", "语音"],
  mistral: ["Mistral", ""],
  modelscope: ["魔搭社区", ""],
  moonshot: ["Moonshot", ""],
  ollama: ["Ollama", "本机"],
  openai: ["OpenAI", "官方接口"],
  "openai-codex": ["OpenAI", "Codex 通道"],
  "openai-codex-oauth": ["OpenAI", "Codex 通道"],
  "opencode-go": ["OpenCode Go", ""],
  openrouter: ["OpenRouter", ""],
  perplexity: ["Perplexity", ""],
  siliconflow: ["硅基流动", ""],
  stepfun: ["阶跃星辰", ""],
  together: ["Together", ""],
  volcengine: ["火山方舟", "官方接口"],
  "volcengine-coding": ["火山方舟", "Coding 套餐"],
  xai: ["xAI", ""],
  zhipu: ["智谱 GLM", "官方接口"],
  "zhipu-coding": ["智谱 GLM", "Coding 套餐"],
};

// 模型商 + 通道名。厂商名用来分组，通道名用来在同一厂商内部区分是哪条线。
export function providerChannelInfo(provider) {
  const id = String(provider ?? "").trim();
  const hit = PROVIDER_CHANNELS[id];
  if (hit) return { family: hit[0], channel: hit[1], provider: id };
  return { family: id || "其他", channel: "", provider: id };
}
