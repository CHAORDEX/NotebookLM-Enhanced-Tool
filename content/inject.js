/**
 * 拦截页面环境的 XMLHttpRequest 和 fetch 请求，捕获 batchexecute 接口的响应，
 * 并将其通过 postMessage 发送回 content-script 进行处理。
 */
(function () {
    const NOTEBOOKLM_DOWNLOAD_HOSTS = [
        'lh3.googleusercontent.com/',
        'lh3.google.com/'
    ];

    /**
     * 判断是否为 NotebookLM 资源下载 URL。
     * @param {string} url - 候选 URL
     * @returns {boolean} - 是否匹配
     */
    function isNotebooklmDownloadUrl(url) {
        return NOTEBOOKLM_DOWNLOAD_HOSTS.some(host => url.includes(host));
    }

    /**
     * 规范化 NotebookLM 资源 URL，去掉包裹符号和空白。
     * @param {string} url - 原始 URL
     * @returns {string} - 清洗后的 URL
     */
    function normalizeNotebooklmUrl(url) {
        return (url || '')
            .trim()
            .replace(/^['"`]+|['"`]+$/g, '');
    }

    /**
     * 向 content-script 发送下载资源 URL，辅助来源命名
     * @param {string} url - 下载资源地址
     */
    function postDownloadUrl(url) {
        try {
            const normalizedUrl = normalizeNotebooklmUrl(url);
            if (!normalizedUrl || typeof normalizedUrl !== 'string') return;
            if (!isNotebooklmDownloadUrl(normalizedUrl)) return;
            window.postMessage({
                type: 'NOTEBOOKLM_DOWNLOAD_URL',
                url: normalizedUrl
            }, '*');
        } catch (e) {
            console.error('Error posting download url:', e);
        }
    }

    const XHR = XMLHttpRequest.prototype;
    const open = XHR.open;
    const send = XHR.send;

    XHR.open = function (method, url) {
        this._method = method;
        this._url = url ? url.toString() : '';
        return open.apply(this, arguments);
    };

    XHR.send = function () {
        this.addEventListener('load', function () {
            if (this._url && typeof this._url === 'string' && this._url.includes('batchexecute')) {
                try {
                    window.postMessage({
                        type: 'NOTEBOOKLM_BATCHEXECUTE_RESPONSE',
                        url: this._url,
                        responseText: this.responseText
                    }, '*');
                } catch (e) {
                    console.error('Error parsing batchexecute response:', e);
                }
            }
        });
        return send.apply(this, arguments);
    };

    const originalFetch = window.fetch;
    window.fetch = async function () {
        const response = await originalFetch.apply(this, arguments);
        const arg0 = arguments[0];
        const url = arg0 instanceof Request ? arg0.url : (arg0 ? arg0.toString() : '');

        if (url && url.includes('batchexecute')) {
            const clone = response.clone();
            clone.text().then(text => {
                window.postMessage({
                    type: 'NOTEBOOKLM_BATCHEXECUTE_RESPONSE',
                    url: url,
                    responseText: text
                }, '*');
            }).catch(e => console.error(e));
        }
        return response;
    };

    // 监听新开 tab 下载，但不阻断原始流程，只负责上报真实 URL 给 content-script。
    const originalOpen = window.open;
    window.open = function () {
        const urlArg = arguments[0];
        const openUrl = normalizeNotebooklmUrl(urlArg ? urlArg.toString() : '');
        if (isNotebooklmDownloadUrl(openUrl)) {
            postDownloadUrl(openUrl);
        }
        return originalOpen.apply(this, arguments);
    };

    // 兜底监听 <a> 点击，捕获 target=_blank 的下载链接
    document.addEventListener('click', function (event) {
        const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!anchor) return;
        const href = normalizeNotebooklmUrl(anchor.href);
        postDownloadUrl(href);
    }, true);
})();
