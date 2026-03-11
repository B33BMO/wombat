// ==UserScript==
// @name         Wombat Token Sync
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Automatically syncs Atera session token to Wombat CLI
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

    // Intercept fetch to capture Authorization headers
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);

        try {
            const request = args[0];
            const options = args[1] || {};
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
        } catch (e) {
            // Ignore errors in interception
        }

        return response;
    };

    // Intercept XHR to capture Authorization headers
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function(...args) {
        this._ateraHeaders = {};
        return originalXHROpen.apply(this, args);
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

    function syncTokenToServer(token) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${SERVER_URL}/token`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ token }),
            onload: function(response) {
                if (response.status === 200) {
                    updateStatus('success', 'Synced ✓');
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
        console.log('[Wombat] v2.0 - Token sync active');
    }

    // Wait for DOM to be ready for the indicator
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
