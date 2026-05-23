(async function () {
    'use strict';

    const DEBUG = true; // 临时启用调试模式

    // 注入 XMLHttpRequest/fetch 拦截脚本
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/inject.js');
    script.onload = function () {
        this.remove();
    };
    (document.head || document.documentElement).appendChild(script);

    let hasExpandedAll = false; // 标记是否已经点击过展开按钮
    let notebooklmResources = []; // 保存从 batchexecute 拦截到的资源
    let batchDeleteInProgress = false; // 标记批量删除状态，避免重复执行
    const resourceTitleById = new Map(); // artifactId -> 标题
    const sourceDocumentTitleById = new Map(); // sourceDocumentId -> 文档标题
    const sourceDocumentIdByResourceId = new Map(); // resourceArtifactId -> sourceDocumentId
    let lastArtifactContext = null; // 最近一次交互的资源上下文，优先用于下载命名
    let lastOpenedDownloadUrl = ''; // 最近一次被打开的 notebooklm 资源 URL
    let pendingDirectDownload = null; // 当前等待补全下载 URL 的重命名任务

    /**
     * 安全地向后台发送消息，兼容扩展热更新后旧上下文失效的场景。
     * @param {Record<string, any>} payload - 发送给后台的消息体
     * @param {(response?: any) => void} [onSuccess] - 成功回调
     * @returns {void}
     */
    function safeSendRuntimeMessage(payload, onSuccess) {
        try {
            chrome.runtime.sendMessage(payload, response => {
                if (chrome.runtime.lastError) {
                    console.warn('[NotebookLM Tool] Background message failed:', chrome.runtime.lastError.message, payload);
                    return;
                }

                if (typeof onSuccess === 'function') {
                    onSuccess(response);
                }
            });
        } catch (e) {
            if (e.message && e.message.includes('Extension context invalidated')) {
                console.warn('[NotebookLM Tool] 插件已更新，旧上下文失效。请刷新页面。');
                alert('NotebookLM 插件已在后台更新，请刷新当前网页（按 F5 或 Cmd+R）后再点击下载！');
            } else {
                console.error('[NotebookLM Tool] Send message failed:', e, payload);
            }
        }
    }

    /**
     * 规范化 NotebookLM 下载 URL，去掉日志里可能混入的引号/反引号。
     * @param {string} url - 原始 URL
     * @returns {string} - 清洗后的 URL
     */
    function normalizeNotebooklmUrl(url) {
        return (url || '')
            .trim()
            .replace(/^['"`]+|['"`]+$/g, '');
    }

    // 监听 inject.js 发来的消息
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || !event.data.type) {
            return;
        }

        if (event.data.type === 'NOTEBOOKLM_DOWNLOAD_URL') {
            lastOpenedDownloadUrl = normalizeNotebooklmUrl(event.data.url || '');
            if (DEBUG) console.log('[DEBUG] Captured download url:', lastOpenedDownloadUrl);

            if (pendingDirectDownload && lastOpenedDownloadUrl) {
                safeSendRuntimeMessage({
                    type: 'UPDATE_DOWNLOAD_RENAME_URL',
                    url: lastOpenedDownloadUrl,
                    baseName: pendingDirectDownload.baseName
                }, response => {
                    if (DEBUG) console.log('[DEBUG] Updated queued rename url:', pendingDirectDownload.baseName, lastOpenedDownloadUrl, response);
                });
            }

            pendingDirectDownload = null;
            return;
        }

        if (event.data.type === 'NOTEBOOKLM_BATCHEXECUTE_RESPONSE') {
            const responseUrl = event.data.url || '';
            const parsed = parseWeirdResponse(event.data.responseText);
            if (parsed && parsed.length > 0) {
                notebooklmResources = notebooklmResources.concat(parsed);
                parsed.forEach((item) => {
                    if (item && item.artifactId && item.title) {
                        resourceTitleById.set(item.artifactId, item.title);
                    }
                });
                if (DEBUG) console.log('[DEBUG] Intercepted batchexecute resources:', parsed);
            }

            if (responseUrl.includes('rpcids=rLM1Ne') || responseUrl.includes('rpcids=wXbhsf')) {
                const sourceDocMappings = parseSourceDocumentMappings(event.data.responseText);
                if (sourceDocMappings.length > 0) {
                    sourceDocMappings.forEach((item) => {
                        sourceDocumentTitleById.set(item.artifactId, item.title);
                    });
                    if (DEBUG) console.log('[DEBUG] Parsed source document mappings:', sourceDocMappings);
                }
            }

            if (responseUrl.includes('rpcids=gArtLc')) {
                const resourceSourceMappings = parseResourceSourceMappings(event.data.responseText);
                if (resourceSourceMappings.length > 0) {
                    resourceSourceMappings.forEach((item) => {
                        sourceDocumentIdByResourceId.set(item.resourceId, item.sourceDocumentId);
                    });
                    if (DEBUG) console.log('[DEBUG] Parsed gArtLc resource-source mappings:', resourceSourceMappings);
                }
            }
        }
    });

    /**
     * 兼容 URL-safe Base64 的解码（用于 jslog payload）
     * @param {string} value - Base64 字符串
     * @returns {string} - 解码结果
     */
    function decodeBase64Flexible(value) {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
        return atob(padded);
    }

    /**
     * 判断字符串是否是 UUID 形态，用于识别 artifactId
     * @param {string} value - 待判断字符串
     * @returns {boolean} - 是否为 UUID
     */
    function isUuid(value) {
        return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    }

    /**
     * 从 jslog 字段中解析 notebookId / artifactId
     * @param {string|null} jslog - 按钮上的 jslog 属性
     * @returns {{notebookId: string|null, artifactId: string|null}} - 解析结果
     */
    function parseIdsFromJslog(jslog) {
        try {
            if (!jslog || typeof jslog !== 'string') return { notebookId: null, artifactId: null };
            const payloadPart = jslog.split('0:')[1];
            if (!payloadPart) return { notebookId: null, artifactId: null };
            const decoded = decodeBase64Flexible(payloadPart.trim());
            const parsed = JSON.parse(decoded);

            if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
                const pair = parsed[0];
                const notebookId = pair[0] || null;
                const artifactId = pair[1] || null;
                return { notebookId, artifactId };
            }
        } catch (e) {
            if (DEBUG) console.log('[DEBUG] parseIdsFromJslog failed:', e);
        }
        return { notebookId: null, artifactId: null };
    }

    /**
     * 判断是否为无效占位标题，避免继续使用 unnamed 作为文件名
     * @param {string} name - 候选标题
     * @returns {boolean} - 是否为无效标题
     */
    function isBadTitle(name) {
        if (!name || !name.trim()) return true;
        const normalized = name.trim().toLowerCase();
        return normalized === 'unnamed' || normalized === 'untitled' || normalized === 'unknown' || normalized === '下载';
    }

    /**
     * 根据 artifactId 在右侧资源列表中反查标题。
     * @param {string|null} artifactId - 资源 ID
     * @returns {string} - 命中的标题，找不到则返回空字符串
     */
    function findTitleByArtifactId(artifactId) {
        if (!artifactId) return '';

        const sourceDocumentId = sourceDocumentIdByResourceId.get(artifactId) || '';
        const sourceDocumentTitle = sourceDocumentTitleById.get(sourceDocumentId) || '';
        if (!isBadTitle(sourceDocumentTitle)) {
            return sourceDocumentTitle;
        }

        const mappedTitle = resourceTitleById.get(artifactId) || '';
        if (!isBadTitle(mappedTitle)) {
            return mappedTitle;
        }

        const container = getArtifactLibraryContainer();
        if (!container) return '';

        const jslogButtons = container.querySelectorAll('button[jslog]');
        for (const btn of jslogButtons) {
            const ids = parseIdsFromJslog(btn.getAttribute('jslog'));
            if (ids.artifactId !== artifactId) continue;

            const row = btn.closest('[role="listitem"], li, .mat-mdc-list-item, .source-item, .artifact-item, div');
            const rowTitle = row ? getRowTitle(row) : '';
            if (!isBadTitle(rowTitle)) {
                return rowTitle;
            }
        }

        return '';
    }

    /**
     * 从当前点击按钮精确解析本次下载应使用的来源文件名。
     * @param {HTMLElement} btn - 当前点击的下载按钮
     * @returns {string} - 最终用于下载的基础文件名
     */
    function resolveDownloadBaseNameFromButton(btn) {
        const ids = parseIdsFromJslog(btn.getAttribute('jslog'));
        const exactTitle = findTitleByArtifactId(ids.artifactId);
        if (!isBadTitle(exactTitle)) {
            if (DEBUG) console.log('[DEBUG] Resolved exact title from artifactId:', ids.artifactId, exactTitle);
            return sanitizeFilename(exactTitle);
        }

        if (ids.artifactId) {
            if (DEBUG) console.log('[DEBUG] Fallback to current artifactId:', ids.artifactId);
            return sanitizeFilename(ids.artifactId);
        }

        if (lastArtifactContext && !isBadTitle(lastArtifactContext.title)) {
            if (DEBUG) console.log('[DEBUG] Fallback to lastArtifactContext title:', lastArtifactContext.title);
            return sanitizeFilename(lastArtifactContext.title);
        }

        const fallback = getSourceName();
        if (DEBUG) console.log('[DEBUG] Fallback to getSourceName():', fallback);
        return sanitizeFilename(fallback);
    }

    /**
     * 绑定“最近资源上下文”，用于下载文件名优先按 artifactId 命中来源标题
     * @param {HTMLElement} btn - 触发按钮
     */
    function bindArtifactContextFromButton(btn) {
        const jslog = btn.getAttribute('jslog');
        const ids = parseIdsFromJslog(jslog);
        if (!ids.artifactId) return;

        const title = findTitleByArtifactId(ids.artifactId) || '';

        lastArtifactContext = {
            notebookId: ids.notebookId || null,
            artifactId: ids.artifactId,
            title: title || '',
            timestamp: Date.now()
        };

        if (DEBUG) {
            console.log('[DEBUG] Bound artifact context:', lastArtifactContext);
        }
    }

    /**
     * 从混合文本中提取首个完整 JSON 数组字符串，避免尾部分块/噪声导致 JSON.parse 失败
     * @param {string} text - 可能包含前缀和分块信息的文本
     * @returns {string|null} - 提取出的完整 JSON 数组字符串
     */
    function extractFirstJsonArray(text) {
        const start = text.indexOf('[');
        if (start === -1) return null;

        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = start; i < text.length; i++) {
            const ch = text[i];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (ch === '\\') {
                    escaped = true;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            }

            if (ch === '"') {
                inString = true;
                continue;
            }

            if (ch === '[') depth++;
            if (ch === ']') depth--;

            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }

        return null;
    }

    /**
     * 解析 batchexecute 外层 block，并返回成功反序列化后的 inner payload 数组。
     * @param {string} rawText - 原始响应文本
     * @returns {Array<any[]>} - 每个 block 的 inner payload
     */
    function parseBatchexecuteInnerPayloads(rawText) {
        let cleaned = rawText.replace(/^\)\]\}'\n/, '').trim();
        const jsonText = extractFirstJsonArray(cleaned);
        if (!jsonText) return [];

        const outer = JSON.parse(jsonText);
        const payloads = [];

        outer.forEach(block => {
            if (!Array.isArray(block)) return;
            const dataStr = block[2];
            if (!dataStr || typeof dataStr !== 'string') return;

            try {
                const inner = JSON.parse(dataStr);
                if (Array.isArray(inner)) {
                    payloads.push(inner);
                }
            } catch {
                // 忽略非 JSON block
            }
        });

        return payloads;
    }

    /**
     * 从任意嵌套数组结构中提取“UUID + 标题”的候选映射，适配来源文档列表接口。
     * @param {any} node - 当前遍历节点
     * @param {Map<string, string>} resultMap - 输出映射表
     * @returns {void}
     */
    function collectUuidTitleMappings(node, resultMap) {
        if (!Array.isArray(node)) return;

        const artifactId = typeof node[0] === 'string' && isUuid(node[0]) ? node[0] : null;
        if (artifactId) {
            for (let i = 1; i < Math.min(node.length, 6); i++) {
                const candidate = node[i];
                if (typeof candidate !== 'string') continue;
                const title = candidate.trim();
                if (!title || isBadTitle(title)) continue;
                if (title.length < 2) continue;
                if (/^[0-9a-f-]{36}$/i.test(title)) continue;
                resultMap.set(artifactId, title);
                break;
            }
        }

        node.forEach(child => collectUuidTitleMappings(child, resultMap));
    }

    /**
     * 规范化来源文档标题，移除原始文档扩展名，避免下载图片时出现 `.md.png` 这类双后缀。
     * @param {string} title - 来源文档标题
     * @returns {string} - 清洗后的标题
     */
    function normalizeSourceDocumentTitle(title) {
        return (title || '')
            .trim()
            .replace(/\.(md|pdf|docx?|pptx?|xlsx?|txt)$/i, '');
    }

    /**
     * 从 `wXbhsf` 的嵌套数组中精确提取来源文档项，结构通常为 `[[artifactId], "文档名", meta, ...]`。
     * @param {any} node - 当前遍历节点
     * @param {Map<string, string>} resultMap - 输出映射表
     * @returns {void}
     */
    function collectSourceDocumentEntries(node, resultMap) {
        if (!Array.isArray(node)) return;

        const idHolder = node[0];
        const titleCandidate = node[1];
        if (Array.isArray(idHolder) && typeof idHolder[0] === 'string' && isUuid(idHolder[0]) && typeof titleCandidate === 'string') {
            const normalizedTitle = normalizeSourceDocumentTitle(titleCandidate);
            if (!isBadTitle(normalizedTitle)) {
                resultMap.set(idHolder[0], normalizedTitle);
            }
        }

        node.forEach(child => collectSourceDocumentEntries(child, resultMap));
    }

    /**
     * 在任意嵌套数组结构中查找第一个 UUID，可选择排除给定 id。
     * @param {any} node - 当前遍历节点
     * @param {Set<string>} [excludedIds] - 需要排除的 UUID 集合
     * @returns {string} - 命中的 UUID，找不到则返回空字符串
     */
    function findFirstUuidInNode(node, excludedIds = new Set()) {
        if (typeof node === 'string') {
            return isUuid(node) && !excludedIds.has(node) ? node : '';
        }

        if (!Array.isArray(node)) return '';

        for (const child of node) {
            const hit = findFirstUuidInNode(child, excludedIds);
            if (hit) return hit;
        }

        return '';
    }

    /**
     * 从 `gArtLc` 的资源详情数据中提取“资源 id -> 来源文档 id”的关系。
     * 典型结构为 `[resourceId, title, type, [[[sourceDocumentId]]], ...]`。
     * @param {any} node - 当前遍历节点
     * @param {Map<string, string>} resultMap - 输出映射表
     * @returns {void}
     */
    function collectResourceSourceEntries(node, resultMap) {
        if (!Array.isArray(node)) return;

        const resourceId = typeof node[0] === 'string' && isUuid(node[0]) ? node[0] : '';
        const sourceRefContainer = node[3];
        if (resourceId && Array.isArray(sourceRefContainer)) {
            const sourceDocumentId = findFirstUuidInNode(sourceRefContainer, new Set([resourceId]));
            if (sourceDocumentId) {
                resultMap.set(resourceId, sourceDocumentId);
            }
        }

        node.forEach(child => collectResourceSourceEntries(child, resultMap));
    }

    /**
     * 解析 `wXbhsf` 返回的引用来源文档列表，抽取 artifactId 到文档标题的映射。
     * @param {string} rawText - 原始响应文本
     * @returns {Array<{artifactId: string, title: string}>} - 解析出的映射列表
     */
    function parseSourceDocumentMappings(rawText) {
        try {
            const payloads = parseBatchexecuteInnerPayloads(rawText);
            const resultMap = new Map();

            payloads.forEach(payload => {
                collectSourceDocumentEntries(payload, resultMap);
                collectUuidTitleMappings(payload, resultMap);
            });

            return Array.from(resultMap.entries()).map(([artifactId, title]) => ({
                artifactId,
                title
            }));
        } catch (err) {
            console.error('[ERROR] parseSourceDocumentMappings 解析失败:', err);
            return [];
        }
    }

    /**
     * 解析 `gArtLc` 返回的右侧资源详情数据，抽取资源 id 到来源文档 id 的映射。
     * @param {string} rawText - 原始响应文本
     * @returns {Array<{resourceId: string, sourceDocumentId: string}>} - 解析出的映射列表
     */
    function parseResourceSourceMappings(rawText) {
        try {
            const payloads = parseBatchexecuteInnerPayloads(rawText);
            const resultMap = new Map();

            payloads.forEach(payload => collectResourceSourceEntries(payload, resultMap));

            return Array.from(resultMap.entries()).map(([resourceId, sourceDocumentId]) => ({
                resourceId,
                sourceDocumentId
            }));
        } catch (err) {
            console.error('[ERROR] parseResourceSourceMappings 解析失败:', err);
            return [];
        }
    }

    /**
     * 解析 NotebookLM batchexecute 接口返回的特殊数据格式，从中提取出资源列表（包括图片、脑图、音视频等信息）
     * @param {string} rawText - 原始响应文本
     * @returns {Array} - 解析后的资源对象数组，包含 title 和 data
     */
    function parseWeirdResponse(rawText) {
        try {
            const results = [];
            const seenTitles = new Set();
            const payloads = parseBatchexecuteInnerPayloads(rawText);

            payloads.forEach(inner => {

                /**
                 * 递归遍历解析结果，提取候选资源标题及其数据载体
                 * @param {any} item - 当前遍历节点
                 */
                function extractData(item) {
                    if (!Array.isArray(item)) return;

                    if (item.length > 5 && typeof item[1] === 'string') {
                        const title = item[1].trim();
                        if (title && !seenTitles.has(title)) {
                            seenTitles.add(title);
                            const artifactId = isUuid(item[0]) ? item[0] : null;
                            results.push({ title, artifactId, data: item });
                        }
                    }

                    item.forEach(extractData);
                }

                extractData(inner);
            });

            if (DEBUG && results.length > 0) {
                console.log(`[DEBUG] parseWeirdResponse 成功解析出 ${results.length} 条资源记录`);
            }
            return results;
        } catch (err) {
            console.error('[ERROR] parseWeirdResponse 解析失败:', err);
            if (DEBUG) {
                console.log('[DEBUG] 解析失败的原始数据片段 (前500字符):', rawText ? rawText.substring(0, 500) : 'null');
            }
            return [];
        }
    }

    // 启动图片下载拦截器
    setupImageDownloadInterceptor();
    // 启动右侧资源列表批量删除工具
    setupBatchDeleteTools();

    setInterval(async () => {
        const svg = findMindMapSvg();
        if (DEBUG && svg) console.log('[DEBUG] Found mindmap SVG');
        if (svg) {
            // 自动点击展开所有节点按钮
            if (!hasExpandedAll) {
                clickExpandAllButton();
            }
            await insertDownloadMarkdownButton(svg);
        }
    }, 1000);

    /**
     * 睡眠指定毫秒，用于等待菜单/对话框动画完成
     * @param {number} ms - 等待毫秒数
     * @returns {Promise<void>} - Promise 对象
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 判断元素是否可见，避免操作隐藏菜单项
     * @param {Element|null} el - 目标元素
     * @returns {boolean} - 是否可见
     */
    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    /**
     * 获取右侧资源列表容器，仅在该容器内注入/统计批量删除复选框
     * @returns {HTMLElement|null} - 资源列表容器
     */
    function getArtifactLibraryContainer() {
        return document.querySelector('div.artifact-library-container');
    }

    /**
     * 查找右侧资源列表中的“更多”按钮，并返回其所属行容器
     * @returns {Array<{row: HTMLElement, moreBtn: HTMLElement}>} - 行与更多按钮映射
     */
    function findResourceRows() {
        const container = getArtifactLibraryContainer();
        if (!container) return [];

        const result = [];
        const seenRows = new Set();
        const moreIconNodes = container.querySelectorAll('mat-icon, span.mat-icon');

        moreIconNodes.forEach(iconNode => {
            const iconText = (iconNode.textContent || '').trim().toLowerCase();
            if (iconText !== 'more_vert' && iconText !== 'more_horiz') return;

            const moreBtn = iconNode.closest('button');
            if (!moreBtn || !isVisible(moreBtn)) return;

            // 优先寻找列表项容器，兜底为最近的可见块级容器
            let row = moreBtn.closest('[role="listitem"], li, .mat-mdc-list-item, .source-item, .artifact-item');
            if (!row) {
                row = moreBtn.closest('div');
            }
            if (!row || seenRows.has(row)) return;
            if (!container.contains(row)) return;

            seenRows.add(row);
            result.push({ row, moreBtn });
        });

        return result;
    }

    /**
     * 从资源行中提取标题文本，用于 UI 展示与日志
     * @param {HTMLElement} row - 资源行容器
     * @returns {string} - 推断出的标题
     */
    function getRowTitle(row) {
        const heading = row.querySelector('[role="heading"], h2, h3, .mat-mdc-list-item-title, .title');
        if (heading && heading.textContent.trim()) return heading.textContent.trim();

        const cloned = row.cloneNode(true);
        cloned.querySelectorAll('mat-icon, .mat-icon, button, [aria-hidden="true"]').forEach(el => el.remove());
        let text = (cloned.textContent || '').replace(/\s+/g, ' ').trim();
        text = text.replace(/\s+\d+\s*个来源.*$/i, '').trim();
        text = text.replace(/\s+more_vert$/i, '').trim();
        text = text.replace(/\s+stacked_bar_chart$/i, '').trim();
        return text.substring(0, 80) || '未命名资源';
    }


    /**
     * 为每个资源行注入复选框
     * @returns {number} - 当前可选资源行数量
     */
    function ensureRowCheckboxes() {
        const rows = findResourceRows();
        rows.forEach(({ row }) => {
            if (row.dataset.batchDeleteEnhanced === 'true') return;
            row.dataset.batchDeleteEnhanced = 'true';

            const rowStyle = window.getComputedStyle(row);
            if (rowStyle.position === 'static') {
                row.style.position = 'relative';
            }

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'notebooklm-batch-delete-checkbox';
            checkbox.title = `选择删除: ${getRowTitle(row)}`;
            checkbox.style.cssText = 'position:absolute;left:8px;top:50%;transform:translateY(-50%);z-index:5;width:16px;height:16px;cursor:pointer;';

            checkbox.addEventListener('click', (e) => e.stopPropagation(), true);
            checkbox.addEventListener('change', () => updateBatchDeleteToolbar());

            row.appendChild(checkbox);

            const currentPaddingLeft = parseFloat(rowStyle.paddingLeft || '0') || 0;
            if (currentPaddingLeft < 28) {
                row.style.paddingLeft = '28px';
            }
        });

        return rows.length;
    }

    /**
     * 获取当前勾选的资源行
     * @returns {HTMLElement[]} - 被选中的资源行数组
     */
    function getSelectedRows() {
        const container = getArtifactLibraryContainer();
        if (!container) return [];

        const checked = container.querySelectorAll('.notebooklm-batch-delete-checkbox:checked');
        return Array.from(checked)
            .map(cb => cb.closest('[data-batch-delete-enhanced="true"]'))
            .filter(Boolean);
    }

    /**
     * 更新工具栏状态（计数、按钮状态、全选状态）
     */
    function updateBatchDeleteToolbar() {
        const toolbar = document.getElementById('notebooklm-batch-delete-toolbar');
        if (!toolbar) return;

        // 删除进行中时不更新（避免覆盖进度提示）
        if (batchDeleteInProgress) return;

        const container = getArtifactLibraryContainer();
        const allCheckboxes = container
            ? Array.from(container.querySelectorAll('.notebooklm-batch-delete-checkbox'))
            : [];
        const selectedCount = allCheckboxes.filter(cb => cb.checked).length;
        const totalCount = allCheckboxes.length;

        const countNode = toolbar.querySelector('.notebooklm-batch-delete-count');
        if (countNode) {
            countNode.textContent = `已选 ${selectedCount}/${totalCount}`;
        }

        const deleteBtn = toolbar.querySelector('.notebooklm-batch-delete-btn');
        if (deleteBtn) {
            deleteBtn.disabled = selectedCount === 0;
            deleteBtn.textContent = `删除 (${selectedCount})`;
        }

        const selectAll = toolbar.querySelector('.notebooklm-batch-select-all');
        if (selectAll) {
            selectAll.checked = totalCount > 0 && selectedCount === totalCount;
            selectAll.indeterminate = selectedCount > 0 && selectedCount < totalCount;
        }
    }

    /**
     * 在按钮附近显示内联确认提示（替代 window.confirm）
     * @param {HTMLElement} anchorEl - 锚定元素
     * @param {string} message - 提示文本
     * @returns {Promise<boolean>} - 用户是否确认
     */
    function showInlineConfirm(anchorEl, message) {
        return new Promise(resolve => {
            // 移除已有的确认提示
            const existing = document.getElementById('notebooklm-inline-confirm');
            if (existing) existing.remove();

            const tip = document.createElement('div');
            tip.id = 'notebooklm-inline-confirm';
            tip.style.cssText = `
                position:absolute; bottom:calc(100% + 6px); right:0;
                background:#2d2e30; color:#e8eaed; border:1px solid #5f6368;
                border-radius:8px; padding:10px 12px; z-index:100;
                box-shadow:0 4px 16px rgba(0,0,0,.3); white-space:nowrap;
                font-size:13px; display:flex; align-items:center; gap:8px;
                animation: notebooklm-tip-in .15s ease-out;
            `;
            tip.innerHTML = `
                <span style="color:#f28b82;">⚠</span>
                <span>${message}</span>
                <button class="notebooklm-confirm-yes" style="border:none;border-radius:6px;padding:4px 12px;background:#d93025;color:#fff;cursor:pointer;font-size:12px;font-weight:500;">确认</button>
                <button class="notebooklm-confirm-no" style="border:none;border-radius:6px;padding:4px 12px;background:#3c4043;color:#e8eaed;cursor:pointer;font-size:12px;">取消</button>
            `;

            // 确保锚定元素有定位上下文
            const anchorStyle = window.getComputedStyle(anchorEl);
            if (anchorStyle.position === 'static') {
                anchorEl.style.position = 'relative';
            }
            anchorEl.appendChild(tip);

            const cleanup = (result) => {
                tip.remove();
                resolve(result);
            };

            tip.querySelector('.notebooklm-confirm-yes').addEventListener('click', (e) => { e.stopPropagation(); cleanup(true); });
            tip.querySelector('.notebooklm-confirm-no').addEventListener('click', (e) => { e.stopPropagation(); cleanup(false); });
        });
    }

    /**
     * 自动点击“更多 -> 删除 -> 确认删除”，删除单条资源
     * @param {HTMLElement} row - 资源行
     * @returns {Promise<boolean>} - 是否删除成功
     */
    async function deleteSingleRowByUi(row) {
        // 检查 row 是否仍在 DOM 中
        if (!row.isConnected) return false;

        const moreBtn = row.querySelector('button mat-icon, button span.mat-icon');
        let triggerBtn = null;
        if (moreBtn) {
            const iconText = (moreBtn.textContent || '').trim().toLowerCase();
            if (iconText === 'more_vert' || iconText === 'more_horiz') {
                triggerBtn = moreBtn.closest('button');
            }
        }
        if (!triggerBtn) return false;

        triggerBtn.click();
        await sleep(220);

        // 菜单中点击“删除”
        const menuItems = Array.from(document.querySelectorAll('[role="menu"] button, .mat-mdc-menu-panel button'));
        const deleteItem = menuItems.find(btn => {
            if (!isVisible(btn)) return false;
            const txt = (btn.textContent || '').replace(/\s+/g, '');
            const hasDeleteText = txt.includes('删除') || txt.toLowerCase().includes('delete');
            const icon = btn.querySelector('mat-icon, .mat-icon');
            const iconText = icon ? (icon.textContent || '').trim().toLowerCase() : '';
            return hasDeleteText || iconText === 'delete';
        });
        if (!deleteItem) return false;

        deleteItem.click();
        await sleep(300);

        // 对话框中点击“删除/确认”
        const dialogButtons = Array.from(document.querySelectorAll('[role="dialog"] button, mat-dialog-container button, .cdk-overlay-pane button'));
        const confirmDeleteBtn = dialogButtons.find(btn => {
            if (!isVisible(btn)) return false;
            const txt = (btn.textContent || '').replace(/\s+/g, '');
            if (!txt) return false;
            if (txt.includes('删除')) return true;
            return txt.toLowerCase() === 'delete';
        });

        if (confirmDeleteBtn) {
            confirmDeleteBtn.click();
            await sleep(520);
            return true;
        }

        return false;
    }

    /**
     * 按标题在当前 DOM 中重新查找资源行（应对列表刷新后旧 DOM 引用失效）
     * @param {string} title - 资源标题
     * @returns {HTMLElement|null} - 找到的行元素
     */
    function findRowByTitle(title) {
        const rows = findResourceRows();
        for (const { row } of rows) {
            if (getRowTitle(row) === title) return row;
        }
        return null;
    }

    /**
     * 等待列表 DOM 稳定（删除操作后列表会刷新重建）
     * @param {number} maxWaitMs - 最长等待时间
     */
    async function waitForListStable(maxWaitMs = 2000) {
        const container = getArtifactLibraryContainer();
        if (!container) return;

        let prevCount = -1;
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            await sleep(200);
            const currentCount = container.querySelectorAll('button mat-icon, button span.mat-icon').length;
            if (currentCount === prevCount && currentCount > 0) return;
            prevCount = currentCount;
        }
    }

    /**
     * 执行批量删除流程：先收集标题，再逐个按标题重新定位并删除。
     * 避免因列表刷新导致 DOM 引用失效而漏删。
     */
    async function runBatchDelete() {
        const selectedRows = getSelectedRows();
        if (selectedRows.length === 0) return;

        // 收集选中行的标题（不依赖 DOM 引用，应对列表刷新）
        const titlesToDelete = selectedRows.map(row => getRowTitle(row));
        const totalCount = titlesToDelete.length;

        // 在删除按钮附近显示内联确认
        const toolbar = document.getElementById('notebooklm-batch-delete-toolbar');
        if (!toolbar) return;

        const confirmed = await showInlineConfirm(toolbar, `删除 ${totalCount} 条资源？不可恢复`);
        if (!confirmed) return;

        batchDeleteInProgress = true;
        const deleteBtn = toolbar.querySelector('.notebooklm-batch-delete-btn');
        const countNode = toolbar.querySelector('.notebooklm-batch-delete-count');

        let successCount = 0;
        let failedTitles = [];

        for (let i = 0; i < titlesToDelete.length; i++) {
            const title = titlesToDelete[i];

            // 更新进度
            if (deleteBtn) {
                deleteBtn.disabled = true;
                deleteBtn.textContent = `删除中 ${i + 1}/${totalCount}`;
            }
            if (countNode) {
                countNode.textContent = `✓${successCount} ✗${failedTitles.length}`;
            }

            // 按标题重新在当前 DOM 中查找行（列表可能已刷新）
            const row = findRowByTitle(title);
            if (!row) {
                // 行已不在 DOM 中，可能已被前一次删除的刷新带走，视为成功
                if (DEBUG) console.log(`[DEBUG] 行已消失，视为已删除: ${title}`);
                successCount += 1;
                continue;
            }

            const ok = await deleteSingleRowByUi(row);
            if (ok) {
                successCount += 1;
            } else {
                failedTitles.push(title);
            }

            // 固定等待 2 秒，确保列表完全刷新后再处理下一条，避免重复删除
            await sleep(2000);
        }

        batchDeleteInProgress = false;

        // 显示结果
        if (countNode) {
            const resultMsg = failedTitles.length > 0
                ? `完成 ✓${successCount} ✗${failedTitles.length}`
                : `已删除 ${successCount} 条`;
            countNode.textContent = resultMsg;
            // 3 秒后恢复正常状态
            setTimeout(() => updateBatchDeleteToolbar(), 3000);
        }
        if (deleteBtn) {
            deleteBtn.disabled = false;
            deleteBtn.textContent = `删除 (0)`;
        }

        if (DEBUG) {
            console.log(`[DEBUG] 批量删除完成: 成功 ${successCount}/${totalCount}`);
            if (failedTitles.length > 0) console.log('[DEBUG] 失败项:', failedTitles);
        }
    }

    /**
     * 创建并维护批量删除工具栏（全选 + 批量删除）
     * 工具栏作为列表容器的首个子元素，随列表滚动，不再悬浮。
     */
    function ensureBatchDeleteToolbar() {
        let toolbar = document.getElementById('notebooklm-batch-delete-toolbar');
        const container = getArtifactLibraryContainer();
        if (!toolbar) {
            toolbar = document.createElement('div');
            toolbar.id = 'notebooklm-batch-delete-toolbar';
            // 使用 normal flow，不再 sticky/fixed，随列表内容滚动
            toolbar.style.cssText = `
                position:relative; margin:6px 8px; width:auto;
                background:#2d2e30; color:#e8eaed;
                padding:6px 10px; border-radius:8px;
                display:flex; align-items:center; gap:8px;
                border:1px solid #3c4043; font-size:12px;
            `;
            toolbar.innerHTML = `
                <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;white-space:nowrap;">
                    <input type="checkbox" class="notebooklm-batch-select-all" />
                    <span>全选</span>
                </label>
                <span class="notebooklm-batch-delete-count" style="font-size:12px;opacity:.9;white-space:nowrap;">已选 0/0</span>
                <button class="notebooklm-batch-delete-btn" style="border:none;border-radius:6px;padding:4px 10px;background:#d93025;color:#fff;cursor:pointer;font-size:12px;line-height:1;white-space:nowrap;margin-left:auto;">删除 (0)</button>
            `;
            if (container) {
                container.prepend(toolbar);
            } else {
                document.body.appendChild(toolbar);
            }

            const selectAll = toolbar.querySelector('.notebooklm-batch-select-all');
            selectAll.addEventListener('change', () => {
                const container = getArtifactLibraryContainer();
                if (!container) return;

                const checkboxes = container.querySelectorAll('.notebooklm-batch-delete-checkbox');
                checkboxes.forEach(cb => {
                    cb.checked = selectAll.checked;
                });
                updateBatchDeleteToolbar();
            });

            const deleteBtn = toolbar.querySelector('.notebooklm-batch-delete-btn');
            deleteBtn.addEventListener('click', async () => {
                await runBatchDelete();
            });
        }

        if (container && toolbar.parentElement !== container) {
            container.prepend(toolbar);
        }
    }

    /**
     * 初始化批量删除工具：持续同步资源行复选框和工具栏状态
     */
    function setupBatchDeleteTools() {
        setInterval(() => {
            ensureBatchDeleteToolbar();
            ensureRowCheckboxes();
            updateBatchDeleteToolbar();
        }, 1200);
    }



    // 自动点击展开所有节点按钮
    function clickExpandAllButton() {
        // 查找展开按钮：包含 expand_all 图标的按钮
        const expandButton = Array.from(document.querySelectorAll('button[mat-icon-button]')).find(btn => {
            const icon = btn.querySelector('mat-icon');
            return icon && icon.textContent.trim() === 'expand_all';
        });

        if (expandButton) {
            if (DEBUG) console.log('[DEBUG] Found expand all button, clicking...');
            expandButton.click();
            hasExpandedAll = true;
            if (DEBUG) console.log('[DEBUG] Clicked expand all button');
        }
    }

    function findMindMapSvg() {
        const svgs = document.querySelectorAll('svg');
        const matchingSvgs = [];

        svgs.forEach(svg => {
            const width = svg.getAttribute('width');
            const height = svg.getAttribute('height');
            if (width === '100%' && height === '100%') {
                matchingSvgs.push(svg);
            }
        });

        if (matchingSvgs.length === 1) {
            return matchingSvgs[0];
        }
    }

    // 获取当前引用资源的名称
    function getSourceName(downloadUrl) {
        // 优先根据最近一次交互的 artifactId 精确命中标题
        if (lastArtifactContext && lastArtifactContext.artifactId) {
            const contextTitle = findTitleByArtifactId(lastArtifactContext.artifactId) || lastArtifactContext.title;
            if (!isBadTitle(contextTitle)) {
                if (DEBUG) console.log('[DEBUG] Using artifact context title:', contextTitle);
                return sanitizeFilename(contextTitle);
            }
        }

        const effectiveUrl = downloadUrl || lastOpenedDownloadUrl;

        // 尝试从 batchexecute 的资源中匹配
        if (effectiveUrl && notebooklmResources && notebooklmResources.length > 0) {
            if (DEBUG) console.log('[DEBUG] Trying to match URL with resources:', effectiveUrl);
            let dlUrl = effectiveUrl.split('=')[0]; // 移除尺寸参数

            // 递归搜索对象或数组中的所有 http 字符串
            function findUrlInObject(obj, targetUrl) {
                if (typeof obj === 'string' && (obj.startsWith('http://') || obj.startsWith('https://')) && obj.length > 20) {
                    let resUrl = obj.split('=')[0];
                    if (targetUrl.includes(resUrl) || resUrl.includes(targetUrl)) {
                        return true;
                    }
                } else if (Array.isArray(obj)) {
                    for (let item of obj) {
                        if (findUrlInObject(item, targetUrl)) return true;
                    }
                } else if (obj !== null && typeof obj === 'object') {
                    for (let key in obj) {
                        if (findUrlInObject(obj[key], targetUrl)) return true;
                    }
                }
                return false;
            }

            for (const res of notebooklmResources) {
                try {
                    if (findUrlInObject(res.data, dlUrl)) {
                        if (!isBadTitle(res.title)) {
                            if (DEBUG) console.log('[DEBUG] Matched batchexecute resource:', res.title);
                            return sanitizeFilename(res.title);
                        }
                    }
                } catch (e) { }
            }
        }

        // 尝试获取当前右侧打开的资源的标题
        // NotebookLM 中查看图片等资源时，标题通常在一个特定的 header 中，例如 h2 或特定的 class
        // 由于没有具体的 DOM 结构，尝试获取弹窗或右侧面板中的粗体/标题文本
        const panelHeaders = document.querySelectorAll('h2, .mat-headline-6, [role="heading"]');
        for (const header of panelHeaders) {
            const headerText = header.textContent.trim();
            if (!isBadTitle(headerText) && notebooklmResources.some(res => res.title === headerText)) {
                if (DEBUG) console.log('[DEBUG] Matched panel header with resource title:', headerText);
                return sanitizeFilename(headerText);
            }
        }

        // 优先：从选中的 checkbox 获取 aria-label
        // 尝试多种选择器以确保兼容性
        let selectedCheckboxes = document.querySelectorAll('input.mdc-checkbox__native-control:checked');

        // 如果没找到，尝试使用 mdc-checkbox--selected 类
        if (selectedCheckboxes.length === 0) {
            selectedCheckboxes = document.querySelectorAll('input.mdc-checkbox__native-control.mdc-checkbox--selected');
        }

        if (DEBUG) console.log('[DEBUG] Found selected checkboxes:', selectedCheckboxes.length);

        if (selectedCheckboxes.length > 0) {
            // 获取所有选中的 aria-label
            const labels = Array.from(selectedCheckboxes)
                .map(cb => cb.getAttribute('aria-label'))
                .filter(label => label && label.trim());

            if (DEBUG) console.log('[DEBUG] Selected labels:', labels);

            if (labels.length > 0) {
                // 如果只有一个选中，使用该名称
                if (labels.length === 1) {
                    const filename = labels[0].replace(/\.md$/i, ''); // 移除 .md 后缀（如果有）
                    if (!isBadTitle(filename)) {
                        if (DEBUG) console.log('[DEBUG] Using single source name:', filename);
                        return sanitizeFilename(filename);
                    }
                }

                // 如果有多个选中，组合名称或使用第一个
                const filename = labels[0].replace(/\.md$/i, ''); // 使用第一个
                if (!isBadTitle(filename)) {
                    if (DEBUG) console.log('[DEBUG] Using first source name from multiple:', filename);
                    return sanitizeFilename(filename);
                }
            }
        }

        // 备选：尝试从页面标题获取
        const title = document.title.replace(' - NotebookLM', '').trim();
        if (title && title !== 'NotebookLM') {
            if (DEBUG) console.log('[DEBUG] Using page title:', title);
            return sanitizeFilename(title);
        }

        // 备选：尝试从 URL 获取
        const urlMatch = window.location.pathname.match(/\/notebook\/([^\/]+)/);
        if (urlMatch) {
            if (DEBUG) console.log('[DEBUG] Using URL path:', urlMatch[1]);
            return sanitizeFilename(urlMatch[1]);
        }

        // 最终兜底：若已有 artifactId 上下文，使用 artifactId 作为文件名，确保不是 unnamed
        if (lastArtifactContext && lastArtifactContext.artifactId) {
            if (DEBUG) console.log('[DEBUG] Fallback to artifactId:', lastArtifactContext.artifactId);
            return sanitizeFilename(lastArtifactContext.artifactId);
        }

        // 默认名称
        if (DEBUG) console.log('[DEBUG] Using default name: mindmap');
        return 'mindmap';
    }

    // 清理文件名，移除不合法字符
    function sanitizeFilename(filename) {
        return filename
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // 移除不合法字符
            .replace(/\s+/g, '_') // 空格替换为下划线
            .substring(0, 200); // 限制长度
    }

    // 监听并修改图片下载的文件名
    function setupImageDownloadInterceptor() {
        // 方法1: 监听 DOM 变化，捕获动态创建的下载链接
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeName === 'A' && node.download) {
                        // 检查是否是图片或音视频文件
                        if (node.download.match(/\.(png|jpg|jpeg|svg|mp3|wav|mp4|webm)$/i)) {
                            // 获取原扩展名
                            const extMatch = node.download.match(/\.([a-z0-9]+)$/i);
                            const ext = extMatch ? extMatch[0] : '.png';
                            const filename = getSourceName(node.href) + ext;
                            node.download = filename;
                            if (DEBUG) console.log('[DEBUG] MutationObserver: Changed filename to:', filename);
                        }
                    }
                });
            });
        });

        const targetNode = document.body || document.documentElement;
        observer.observe(targetNode, {
            childList: true,
            subtree: true
        });

        // 方法2: 拦截 createElement，修改创建的 <a> 标签
        const originalCreateElement = document.createElement.bind(document);
        document.createElement = function (tagName, options) {
            const element = originalCreateElement(tagName, options);
            if (tagName.toLowerCase() === 'a') {
                // 监听 download 属性变化
                const originalSetAttribute = element.setAttribute.bind(element);
                element.setAttribute = function (name, value) {
                    if (name === 'download' && value && value.match(/\.(png|jpg|jpeg|svg|mp3|wav|mp4|webm)$/i)) {
                        const extMatch = value.match(/\.([a-z0-9]+)$/i);
                        const ext = extMatch ? extMatch[0] : '.png';
                        const filename = getSourceName(this.href) + ext;
                        if (DEBUG) console.log('[DEBUG] setAttribute intercepted: Changed', value, 'to', filename);
                        return originalSetAttribute(name, filename);
                    }
                    return originalSetAttribute(name, value);
                };

                // 监听 download 属性的直接赋值
                Object.defineProperty(element, 'download', {
                    get() {
                        return this.getAttribute('download');
                    },
                    set(value) {
                        if (value && value.match(/\.(png|jpg|jpeg|svg|mp3|wav|mp4|webm)$/i)) {
                            const extMatch = value.match(/\.([a-z0-9]+)$/i);
                            const ext = extMatch ? extMatch[0] : '.png';
                            const filename = getSourceName(this.href) + ext;
                            if (DEBUG) console.log('[DEBUG] download property intercepted: Changed', value, 'to', filename);
                            this.setAttribute('download', filename);
                        } else {
                            this.setAttribute('download', value);
                        }
                    }
                });
            }
            return element;
        };

        // 方法3: 监听点击事件
        document.addEventListener('click', (e) => {
            const target = e.target.closest('button');
            if (target) {
                // 记录右侧资源的上下文（用于下载按来源命名）
                if (target.hasAttribute('jslog')) {
                    bindArtifactContextFromButton(target);
                }

                // 右侧“更多”菜单里的“下载(save_alt)”：仅排队重命名，原始下载仍由页面自己发起。
                const iconNode = target.querySelector('mat-icon, .mat-icon');
                const iconText = iconNode ? (iconNode.textContent || '').trim().toLowerCase() : '';
                const btnText = (target.textContent || '').replace(/\s+/g, '');
                const inMenu = !!target.closest('[role="menu"], .mat-mdc-menu-panel, .more-menu');
                if (inMenu && (iconText === 'save_alt' || btnText.includes('下载'))) {
                    const baseName = resolveDownloadBaseNameFromButton(target);
                    lastOpenedDownloadUrl = '';
                    pendingDirectDownload = {
                        baseName,
                        ext: '.png',
                        createdAt: Date.now()
                    };
                    safeSendRuntimeMessage({
                        type: 'QUEUE_DOWNLOAD_RENAME',
                        baseName,
                        url: ''
                    }, response => {
                        if (DEBUG) console.log('[DEBUG] Queued download rename in background:', baseName, response);
                    });
                    if (DEBUG) console.log('[DEBUG] Queued native download rename from menu click:', baseName);
                }

                const mindmapActionsDiv = document.querySelector('.mindmap-actions');
                if (mindmapActionsDiv && mindmapActionsDiv.contains(target)) {
                    const buttons = mindmapActionsDiv.querySelectorAll('button');
                    // 检查是否点击了第二个按钮（图片下载按钮）
                    if (buttons[1] === target) {
                        if (DEBUG) console.log('[DEBUG] Image download button clicked');
                        // 多次延迟检查并修改下载链接
                        [10, 50, 100, 200, 500].forEach(delay => {
                            setTimeout(() => {
                                const links = document.querySelectorAll('a[download]');
                                links.forEach(link => {
                                    if (link.download && link.download.match(/\.(png|jpg|jpeg|svg|mp3|wav|mp4|webm)$/i)) {
                                        const extMatch = link.download.match(/\.([a-z0-9]+)$/i);
                                        const ext = extMatch ? extMatch[0] : '.png';
                                        const filename = getSourceName(link.href) + ext;
                                        link.download = filename;
                                        if (DEBUG) console.log(`[DEBUG] Click handler (${delay}ms): Changed to`, filename);
                                    }
                                });
                            }, delay);
                        });
                    }
                }
            }
        }, true);

        if (DEBUG) console.log('[DEBUG] Image download interceptor setup complete (3 methods)');
    }

    // 修改原有的图片下载按钮
    function modifyImageDownloadButton() {
        const mindmapActionsDiv = document.querySelector('.mindmap-actions');
        if (!mindmapActionsDiv) return;

        const buttons = mindmapActionsDiv.querySelectorAll('button');
        if (buttons.length < 2) return;

        const imageDownloadButton = buttons[1];

        // 检查是否已经修改过
        if (imageDownloadButton.dataset.modified === 'true') {
            return;
        }

        imageDownloadButton.dataset.modified = 'true';

        // 添加点击事件监听器（捕获阶段）
        imageDownloadButton.addEventListener('click', () => {
            if (DEBUG) console.log('[DEBUG] Image download button clicked');
        }, true);

        if (DEBUG) console.log('[DEBUG] Modified image download button');
    }

    async function insertDownloadMarkdownButton(svgElement) {
        const mindmapActionsDiv = document.querySelector('.mindmap-actions');
        let data = {}; // Initialize data object

        if (DEBUG) console.log('[DEBUG] mindmapActionsDiv found:', !!mindmapActionsDiv);

        if (mindmapActionsDiv) {
            // 检查是否已经添加了自定义按钮
            const hasCopyBtn = mindmapActionsDiv.querySelector('.notebooklm-copy-btn');
            const hasDownloadBtn = mindmapActionsDiv.querySelector('.notebooklm-download-btn');

            if (DEBUG) console.log('[DEBUG] Existing buttons:', { hasCopyBtn: !!hasCopyBtn, hasDownloadBtn: !!hasDownloadBtn });

            if (hasCopyBtn || hasDownloadBtn) {
                if (DEBUG) console.log('[DEBUG] Buttons already exist, skipping...');
                return; // 按钮已存在，不重复添加
            }

            const buttons = mindmapActionsDiv.querySelectorAll('button');
            if (DEBUG) console.log('[DEBUG] Found buttons count:', buttons.length);

            if (buttons.length >= 2) {
                const secondButton = buttons[1];

                // 创建复制按钮
                const copyButton = secondButton.cloneNode(true);
                copyButton.classList.add('notebooklm-copy-btn'); // 添加标识类
                // 添加蓝色样式，圆形小按钮
                copyButton.style.backgroundColor = '#1a73e8';
                copyButton.style.color = 'white';
                copyButton.style.width = '32px';
                copyButton.style.height = '32px';
                copyButton.style.minWidth = '32px';
                copyButton.style.padding = '0';
                copyButton.style.borderRadius = '50%';
                copyButton.style.marginRight = '8px';
                copyButton.addEventListener('click', async (event) => {
                    event.preventDefault();
                    const markdownOutput = convertMindmapToMarkdown(svgElement.outerHTML);

                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        try {
                            await navigator.clipboard.writeText(markdownOutput);
                        } catch (err) {
                            console.error('寫入剪貼簿失敗:', err);
                        }
                    } else {
                        const textarea = document.createElement('textarea');
                        textarea.value = markdownOutput;
                        document.body.appendChild(textarea);
                        textarea.select();
                        try {
                            document.execCommand('copy');
                        } catch (err) {
                            console.error('寫入剪貼簿失敗:', err);
                        }
                        document.body.removeChild(textarea);
                    }
                });

                // 创建下载按钮
                const downloadButton = secondButton.cloneNode(true);
                downloadButton.classList.add('notebooklm-download-btn'); // 添加标识类
                // 添加绿色样式，圆形小按钮
                downloadButton.style.backgroundColor = '#34a853';
                downloadButton.style.color = 'white';
                downloadButton.style.width = '32px';
                downloadButton.style.height = '32px';
                downloadButton.style.minWidth = '32px';
                downloadButton.style.padding = '0';
                downloadButton.style.borderRadius = '50%';
                downloadButton.style.marginRight = '8px'
                downloadButton.addEventListener('click', async (event) => {
                    event.preventDefault();
                    const markdownOutput = convertMindmapToMarkdown(svgElement.outerHTML);
                    const filename = getSourceName() + '.md';

                    const blob = new Blob([markdownOutput], { type: 'text/markdown' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                });

                // 设置复制按钮图标
                const copyMatIcon = copyButton.querySelector('mat-icon');
                if (copyMatIcon) {
                    copyMatIcon.textContent = 'content_copy';
                    copyMatIcon.title = 'Copy mindmap content';
                    copyMatIcon.style.color = 'white';
                } else {
                    const copyIconSpan = copyButton.querySelector('.mat-icon');
                    if (copyIconSpan) {
                        copyIconSpan.textContent = 'content_copy';
                        copyIconSpan.title = 'Copy mindmap content';
                        copyIconSpan.style.color = 'white';
                    }
                }

                // 设置下载按钮图标
                const downloadMatIcon = downloadButton.querySelector('mat-icon');
                if (downloadMatIcon) {
                    downloadMatIcon.textContent = 'download';
                    downloadMatIcon.title = 'Download mindmap as markdown';
                    downloadMatIcon.style.color = 'white';
                } else {
                    const downloadIconSpan = downloadButton.querySelector('.mat-icon');
                    if (downloadIconSpan) {
                        downloadIconSpan.textContent = 'download';
                        downloadIconSpan.title = 'Download mindmap as markdown';
                        downloadIconSpan.style.color = 'white';
                    }
                }

                // 修改原有的图片下载按钮
                modifyImageDownloadButton();

                // 插入按钮到页面
                if (DEBUG) console.log('[DEBUG] Inserting buttons...');
                mindmapActionsDiv.insertBefore(copyButton, secondButton);
                mindmapActionsDiv.insertBefore(downloadButton, secondButton);
                if (DEBUG) console.log('[DEBUG] Buttons inserted successfully!');

                data = {
                    success: true,
                    message: 'Copy and download buttons inserted successfully.'
                };

            } else {
                data = {
                    success: false,
                    message: 'Less than two buttons found within .mindmap-actions.'
                };
            }
        } else {
            data = {
                success: false,
                message: '.mindmap-actions element not found.'
            };
        }
        data; // Return the data object
    }


    /**
     * Represents a node in the mindmap.
     */
    class MindmapNode {
        /**
         * @param {string} name - The text content of the node.
         * @param {number} g_x - The x-coordinate from the node's <g> transform.
         * @param {number} g_y - The y-coordinate from the node's <g> transform.
         * @param {number} rect_width - The width of the node's rect element.
         * @param {number} rect_height - The height of the node's rect element.
         */
        constructor(name, g_x, g_y, rect_width, rect_height) {
            this.name = name;
            this.g_x = g_x;
            this.g_y = g_y;
            this.rect_width = rect_width;
            this.rect_height = rect_height;
            this.children = [];
        }
    }

    /**
     * Converts an SVG string representing a mindmap into a Markdown hierarchical list.
     * @param {string} svgString - The SVG content as a string.
     * @returns {string} The mindmap structure in Markdown format.
     */
    function convertMindmapToMarkdown(svgString) {
        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(svgString, "image/svg+xml");
        const gNodes = svgDoc.querySelectorAll('g.node');
        const pathLinks = svgDoc.querySelectorAll('path.link');

        const nodeMap = new Map(); // Map: nodeName -> MindmapNode object (for quick lookup by name)
        // Map: roundedGx -> Map: roundedGy -> MindmapNode[] (for lookup by coordinates)
        const nodesByRoundedCoords = new Map();
        const allNodes = []; // Flat list of all node objects

        const epsilon = 10; // Tolerance for coordinate matching (e.g., to handle minor float differences)

        // 1. Parse all nodes and store them
        gNodes.forEach(g => {
            const transformAttr = g.getAttribute('transform');
            const translateMatch = transformAttr.match(/translate\(([^,]+),([^)]+)\)/);
            if (!translateMatch) return;

            const g_x = parseFloat(translateMatch[1]);
            const g_y = parseFloat(translateMatch[2]);

            const nodeNameText = g.querySelector('text.node-name');
            if (!nodeNameText) return;
            const name = nodeNameText.textContent.trim();

            const rect = g.querySelector('rect');
            const rect_width = rect ? parseFloat(rect.getAttribute('width')) : 0;
            const rect_height = rect ? parseFloat(rect.getAttribute('height')) : 0;

            const node = new MindmapNode(name, g_x, g_y, rect_width, rect_height);
            nodeMap.set(name, node);
            allNodes.push(node);

            const roundedGx = Math.round(g_x);
            const roundedGy = Math.round(g_y);

            if (!nodesByRoundedCoords.has(roundedGx)) {
                nodesByRoundedCoords.set(roundedGx, new Map());
            }
            if (!nodesByRoundedCoords.get(roundedGx).has(roundedGy)) {
                nodesByRoundedCoords.get(roundedGx).set(roundedGy, []);
            }
            nodesByRoundedCoords.get(roundedGx).get(roundedGy).push(node);
        });

        // Get sorted unique g_x coordinates, representing the levels/columns of the mindmap
        const levels = Array.from(nodesByRoundedCoords.keys()).sort((a, b) => a - b);

        // 2. Establish Parent-Child Relationships
        pathLinks.forEach(path => {
            const dAttr = path.getAttribute('d');
            // Regex to extract M x1 y1 and the last C x4 y4 (end point)
            const dCoords = dAttr.match(/M\s*([-.\d]+)\s*([-.\d]+)\s*C.*,\s*([-.\d]+)\s*([-.\d]+)/);
            if (!dCoords) return;

            const x1 = parseFloat(dCoords[1]); // Link start X
            const y1 = parseFloat(dCoords[2]); // Link start Y
            const x4 = parseFloat(dCoords[3]); // Link end X
            const y4 = parseFloat(dCoords[4]); // Link end Y

            let sourceNode = null;
            let targetNode = null;

            // Find Source Node: It's typically on a level to the left of the link's start X (x1),
            // and its g_y should match the link's y1.
            for (const levelX of levels) {
                // Check if this level is a plausible source level (left of or very near link start X)
                if (levelX <= x1 + epsilon) {
                    const nodesAtLevelY = nodesByRoundedCoords.get(levelX)?.get(Math.round(y1));
                    if (nodesAtLevelY && nodesAtLevelY.length > 0) {
                        // Pick the node that is closest to x1 (often the right edge of the source node)
                        // In most mindmaps, there's only one node at a given (g_x, g_y) rounded coordinate.
                        sourceNode = nodesAtLevelY.reduce((prev, curr) =>
                            Math.abs((curr.g_x + curr.rect_width) - x1) < Math.abs((prev.g_x + prev.rect_width) - x1) ? curr : prev
                        );
                        break; // Found the level for the source, break outer loop
                    }
                }
            }

            // Find Target Node: It's typically on a level to the right of the link's start X (x1),
            // and its g_y should match the link's y4.
            for (const levelX of levels) {
                // Check if this level is a plausible target level (right of or very near link end X)
                // And also ensure it's to the right of the identified source node (if any)
                if (levelX >= x1 - epsilon) {
                    const nodesAtLevelY = nodesByRoundedCoords.get(levelX)?.get(Math.round(y4));
                    if (nodesAtLevelY && nodesAtLevelY.length > 0) {
                        // Pick the node that is closest to x4 (often the left edge of the target node)
                        targetNode = nodesAtLevelY.reduce((prev, curr) =>
                            Math.abs(curr.g_x - x4) < Math.abs(prev.g_x - x4) ? curr : prev
                        );
                        break; // Found the level for the target, break outer loop
                    }
                }
            }

            if (sourceNode && targetNode && sourceNode.g_x < targetNode.g_x) { // Ensure parent is to the left of child
                // Add targetNode to sourceNode's children, avoiding duplicates
                if (!sourceNode.children.includes(targetNode)) {
                    sourceNode.children.push(targetNode);
                }
            } else {
                // console.warn(`Could not unambiguously determine source/target for link (${x1},${y1}) -> (${x4},${y4})`);
                // console.warn(`Source found: ${sourceNode?.name}, Target found: ${targetNode?.name}`);
            }
        });

        // 3. Find the root node(s) (nodes with no parents)
        const childNodes = new Set();
        allNodes.forEach(node => {
            node.children.forEach(child => childNodes.add(child));
        });
        const rootNodes = allNodes.filter(node => !childNodes.has(node));

        // For a typical mindmap, there should be one central root.
        // If multiple roots are found, pick the leftmost one.
        const mainRoot = rootNodes.length > 0
            ? rootNodes.reduce((prev, curr) => (prev.g_x < curr.g_x ? prev : curr))
            : (allNodes.length > 0 ? allNodes[0] : null); // Fallback if no roots or no nodes

        if (!mainRoot) {
            return "No mindmap nodes found.";
        }

        // 4. Generate Markdown
        let markdown = '';

        /**
         * Recursively generates Markdown for a node and its children.
         * @param {MindmapNode} node - The current node to process.
         * @param {number} level - The current indentation level.
         */
        function generateMarkdown(node, level) {
            const indent = '  '.repeat(level); // 2 spaces per level
            markdown += `${indent}* ${node.name}\n`;

            // Sort children by their Y-coordinate for consistent vertical ordering in markdown
            node.children.sort((a, b) => a.g_y - b.g_y);

            node.children.forEach(child => {
                generateMarkdown(child, level + 1);
            });
        }

        // Start generating from the main root
        generateMarkdown(mainRoot, 0);

        return markdown;
    }

})();
