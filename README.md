# 网页全文翻译助手

一个用自定义 OpenAI 兼容 API 翻译整页的油猴脚本。

API 地址、Key、模型全部由使用者自己填写，脚本不绑定任何服务商。Key 与缓存均保存在本地，不经作者或第三方服务器。

## 安装

1. 安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox / Safari 均支持）或 Violentmonkey。
2. 点击[安装脚本](https://github.com/你的用户名/仓库名/raw/main/wbtf.user.js)。

若使用 Violentmonkey 或其他管理器，请确认已授权 `GM_xmlhttpRequest` 的 `@connect *` 权限，否则请求会被拦截。

## 配置

点击页面右侧的悬浮球 → 翻译设置，填写以下三项：

- **API 接口地址**：需为完整的 `http(s)://` 地址，形如 `https://api.deepseek.com/v1/chat/completions`
- **API Key**：本地模型可留空
- **模型名称**：如 `deepseek-chat`、`gpt-4o-mini`、`glm-4-flash`

填写后点击「测试连接」验证，通过后保存。

常用接口地址：

| 服务商 | 接口地址 | 参考模型 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-4-flash` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1/chat/completions` | `moonshot-v1-8k` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen-turbo` |
| Ollama（本地） | `http://localhost:11434/v1/chat/completions` | `llama3.1:8b` |

one-api、new-api 等中转服务，填入中转地址即可。

## 使用

点击悬浮球，或按 `Alt + T`，开始翻译。

再次按 `Alt + T` 依次进入停止、还原，如此循环。

显示模式有两种，在设置或菜单中切换：

- **双语对照**（默认）：译文追加在原文下方
- **仅译文替换**：隐藏原文，只显示译文

悬浮球可拖拽，位置自动保存。

## 说明

**替换模式不会破坏页面结构。** 多数同类脚本在「仅译文」模式下直接覆盖容器的 `textContent`，会摧毁链接、按钮、图标等子元素。本脚本采用文本节点级改写：单节点直接改写，多节点通过编号标记协议让模型按节点分段回传，逐节点原位写入；标记解析失败时降级为包裹原文 + 追加译文，DOM 结构始终不被改动。

**缓存。** 以「模型 | 目标语言 | 提示词哈希 | 原文」为键存储译文，相同内容不重复请求。换模型或修改翻译指令后旧缓存自动失效，无需手动清理。

**默认排除。** 代码块、输入框、导航栏、页脚、按钮等默认不翻译。需要额外排除的区域（广告、侧边栏等），在「自定义排除选择器」中按行填写 CSS 选择器，`#` 开头的行为注释。

**尊重站点标记。** 页面元素带 `translate="no"` 或 `.notranslate` 时，脚本不会翻译该区域。

**中文排版。** 同一容器内相邻的中文文本不补空格，其他情况补一个空格。

## 常见问题

**提示「网络错误或接口不可达」**

依次检查：接口地址是否完整、Tampermonkey 是否已授权 `@connect` 权限、当前网络能否访问该地址。国内直连 OpenAI 通常不可用，需改用国内服务商或自行处理网络。

**翻译过程中大量失败**

一般为限频所致。将「并发请求数」降至 1–2，或更换模型。若使用付费接口，请确认额度。

**替换模式下页面排版错乱或元素丢失**

正常情况下不会出现。若确实遇到，请在 Issue 中附上页面 URL 与截图，多为该站点 DOM 结构特殊所致，值得单独适配。

**模型返回内容无法解析**

多为模型自身能力问题。建议更换模型（`gpt-4o-mini`、`deepseek-chat`、`glm-4-plus` 较为稳定），或调小「单次请求最大字符数」。

**手机能否使用**

可以。Kiwi Browser、Firefox Mobile 等支持扩展的浏览器安装 Tampermonkey 后即可使用，悬浮球支持触摸拖拽。

## 已知限制

**弱模型大块可能截断。** 单块最多 24 段，主流云端模型稳定；部分小参数模型一次返回 24 项 JSON 时截断概率较高。脚本会自动补发漏项，代价是多一次请求往返。若常用小模型，可将源码中 `CHUNK_MAX_ITEMS` 改为 12。

**懒加载内容需手动触发。** 页面路由变化时脚本会自动还原译文，避免错位；但页面内懒加载的新内容需再次按 `Alt + T` 触发翻译。

## 实现简述

遍历 DOM，将同一容器内的文本节点归组为段落，按字符数与段数上限切块，长块优先发送，并发请求到所配置的 API。返回严格 JSON 数组，双语模式追加译文节点，替换模式按节点原位改写。

替换模式下的多节点合并使用编号标记协议（`<0>…</0><1>…</1>`）。相比嵌套 JSON，编号标记对模型更简单，解析失败时也能安全降级。

## 隐私

API Key 与翻译缓存均存储在本地浏览器。网络请求只发往使用者配置的 API 接口地址。页面内容仅在翻译请求中发送给使用者自己选择的服务商，脚本作者不接触任何数据。

## License

MIT