// ==UserScript==
// @name         CamRadar PiP Assistant
// @namespace    https://cbnewgirls.com/camradar-pip
// @version      3.0.3
// @description  Picture-in-Picture (PiP) helper for Stripchat, Chaturbate, Bongacams, Cam4 and CamSoda — keep playing when the tab is hidden (no pause, no quality drop), one-click native PiP, discover new models
// @author       CamRadar
// @license      MIT
// @match        *://*.stripchat.com/*
// @match        *://stripchat.com/*
// @match        *://*.chaturbate.com/*
// @match        *://chaturbate.com/*
// @match        *://*.bongacams.com/*
// @match        *://bongacams.com/*
// @match        *://*.cam4.com/*
// @match        *://cam4.com/*
// @match        *://*.camsoda.com/*
// @match        *://camsoda.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* ================================================================
     * CONFIG (edit here)
     * ================================================================ */
    // Keep playing when the tab is hidden (no pause / no quality drop).
    // Set to false to disable this feature instantly if the script gets reported.
    const ENABLE_ANTI_BLUR = true;
    // Per-platform "new models" channel links — the channel of the platform
    // you are currently on is shown on the toolbar button.
    // (Source: camradar/core/config.py NEW_GIRLS_CHANNELS)
    const PLATFORM_GROUPS = {
        'SC':   { name: 'SC New Girls',   url: 'https://t.me/SC_New_Girls_Vip' },
        'CB':   { name: 'CB New Girls',   url: 'https://t.me/cb_new_girls_vip' },
        'BC':   { name: 'BC New Girls',   url: 'https://t.me/BC_New_Girls_Vip' },
        'CAM4': { name: 'Cam4 New Girls', url: 'https://t.me/Cam4_New_Girls_Vip' },
        'CS':   { name: 'CS New Girls',   url: 'https://t.me/CS_New_Girls_Vip' },
    };
    const DEBUG = true;              // Diagnostic output (video inventory to console)
    const UI_POS_KEY = 'camradar-ui-pos-v3';
    /* ================================================================ */

    // ---- Platform detection ----
    const HOST = location.hostname.toLowerCase();
    const PLATFORM = HOST.includes('stripchat') ? 'SC'
        : HOST.includes('chaturbate') ? 'CB'
        : HOST.includes('bongacams') ? 'BC'
        : HOST.includes('cam4') ? 'CAM4'
        : HOST.includes('camsoda') ? 'CS' : 'OTHER';
    const GROUP = PLATFORM_GROUPS[PLATFORM] || null;

    /* ================= 1. Anti-blur (keep playing) ================= */
    if (ENABLE_ANTI_BLUR) {
        const constantProp  = { get: () => false,     enumerable: true, configurable: true };
        const constantState = { get: () => 'visible', enumerable: true, configurable: true };
        try { Object.defineProperty(document, 'hidden', constantProp); } catch (e) {}
        try { Object.defineProperty(document, 'visibilityState', constantState); } catch (e) {}
        try { Object.defineProperty(document, 'webkitVisibilityState', constantState); } catch (e) {}
        const blockEvent = (e) => { e.stopImmediatePropagation(); e.stopPropagation(); };
        ['visibilitychange', 'webkitvisibilitychange', 'blur'].forEach(evt => {
            window.addEventListener(evt, blockEvent, true);
            document.addEventListener(evt, blockEvent, true);
        });
    }

    /* ================= Utils ================= */
    function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
    function loadPos(key) {
        try {
            const p = JSON.parse(localStorage.getItem(key));
            if (typeof p.left === 'number' && typeof p.top === 'number') return p;
        } catch (e) {}
        return null;
    }
    function savePos(key, left, top) {
        try { localStorage.setItem(key, JSON.stringify({ left, top })); } catch (e) {}
    }

    /**
     * Deep video discovery (V2.2, keeps PiP working on Cam4):
     * Some platforms render the player inside shadow DOM or a same-origin iframe,
     * which a plain querySelectorAll never sees. Walk every open shadow root and
     * every same-origin frame to find all <video> elements. Cached 500ms.
     */
    let _videoCache = [];
    let _videoCacheTs = 0;
    function deepQueryAllVideos() {
        const now = Date.now();
        if (now - _videoCacheTs < 500) return _videoCache;
        const vids = new Set();
        const walkShadow = (root) => {
            root.querySelectorAll('video').forEach(v => vids.add(v));
            root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walkShadow(el.shadowRoot); });
        };
        const walkDoc = (doc) => {
            try {
                doc.querySelectorAll('video').forEach(v => vids.add(v));
                doc.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walkShadow(el.shadowRoot); });
            } catch (e) {}
        };
        walkDoc(document);
        // Same-origin frames only (cross-origin access throws and is skipped)
        try {
            Array.from(window.frames || []).forEach(f => { try { walkDoc(f.document); } catch (e) {} });
        } catch (e) {}
        _videoCache = Array.from(vids);
        _videoCacheTs = now;
        return _videoCache;
    }

    /**
     * Ad container detection with word-boundary regex (V2.2):
     * The old [class*="ad"] substring selector wrongly matched normal words
     * such as "adaptive"/"admin" and hid the main player on Cam4.
     */
    function isAdContainer(el) {
        const text = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
        return /\b(banner|promo|sponsor|advert)\b/.test(text) ||
               /(^|[\s_\-])(ad|ads)([\s_\-]|$)/.test(text);
    }

    /**
     * "Real video" heuristic (V2.2): accept any video that is playing —
     * do NOT depend on videoWidth/videoHeight (MSE streams may not expose it,
     * which caused the V2.1 regression on Cam4).
     */
    function isRealVideo(v) {
        if (!v.isConnected) return false;
        const playing = !v.paused && (v.currentTime > 0 || v.readyState >= 2);
        const hasSize = v.videoWidth > 0 || v.videoHeight > 0;
        if (!playing && !hasSize) return false;
        // Ad container exclusion (word-boundary, no false positives)
        let node = v;
        while (node && node !== document.body) {
            if (isAdContainer(node)) return false;
            node = node.parentElement;
        }
        // Visibility check on ancestors
        node = v;
        while (node && node !== document.body) {
            const cs = getComputedStyle(node);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
            node = node.parentElement;
        }
        return true;
    }

    function getRealVideos() {
        return deepQueryAllVideos().filter(isRealVideo);
    }

    // Best video = the largest one on screen (by layout size, not videoWidth)
    function getBestVideo() {
        const vids = getRealVideos();
        if (!vids.length) return null;
        return vids.sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            const sa = (ra.width || a.videoWidth) * (ra.height || a.videoHeight);
            const sb = (rb.width || b.videoWidth) * (rb.height || b.videoHeight);
            return sb - sa;
        })[0];
    }

    // Fallback for WebRTC/custom rendering: canvas -> MediaStream -> hidden <video> -> PiP
    function getBigCanvas() {
        const cs = Array.from(document.querySelectorAll('canvas'))
            .filter(c => c.width >= 320 && c.height >= 180 && c.getBoundingClientRect().width > 0);
        if (!cs.length) return null;
        return cs.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    }
    function requestCanvasPip(canvas) {
        try {
            const stream = canvas.captureStream(30);
            const v = document.createElement('video');
            v.srcObject = stream;
            v.muted = true;
            v.playsInline = true;
            v.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
            document.body.appendChild(v);
            v.play().then(() => {
                try { v.disablePictureInPicture = false; } catch (e) {}
                v.requestPictureInPicture().catch(err => {
                    console.error('Canvas PiP failed:', err);
                    v.remove();
                });
            }).catch(err => {
                console.error('Canvas stream failed to play:', err);
                v.remove();
            });
        } catch (e) {
            console.error('canvas.captureStream failed:', e);
        }
    }

    function requestPip(video) {
        try { video.disablePictureInPicture = false; } catch (e) {}
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture();
        } else {
            video.requestPictureInPicture().catch(err => {
                console.error('PiP failed:', err);
                alert('PiP failed: wait until the stream has started, then try again');
            });
        }
    }

    /* ================= 2. Toolbar ================= */
    function createMainButton() {
        if (!document.body) return;
        if (document.getElementById('camradar-ui')) return;

        const container = document.createElement('div');
        container.id = 'camradar-ui';
        container.style.cssText = `
            position: fixed; z-index: 999999;
            background: rgba(0, 0, 0, 0.82); padding: 8px; border-radius: 8px;
            border: 1px solid #ff0055; display: flex; flex-direction: column; gap: 8px;
            user-select: none;
        `;
        const saved = loadPos(UI_POS_KEY);
        if (saved) {
            container.style.left = saved.left + 'px';
            container.style.top  = saved.top + 'px';
            container.style.right = 'auto';
        } else {
            container.style.top = '80px';
            container.style.right = '20px';
        }

        const dragBar = document.createElement('div');
        dragBar.textContent = '⇅ Drag';
        dragBar.style.cssText = `
            color: #fff; font-weight: bold; font-size: 12px; padding: 4px 8px;
            border-radius: 6px; background: rgba(255, 0, 85, 0.25); cursor: move;
            text-align: center; touch-action: none;
        `;

        // PiP button: always targets the largest real video on screen
        const btn = document.createElement('button');
        btn.innerHTML = '📺 PiP';
        btn.style.cssText = `
            background: #ff0055; color: white; border: none; padding: 8px 15px;
            border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 14px;
            white-space: nowrap;
        `;
        btn.onclick = () => {
            const reals = getRealVideos();
            if (reals.length) { requestPip(getBestVideo()); return; }
            const canvas = getBigCanvas();
            if (canvas) { requestCanvasPip(canvas); return; }
            alert('No video stream found (no video/canvas). Open the console (F12) and report the diagnostics.');
        };

        // Ad button: "Discover new models" — opens the current platform's channel
        const adBtn = document.createElement('button');
        adBtn.innerHTML = GROUP
            ? `⚡ Discover New Models<br><span style="font-size:11px;color:#ffd;">→ ${GROUP.name}</span>`
            : '⚡ Discover New Models';
        adBtn.title = GROUP ? `Join ${GROUP.name}` : 'Channel not configured';
        adBtn.style.cssText = `
            background: linear-gradient(135deg, #ff0055, #ff8c00); color: white;
            border: none; padding: 9px 12px; border-radius: 6px; cursor: pointer;
            font-weight: bold; font-size: 13px; line-height: 1.4; white-space: nowrap;
        `;
        adBtn.onclick = () => {
            if (GROUP) { try { window.open(GROUP.url, '_blank'); } catch (e) {} }
        };

        container.appendChild(dragBar);
        container.appendChild(btn);
        container.appendChild(adBtn);
        document.body.appendChild(container);

        // Drag logic (drag bar only)
        let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
        function getLeftTop() {
            const r = container.getBoundingClientRect();
            return { left: r.left, top: r.top };
        }
        dragBar.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            dragging = true;
            const cur = getLeftTop();
            startLeft = cur.left; startTop = cur.top;
            startX = e.clientX; startY = e.clientY;
            container.style.right = 'auto';
            container.style.left  = startLeft + 'px';
            container.style.top   = startTop + 'px';
            try { dragBar.setPointerCapture(e.pointerId); } catch (err) {}
        });
        dragBar.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const nl = clamp(startLeft + e.clientX - startX, 0, window.innerWidth  - container.offsetWidth);
            const nt = clamp(startTop  + e.clientY - startY, 0, window.innerHeight - container.offsetHeight);
            container.style.left = nl + 'px';
            container.style.top  = nt + 'px';
        });
        dragBar.addEventListener('pointerup', (e) => {
            if (!dragging) return;
            dragging = false;
            try { dragBar.releasePointerCapture(e.pointerId); } catch (err) {}
            const cur = getLeftTop();
            savePos(UI_POS_KEY, cur.left, cur.top);
        });
        dragBar.addEventListener('pointercancel', () => { dragging = false; });
    }

    /* ================= 3. Diagnostics (troubleshooting) ================= */
    let diagDone = false;
    function diag() {
        if (!DEBUG || diagDone) return;
        diagDone = true;
        const all = deepQueryAllVideos();
        const iframes = Array.from(document.querySelectorAll('iframe'));
        const canvases = Array.from(document.querySelectorAll('canvas'));
        console.log(`[CamRadar] ${all.length} video element(s) on page (platform: ${PLATFORM})` +
                    ` | iframe: ${iframes.length} | canvas: ${canvases.length}`);
        if (all.length) {
            console.table(all.map((v, i) => {
                const r = v.getBoundingClientRect();
                const cs = getComputedStyle(v);
                return {
                    '#': i,
                    'size': `${v.videoWidth}x${v.videoHeight}`,
                    'rect': `${Math.round(r.width)}x${Math.round(r.height)}`,
                    'visible': r.width > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
                    'playing': !v.paused,
                    'real': isRealVideo(v) ? 'YES' : '-',
                    'container': (v.parentElement ? (v.parentElement.id || v.parentElement.className || '?') : '?').toString().slice(0, 24),
                };
            }));
        } else {
            console.warn('[CamRadar] WARNING: no <video> element found on the page');
            if (canvases.length) {
                console.warn(`[CamRadar] but ${canvases.length} canvas(es) found (possible WebRTC/custom render):`,
                    canvases.slice(0, 5).map(c => `${c.width}x${c.height}`));
            }
        }
        const globals = [];
        ['Hls', 'hls', 'videojs', 'jwplayer', 'clappr', 'flowplayer', 'dashjs', 'MediaElement']
            .forEach(k => { if (window[k] !== undefined) globals.push(k); });
        if (globals.length) console.log('[CamRadar] player libraries detected:', globals.join(', '));
        console.log('[CamRadar] pictureInPicture support:',
            'pictureInPictureEnabled' in document && document.pictureInPictureEnabled);
    }

    /* ================= 4. Main loop ================= */
    setInterval(() => {
        createMainButton();
        diag();
        deepQueryAllVideos().forEach(v => {
            try {
                if (v.disablePictureInPicture !== false) v.disablePictureInPicture = false;
            } catch (e) {}
            v.oncontextmenu = (e) => e.stopPropagation();
        });
    }, 2000);

    console.log(`✅ CamRadar PiP Assistant V3.0 ready (platform: ${PLATFORM}${GROUP ? ' · channel: ' + GROUP.name : ''})`);
    console.log('💡 PiP: click "📺 PiP"; the ad button opens the new-models channel of this platform.');
})();
