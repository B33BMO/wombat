// ==UserScript==
// @name         Unicorn Token Sync
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Syncs Unicorn session cookie to local token server for CLI access
// @author       You
// @match        https://unicorn.cyburity.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function() {
    'use strict';

    const TOKEN_SERVER = 'http://127.0.0.1:7847';
    const SYNC_INTERVAL = 30000; // 30 seconds

    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    function sendToken(token) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${TOKEN_SERVER}/unicorn/token`,
            headers: {
                'Content-Type': 'application/json'
            },
            data: JSON.stringify({ token: token }),
            onload: function(response) {
                if (response.status === 200) {
                    console.log('[Unicorn Sync] Token synced to local server');
                } else {
                    console.log('[Unicorn Sync] Failed to sync token:', response.statusText);
                }
            },
            onerror: function(error) {
                console.log('[Unicorn Sync] Token server not running (start with: node token-server.js)');
            }
        });
    }

    function syncToken() {
        // First try document.cookie
        let token = getCookie('token');

        if (token) {
            sendToken(token);
            return;
        }

        // If not found, try GM_cookie for HttpOnly cookies
        GM_cookie.list({ name: 'token' }, function(cookies) {
            if (cookies && cookies.length > 0) {
                token = cookies[0].value;
                sendToken(token);
            } else {
                console.log('[Unicorn Sync] No token cookie found (checked both regular and HttpOnly)');
            }
        });
    }

    // Initial sync
    console.log('[Unicorn Sync] Starting token sync...');
    syncToken();

    // Periodic sync
    setInterval(syncToken, SYNC_INTERVAL);

    // Sync on visibility change (when tab becomes active)
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) {
            syncToken();
        }
    });
})();
