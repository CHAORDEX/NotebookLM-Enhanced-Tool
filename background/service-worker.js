const DEFAULT_URL = "https://notebooklm.google.com";
// NotebookLM 下载来源：图片/音频均源于 googleusercontent.com（不限 lh3 子域）
const NOTEBOOKLM_DOWNLOAD_HOSTS = [
  "googleusercontent.com",
  "lh3.google.com/",
];
const DOWNLOAD_RENAME_TTL_MS = 120000;
const pendingRenameQueue = [];

/**
 * 判断是否为 NotebookLM 资源下载 URL。
 * @param {string} url 下载 URL
 * @returns {boolean} 是否匹配
 */
function isNotebooklmDownloadUrl(url) {
  return NOTEBOOKLM_DOWNLOAD_HOSTS.some((host) => (url || "").includes(host));
}

/**
 * 清理过期的重命名任务，避免队列无限增长。
 */
function cleanupExpiredRenameTasks() {
  const now = Date.now();
  for (let i = pendingRenameQueue.length - 1; i >= 0; i--) {
    if (now - pendingRenameQueue[i].createdAt > DOWNLOAD_RENAME_TTL_MS) {
      pendingRenameQueue.splice(i, 1);
    }
  }
}

/**
 * 清理并标准化文件名，去掉非法字符并限制长度。
 * @param {string} name 候选文件名（不含扩展名）
 * @returns {string} 规范化后的文件名
 */
function sanitizeFilename(name) {
  return (name || "notebooklm")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 180) || "notebooklm";
}

/**
 * 从 URL 中推断扩展名。NotebookLM 链接通常不带扩展名，默认回退为 png。
 * @param {string} url 下载 URL
 * @returns {string} 扩展名（含点）
 */
function inferExtFromUrl(url) {
  const clean = (url || "").split("?")[0];
  const match = clean.match(/\.([a-z0-9]{2,5})$/i);
  return match ? `.${match[1].toLowerCase()}` : ".png";
}

/**
 * 从下载项信息中决定最终扩展名，优先使用已有文件名中的扩展名。
 * @param {chrome.downloads.DownloadItem} item 下载项
 * @returns {string} 扩展名（含点）
 */
function resolveExtForDownload(item) {
  const filename = item.filename || "";
  const m = filename.match(/\.([a-z0-9]{2,5})$/i);
  if (m) return `.${m[1].toLowerCase()}`;
  return inferExtFromUrl(item.finalUrl || item.url || "");
}

/**
 * 判断下载项是否可视为一次 NotebookLM 资源下载。
 * @param {chrome.downloads.DownloadItem} item 下载项
 * @returns {boolean} 是否命中 NotebookLM 下载上下文
 */
function isNotebooklmDownloadItem(item) {
  const url = item.finalUrl || item.url || "";
  const referrer = item.referrer || "";
  const filename = item.filename || "";

  if (isNotebooklmDownloadUrl(url)) return true;
  if (referrer.includes("https://notebooklm.google.com/")) return true;
  if (/\/unnamed(\.[a-z0-9]{2,5})?$/i.test(filename)) return true;
  return false;
}

chrome.runtime.onInstalled.addListener(() => {
  // Notification
  chrome.notifications.onClicked.addListener(function () {
    chrome.tabs.create({ url: DEFAULT_URL });
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url.startsWith(DEFAULT_URL)) {
    chrome.tabs.create({ url: DEFAULT_URL });
  }
});

/**
 * 接收 content-script 发来的“待重命名下载任务”。
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === "QUEUE_DOWNLOAD_RENAME") {
    cleanupExpiredRenameTasks();
    pendingRenameQueue.push({
      tabId: sender && sender.tab ? sender.tab.id : null,
      baseName: sanitizeFilename(message.baseName || "notebooklm"),
      url: message.url || "",
      createdAt: Date.now(),
    });

    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "UPDATE_DOWNLOAD_RENAME_URL") {
    cleanupExpiredRenameTasks();
    for (let i = pendingRenameQueue.length - 1; i >= 0; i--) {
      const task = pendingRenameQueue[i];
      if (sender && sender.tab && task.tabId === sender.tab.id) {
        task.url = message.url || task.url || "";
        if (message.baseName) {
          task.baseName = sanitizeFilename(message.baseName);
        }
        sendResponse({ ok: true, updated: true });
        return true;
      }
    }

    pendingRenameQueue.push({
      tabId: sender && sender.tab ? sender.tab.id : null,
      baseName: sanitizeFilename(message.baseName || "notebooklm"),
      url: message.url || "",
      createdAt: Date.now(),
    });
    sendResponse({ ok: true, updated: false });
    return true;
  }
});

/**
 * 下载开始前重写文件名：对 NotebookLM 资源下载应用最近一次排队的来源名称。
 */
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const url = item.finalUrl || item.url || "";

  cleanupExpiredRenameTasks();
  const currentFilename = item.filename || "";
  const looksUnnamed = /(^|\/)unnamed(\.[a-z0-9]{2,5})?$/i.test(currentFilename);
  // 文件名看起来正常（非空、非 unnamed）：说明页面/浏览器已自行设定了有效文件名，
  // 例如脑图通过 <a download="xxx.md"> 下载时就有正确文件名，不应该被覆盖。
  const hasGoodFilename = currentFilename && !looksUnnamed;

  // 优先匹配同标签页 + 同 URL 的精确任务。
  let taskIndex = -1;
  if (item.tabId !== undefined && item.tabId !== -1) {
    taskIndex = pendingRenameQueue.findIndex((task) => {
      if (task.tabId !== item.tabId) return false;
      // 仅在 task 有 url 且与下载 url 匹配时才精确命中
      if (task.url && url) return task.url === url;
      // task.url 为空时，仅当当前文件名不正常才视为匹配（避免覆盖脑图等已有好文件名的下载）
      return !hasGoodFilename;
    });
  }

  if (taskIndex === -1 && isNotebooklmDownloadItem(item)) {
    taskIndex = pendingRenameQueue.findIndex((task) => task.url && url && task.url === url);
  }

  if (taskIndex === -1 && looksUnnamed && pendingRenameQueue.length > 0) {
    taskIndex = pendingRenameQueue.length - 1;
  }

  // 最终兜底：仅当文件名不正常时才使用队列中最后一个任务。
  // 已有正确文件名的下载（如脑图 markdown）不会被覆盖。
  if (taskIndex === -1 && !hasGoodFilename && isNotebooklmDownloadItem(item) && pendingRenameQueue.length > 0) {
    taskIndex = pendingRenameQueue.length - 1;
  }

  if (taskIndex === -1) {
    suggest();
    return;
  }

  const task = pendingRenameQueue.splice(taskIndex, 1)[0];
  const ext = resolveExtForDownload(item);
  const finalFilename = `${task.baseName}${ext}`;

  suggest({
    filename: finalFilename,
    conflictAction: "uniquify",
  });
});
