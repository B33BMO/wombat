// ==UserScript==
// @name         Wombat API Sniffer
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Captures Atera API calls and sends to local server
// @author       wombat
// @match        https://app.atera.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const captured = [];
    const TOKEN_SERVER = 'http://127.0.0.1:7847';

    function sendToServer(entry) {
        // Use GM_xmlhttpRequest for cross-origin to localhost
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            GM_xmlhttpRequest({
                method: 'POST',
                url: TOKEN_SERVER + '/endpoints',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(entry),
                onload: function(response) {
                    // Silent success
                },
                onerror: function(error) {
                    // Server not running, ignore
                }
            });
        } else {
            // Fallback to fetch
            fetch(TOKEN_SERVER + '/endpoints', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(entry)
            }).catch(() => {});
        }
    }

    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const options = args[1] || {};

        const response = await originalFetch.apply(this, args);

        // Only log proxy API calls
        if (url && url.includes('/proxy/')) {
            try {
                const clone = response.clone();
                const body = await clone.text();

                const entry = {
                    timestamp: new Date().toISOString(),
                    method: options.method || 'GET',
                    url: url,
                    requestBody: options.body || null,
                    status: response.status,
                    responseBody: body.substring(0, 2000) // Truncate large responses
                };

                captured.push(entry);
                sendToServer(entry);
                console.log(`%c[Wombat] ${entry.method} ${url}`, 'color: #00ff88; font-weight: bold');
                console.log('  Request:', options.body ? JSON.parse(options.body) : null);
                console.log('  Response:', body.length > 500 ? body.substring(0, 500) + '...' : body);
            } catch (e) {
                // Ignore errors
            }
        }

        return response;
    };

    // Intercept XHR
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._wombatMethod = method;
        this._wombatUrl = url;
        return originalXHROpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
        const xhr = this;
        const url = this._wombatUrl;

        if (url && url.includes('/proxy/')) {
            xhr.addEventListener('load', function() {
                const entry = {
                    timestamp: new Date().toISOString(),
                    method: xhr._wombatMethod,
                    url: url,
                    requestBody: body,
                    status: xhr.status,
                    responseBody: xhr.responseText?.substring(0, 2000)
                };

                captured.push(entry);
                sendToServer(entry);
                console.log(`%c[Wombat] ${entry.method} ${url}`, 'color: #00ff88; font-weight: bold');
                console.log('  Request:', body ? JSON.parse(body) : null);
                console.log('  Response:', xhr.responseText?.length > 500 ? xhr.responseText.substring(0, 500) + '...' : xhr.responseText);
            });
        }

        return originalXHRSend.apply(this, arguments);
    };

    // Export captured data
    window.wombatExport = function() {
        console.log('%c[Wombat] Exporting captured API calls...', 'color: #ffaa00');
        console.log(JSON.stringify(captured, null, 2));
        return captured;
    };

    window.wombatClear = function() {
        captured.length = 0;
        console.log('%c[Wombat] Cleared captured data', 'color: #ffaa00');
    };

    console.log('%c[Wombat] API Sniffer Active', 'color: #00ff88; font-size: 14px; font-weight: bold');
    console.log('%cCapturing /proxy/ API calls. Auto-syncing to localhost:7847', 'color: #888');
    console.log('%cRun wombatExport() to get captured data locally.', 'color: #888');
})();
