// ==UserScript==
// @name         Pixiv Discovery Anti-Reload
// @namespace    http://tampermonkey.net/
// @version      1.7.0
// @description
// Pixivのディスカバリーページでブラウザバック時の作品リストとスクロール位置を復元します
// @author       Anti-Pixiv-Reloader
// @match        https://www.pixiv.net/*
// @icon         https://www.pixiv.net/favicon.ico
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SCROLL_KEY = 'pixiv_discovery_scroll';
  const NAVIGATION_FLAG = 'pixiv_navigated_away';
  const API_CACHE_KEY = 'pixiv_discovery_api_cache';
  const PAGE_LOAD_ID_KEY = 'pixiv_page_load_id';

  const RESTORE_WINDOW = 15000;  // 戻り直後の復元に使う猶予（短すぎると不安定になりがち）

  // sessionStorageは容量が小さいので、Discovery APIキャッシュは上限を設ける
  const API_CACHE_VERSION = 2;
  const API_CACHE_MAX_ENTRIES = 25;

  let isReturningFromNavigation = false;
  let returnTimestamp = 0;
  let scrollRestored = false;  // スクロール復元済みフラグ

  function isDiscoveryPage() {
    return window.location.pathname.startsWith('/discovery');
  }

  function getFetchUrlString(url) {
    if (typeof url === 'string') return url;
    try {
      // Requestオブジェクト
      if (url && typeof url === 'object' && 'url' in url) {
        return String(url.url);
      }
    } catch (e) {
    }
    return String(url);
  }

  // ページリロードかどうかを検出
  function isPageReload() {
    try {
      // Navigation Timing API v2
      const entries = performance.getEntriesByType('navigation');
      if (entries.length > 0) {
        return entries[0].type === 'reload';
      }
      // フォールバック
      if (performance.navigation) {
        return performance.navigation.type === 1;  // TYPE_RELOAD
      }
    } catch (e) {
    }
    return false;
  }

  // ページリロード時にキャッシュをクリア
  function clearCacheOnReload() {
    if (isPageReload()) {
      console.log('[Pixiv Anti-Reload] Page reload detected, clearing cache');
      sessionStorage.removeItem(API_CACHE_KEY);
      sessionStorage.removeItem(SCROLL_KEY);
      sessionStorage.removeItem(NAVIGATION_FLAG);
      return true;
    }
    return false;
  }

  function getApiCache() {
    try {
      const cached = sessionStorage.getItem(API_CACHE_KEY);
      if (!cached) {
        return { v: API_CACHE_VERSION, entries: {}, order: [] };
      }
      const parsed = JSON.parse(cached);
      // v2形式
      if (parsed && parsed.v === API_CACHE_VERSION && parsed.entries && parsed.order) {
        return parsed;
      }
      // 旧形式（url -> {data,timestamp}）の移行
      if (parsed && typeof parsed === 'object') {
        const keys = Object.keys(parsed);
        const entries = {};
        const order = [];
        for (const key of keys) {
          const val = parsed[key];
          if (val && typeof val === 'object' && 'data' in val && 'timestamp' in val) {
            entries[key] = val;
            order.push(key);
          }
        }
        return { v: API_CACHE_VERSION, entries, order };
      }
      return { v: API_CACHE_VERSION, entries: {}, order: [] };
    } catch (e) {
      return { v: API_CACHE_VERSION, entries: {}, order: [] };
    }
  }

  function pruneApiCache(cache) {
    // LRU順（order先頭が最古）で削る
    while (cache.order.length > API_CACHE_MAX_ENTRIES) {
      const oldest = cache.order.shift();
      if (oldest) delete cache.entries[oldest];
    }
  }

  function touchApiCacheKey(cache, key) {
    const idx = cache.order.indexOf(key);
    if (idx >= 0) cache.order.splice(idx, 1);
    cache.order.push(key);
  }

  function setApiCache(cache) {
    try {
      pruneApiCache(cache);
      sessionStorage.setItem(API_CACHE_KEY, JSON.stringify(cache));
      return;
    } catch (e) {
      // 容量超過などのとき、古いものを削ってリトライ
      try {
        for (let i = 0; i < 10 && cache.order.length > 0; i++) {
          const oldest = cache.order.shift();
          if (oldest) delete cache.entries[oldest];
        }
        sessionStorage.setItem(API_CACHE_KEY, JSON.stringify(cache));
      } catch (e2) {
      }
    }
  }

  function checkNavigationFlag() {
    try {
      const flag = sessionStorage.getItem(NAVIGATION_FLAG);
      if (flag === 'true' && isDiscoveryPage()) {
        isReturningFromNavigation = true;
        returnTimestamp = Date.now();
        sessionStorage.removeItem(NAVIGATION_FLAG);
        console.log('[Pixiv Anti-Reload] ★ Returning from navigation');

        // RESTORE_WINDOW後にフラグをリセット（無限スクロール復活）
        setTimeout(() => {
          isReturningFromNavigation = false;
          console.log('[Pixiv Anti-Reload] Restore window ended, normal mode');
        }, RESTORE_WINDOW + 500);
      }
    } catch (e) {
    }
  }

  function saveDiscoveryState() {
    if (!isDiscoveryPage()) return;
    try {
      const state = {
        scrollY: window.scrollY,
        scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
        ts: Date.now(),
      };
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify(state));
      sessionStorage.setItem(NAVIGATION_FLAG, 'true');
    } catch (e) {
    }
  }

  // スクロール復元（一度だけ）
  function restoreScrollPosition() {
    if (!isDiscoveryPage() || scrollRestored) return;

    try {
      const saved = sessionStorage.getItem(SCROLL_KEY);
      if (!saved) return;

      let scrollY = 0;
      try {
        const obj = JSON.parse(saved);
        if (obj && typeof obj.scrollY === 'number') scrollY = obj.scrollY;
      } catch (e) {
        // 旧形式（数値文字列）
        scrollY = parseInt(saved, 10);
      }
      if (!Number.isFinite(scrollY) || scrollY <= 0) return;

      scrollRestored = true;  // 復元済みフラグ
      console.log('[Pixiv Anti-Reload] Restoring scroll to:', scrollY);

      const start = Date.now();
      const MAX_WAIT = 12000;
      const attempt = () => {
        try {
          // ChromeのScrollBehaviorは auto/smooth のみ。instantは例外になり得る
          window.scrollTo({ top: scrollY, behavior: 'auto' });
        } catch (e) {
          try {
            window.scrollTo(0, scrollY);
          } catch (e2) {
          }
        }

        // まだ高さが足りず目的位置に行けてない/戻された場合、少し待って再試行
        const delta = Math.abs(window.scrollY - scrollY);
        const heightOk = (document.documentElement.scrollHeight || 0) >= (scrollY + window.innerHeight + 200);
        if ((delta > 200 || !heightOk) && (Date.now() - start) < MAX_WAIT) {
          setTimeout(attempt, 400);
        }
      };

      setTimeout(attempt, 500);

    } catch (e) {
    }
  }

  function hookLinkClicks() {
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (link && isDiscoveryPage()) {
        const href = link.getAttribute('href');
        if (href && (href.includes('/artworks/') || href.includes('/users/'))) {
          saveDiscoveryState();
          console.log('[Pixiv Anti-Reload] Saved state before navigation');
        }
      }
    }, { capture: true });
  }

  function setupScrollSaving() {
    let scrollTimeout;
    window.addEventListener('scroll', () => {
      if (!isDiscoveryPage()) return;
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        // スクロール復元の最中（未完了）で頻繁に上書きしない
        if (isReturningFromNavigation && !scrollRestored) return;
        try {
          const state = {
            scrollY: window.scrollY,
            scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
            ts: Date.now(),
          };
          sessionStorage.setItem(SCROLL_KEY, JSON.stringify(state));
        } catch (e) {
        }
      }, 500);
    }, { passive: true });
  }

  function isPaginationRequest(url) {
    return url.includes('offset=') || url.includes('page=') ||
      url.includes('p=') ||
      url.includes('last_id=') || url.includes('lastId=') ||
      url.includes('_start=');
  }

  function isWithinRestoreWindow() {
    if (!isReturningFromNavigation) return false;
    return (Date.now() - returnTimestamp) < RESTORE_WINDOW;
  }

  function hookFetch() {
    const originalFetch = window.fetch;
    const CACHE_DURATION = 10 * 60 * 1000;

    window.fetch = async function (url, options) {
      const urlString = getFetchUrlString(url);
      const method = (options && options.method) ? String(options.method).toUpperCase() : 'GET';

      // Discovery APIのみ処理
      const isDiscoveryAPI = urlString.includes('/ajax/discovery');

      if (!isDiscoveryAPI) {
        return originalFetch.apply(this, arguments);
      }

      // GET以外は触らない
      if (method !== 'GET') {
        return originalFetch.apply(this, arguments);
      }

      const apiCache = getApiCache();

      // 戻り直後は、ページネーションも含め「以前取得したものがあれば」キャッシュで返す
      if (isWithinRestoreWindow()) {
        const cached = apiCache.entries[urlString];
        if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
          console.log('[Pixiv Anti-Reload] ★ USING CACHE:', urlString);
          try {
            return new Response(
              JSON.stringify(cached.data),
              { status: 200, headers: { 'Content-Type': 'application/json' } });
          } catch (e) {
          }
        }
      }

      // 新規取得
      const response = await originalFetch.apply(this, arguments);

      // キャッシュに保存（ページネーションも含め、戻り復元に使う）
      const clone = response.clone();
      try {
        const data = await clone.json();
        apiCache.entries[urlString] = { data, timestamp: Date.now() };
        touchApiCacheKey(apiCache, urlString);
        setApiCache(apiCache);
        if (isPaginationRequest(urlString)) {
          console.log('[Pixiv Anti-Reload] Cached (pagination):', urlString);
        } else {
          console.log('[Pixiv Anti-Reload] Cached:', urlString);
        }
      } catch (e) {
      }

      return response;
    };
  }

  function setupPageEvents() {
    window.addEventListener('pagehide', () => {
      saveDiscoveryState();
    }, { capture: true });

    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        console.log('[Pixiv Anti-Reload] Restored from bfcache');
      }
    }, { capture: true });
  }

  function hookHistoryAPI() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function (...args) {
      saveDiscoveryState();
      return originalPushState.apply(this, arguments);
    };

    history.replaceState = function (...args) {
      saveDiscoveryState();
      return originalReplaceState.apply(this, arguments);
    };

    window.addEventListener('popstate', () => {
      isReturningFromNavigation = true;
      returnTimestamp = Date.now();
      scrollRestored = false;  // スクロール復元フラグをリセット
      console.log('[Pixiv Anti-Reload] ★ Popstate detected');

      setTimeout(() => {
        restoreScrollPosition();
      }, 100);

      // RESTORE_WINDOW後に無限スクロール復活
      setTimeout(() => {
        isReturningFromNavigation = false;
        console.log('[Pixiv Anti-Reload] Restore window ended');
      }, RESTORE_WINDOW + 500);
    });
  }

  function init() {
    console.log('[Pixiv Anti-Reload] v1.7.0 initializing...');

    // ページリロード時はキャッシュをクリア
    if (clearCacheOnReload()) {
      console.log('[Pixiv Anti-Reload] Fresh start (reload detected)');
      return initFreshStart();
    }

    checkNavigationFlag();
    hookFetch();
    setupPageEvents();
    hookHistoryAPI();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        hookLinkClicks();
        setupScrollSaving();
        if (isReturningFromNavigation) {
          restoreScrollPosition();
        }
      });
    } else {
      hookLinkClicks();
      setupScrollSaving();
      if (isReturningFromNavigation) {
        restoreScrollPosition();
      }
    }

    console.log(
      '[Pixiv Anti-Reload] Initialized, returning:', isReturningFromNavigation);
  }

  // リロード後のフレッシュスタート
  function initFreshStart() {
    hookFetch();
    setupPageEvents();
    hookHistoryAPI();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        hookLinkClicks();
        setupScrollSaving();
        scrollRestored = true;  // フレッシュスタートなのでスクロール保存を許可
      });
    } else {
      hookLinkClicks();
      setupScrollSaving();
      scrollRestored = true;
    }

    console.log('[Pixiv Anti-Reload] Fresh start initialized');
  }

  init();
})();
