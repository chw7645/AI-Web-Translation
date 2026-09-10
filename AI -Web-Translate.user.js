// ==UserScript==
// @name         AI 网页翻译助手 
// @name:en      Web Page Full Translator (Custom API)
// @namespace    wbtf.custom.api
// @version      1.0.8
// @description  使用自定义 OpenAI 兼容 API 翻译网页全文：可自定义接口地址 / API Key / 模型名，支持悬浮球 + Alt+T 快捷键、双语对照 / 仅译文切换、分段并发、翻译缓存、目标语言与翻译指令自定义，电脑 / 手机双端适配。
// @description:en  Translate entire web pages via any OpenAI-compatible API. Custom endpoint / key / model, bilingual mode, concurrency, cache, floating ball UI.
// @author       WBTF
// @license      MIT
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-end
// @noframes
// ==/UserScript==

/**
 * ============================ 使用前必读 ============================
 * 1. 点击页面右侧悬浮球 -> 「翻译设置」，填写：
 *      - API 接口地址：形如 https://api.openai.com/v1/chat/completions
 *        （DeepSeek / GLM / Kimi / Qwen / Ollama 等 OpenAI 兼容地址均可）
 *      - API Key：本地模型（ollama 等）可留空
 *      - 模型名称：如 gpt-4o-mini / deepseek-chat / glm-4-flash
 * 2. 点「测试连接」确认可用后保存。
 * 3. 悬浮球或 Alt+T 一键翻译；再次按下停止 / 还原。
 * ====================================================================
 */

(function () {
  'use strict';

  /* ==================== 默认配置 ==================== */

  var DEFAULTS = {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4o-mini',
    targetLang: '简体中文',
    mode: 'bilingual',            // bilingual = 双语对照 | replace = 仅译文替换
    concurrency: 3,               // 并发请求数
    chunkSize: 1200,              // 单次请求最大字符数
    timeout: 60,                  // 请求超时（秒）
    customPrompt: '',             // 自定义翻译指令（{{lang}} 占位）
    customExclude: '',            // 自定义排除 CSS 选择器（每行一个）
    skipCode: true,               // 跳过代码块与输入框
    skipUI: true,                 // 跳过导航栏 / 页脚等界面元素
    cacheEnabled: true            // 启用翻译缓存
  };

  // 提示词融合了沉浸式翻译经过大规模验证的质量规则：禁止开场白、保持段落结构、
  // 专有名词与代码保留、标点风格一致（不额外加句号 / 引号），可显著减少模型的坏习惯
  var DEFAULT_PROMPT =
    'You are a professional web page translation engine. Translate every string in the JSON array provided by the user into {{lang}}.\n' +
    'Rules:\n' +
    '1. Return ONLY a valid JSON array. Same number of items, same order. No explanations, no notes (such as "Here is the translation"), no markdown code fences.\n' +
    '2. Preserve original meaning, tone, emoji, numbers, URLs, emails, @mentions, hashtags and inline code. Keep the original punctuation style; do not add or remove trailing punctuation.\n' +
    '3. Keep proper nouns and brand / product names unless they have a well-known official {{lang}} translation. Never wrap any result in quotes.\n' +
    '4. Never merge, split, add or drop items. If an item is already in {{lang}}, return it unchanged.';

  // 标记协议附加规则：仅当请求串中真的含有 <数字> 标记时才追加到系统指令
  var MARK_RULE =
    '5. Some strings contain numbered inline markers like <0>text</0> <1>text</1>. '
    + 'They are structural placeholders split from one paragraph: keep every marker EXACTLY in place '
    + '(same count, same order). Translate only the readable text inside and between markers; '
    + 'never drop, merge, renumber or invent markers.';

  var COMMON_MODELS = [
    'gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini',
    'deepseek-chat', 'deepseek-reasoner',
    'glm-4-flash', 'glm-4.5-flash', 'glm-4-plus',
    'qwen-turbo', 'qwen-plus', 'qwen-flash',
    'moonshot-v1-8k', 'kimi-k2-0711-preview',
    'gemini-2.0-flash', 'claude-3-5-haiku-20241022',
    'llama3.1:8b', 'qwen2.5:7b'
  ];

  var LANGS = [
    '简体中文', '繁體中文', 'English', '日本語', '한국어',
    'Français', 'Deutsch', 'Español', 'Português', 'Русский',
    'Italiano', 'Tiếng Việt', 'ไทย', 'العربية', 'Bahasa Indonesia'
  ];

  /* ==================== 存储封装（GM 优先，localStorage 兜底） ==================== */

  function gsGet(key, defVal) {
    try {
      var raw = null;
      if (typeof GM_getValue === 'function') {
        raw = GM_getValue(key);
      } else {
        raw = localStorage.getItem(key);
      }
      if (raw === null || raw === undefined) return defVal;
      if (typeof raw === 'object') return raw; // 部分管理器直接返回对象
      return JSON.parse(raw);
    } catch (e) {
      return defVal;
    }
  }

  function gsSet(key, val) {
    try {
      var s = JSON.stringify(val);
      if (typeof GM_setValue === 'function') GM_setValue(key, s);
      else localStorage.setItem(key, s);
    } catch (e) { /* 存储失败不影响主流程 */ }
  }

  function loadSettings() {
    var saved = gsGet('wbtf_settings', {});
    var s = {};
    for (var k in DEFAULTS) s[k] = (saved[k] !== undefined ? saved[k] : DEFAULTS[k]);
    return s;
  }

  /* ==================== 运行状态 ==================== */

  var settings = loadSettings();

  var records = [];        // 已翻译记录 [{host, mode}]
  var running = false;     // 是否翻译中
  var abortFns = [];       // 可中断请求句柄
  var queue = [];          // 待处理分块队列
  var total = 0;           // 本轮总段数
  var doneCount = 0;       // 已处理段数
  var failCount = 0;       // 失败段数
  var cacheHitCount = 0;   // 缓存命中段数
  var lastErrMsg = '';

  var cacheObj = gsGet('wbtf_cache', {}) || {};
  if (typeof cacheObj !== 'object') cacheObj = {};

  /* ==================== 小工具 ==================== */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // djb2 变体哈希：用于缓存键（53 位，碰撞率极低）
  function cyrb53(str, seed) {
    seed = seed || 0;
    var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed, ch;
    for (var i = 0; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // 拼接同一容器内的多段文本：中文（含全角标点）相邻不加空格，否则补一个空格
  function smartJoin(parts) {
    var out = '';
    var CJK = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF\u3000-\u303F\uFF00-\uFFEF]/;
    for (var i = 0; i < parts.length; i++) {
      var s = String(parts[i]).replace(/\s+/g, ' ').trim();
      if (!s) continue;
      if (!out) { out = s; continue; }
      var a = out.charAt(out.length - 1);
      var b = s.charAt(0);
      out += (CJK.test(a) && CJK.test(b)) ? s : (' ' + s);
    }
    return out.trim();
  }

  // 是否包含可翻译文字（排除纯数字 / 标点 / 符号）
  var RE_HAS_LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
  function hasTranslatable(t) { return RE_HAS_LETTER.test(t); }

  // 非 ASCII 字母（带变音符的拉丁字母 / 希腊 / 西里尔 / 阿拉伯 / 天城文 / 假名 / 汉字 / 谚文）
  var RE_NON_ASCII_LETTER = /[\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;

  // 英语常用功能词表：供「目标语言=英语」的已译判定使用
  var EN_STOP = {
    the: 1, and: 1, of: 1, to: 1, in: 1, is: 1, are: 1, was: 1, were: 1, that: 1,
    it: 1, for: 1, on: 1, with: 1, as: 1, at: 1, by: 1, from: 1, this: 1, be: 1,
    or: 1, an: 1, has: 1, have: 1, had: 1, not: 1, but: 1, they: 1, we: 1, you: 1,
    he: 1, she: 1, his: 1, her: 1, its: 1, their: 1, our: 1, your: 1, my: 1,
    what: 1, which: 1, who: 1, when: 1, where: 1, how: 1, why: 1, can: 1, will: 1,
    would: 1, should: 1, may: 1, might: 1, must: 1, do: 1, does: 1, did: 1,
    than: 1, then: 1, so: 1, if: 1, into: 1, about: 1, over: 1, after: 1,
    before: 1, more: 1, most: 1, other: 1, such: 1, only: 1, also: 1, just: 1,
    now: 1, here: 1, there: 1, all: 1, any: 1, each: 1
  };

  // 判断文本是否已经基本是目标语言（避免浪费 token）
  function isMostlyTargetLang(t) {
    var lang = String(settings.targetLang || '');
    var cjkCount = (t.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g) || []).length;
    var jpCount = (t.match(/[\u3040-\u30FF]/g) || []).length;
    var krCount = (t.match(/[\uAC00-\uD7AF]/g) || []).length;
    var enWords = (t.match(/[A-Za-z]+/g) || []).length;
    if (/zh|中|Chinese/i.test(lang)) {
      return cjkCount > 0 && cjkCount >= enWords * 1.5;
    }
    if (/ja|日|Japanese/i.test(lang)) {
      return (cjkCount + jpCount) > 0 && (cjkCount + jpCount) >= enWords * 1.5 && jpCount > 0;
    }
    if (/ko|韩|朝|Korean/i.test(lang)) {
      return krCount > 0 && krCount >= enWords * 1.5;
    }
    if (/en|英|English/i.test(lang)) {
      // 已是英语判定（保守策略）：含任何非 ASCII 字母（变音符 / 其他文字）直接不算，
      // 至少 4 个单词且命中 ≥3 个不同英语功能词才跳过，避免把法语 / 德语等误判为英语
      if (RE_NON_ASCII_LETTER.test(t)) return false;
      var words = t.toLowerCase().match(/[a-z]+/g) || [];
      if (words.length < 4) return false;
      var distinct = {}, hit = 0;
      for (var w2 = 0; w2 < words.length; w2++) {
        var wd = words[w2];
        if (EN_STOP[wd] && !distinct[wd]) { distinct[wd] = 1; if (++hit >= 3) return true; }
      }
      return false;
    }
    return false;
  }

  // 从模型返回文本中稳健地解析出 JSON 数组
  function parseArray(s) {
    try {
      if (typeof s !== 'string' || !s) return null;
      s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');   // 剥离思考标签
      s = s.trim();
      s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim(); // 剥离代码围栏
      var i = s.indexOf('['), j = s.lastIndexOf(']');
      if (i < 0 || j <= i) return null;
      var arr = JSON.parse(s.slice(i, j + 1));
      if (!Array.isArray(arr)) return null;
      return arr.map(function (x) { return x === null || x === undefined ? '' : String(x); });
    } catch (e) {
      return null;
    }
  }

  function clampNum(v, min, max, def) {
    v = Number(v);
    if (!isFinite(v)) v = def;
    return Math.max(min, Math.min(max, Math.round(v)));
  }

  // 解析带数字标记的译文："<0>A</0><1>B</1>" → ['A','B']
  // 校验失败（缺标记 / 出现未知高位标记）返回 null，由调用方降级处理，绝不破坏页面
  function parseMarked(s, count) {
    try {
      if (typeof s !== 'string' || !s || count < 1) return null;
      var re = /<(\d{1,3})>([\s\S]*?)<\/\1>/g;
      var frags = new Array(count), seen = {}, m, found = 0;
      var lastEnd = 0, prev = -1;
      while ((m = re.exec(s)) !== null) {
        var idx = parseInt(m[1], 10);
        if (idx >= count) return null;                     // 未知标记 → 失败
        var between = s.slice(lastEnd, m.index);
        if (prev >= 0 && /\S/.test(between)) frags[prev] += between; // 标记外正文并入前段
        if (!(idx in seen)) { seen[idx] = true; frags[idx] = m[2]; found++; }
        else { frags[idx] += m[2]; }                       // 同标记重复出现：拼接
        prev = idx; lastEnd = re.lastIndex;
      }
      var tail = s.slice(lastEnd);
      if (prev >= 0 && /\S/.test(tail)) frags[prev] += tail;
      if (found < count) return null;                      // 缺标记 → 失败
      for (var i = 0; i < count; i++) {
        frags[i] = String(frags[i] === undefined ? '' : frags[i]).trim();
      }
      return frags;
    } catch (e) { return null; }
  }

  // 替换模式的标记化请求构造：把同一容器内的多个文本节点编为 <0>..</0><1>..</1>
  // 返回 { req, mnodes }；不适合标记时返回 null（原文自带 <数字> 形态 / 可用节点不足）
  function buildMarkedReq(vals) {
    try {
      if (!vals || vals.length < 2 || vals.length > 24) return null;
      var parts = [], ms = [];
      for (var i = 0; i < vals.length; i++) {
        var s = String((vals[i] && vals[i].nodeValue) || '').replace(/\s+/g, ' ').trim();
        if (!s) continue;
        if (/<\d{1,3}>/.test(s)) return null; // 避免与源文冲突
        parts.push(s); ms.push(vals[i]);
      }
      if (parts.length < 2) return null;
      var mk = '';
      for (var j = 0; j < parts.length; j++) mk += '<' + j + '>' + parts[j] + '</' + j + '>';
      return { req: mk, mnodes: ms };
    } catch (e) { return null; }
  }

  // 保留原节点首尾空白形态，避免破坏行内排版间距
  function adaptWS(orig, frag) {
    var lead = (/^\s*/.exec(orig) || [''])[0];
    var trail = (/\s*$/.exec(orig) || [''])[0];
    return lead + frag + trail;
  }

  // 目标语言对应的 lang / dir 属性（借鉴沉浸式翻译）：译文标注书写方向，
  // 阿拉伯语等 RTL 目标语言不再被强制从左往右显示
  function targetLangAttrs() {
    var l = String(settings.targetLang || '');
    if (!l) return { lang: '', dir: '' };
    if (/阿拉伯|العربية|Arabic/i.test(l)) return { lang: 'ar', dir: 'rtl' };
    if (/简体/.test(l)) return { lang: 'zh-CN', dir: '' };
    if (/繁體|繁体/.test(l)) return { lang: 'zh-TW', dir: '' };
    if (/english|英语|英文|^en(\b|-)/i.test(l)) return { lang: 'en', dir: '' };
    if (/日本|japanese/i.test(l)) return { lang: 'ja', dir: '' };
    if (/한국|韩|朝鲜|korean/i.test(l)) return { lang: 'ko', dir: '' };
    if (/français|法语|法文/i.test(l)) return { lang: 'fr', dir: '' };
    if (/deutsch|德语|德文/i.test(l)) return { lang: 'de', dir: '' };
    if (/español|西班牙/i.test(l)) return { lang: 'es', dir: '' };
    if (/português|葡萄牙/i.test(l)) return { lang: 'pt', dir: '' };
    if (/русский|俄语|俄文/i.test(l)) return { lang: 'ru', dir: '' };
    if (/italiano|意大利/i.test(l)) return { lang: 'it', dir: '' };
    if (/việt|越南/i.test(l)) return { lang: 'vi', dir: '' };
    if (/ไทย|泰语|泰文/i.test(l)) return { lang: 'th', dir: '' };
    if (/indonesia|印尼/i.test(l)) return { lang: 'id', dir: '' };
    return { lang: '', dir: '' };
  }

  // 同批请求去重：相同文本只翻译一次、结果按映射回填，重复标签（如列表里的 Read more）
  // 不再重复消耗 token（参考沉浸式翻译的按文本去重批处理思路）
  function uniqueWithMap(texts) {
    var uniq = [], map = new Array(texts.length), seen = new Map();
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i], k = seen.get(t);
      if (k === undefined) { k = uniq.length; seen.set(t, k); uniq.push(t); }
      map[i] = k;
    }
    return { uniq: uniq, map: map };
  }

  /* ==================== 翻译缓存 ==================== */

  // 实际生效的提示词（自定义或内置默认）参与缓存键：改了翻译指令后旧缓存自然失效，
  // 不会出现「改了指令却仍命中旧译文」的困惑；内置提示词升级时同样自动失效。
  // 注意：换键会使既有缓存整体失效一次（一次性重译），属预期行为。
  // 提示词哈希做记忆化：缓存命中热路径上每一段都要算一次键，几百段页面对长指令
  // 重复哈希纯属浪费；memo 按源串精确匹配，指令源变化时自动重算，不会返回过期值
  var _promptKeySrc = null, _promptKeyCache = null;
  function activePromptKey() {
    var p = (settings.customPrompt && settings.customPrompt.trim()) ? settings.customPrompt.trim() : DEFAULT_PROMPT;
    if (p !== _promptKeySrc) { _promptKeySrc = p; _promptKeyCache = cyrb53(p); }
    return _promptKeyCache;
  }

  function cacheKeyOf(text) {
    return 'c' + cyrb53(String(settings.model) + '|' + String(settings.targetLang) + '|' + activePromptKey() + '|' + text);
  }
  function cacheGet(text) {
    if (!settings.cacheEnabled) return null;
    try {
      var k = cacheKeyOf(text);
      var v = cacheObj[k];
      if (v === undefined || v === null) return null;
      // LRU 触碰：命中即把词条移到最新位置，热门旧词条不会被裁剪丢弃
      delete cacheObj[k];
      cacheObj[k] = v;
      return String(v);
    } catch (e) { return null; }
  }
  function cachePut(text, val) {
    try {
      var k = cacheKeyOf(text);
      delete cacheObj[k];       // 重新写入也刷新位置（新译文视为最热）
      cacheObj[k] = String(val);
    } catch (e) { }
  }
  function saveCache() {
    try {
      var keys = Object.keys(cacheObj);
      if (keys.length > 900) {
        var drop = keys.slice(0, keys.length - 800); // 超限后按最近使用顺序保留 800 条（LRU）
        for (var i = 0; i < drop.length; i++) delete cacheObj[drop[i]];
      }
      gsSet('wbtf_cache', cacheObj);
    } catch (e) { }
  }

  /* ==================== 文本收集 ==================== */

  var INLINE_TAGS = {
    A: 1, SPAN: 1, STRONG: 1, EM: 1, B: 1, I: 1, U: 1, S: 1, SMALL: 1,
    SUP: 1, SUB: 1, MARK: 1, CODE: 1, KBD: 1, SAMP: 1, VAR: 1, CITE: 1,
    Q: 1, ABBR: 1, DFN: 1, TIME: 1, BDI: 1, BDO: 1, RUBY: 1, RT: 1, RP: 1,
    LABEL: 1, FONT: 1, BIG: 1, TT: 1, WBR: 1, DEL: 1, INS: 1, NOBR: 1, ACRONYM: 1
  };

  function isInlineEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (INLINE_TAGS[el.tagName]) return true;
    try { return getComputedStyle(el).display === 'inline'; } catch (e) { return false; }
  }

  function isVisible(el) {
    try {
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
      }
      return el.getClientRects().length > 0;
    } catch (e) { return true; }
  }

  // 构建排除选择器组合
  function buildExcludeSelector() {
    // 尊重站点自身的翻译限制标记（.notranslate / translate="no"，与沉浸式翻译一致）；
    // 用 :not(html):not(body) 防止个别站点把标记写在根节点导致整页拒绝翻译
    var base = '.wbtf-tr, .wbtf-tr-full, .wbtf-orig, script, style, noscript, template, iframe, svg, canvas, math, object, embed, [aria-hidden="true"], [hidden], '
      + '[translate="no"]:not(html):not(body), .notranslate:not(html):not(body)';
    if (settings.skipCode) {
      base += ', pre, code, kbd, samp, textarea, input, select, option, optgroup, [contenteditable]';
    }
    if (settings.skipUI) {
      base += ', nav, aside, button, [role="navigation"], [role="banner"], [role="contentinfo"], [role="button"], menu';
    }
    return base;
  }

  // header / footer 若位于 article 或 main 内，视为正文标题 / 脚注，应翻译
  function inExcludedUI(el) {
    var hf = el.closest('header,footer');
    return !!(hf && !hf.closest('article,main,[role="main"]'));
  }

  function matchCustomExclude(el) {
    var lines = String(settings.customExclude || '').split(/\n+/);
    for (var i = 0; i < lines.length; i++) {
      var sel = lines[i].trim();
      if (!sel || sel.charAt(0) === '#') continue; // 支持 # 注释
      try { if (el.closest(sel)) return true; } catch (e) { /* 无效选择器忽略 */ }
    }
    return false;
  }

  // 收集需要翻译的段落 [{host, text}]
  function collectTargets() {
    var combined = buildExcludeSelector();
    var hostMap = new Map();
    var walker, node;

    try {
      walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var v = n.nodeValue;
          if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
          var p = n.parentElement;
          if (!p || !p.closest) return NodeFilter.FILTER_REJECT;
          try {
            if (p.closest(combined)) return NodeFilter.FILTER_REJECT;
            if (settings.skipUI && inExcludedUI(p)) return NodeFilter.FILTER_REJECT;
            if (matchCustomExclude(p)) return NodeFilter.FILTER_REJECT;
          } catch (e) { return NodeFilter.FILTER_REJECT; }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      while ((node = walker.nextNode())) {
        var p = node.parentElement;
        var host = p, guard = 0;
        while (host && isInlineEl(host) && guard++ < 25) host = host.parentElement;
        if (!host || host.nodeType !== 1) continue;
        try {
          if (host.closest(combined)) continue;
          if (settings.skipUI && inExcludedUI(host)) continue;
          if (matchCustomExclude(host)) continue;
        } catch (e) { continue; }
        if (host.getAttribute('data-wbtf-done') === '1') continue;
        var arr = hostMap.get(host);
        if (!arr) { arr = []; hostMap.set(host, arr); }
        arr.push(node); // 保存文本节点引用，替换模式需按节点无损改写
      }
    } catch (e) {
      return [];
    }

    var targets = [];
    hostMap.forEach(function (vals, host) {
      if (host.getAttribute('data-wbtf-done') === '1') return;
      var text = smartJoin(vals.map(function (n) { return n.nodeValue; }));
      if (!text || text.length < 2) return;
      if (!hasTranslatable(text)) return;
      if (isMostlyTargetLang(text)) return;
      if (!isVisible(host)) return;
      var entry = { host: host, text: text, nodes: vals, req: text, mnodes: null };
      // 替换模式 + 多文本节点 → 标记协议：让模型按节点分段回传，
      // 渲染时逐节点原位改写，彻底保留链接 / 徽章 / 图标等子元素结构
      if (settings.mode === 'replace') {
        var mk = buildMarkedReq(vals);
        if (mk) { entry.req = mk.req; entry.mnodes = mk.mnodes; }
      }
      targets.push(entry);
    });
    return targets;
  }

  /* ==================== 分块 ==================== */

  // 单块段数上限：短文本（按钮 / 标签 / 菜单项）为主的页面按段数封顶，
  // 24 段比旧值 12 减少近一半请求；长文本仍由 chunkSize 字符上限控制。
  // 截断风险如实说明：主流云端模型（gpt-4o / deepseek-chat 等）单次返回 24 项很稳；
  // 部分本地小参数 / 弱模型返回 24 项 JSON 时截断概率更高——截断不丢内容
  // （漏项补发兜底，补发仍失败则该段保留原文），但会多一次补发往返、该段上屏变慢；
  // 常用弱模型的用户可把下方 CHUNK_MAX_ITEMS 手动改小到 12
  var CHUNK_MAX_ITEMS = 24;

  function makeChunks(targets) {
    var max = clampNum(settings.chunkSize, 200, 6000, 1200);
    var chunks = [], cur = [], len = 0;
    for (var i = 0; i < targets.length; i++) {
      var L = (targets[i].req || targets[i].text).length;
      if (cur.length && (len + L > max || cur.length >= CHUNK_MAX_ITEMS)) {
        chunks.push({ items: cur, len: len });
        cur = []; len = 0;
      }
      cur.push(targets[i]);
      len += L;
    }
    if (cur.length) chunks.push({ items: cur, len: len });
    // LPT 调度：耗时长的块先发。worker 数固定时，让大块占据并发窗口、
    // 小块收尾，整页翻译总耗时明显缩短；译文内容与顺序无关，质量零影响
    chunks.sort(function (a, b) { return b.len - a.len; });
    return chunks;
  }

  /* ==================== 翻译请求 ==================== */

  function buildSystemPrompt() {
    var p = (settings.customPrompt && settings.customPrompt.trim())
      ? settings.customPrompt.trim()
      : DEFAULT_PROMPT;
    var lang = settings.targetLang || '简体中文';
    return p.split('{{lang}}').join(lang).split('{{target}}').join(lang);
  }

  function requestHeaders() {
    var h = { 'Content-Type': 'application/json' };
    if (settings.apiKey) h['Authorization'] = 'Bearer ' + settings.apiKey;
    return h;
  }

  // 请求终结（成功 / 失败 / 超时）后把句柄从 abortFns 移除，避免长会话下数组无限增长
  function settleAbort(en) {
    var ix = abortFns.indexOf(en);
    if (ix >= 0) abortFns.splice(ix, 1);
  }

  // 发送一次翻译请求：texts(string[]) -> Promise<string[]>
  // cold = 重试请求：temperature 降为 0（更确定性地输出 JSON，减少二次失败）
  function requestTranslate(texts, cold) {
    var sys = buildSystemPrompt();
    // 请求串中真的含有 <数字> 标记时，附加标记保留规则（协议关键，自定义指令也不例外）
    for (var mi = 0; mi < texts.length; mi++) {
      if (/<\d{1,3}>/.test(texts[mi])) { sys += '\n' + MARK_RULE; break; }
    }
    var body = {
      model: settings.model || 'gpt-4o-mini',
      temperature: cold ? 0 : 0.2,
      stream: false,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: JSON.stringify(texts) }
      ]
    };

    return new Promise(function (resolve, reject) {
      var attempt = 0;

      function send(b) {
        if (!running) { reject(new Error('已中断')); return; }
        var aborted = false;
        var entry = { abort: function () { aborted = true; try { rq && rq.abort && rq.abort(); } catch (e) { } } };
        var rq = GM_xmlhttpRequest({
          method: 'POST',
          url: settings.apiUrl,
          headers: requestHeaders(),
          data: JSON.stringify(b),
          timeout: clampNum(settings.timeout, 5, 600, 60) * 1000,
          onload: function (r) {
            settleAbort(entry);
            if (aborted) return;
            try {
              if (r.status >= 200 && r.status < 300) {
                var j = JSON.parse(r.responseText);
                var c = '';
                if (j && j.choices && j.choices[0]) {
                  if (j.choices[0].message) c = j.choices[0].message.content || '';
                  else if (j.choices[0].text) c = j.choices[0].text;
                }
                var arr = parseArray(c);
                if (arr) resolve(arr);
                else reject(new Error('模型返回内容无法解析为 JSON 数组（可在指令中强调只输出 JSON）'));
              } else if (r.status === 400 && attempt === 0 && /temperature/i.test(r.responseText || '')) {
                // 个别模型不支持 temperature 参数，去掉后重发一次
                attempt = 1;
                var b2 = {};
                for (var k in b) if (k !== 'temperature') b2[k] = b[k];
                send(b2);
              } else {
                var detail = '';
                try {
                  var ej = JSON.parse(r.responseText);
                  detail = (ej.error && (ej.error.message || ej.error.code)) || ej.message || '';
                } catch (e) { }
                if (!detail && r.responseText) detail = r.responseText.slice(0, 120);
                reject(new Error('HTTP ' + r.status + (detail ? ('：' + detail) : '')));
              }
            } catch (e) { reject(e); }
          },
          onerror: function () { settleAbort(entry); if (!aborted) reject(new Error('网络错误或接口不可达（检查地址 / 网络 / 脚本跨域授权）')); },
          ontimeout: function () { settleAbort(entry); if (!aborted) reject(new Error('请求超时（可在设置中加大超时秒数）')); }
        });

        abortFns.push(entry);   // 终结时由 settleAbort 移除，防止数组只增不减
      }

      send(body);
    });
  }

  /* ==================== 处理单个分块（含缓存合并） ==================== */

  async function processChunk(chunk) {
    var items = chunk.items;
    var results = new Array(items.length).fill(null);
    var rendered = new Array(items.length).fill(false);
    var pending = [];
    var mayMark = false;   // 本块是否含标记协议段（用于渲染时剥壳容错）

    for (var i = 0; i < items.length; i++) {
      if (items[i].mnodes) mayMark = true;
      var hit = cacheGet(items[i].req);
      if (hit !== null) {
        results[i] = hit;
        cacheHitCount++;
        doneCount++;
        // 缓存段立即上屏：零等待，不必等同块的网络请求返回
        rendered[i] = true;
        renderTranslation(items[i].host, hit, items[i].nodes, items[i].mnodes, mayMark);
      } else {
        pending.push(i);
      }
    }
    updateProgress();

    if (pending.length) {
      if (!running) return;
      // 同块内相同文本只发一次、结果按映射回填（省 token）
      var texts = pending.map(function (i) { return items[i].req; });
      var dd = uniqueWithMap(texts);
      var out = null, err = null;

      for (var a = 0; a < 2; a++) {          // 失败自动重试 1 次（429 限频时退避更久）
        if (!running) return;
        try { out = await requestTranslate(dd.uniq, a > 0); err = null; break; } // 重试降温：temperature 0 提高 JSON 复现率
        catch (e) { err = e; if (a === 0) await sleep(/429|rate/i.test(String(e && e.message)) ? 1600 : 700); }
      }
      if (!running) return;

      if (out) {
        var got = new Array(dd.uniq.length).fill(null);
        var miss = [];
        for (var u = 0; u < dd.uniq.length; u++) {
          var v = (u < out.length && typeof out[u] === 'string') ? out[u] : '';
          if (v.length) got[u] = v;
          else miss.push(u);
        }
        // 漏项补发：大块被模型截断时只补译缺失的段，最多补一次，提高成功率
        if (miss.length && miss.length < dd.uniq.length && running) {
          try {
            var out2 = await requestTranslate(miss.map(function (u) { return dd.uniq[u]; }));
            for (var m2 = 0; m2 < miss.length; m2++) {
              var v2 = (m2 < out2.length && typeof out2[m2] === 'string') ? out2[m2] : '';
              if (v2.length) got[miss[m2]] = v2;
            }
          } catch (e2) { /* 补发失败按原结果计，不追加整体错误 */ }
          if (!running) return;   // 补发期间被停止：丢弃本轮，不再渲染
        }

        for (var k = 0; k < pending.length; k++) {
          var idx = pending[k];
          var g = got[dd.map[k]];
          if (g === null) {
            failCount++;
          } else if (g !== items[idx].req) {
            results[idx] = g;
            if (settings.cacheEnabled) cachePut(items[idx].req, g);
          } else {
            results[idx] = g; // 模型原样返回（已是目标语言），不写缓存
          }
          doneCount++;
        }
      } else {
        failCount += pending.length;
        doneCount += pending.length;
        lastErrMsg = (err && err.message) ? err.message : String(err);
        updateProgress();
        throw (err || new Error('翻译请求失败'));
      }
    }

    updateProgress();
    for (var m = 0; m < items.length; m++) {
      if (results[m] && !rendered[m]) renderTranslation(items[m].host, results[m], items[m].nodes, items[m].mnodes, mayMark);
    }
  }

  /* ==================== 并发调度 ==================== */

  async function translateAll() {
    if (running) return;
    if (!settings.apiUrl || !/^https?:\/\//i.test(settings.apiUrl)) {
      if (overlay) openSettings();
      toast('请先在设置中填写正确的 API 接口地址');
      return;
    }

    var targets;
    try { targets = collectTargets(); }
    catch (e) { toast('收集页面文本失败：' + e.message, 4000); return; }

    if (!targets.length) {
      toast('没有发现需要翻译的新内容（或页面已是目标语言）');
      return;
    }

    running = true;
    abortFns = [];
    failCount = 0; cacheHitCount = 0; lastErrMsg = '';
    total = targets.length; doneCount = 0;
    updateProgress();

    queue = makeChunks(targets);
    var t0 = Date.now();
    var n = clampNum(settings.concurrency, 1, 10, 3);
    var workers = [];
    for (var i = 0; i < n; i++) workers.push(workerLoop());

    try { await Promise.all(workers); }
    catch (e) { toast('翻译过程出现异常：' + ((e && e.message) || e), 4200); }

    var usedSec = Math.round((Date.now() - t0) / 1000);
    running = false;
    abortFns = [];
    queue = [];
    updateBallIdle();
    saveCache();

    var msg = '翻译完成：' + doneCount + ' 段 · 耗时 ' + usedSec + ' 秒';
    if (cacheHitCount) msg += ' · 缓存命中 ' + cacheHitCount;
    if (failCount) msg += ' · 失败 ' + failCount + ' 段';
    if (failCount && lastErrMsg) msg += '\n最后错误：' + lastErrMsg;
    toast(msg, failCount ? 6000 : 3600);
  }

  async function workerLoop() {
    while (running && queue.length) {
      var chunk = queue.shift();
      try {
        await processChunk(chunk);
      } catch (e) {
        // 失败段已在 processChunk 内计数，继续处理下一块
      }
    }
  }

  function stopAll(silent) {
    var wasRunning = running;
    running = false;
    abortFns.forEach(function (f) { try { f.abort(); } catch (e) { } });
    abortFns = [];
    queue = [];
    updateBallIdle();
    saveCache();
    if (!silent && wasRunning) toast('已停止翻译');
  }

  /* ==================== 渲染与还原 ==================== */

  // 渲染译文。替换模式禁止容器级 textContent 覆盖（会摧毁容器内链接/徽章/图标，
  // 并与 SPA 框架冲突导致页面空白），全部为文本节点级操作：
  //   - 单存活节点：直接改写 nodeValue，零结构改动
  //   - 多节点 + 标记译文：逐节点原位写入各自片段（借鉴沉浸式翻译 in-place mapping）
  //   - 标记缺失/解析失败：降级为包裹隐藏原文 + 追加整段译文，结构依旧不动
  function renderTranslation(host, text, nodes, mnodes, mayMark) {
    try {
      host.setAttribute('data-wbtf-done', '1');
      var la = targetLangAttrs();   // 译文 lang / dir（RTL 目标语言正确显示）
      if (mayMark) {
        // 模型对无标记串幻觉出单标记时剥壳，避免把 <0> 显示到页面上
        var f1 = parseMarked(text, 1);
        if (f1) text = f1[0];
      }
      if (settings.mode === 'replace') {
        nodes = nodes || [];
        var live = [];
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].parentNode) live.push(nodes[i]);
        }

        var mapped = false;
        if (live.length === 1) {
          var orig = live[0].nodeValue;
          live[0].nodeValue = text;
          records.push({ host: host, mode: 'replace-node', node: live[0], orig: orig, trans: text });
          mapped = true;
        } else if (live.length > 1 && mnodes && mnodes.length > 1) {
          // 多节点原位映射：仅改写文本节点值，任何元素都不动
          var frags = parseMarked(text, mnodes.length);
          if (frags) {
            var items = [];
            for (var k = 0; k < mnodes.length; k++) {
              var nd = mnodes[k];
              if (!nd.parentNode) continue;      // 已被页面卸载
              var fg = frags[k];
              if (!fg) continue;                 // 空片段：保留原文（链接文字保护）
              var o2 = nd.nodeValue || '';
              var nv = adaptWS(o2, fg);
              if (nv === o2) continue;
              nd.nodeValue = nv;
              items.push({ node: nd, orig: o2, trans: nv });
            }
            if (items.length) {
              records.push({ host: host, mode: 'replace-map', items: items });
              mapped = true;
            }
          }
        }

        if (!mapped) {
          // 降级路径：多节点无标记 / 标记解析失败 / 全部节点已卸载
          var tr = document.createElement('span');
          tr.className = 'wbtf-tr-full';
          tr.setAttribute('translate', 'no');
          if (la.lang) tr.setAttribute('lang', la.lang);
          if (la.dir) tr.setAttribute('dir', la.dir);
          tr.textContent = text;
          var wrapped = [];
          for (var j = 0; j < live.length; j++) {
            var n = live[j];
            var w = document.createElement('span');
            w.className = 'wbtf-orig';
            n.parentNode.insertBefore(w, n);
            w.appendChild(n);
            wrapped.push({ node: n, wrapper: w });
          }
          host.appendChild(tr);
          records.push({ host: host, mode: 'replace-wrap', tr: tr, wrapped: wrapped });
        }
      } else {
        var tr2 = document.createElement('span');
        tr2.className = 'wbtf-tr';
        tr2.setAttribute('translate', 'no');
        if (la.lang) tr2.setAttribute('lang', la.lang);
        if (la.dir) tr2.setAttribute('dir', la.dir);
        tr2.textContent = text;
        host.appendChild(tr2);
        records.push({ host: host, mode: 'bilingual' });
      }
    } catch (e) { /* 个别节点渲染失败不影响整体 */ }
  }

  function restoreAll(silent) {
    var cnt = 0;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      try {
        if (r.mode === 'replace-node') {
          // 仅当节点仍是我们写入的译文时才回写原文（页面若已自行修改则不覆盖）
          if (r.node.nodeValue === r.trans) { r.node.nodeValue = r.orig; cnt++; }
        } else if (r.mode === 'replace-map') {
          for (var j2 = 0; j2 < r.items.length; j2++) {
            var it = r.items[j2];
            try {
              if (it.node.nodeValue === it.trans) { it.node.nodeValue = it.orig; cnt++; }
            } catch (e3) { }
          }
        } else if (r.mode === 'replace-wrap') {
          for (var j = 0; j < r.wrapped.length; j++) {
            var p = r.wrapped[j];
            try {
              if (p.wrapper.parentNode) p.wrapper.parentNode.replaceChild(p.node, p.wrapper);
            } catch (e2) { }
          }
          if (r.tr && r.tr.parentNode) r.tr.parentNode.removeChild(r.tr);
          cnt++;
        } else {
          var trs = r.host.querySelectorAll('.wbtf-tr');
          for (var k = 0; k < trs.length; k++) {
            if (trs[k].parentNode) trs[k].parentNode.removeChild(trs[k]);
          }
          if (trs.length) cnt += trs.length;
        }
        r.host.removeAttribute('data-wbtf-done');
      } catch (e) { /* 节点可能已被页面卸载 */ }
    }
    records = [];
    if (!silent) toast(cnt ? ('已还原 ' + cnt + ' 段译文') : '当前页面没有译文');
  }

  /* ==================== UI：样式（Shadow DOM 内，与页面完全隔离） ==================== */

  var UI_CSS = [
    '*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif;}',
    '#wbtf-ball{position:fixed;width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#4f8cff,#3565e8);color:#fff;display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:700;box-shadow:0 3px 14px rgba(53,101,232,.45);cursor:pointer;pointer-events:auto;user-select:none;-webkit-user-select:none;touch-action:none;z-index:1;opacity:.88;transition:transform .18s ease,opacity .18s ease;}',
    '#wbtf-ball:hover{transform:scale(1.07);opacity:1;}',
    '#wbtf-ball.running{background:linear-gradient(135deg,#9b59f6,#5d3fd3);animation:wbtf-pulse 1.25s infinite;}',
    '#wbtf-ball.running .txt{font-size:12px;font-weight:600;letter-spacing:.3px;}',
    '@keyframes wbtf-pulse{0%,100%{box-shadow:0 0 0 0 rgba(93,63,211,.42)}50%{box-shadow:0 0 0 12px rgba(93,63,211,0)}}',
    '#wbtf-menu{position:fixed;display:none;flex-direction:column;min-width:172px;background:#ffffff;border-radius:13px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:6px;gap:2px;z-index:2;pointer-events:auto;}',
    '#wbtf-menu.show{display:flex;}',
    '#wbtf-menu button{appearance:none;border:0;background:transparent;text-align:left;padding:10px 14px;border-radius:9px;font-size:14px;color:#333;cursor:pointer;white-space:nowrap;}',
    '#wbtf-menu button:hover{background:#f0f4ff;}',
    '#wbtf-menu button:disabled{color:#c0c4cc;cursor:default;}',
    '#wbtf-menu button:disabled:hover{background:transparent;}',
    '#wbtf-toast{position:fixed;left:50%;top:20px;transform:translateX(-50%) translateY(-8px);max-width:min(86vw,560px);background:rgba(28,30,34,.92);color:#fff;padding:10px 16px;border-radius:10px;font-size:13.5px;line-height:1.6;white-space:pre-line;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;z-index:4;text-align:center;}',
    '#wbtf-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}',
    '#wbtf-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:3;padding:14px;pointer-events:auto;}',
    '#wbtf-overlay.show{display:flex;}',
    '#wbtf-panel{background:#fff;border-radius:15px;width:min(560px,94vw);max-height:88vh;overflow-y:auto;padding:20px 22px 18px;font-size:14px;color:#333;-webkit-overflow-scrolling:touch;}',
    '#wbtf-panel h3{font-size:17px;font-weight:700;margin-bottom:3px;color:#111;}',
    '#wbtf-panel .sec{margin-top:14px;padding-top:12px;border-top:1px solid #eef0f3;}',
    '#wbtf-panel .sec>b{display:block;font-size:13px;color:#3565e8;margin-bottom:9px;letter-spacing:.5px;}',
    '#wbtf-panel .row{margin-bottom:10px;}',
    '#wbtf-panel label{display:block;font-size:12.5px;color:#69707d;margin-bottom:4px;}',
    '#wbtf-panel input[type=text],#wbtf-panel input[type=password],#wbtf-panel input[type=number],#wbtf-panel select,#wbtf-panel textarea{width:100%;padding:9px 11px;border:1px solid #d6dae2;border-radius:9px;font-size:14px;background:#fafbfd;color:#222;outline:none;transition:border-color .15s;}',
    '#wbtf-panel input:focus,#wbtf-panel select:focus,#wbtf-panel textarea:focus{border-color:#3565e8;background:#fff;}',
    '#wbtf-panel textarea{resize:vertical;min-height:54px;line-height:1.55;}',
    '#wbtf-panel .grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;}',
    '#wbtf-panel .hint{font-size:11.5px;color:#9aa1ab;margin-top:3px;line-height:1.55;}',
    '#wbtf-panel .btns{display:flex;gap:9px;margin-top:18px;flex-wrap:wrap;}',
    '#wbtf-panel .btn{flex:1;min-width:92px;padding:10px 12px;border:0;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;transition:filter .15s;}',
    '#wbtf-panel .btn:hover{filter:brightness(.95);}',
    '#wbtf-panel .btn.primary{background:#3565e8;color:#fff;}',
    '#wbtf-panel .btn.ghost{background:#eef1f6;color:#424653;}',
    '#wbtf-panel .btn.danger{background:#fdeaea;color:#d33a3a;flex:none;}',
    '#wbtf-panel .check{display:flex;align-items:center;gap:8px;font-size:13.5px;color:#3d434d;margin:8px 0;cursor:pointer;}',
    '#wbtf-panel .check input{width:16px;height:16px;accent-color:#3565e8;flex:none;}',
    '#wbtf-panel #wbtf-test-result{display:inline-block;margin-left:10px;font-size:12px;vertical-align:middle;}',
    '#wbtf-test-result.ok{color:#1a9e55;}',
    '#wbtf-test-result.err{color:#d33a3a;}',
    '@media (max-width:520px){#wbtf-panel{padding:16px 14px;border-radius:13px;}#wbtf-panel .grid2{grid-template-columns:1fr;}#wbtf-panel input[type=text],#wbtf-panel input[type=password],#wbtf-panel input[type=number],#wbtf-panel select,#wbtf-panel textarea{font-size:16px;}}',
    '@media (prefers-color-scheme: dark){',
    '  #wbtf-menu{background:#26282e;box-shadow:0 8px 28px rgba(0,0,0,.5);}',
    '  #wbtf-menu button{color:#d6d9de;}',
    '  #wbtf-menu button:hover{background:#33363e;}',
    '  #wbtf-panel{background:#22242a;color:#d6d9de;}',
    '  #wbtf-panel h3{color:#f2f3f5;}',
    '  #wbtf-panel .sec{border-top-color:#33363e;}',
    '  #wbtf-panel label{color:#9aa1ab;}',
    '  #wbtf-panel input[type=text],#wbtf-panel input[type=password],#wbtf-panel input[type=number],#wbtf-panel select,#wbtf-panel textarea{background:#1b1d22;border-color:#3a3d46;color:#e6e8ec;}',
    '  #wbtf-panel input:focus,#wbtf-panel select:focus,#wbtf-panel textarea:focus{border-color:#5b83f0;background:#1e2026;}',
    '  #wbtf-panel .check{color:#c6cad1;}',
    '  #wbtf-panel .btn.ghost{background:#33363e;color:#d6d9de;}',
    '  #wbtf-panel .btn.danger{background:#3d2626;color:#e88;}',
    '}'
  ].join('\n');

  // 译文样式注入到页面（非 Shadow，需要参与页面排版）
  function injectPageStyle() {
    if (document.getElementById('wbtf-page-style')) return;
    var st = document.createElement('style');
    st.id = 'wbtf-page-style';
    st.textContent =
      '.wbtf-tr{display:block !important;visibility:visible !important;opacity:.66;color:inherit;' +
      'font-size:.94em;line-height:inherit;font-weight:inherit;letter-spacing:normal;text-transform:none;' +
      'margin-top:.28em;white-space:pre-wrap;word-break:break-word;user-select:text;-webkit-user-select:text;}' +
      '.wbtf-tr-full{display:block !important;visibility:visible !important;color:inherit;line-height:inherit;' +
      'letter-spacing:normal;text-transform:none;margin-top:.1em;white-space:pre-wrap;word-break:break-word;user-select:text;-webkit-user-select:text;}' +
      '.wbtf-orig{display:none !important;}';
    (document.head || document.documentElement).appendChild(st);
  }

  /* ==================== UI：构建 ==================== */

  var ball, ballTxt, menu, toastBox, overlay, shadowRoot, uiHost;
  var MENU_HTML =
    '<button data-act="translate">&#9654; 翻译本页</button>' +
    '<button data-act="restore">&#8634; 还原原文</button>' +
    '<button data-act="mode">&#8646; 显示模式：双语对照</button>' +
    '<button data-act="settings">&#9881; 翻译设置</button>';

  function buildPanelHTML() {
    var modelOpts = COMMON_MODELS.map(function (m) { return '<option value="' + m + '"></option>'; }).join('');
    var langOpts = LANGS.map(function (l) { return '<option value="' + l + '"></option>'; }).join('');
    return '' +
      '<div id="wbtf-panel">' +
      '<h3>&#9881; 翻译设置</h3>' +
      // 面板顶部只读状态行：每次 openSettings 时刷新为当前已保存值；
      // 初始留空，避免把用户输入（模型名等）直接拼进 innerHTML
      '<div class="hint" id="f-cur"></div>' +
      '<div class="hint">兼容 OpenAI /v1/chat/completions 格式的任意接口（OpenAI、DeepSeek、GLM、Kimi、Qwen、Ollama 本地模型等）</div>' +
      '<div class="sec"><b>接口配置</b>' +
      '  <div class="row"><label>API 接口地址</label>' +
      '    <input type="text" id="f-url" placeholder="https://api.openai.com/v1/chat/completions" autocomplete="off" spellcheck="false"></div>' +
      '  <div class="row"><label>API Key（明文显示，长按可直接粘贴；本地 Ollama 等可留空）</label>' +
      '    <input type="text" id="f-key" placeholder="sk-..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="font-family:ui-monospace,Consolas,monospace"></div>' +
      '  <div class="row"><label>模型名称</label>' +
      '    <input type="text" id="f-model" list="dl-models" placeholder="gpt-4o-mini" autocomplete="off" spellcheck="false">' +
      '    <datalist id="dl-models">' + modelOpts + '</datalist></div>' +
      '  <button type="button" class="btn ghost" id="btn-test" style="flex:none;min-width:110px">&#128268; 测试连接</button>' +
      '  <span id="wbtf-test-result"></span>' +
      '</div>' +
      '<div class="sec"><b>翻译选项</b>' +
      '  <div class="grid2">' +
      '  <div class="row"><label>目标语言</label>' +
      '    <input type="text" id="f-lang" list="dl-langs" autocomplete="off"><datalist id="dl-langs">' + langOpts + '</datalist></div>' +
      '  <div class="row"><label>显示模式</label>' +
      '    <select id="f-mode"><option value="bilingual">双语对照</option><option value="replace">仅译文替换</option></select></div>' +
      '  <div class="row"><label>并发请求数（1-10）</label><input type="number" id="f-con" min="1" max="10" step="1"></div>' +
      '  <div class="row"><label>单次请求最大字符数</label><input type="number" id="f-chunk" min="200" max="6000" step="100"></div>' +
      '  <div class="row"><label>请求超时（秒）</label><input type="number" id="f-timeout" min="5" max="600" step="5"></div>' +
      '  </div>' +
      '  <label class="check"><input type="checkbox" id="f-skipcode"> 跳过代码块与输入框（pre / code / textarea 等）</label>' +
      '  <label class="check"><input type="checkbox" id="f-skipui"> 跳过导航栏、页脚、按钮等界面元素</label>' +
      '  <label class="check"><input type="checkbox" id="f-cache"> 启用翻译缓存（相同内容不重复请求）</label>' +
      '</div>' +
      '<div class="sec"><b>高级</b>' +
      '  <div class="row"><label>自定义翻译指令（留空使用内置；{{lang}} 代表目标语言）</label>' +
      '    <textarea id="f-prompt" rows="4" placeholder="例：把内容翻译成{{lang}}，语气口语化，专有名词保留原文，只输出 JSON 数组…"></textarea></div>' +
      '  <div class="row"><label>自定义排除选择器（每行一个 CSS 选择器，# 开头为注释）</label>' +
      '    <textarea id="f-exclude" rows="3" placeholder=".ad-banner&#10;#sidebar&#10;.no-translate"></textarea></div>' +
      '  <button type="button" class="btn danger" id="btn-clearcache">&#128465; 清空翻译缓存</button>' +
      '</div>' +
      '<div class="btns">' +
      '  <button type="button" class="btn ghost" id="btn-reset">恢复默认</button>' +
      '  <button type="button" class="btn ghost" id="btn-cancel">取消</button>' +
      '  <button type="button" class="btn primary" id="btn-save">保存</button>' +
      '</div>' +
      '<div class="hint" style="margin-top:11px">&#128274; API Key 仅保存在本机脚本存储中，不会上传到任何第三方。快捷键 Alt+T：翻译 &#8594; 停止 &#8594; 还原 循环切换。</div>' +
      '</div>';
  }

  function buildUI() {
    var hostEl = document.createElement('div');
    uiHost = hostEl;
    hostEl.id = 'wbtf-host';
    hostEl.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    var sh = hostEl.attachShadow({ mode: 'closed' });
    shadowRoot = sh;

    var style = document.createElement('style');
    style.textContent = UI_CSS;
    sh.appendChild(style);

    ball = document.createElement('div');
    ball.id = 'wbtf-ball';
    ball.title = '点击翻译（Alt+T）';
    ballTxt = document.createElement('span');
    ballTxt.className = 'txt';
    ballTxt.textContent = '译';
    ball.appendChild(ballTxt);

    menu = document.createElement('div');
    menu.id = 'wbtf-menu';
    menu.innerHTML = MENU_HTML;

    toastBox = document.createElement('div');
    toastBox.id = 'wbtf-toast';

    overlay = document.createElement('div');
    overlay.id = 'wbtf-overlay';
    overlay.innerHTML = buildPanelHTML();

    sh.appendChild(ball);
    sh.appendChild(menu);
    sh.appendChild(toastBox);
    sh.appendChild(overlay);

    (document.body || document.documentElement).appendChild(hostEl);

    restoreBallPos();
    bindBallEvents();
    bindMenuEvents();
    bindPanelEvents();
    bindGlobalEvents();
  }

  /* ==================== 悬浮球：状态 / 拖拽 ==================== */

  function updateBallIdle() {
    if (!ball) return;
    ball.classList.remove('running');
    ballTxt.textContent = '译';
    ball.title = '点击翻译（Alt+T）';
  }

  function updateProgress() {
    if (!running || !ball) return;
    var pct = total ? Math.min(99, Math.round(doneCount / total * 100)) : 0;
    ball.classList.add('running');
    ballTxt.textContent = pct + '%';
    ball.title = '翻译中 ' + doneCount + '/' + total + '（点击菜单可停止）';
  }

  function setBallPos(x, y) {
    var w = 46;
    var maxX = Math.max(6, window.innerWidth - w - 6);
    var maxY = Math.max(6, window.innerHeight - w - 6);
    x = Math.max(6, Math.min(maxX, x));
    y = Math.max(6, Math.min(maxY, y));
    ball.style.left = x + 'px';
    ball.style.top = y + 'px';
    ball.style.right = 'auto';
    ball.style.bottom = 'auto';
  }

  function restoreBallPos() {
    var pos = gsGet('wbtf_pos', null);
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      setBallPos(pos.x, pos.y);
    } else {
      setBallPos(window.innerWidth - 64, Math.round(window.innerHeight * 0.42));
    }
  }

  function bindBallEvents() {
    var drag = null;

    ball.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      drag = {
        sx: e.clientX, sy: e.clientY,
        ox: ball.offsetLeft, oy: ball.offsetTop,
        moved: false
      };
      try { ball.setPointerCapture(e.pointerId); } catch (err) { }
      e.preventDefault();
    });

    ball.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) drag.moved = true;
      if (drag.moved) setBallPos(drag.ox + dx, drag.oy + dy);
    });

    function finish(e) {
      if (!drag) return;
      var moved = drag.moved;
      drag = null;
      if (moved) {
        gsSet('wbtf_pos', { x: ball.offsetLeft, y: ball.offsetTop });
      } else {
        toggleMenu();
      }
    }
    ball.addEventListener('pointerup', finish);
    ball.addEventListener('pointercancel', function () { drag = null; });
  }

  /* ==================== 菜单 ==================== */

  function updateMenuState() {
    var btnT = menu.querySelector('[data-act="translate"]');
    var btnR = menu.querySelector('[data-act="restore"]');
    var btnM = menu.querySelector('[data-act="mode"]');
    if (btnT) btnT.innerHTML = running ? '&#9209; 停止翻译' : '&#9654; 翻译本页';
    if (btnR) btnR.disabled = !records.length;
    if (btnM) btnM.innerHTML = '&#8646; 显示模式：' + (settings.mode === 'bilingual' ? '双语对照' : '仅译文替换');
  }

  function toggleMenu() {
    if (menu.classList.contains('show')) { menu.classList.remove('show'); return; }
    updateMenuState();
    var bx = ball.offsetLeft, by = ball.offsetTop;
    var onRight = bx > window.innerWidth / 2;
    var top = Math.max(8, Math.min(by - 8, window.innerHeight - 240));
    menu.style.top = top + 'px';
    if (onRight) {
      menu.style.left = 'auto';
      menu.style.right = Math.max(6, window.innerWidth - bx + 54) + 'px';
    } else {
      menu.style.right = 'auto';
      menu.style.left = (bx + 54) + 'px';
    }
    menu.classList.add('show');
  }

  function bindMenuEvents() {
    menu.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      menu.classList.remove('show');
      if (act === 'translate') { running ? stopAll() : translateAll(); }
      else if (act === 'restore') { restoreAll(); }
      else if (act === 'mode') {
        settings.mode = (settings.mode === 'bilingual') ? 'replace' : 'bilingual';
        gsSet('wbtf_settings', settings);
        updateMenuState();
        toast('显示模式已切换为「' + (settings.mode === 'bilingual' ? '双语对照' : '仅译文替换') + '」，对下次翻译生效');
      }
      else if (act === 'settings') { openSettings(); }
    });
  }

  /* ==================== Toast ==================== */

  var toastTimer = null;
  function toast(msg, ms) {
    if (!toastBox) return;
    toastBox.textContent = msg;
    toastBox.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastBox.classList.remove('show'); }, ms || 3000);
  }

  /* ==================== 设置面板逻辑 ==================== */

  function $(id) { return shadowRoot.getElementById(id); }

  // 面板顶部状态行文案：显示当前已保存并生效的模型 / 目标语言 / 显示模式 / 并发 / 缓存，
  // 便于确认「上次保存了什么」，求助时截图也更有信息量。只读展示，无任何操作入口
  function currentConfigLine() {
    return '当前生效：模型 ' + (settings.model || 'gpt-4o-mini') +
      ' → ' + (settings.targetLang || '简体中文') +
      ' · ' + (settings.mode === 'replace' ? '仅译文替换' : '双语对照') +
      ' · 并发 ' + (settings.concurrency || 3) +
      ' · 缓存' + (settings.cacheEnabled ? '开' : '关');
  }

  function fillForm() {
    $('f-url').value = settings.apiUrl || '';
    $('f-key').value = settings.apiKey || '';
    $('f-model').value = settings.model || '';
    $('f-lang').value = settings.targetLang || '简体中文';
    $('f-mode').value = settings.mode || 'bilingual';
    $('f-con').value = settings.concurrency;
    $('f-chunk').value = settings.chunkSize;
    $('f-timeout').value = settings.timeout;
    $('f-skipcode').checked = !!settings.skipCode;
    $('f-skipui').checked = !!settings.skipUI;
    $('f-cache').checked = !!settings.cacheEnabled;
    $('f-prompt').value = settings.customPrompt || '';
    $('f-exclude').value = settings.customExclude || '';
    var tr = $('wbtf-test-result');
    tr.textContent = '';
    tr.className = '';
  }

  function openSettings() {
    menu.classList.remove('show');
    fillForm();
    // 状态行在此刷新（而非 fillForm 内）：「恢复默认」按钮会临时以默认值调用 fillForm，
    // 若放在 fillForm 里会把「表单默认值」误显示成「当前生效值」
    $('f-cur').textContent = currentConfigLine();
    overlay.classList.add('show');
  }

  function closeSettings() { overlay.classList.remove('show'); }

  function readForm() {
    var url = $('f-url').value.trim();
    if (!/^https?:\/\//i.test(url)) {
      toast('API 接口地址需要以 http:// 或 https:// 开头');
      return null;
    }
    return {
      apiUrl: url,
      apiKey: $('f-key').value.trim(),
      model: $('f-model').value.trim() || 'gpt-4o-mini',
      targetLang: $('f-lang').value.trim() || '简体中文',
      mode: $('f-mode').value === 'replace' ? 'replace' : 'bilingual',
      concurrency: clampNum($('f-con').value, 1, 10, 3),
      chunkSize: clampNum($('f-chunk').value, 200, 6000, 1200),
      timeout: clampNum($('f-timeout').value, 5, 600, 60),
      customPrompt: $('f-prompt').value,
      customExclude: $('f-exclude').value,
      skipCode: $('f-skipcode').checked,
      skipUI: $('f-skipui').checked,
      cacheEnabled: $('f-cache').checked
    };
  }

  function testConnection() {
    var url = $('f-url').value.trim();
    var res = $('wbtf-test-result');
    if (!/^https?:\/\//i.test(url)) {
      res.textContent = '✗ 地址格式不正确';
      res.className = 'err';
      return;
    }
    var model = $('f-model').value.trim() || 'gpt-4o-mini';
    var key = $('f-key').value.trim();
    var headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = 'Bearer ' + key;

    res.textContent = '… 测试中';
    res.className = '';
    var btn = $('btn-test');
    btn.disabled = true;
    var t0 = Date.now();

    GM_xmlhttpRequest({
      method: 'POST',
      url: url,
      headers: headers,
      data: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
        stream: false
      }),
      timeout: clampNum($('f-timeout').value, 5, 600, 60) * 1000,
      onload: function (r) {
        btn.disabled = false;
        var sec = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.status >= 200 && r.status < 300) {
          res.textContent = '✓ 连接成功 · ' + sec + 's';
          res.className = 'ok';
        } else {
          var d = '';
          try { var ej = JSON.parse(r.responseText); d = (ej.error && ej.error.message) || ej.message || ''; } catch (e) { }
          res.textContent = '✗ HTTP ' + r.status + (d ? (' ' + d.slice(0, 80)) : '');
          res.className = 'err';
        }
      },
      onerror: function () {
        btn.disabled = false;
        res.textContent = '✗ 网络错误 / 无法访问';
        res.className = 'err';
      },
      ontimeout: function () {
        btn.disabled = false;
        res.textContent = '✗ 请求超时';
        res.className = 'err';
      }
    });
  }

  function bindPanelEvents() {
    $('btn-save').addEventListener('click', function () {
      var s = readForm();
      if (!s) return;
      settings = s;
      gsSet('wbtf_settings', settings);
      closeSettings();
      updateMenuState();
      toast('设置已保存 ✓');
    });

    $('btn-cancel').addEventListener('click', closeSettings);

    $('btn-test').addEventListener('click', testConnection);

    $('btn-clearcache').addEventListener('click', function () {
      var ok = window.confirm('确定清空全部翻译缓存吗？');
      if (!ok) return;
      cacheObj = {};
      saveCache();
      toast('翻译缓存已清空 ✓');
    });

    $('btn-reset').addEventListener('click', function () {
      var ok = window.confirm('将表单恢复为默认值（需点击「保存」后生效）？');
      if (!ok) return;
      var bak = settings;
      settings = {};
      for (var k in DEFAULTS) settings[k] = DEFAULTS[k];
      fillForm();
      settings = bak;
    });

    // 点击遮罩空白处关闭。
    // 注意：此监听挂在 overlay 自身（同一 Shadow 树内），e.target 是真实内部节点，
    // 不涉及 closed host 的 target 重定向；若把监听移到 shadowRoot 之外此判断会失效
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeSettings();
    });
    // 防止触摸滚动穿透到页面背景
    overlay.addEventListener('touchmove', function (e) {
      if (e.target === overlay) e.preventDefault();
    }, { passive: false });
  }

  /* ==================== 全局事件与初始化 ==================== */

  function primaryAction() {
    if (running) { stopAll(); return; }
    if (records.length) { restoreAll(); return; }
    translateAll();
  }

  function bindGlobalEvents() {
    // 快捷键 Alt+T：翻译 -> 停止 -> 还原 循环
    // keydown 为非 composed 事件：焦点落在页面时只有 document 收到，
    // 焦点落在脚本 Shadow UI 内时只有 shadowRoot 收到，两处都挂同一处理器
    var keyHandler = function (e) {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      var k = (e.key || '').toLowerCase();
      if (k !== 't') return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      primaryAction();
    };
    document.addEventListener('keydown', keyHandler, true);
    shadowRoot.addEventListener('keydown', keyHandler, true);

    // 点击菜单外区域自动收起
    // 关键：UI 位于 closed Shadow DOM 中，内部点击冒泡到 document 时
    // e.target 会被重定向为 host 容器（uiHost），composedPath 也会被截断，
    // 因此用 e.target === uiHost 判断“点击发生在脚本 UI 内”。
    // 用 click 而非 pointerdown：避免提前关闭菜单导致 click 丢失、菜单项无法响应
    document.addEventListener('click', function (e) {
      if (!menu.classList.contains('show')) return;
      if (e.target === uiHost) return;
      var path = (e.composedPath ? e.composedPath() : []);
      if (path.indexOf(menu) >= 0 || path.indexOf(ball) >= 0 || path.indexOf(uiHost) >= 0) return;
      menu.classList.remove('show');
    }, true);

    // 窗口尺寸变化时把悬浮球拉回可视区
    window.addEventListener('resize', function () {
      setBallPos(ball.offsetLeft || 6, ball.offsetTop || 6);
    });

    // 页面隐藏 / 关闭前持久化缓存
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') saveCache();
    });
    window.addEventListener('beforeunload', function () { saveCache(); });

    // SPA 路由变化：自动还原，避免译文与内容错位
    var lastUrl = location.href;
    setInterval(function () {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        if (running) stopAll(true);
        if (records.length) restoreAll(true);
        menu.classList.remove('show');
      }
    }, 800);
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try { GM_registerMenuCommand('▶ 翻译本页', function () { running ? stopAll() : translateAll(); }); } catch (e) { }
    try { GM_registerMenuCommand('↺ 还原原文', function () { restoreAll(); }); } catch (e) { }
    try { GM_registerMenuCommand('⚙ 翻译设置', function () { openSettings(); }); } catch (e) { }
  }

  function boot() {
    injectPageStyle();
    try {
      buildUI();
    } catch (e) {
      // 极少数环境不支持 Shadow DOM 时降级：直接 alert 提示
      console.error('[WBTF] UI 构建失败：', e);
      return;
    }
    registerMenus();
  }

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  init();
})();
