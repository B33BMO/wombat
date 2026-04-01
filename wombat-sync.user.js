// ==UserScript==
// @name         Wombat Token Sync
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Syncs Atera session token + captures API calls for Wombat CLI
// @author       wombat
// @match        https://app.atera.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const SERVER_URL = 'http://127.0.0.1:7847';
    let lastToken = null;
    let statusIndicator = null;

    // Capture buffer — batch API calls before sending to server
    let captureBuffer = [];
    let flushTimer = null;
    const FLUSH_INTERVAL = 2000; // send every 2s

    function bufferCapture(entry) {
        captureBuffer.push(entry);
        if (!flushTimer) {
            flushTimer = setTimeout(flushCaptures, FLUSH_INTERVAL);
        }
    }

    function flushCaptures() {
        flushTimer = null;
        if (captureBuffer.length === 0) return;
        const batch = captureBuffer.splice(0);
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${SERVER_URL}/captures`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(batch),
            onload: function() {},
            onerror: function() {}
        });
    }

    // Intercept fetch to capture Authorization headers + API calls
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const request = args[0];
        const options = args[1] || {};
        const url = typeof request === 'string' ? request : request?.url;

        const response = await originalFetch.apply(this, args);

        try {
            let authHeader = null;

            // Check for Authorization header
            if (options.headers) {
                if (options.headers instanceof Headers) {
                    authHeader = options.headers.get('Authorization');
                } else if (typeof options.headers === 'object') {
                    authHeader = options.headers['Authorization'] || options.headers['authorization'];
                }
            }

            if (authHeader && authHeader.startsWith('Bearer eyJ') && authHeader !== lastToken) {
                lastToken = authHeader;
                syncTokenToServer(authHeader);
            }

            // Capture /proxy/ API calls
            if (url && url.includes('/proxy/')) {
                const clone = response.clone();
                const resBody = await clone.text().catch(() => '');
                bufferCapture({
                    timestamp: new Date().toISOString(),
                    method: options.method || 'GET',
                    url: url,
                    requestBody: options.body || null,
                    status: response.status,
                    responseBody: resBody.substring(0, 4000),
                });
            }
        } catch (e) {
            // Ignore errors in interception
        }

        return response;
    };

    // Intercept XHR to capture Authorization headers + API calls
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._ateraHeaders = {};
        this._wombatMethod = method;
        this._wombatUrl = url;
        return originalXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        if (name.toLowerCase() === 'authorization' && value.startsWith('Bearer eyJ')) {
            this._ateraHeaders[name] = value;
            if (value !== lastToken) {
                lastToken = value;
                syncTokenToServer(value);
            }
        }
        return originalXHRSetHeader.apply(this, arguments);
    };

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
        const xhr = this;
        const url = this._wombatUrl;
        if (url && url.includes('/proxy/')) {
            xhr.addEventListener('load', function() {
                bufferCapture({
                    timestamp: new Date().toISOString(),
                    method: xhr._wombatMethod || 'GET',
                    url: url,
                    requestBody: body || null,
                    status: xhr.status,
                    responseBody: (xhr.responseText || '').substring(0, 4000),
                });
            });
        }
        return origSend.apply(this, arguments);
    };

    function syncTokenToServer(token) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${SERVER_URL}/token`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ token }),
            onload: function(response) {
                if (response.status === 200) {
                    updateStatus('success', 'Synced');
                    console.log('[Wombat] Token synced successfully');
                }
            },
            onerror: function() {
                updateStatus('error', 'Server offline');
            }
        });
    }

    function getToken() {
        return lastToken;
    }

    function createStatusIndicator() {
        const indicator = document.createElement('div');
        indicator.id = 'atera-token-sync-indicator';
        indicator.style.cssText = `
            position: fixed;
            bottom: 10px;
            right: 10px;
            padding: 8px 12px;
            background: #1a1a2e;
            color: #eee;
            border-radius: 6px;
            font-family: monospace;
            font-size: 11px;
            z-index: 999999;
            display: flex;
            align-items: center;
            gap: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            cursor: pointer;
            user-select: none;
            transition: opacity 0.3s;
        `;

        indicator.innerHTML = `
            <span id="ats-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #888;"></span>
            <span id="ats-text"> Wombat</span>
        `;

        indicator.title = lastToken ? 'Token captured!' : 'Navigate Atera to capture token';
        indicator.addEventListener('click', () => {
            if (lastToken) {
                syncTokenToServer(lastToken);
            } else {
                updateStatus('waiting', 'Navigate page...');
            }
        });

        // Auto-hide after 5 seconds, show on hover
        let hideTimeout;
        const autoHide = () => {
            hideTimeout = setTimeout(() => {
                indicator.style.opacity = '0.3';
            }, 5000);
        };

        indicator.addEventListener('mouseenter', () => {
            clearTimeout(hideTimeout);
            indicator.style.opacity = '1';
        });

        indicator.addEventListener('mouseleave', autoHide);

        document.body.appendChild(indicator);
        autoHide();

        return indicator;
    }

    function updateStatus(status, message) {
        if (!statusIndicator) return;

        const dot = statusIndicator.querySelector('#ats-dot');
        const text = statusIndicator.querySelector('#ats-text');

        const colors = {
            success: '#00ff88',
            error: '#ff4444',
            syncing: '#ffaa00',
            waiting: '#888'
        };

        dot.style.background = colors[status] || colors.waiting;
        text.textContent = message || 'Token Sync';

        // Flash the indicator
        statusIndicator.style.opacity = '1';
    }

    function checkServerHealth() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: `${SERVER_URL}/health`,
            onload: function(response) {
                if (response.status === 200) {
                    updateStatus('success', 'Listening...');
                } else {
                    updateStatus('error', 'Server error');
                }
            },
            onerror: function() {
                updateStatus('waiting', 'Server offline');
            }
        });
    }

    // Initialize
    function init() {
        statusIndicator = createStatusIndicator();
        checkServerHealth();
        console.log('[Wombat Token Sync] v2.0 - Intercepting API requests for token');
    }

    // Wait for DOM to be ready for the indicator
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
