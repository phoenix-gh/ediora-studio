(() => {
  const CONFIG = {
    apiUrl: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    apiKey: "sk-30e50dcfa66546ef99dc84f373d317da"
  };

  const BTN_FLAG = "data-wemedia-auto-reply";

  function getActiveEditor() {
    const editors = document.querySelectorAll(
      '[data-testid^="tweetTextarea_"] [contenteditable="true"]'
    );
    for (const ed of editors) {
      const r = ed.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return ed;
    }
    return null;
  }

  function getScopeFromEditor(editor) {
    if (!editor) return document;
    return (
      editor.closest('[role="dialog"]') ||
      editor.closest("form") ||
      editor.closest("article") ||
      document
    );
  }

  function setReplyText(text) {
    const editor = getActiveEditor();
    if (!editor) {
      console.error("未找到回复框，请确保回复窗口已打开");
      return;
    }

    editor.focus();

    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", text);

    const pasteEvent = new ClipboardEvent("paste", {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });

    editor.dispatchEvent(pasteEvent);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function getContextText(scope) {
    const root = scope || document;
    const article =
      (root.closest && root.closest("article")) ||
      root.querySelector?.("article") ||
      document.querySelector("article");
    const tweetText = article?.querySelector('[data-testid="tweetText"]');
    return (tweetText?.textContent || "").trim();
  }

  async function callHermes(contextText) {
    const prompt = contextText
      ? `针对这个帖子写一篇回复：\n\n${contextText}`
      : "请写一条自然、简短、有信息量的中文回复。";

    const res = await fetch(CONFIG.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(CONFIG.apiKey ? { Authorization: `Bearer ${CONFIG.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: CONFIG.model,
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content:
              "你是社媒运营助手，擅长读懂楼主帖子核心内容、情绪、诉求，给出专业得体、贴合圈层、不生硬、有共情的高质量回复，不灌水、不废话、不抬杠。\
工作规则：\
要以自己看这篇帖子的人的角度去思考, 而不是以楼主的角度去思考。\
先精准提炼帖子核心：楼主想问什么、分享什么、吐槽什么、求推荐 / 求解决 / 求共鸣。\
回复风格适配帖子圈层：科技、生活、汽车、理财、编程、情感、数码等自动匹配语气。\
回复结构自然：先共情 / 认可 → 补充专业观点 / 干货 → 给到实用建议 / 延伸思路 → 语气友好接地气。不能有AI味道, 不能有AI的痕迹。\
禁用：生硬机器话术、说教感太强、阴阳怪气、引战、广告、套话流水账。\
可根据帖子氛围灵活调整：偏干货就专业严谨，偏闲聊就轻松随和，偏求助就耐心细致。\
字数适配帖子评论区：不长篇大论，精简有料，符合普通人发帖回复习惯, 一般在30字以内, 最多不超过50字。\
不需要各个要素齐全, 故意忽略一点, 显得更加自然。\
一定不可以说: 这流程太香了, 太好了, 太棒了, 太对了 这种没营养的话."
          },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!res.ok) {
      throw new Error(`LLM 请求失败: ${res.status}`);
    }

    const data = await res.json();
    const text =
      data?.choices?.[0]?.message?.content || data?.output_text || "";

    return String(text).trim();
  }


  // 检测当前屏幕正中间的推文
function findCentralTweet() {
  const tweets = document.querySelectorAll('article[data-testid="tweet"]');
  let centralTweet = null;
  const viewportCenter = window.innerHeight / 2;

  tweets.forEach(tweet => {
      const rect = tweet.getBoundingClientRect();
      if (rect.top < viewportCenter && rect.bottom > viewportCenter) {
          centralTweet = tweet;
      }
  });
  return centralTweet;
}

// 自动浏览开关 + 定时器
const AUTO_BROWSE_KEY = "wemedia_auto_browse";
let autoBrowseRunning = false;
let autoBrowseTimer = null;

// 工作 / 休息 节奏
const WORK_MIN_MS = 3 * 60 * 1000;   // 工作最少 3 分钟
const WORK_MAX_MS = 7 * 60 * 1000;   // 工作最多 7 分钟
const REST_MIN_MS = 2 * 60 * 1000;   // 休息最少 2 分钟
const REST_MAX_MS = 5 * 60 * 1000;   // 休息最多 5 分钟
let sessionStartAt = 0;
let nextWorkDuration = 0;
function rand(min, max) { return Math.floor(Math.random() * (max - min)) + min; }

// 检测“有新帖子 / See new posts”按钮
function findNewPostsButton() {
  return Array.from(document.querySelectorAll('div[role="button"]'))
    .find(el => {
      const t = el.innerText || "";
      return t.includes('See new posts') || t.includes('有新帖子') || t.includes('显示新帖子');
    });
}

// 休息一会儿再回顶检查新帖子
async function takeRestThenRefresh() {
  const restMs = rand(REST_MIN_MS, REST_MAX_MS);
  console.log(`[WeMedia] 休息 ${(restMs / 1000 / 60).toFixed(1)} 分钟…`);
  await new Promise(r => (autoBrowseTimer = setTimeout(r, restMs)));
  if (!autoBrowseRunning) return;

  console.log("[WeMedia] 休息结束，回顶检查新帖子…");
  window.scrollTo({ top: 0, behavior: 'smooth' });
  await new Promise(r => setTimeout(r, 1500));
  if (!autoBrowseRunning) return;

  const btn = findNewPostsButton();
  if (btn) {
    try { btn.click(); } catch (_) {}
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!autoBrowseRunning) return;

  sessionStartAt = Date.now();
  nextWorkDuration = rand(WORK_MIN_MS, WORK_MAX_MS);
  autoBrowseTimer = setTimeout(smartScrollAndScan, 800);
}

// 模拟真人阅读并“锁定”目标
async function smartScrollAndScan() {
  if (!autoBrowseRunning) return;

  // 0a. 工作时长到了 → 进入休息
  if (Date.now() - sessionStartAt >= nextWorkDuration) {
    takeRestThenRefresh();
    return;
  }

  // 1. 先检查有没有 "posted" 按钮
  if (clickPostedIndicator()) {
    // 点击后稍微等 2 秒，让新帖子刷出来
    await new Promise(r => setTimeout(r, 2000));
    // 可选：回到顶部，方便 AI 抓取最新的第一条
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await new Promise(r => setTimeout(r, 1000));
  }

  // 0b. 优先检查是否出现“新帖子”提示，有则回顶点击加载
  const newPostBtn = findNewPostsButton();
  if (newPostBtn) {
    console.log("[WeMedia] 发现新内容，回顶加载…");
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await new Promise(r => setTimeout(r, 1200));
    if (!autoBrowseRunning) return;
    try { newPostBtn.click(); } catch (_) {}
    await new Promise(r => setTimeout(r, 3000));
    if (!autoBrowseRunning) return;
    autoBrowseTimer = setTimeout(smartScrollAndScan, 800);
    return;
  }

  // 1. ~20% 概率随机回滚（向上滑 1-3 下，模拟回看）
  if (Math.random() < 0.2) {
    const backTimes = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < backTimes; i++) {
      if (!autoBrowseRunning) return;
      const up = Math.floor(Math.random() * 250) + 150;
      window.scrollBy({ top: -up, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, Math.random() * 800 + 600));
    }
    if (!autoBrowseRunning) return;
    await new Promise(r => setTimeout(r, Math.random() * 1500 + 1000));
  }

  // 2. 正常向下滚动
  const distance = Math.floor(Math.random() * 400) + 300;
  window.scrollBy({ top: distance, behavior: 'smooth' });

  await new Promise(r => setTimeout(r, 2000));
  if (!autoBrowseRunning) return;

  const target = findCentralTweet();
  if (target) {
      const tweetText = target.innerText.substring(0, 50) + "...";
      console.log("正在分析当前推文:", tweetText);
      target.style.border = "2px solid #1d9bf0";
  }

  autoBrowseTimer = setTimeout(smartScrollAndScan, Math.random() * 3000 + 2000);
}


function clickPostedIndicator() {
  // 查找包含 "posted" 文本的元素
  const postedBtn = Array.from(document.querySelectorAll('div[role="button"]'))
    .find(el => el.innerText.toLowerCase().includes('posted'));

  if (postedBtn) {
    console.log("检测到新帖子按钮，正在点击...");
    postedBtn.click();
    return true;
  }
  return false;
}

function startAutoBrowse() {
  if (autoBrowseRunning) return;
  autoBrowseRunning = true;
  sessionStartAt = Date.now();
  nextWorkDuration = rand(WORK_MIN_MS, WORK_MAX_MS);
  console.log(`[WeMedia] 自动浏览：开启（本轮工作 ${(nextWorkDuration / 1000 / 60).toFixed(1)} 分钟）`);
  smartScrollAndScan();
}

function stopAutoBrowse() {
  if (!autoBrowseRunning) return;
  autoBrowseRunning = false;
  if (autoBrowseTimer) {
    clearTimeout(autoBrowseTimer);
    autoBrowseTimer = null;
  }
  console.log("[WeMedia] 自动浏览：关闭");
}

if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local.get([AUTO_BROWSE_KEY], (res) => {
    if (res[AUTO_BROWSE_KEY]) startAutoBrowse();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(AUTO_BROWSE_KEY in changes)) return;
    if (changes[AUTO_BROWSE_KEY].newValue) startAutoBrowse();
    else stopAutoBrowse();
  });
}

// ── HTML → Markdown (shared with toolbar.js) ────────────────────────────────

function isEmojiImg(el) {
  const src = el.getAttribute('src') || '';
  return /twemoji|abs\.twimg\.com\/emoji|emoji\.twimg\.com/.test(src)
    || (el.getAttribute('draggable') === 'false' && parseInt(el.getAttribute('width') || '99') < 32);
}

function nodeToMd(node) {
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (['script','style','noscript','svg'].includes(tag)) return '';
  const kids = () => Array.from(node.childNodes).map(nodeToMd).join('');
  switch (tag) {
    case 'h1': return `\n# ${kids().trim()}\n\n`;
    case 'h2': return `\n## ${kids().trim()}\n\n`;
    case 'h3': return `\n### ${kids().trim()}\n\n`;
    case 'h4': case 'h5': case 'h6': return `\n#### ${kids().trim()}\n\n`;
    case 'p':  return `${kids().trim()}\n\n`;
    case 'br': return '\n';
    case 'hr': return '\n---\n\n';
    case 'strong': case 'b': { const t = kids(); return t ? `**${t}**` : ''; }
    case 'em':     case 'i': { const t = kids(); return t ? `*${t}*`  : ''; }
    case 'del':    case 's': { const t = kids(); return t ? `~~${t}~~`: ''; }
    case 'code': return node.closest('pre') ? kids() : `\`${kids()}\``;
    case 'pre':  return `\`\`\`\n${kids().trim()}\n\`\`\`\n\n`;
    case 'blockquote': return `> ${kids().trim().replace(/\n/g, '\n> ')}\n\n`;
    case 'a': {
      const href = node.getAttribute('href') || '';
      const text = kids().trim();
      if (!href || href.startsWith('/')) return text;
      return text && text !== href ? `[${text}](${href})` : href;
    }
    case 'img': {
      if (isEmojiImg(node)) return node.getAttribute('alt') || '';
      const src = node.getAttribute('src') || '';
      if (!src) return '';
      const w = parseInt(node.getAttribute('width') || '999');
      if (w > 0 && w < 48) return node.getAttribute('alt') || '';
      return `\n\n![${node.getAttribute('alt') || ''}](${src})\n\n`;
    }
    case 'ul': return '\n' + Array.from(node.children).filter(c => c.tagName === 'LI')
      .map(li => `- ${nodeToMd(li).trim()}`).join('\n') + '\n\n';
    case 'ol': return '\n' + Array.from(node.children).filter(c => c.tagName === 'LI')
      .map((li, i) => `${i + 1}. ${nodeToMd(li).trim()}`).join('\n') + '\n\n';
    case 'li': return kids();
    default: return kids();
  }
}

function elToMd(el) {
  if (!el) return '';
  return nodeToMd(el).replace(/\n{3,}/g, '\n\n').trim();
}

function tweetPhotos(tweetArticle) {
  return Array.from(tweetArticle.querySelectorAll(
    '[data-testid="tweetPhoto"] img, [data-testid="card.layoutLarge.media"] img'
  )).filter(img => !isEmojiImg(img)).map(img => {
    const src = img.getAttribute('src') || '';
    return src ? `\n\n![${img.getAttribute('alt') || ''}](${src})` : '';
  }).filter(Boolean).join('\n\n');
}

// ── Thread / article extraction (called from popup via message) ───────────────

function extractPageContent() {
  const ARTICLE_SELECTORS = [
    '[data-testid="longformBody"]','[data-testid="longformContent"]',
    '[data-testid="articleBody"]','[data-testid="article-body"]',
    '[data-testid="scrollableArticleBody"]',
  ];
  for (const sel of ARTICLE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 80) {
      const titleEl = document.querySelector('[data-testid="articleTitle"]')
        || document.querySelector('[data-testid="longformTitle"]') || el.querySelector('h1,h2');
      return { type: "article", title: elToMd(titleEl), body: elToMd(el) };
    }
  }
  const primaryCol = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main');
  if (primaryCol) {
    const h1 = primaryCol.querySelector('h1');
    const paras = Array.from(primaryCol.querySelectorAll('p')).filter(p => p.innerText.trim().length > 30);
    if (h1 && paras.length >= 2) {
      return { type: "article", title: elToMd(h1), body: paras.map(elToMd).join('\n\n') };
    }
  }
  const firstTweet = document.querySelector('article[data-testid="tweet"]');
  if (firstTweet) {
    const t = firstTweet.querySelector('[data-testid="tweetText"]');
    const body = elToMd(t) + tweetPhotos(firstTweet);
    const replies = Array.from(document.querySelectorAll('article[data-testid="tweet"]')).slice(1)
      .map(a => { const tx = a.querySelector('[data-testid="tweetText"]'); return tx ? elToMd(tx) + tweetPhotos(a) : ''; })
      .filter(Boolean).slice(0, 20);
    return { type: "tweet", title: "", body, replies };
  }
  return { type: "tweet", title: "", body: "" };
}

function extractThread() {
  const r = extractPageContent();
  if (r.type === "article") {
    const paras = r.body.split(/\n{2,}/).filter(Boolean);
    return {
      post: r.title ? `${r.title}\n\n${paras[0] || ""}` : paras[0] || "",
      replies: paras.slice(1, 21),
    };
  }
  return { post: r.body, replies: r.replies || [] };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "EXTRACT_THREAD") {
      sendResponse(extractThread());
    }
    return true;
  });
}

  function findReplyButtons() {
    return document.querySelectorAll(
      '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'
    );
  }

  function createAutoReplyButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute(BTN_FLAG, "1");
    btn.textContent = "自动回复";
    btn.style.cssText =
      "margin-right:8px;padding:0 16px;height:36px;border-radius:9999px;border:1px solid #536471;background:transparent;color:#1d9bf0;font-weight:700;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;";

    btn.addEventListener("mouseenter", () => {
      btn.style.background = "rgba(29,155,240,0.1)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "transparent";
    });

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const editor = getActiveEditor();
      const scope = getScopeFromEditor(editor);
      const contextText = getContextText(scope);

      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "生成中…";
      btn.style.opacity = "0.6";

      try {
        const generated = await callHermes(contextText);
        if (!generated) throw new Error("返回为空");
        setReplyText(generated);
        btn.textContent = "已注入";
        setTimeout(() => {
          btn.textContent = original;
        }, 1200);
      } catch (err) {
        console.error("[WeMedia]", err);
        btn.textContent = "失败";
        setTimeout(() => {
          btn.textContent = original;
        }, 1500);
      } finally {
        btn.disabled = false;
        btn.style.opacity = "1";
      }
    });

    return btn;
  }

  function injectAutoReplyButtons() {
    const replyButtons = findReplyButtons();
    replyButtons.forEach((replyBtn) => {
      const parent = replyBtn.parentElement;
      if (!parent) return;
      if (parent.querySelector(`[${BTN_FLAG}]`)) return;
      if (replyBtn.innerText != 'Reply' && replyBtn.innerText != '回复') return;

      const autoBtn = createAutoReplyButton();
      parent.insertBefore(autoBtn, replyBtn);
    });
  }

  const observer = new MutationObserver(() => {
    injectAutoReplyButtons();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  injectAutoReplyButtons();
})();
