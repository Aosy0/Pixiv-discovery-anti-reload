// ==UserScript==
// @name         Pixiv Discovery Anti-Reload
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description
// Pixivのディスカバリーページでブラウザバック時の作品リストとスクロール位置を復元します
// @author       Anti-Pixiv-Reloader
// @match        https://www.pixiv.net/*
// @icon         https://www.pixiv.net/favicon.ico
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
'use strict';

// ============================================================
// 設定値（CONFIG）
// ============================================================
/**
 * @typedef {Object} Config
 * @property {string} SCROLL_KEY - スクロール位置保存用のsessionStorageキー
 * @property {string} NAVIGATION_FLAG - ナビゲーションフラグ用のキー
 * @property {string} API_CACHE_KEY - APIキャッシュ用のキー
 * @property {string} PAGE_LOAD_ID_KEY - ページロードID用のキー
 * @property {number} RESTORE_WINDOW - 戻り直後の復元猶予時間（ms）
 * @property {number} CACHE_DURATION - APIキャッシュの有効期限（ms）
 * @property {number} API_CACHE_VERSION - APIキャッシュのバージョン
 * @property {number} API_CACHE_MAX_ENTRIES - APIキャッシュの最大エントリ数
 * @property {number} SCROLL_RESTORE_MAX_WAIT -
 * スクロール復元の最大待機時間（ms）
 * @property {number} SCROLL_RESTORE_TOLERANCE - スクロール位置の許容誤差（px）
 */
const CONFIG = Object.freeze({
  // sessionStorageキー
  SCROLL_KEY: 'pixiv_discovery_scroll',
  NAVIGATION_FLAG: 'pixiv_navigated_away',
  API_CACHE_KEY: 'pixiv_discovery_api_cache',
  PAGE_LOAD_ID_KEY: 'pixiv_page_load_id',

  // タイミング設定
  RESTORE_WINDOW: 15000,           // 戻り直後の復元猶予（ms）
  CACHE_DURATION: 10 * 60 * 1000,  // APIキャッシュ有効期限（10分）
  SCROLL_RESTORE_MAX_WAIT: 12000,  // スクロール復元の最大待機時間（ms）
  SCROLL_RESTORE_TOLERANCE: 200,   // スクロール位置の許容誤差（px）

  // キャッシュ設定
  API_CACHE_VERSION: 2,
  API_CACHE_MAX_ENTRIES: 25,
});

// ============================================================
// 状態管理
// ============================================================
let isReturningFromNavigation = false;
let returnTimestamp = 0;
let scrollRestored = false;

// ============================================================
// ユーティリティ関数
// ============================================================

/**
 * 現在のページがディスカバリーページかどうかを判定
 * @returns {boolean} ディスカバリーページならtrue
 */
function isDiscoveryPage() {
  return window.location.pathname.startsWith('/discovery');
}

/**
 * fetch引数からURL文字列を取得
 * @param {RequestInfo|URL} url - fetchの第1引数
 * @returns {string} URL文字列
 */
function getFetchUrlString(url) {
  if (typeof url === 'string') return url;
  try {
    if (url && typeof url === 'object' && 'url' in url) {
      return String(url.url);
    }
  } catch (e) {
    // エラー時は文字列化を試みる
  }
  return String(url);
}

/**
 * ページリロードかどうかを検出
 * @returns {boolean} リロードならtrue
 */
function isPageReload() {
  try {
    const entries = performance.getEntriesByType('navigation');
    if (entries.length > 0) {
      return entries[0].type === 'reload';
    }
    if (performance.navigation) {
      return performance.navigation.type === 1;  // TYPE_RELOAD
    }
  } catch (e) {
    // Navigation Timing APIが使えない場合
  }
  return false;
}

/**
 * ページネーションリクエストかどうかを判定
 * @param {string} url - リクエストURL
 * @returns {boolean} ページネーションリクエストならtrue
 */
function isPaginationRequest(url) {
  return url.includes('offset=') || url.includes('page=') ||
      url.includes('p=') || url.includes('last_id=') ||
      url.includes('lastId=') || url.includes('_start=');
}

/**
 * 復元ウィンドウ内かどうかを判定
 * @returns {boolean} 復元ウィンドウ内ならtrue
 */
function isWithinRestoreWindow() {
  if (!isReturningFromNavigation) return false;
  return (Date.now() - returnTimestamp) < CONFIG.RESTORE_WINDOW;
}

// ============================================================
// APIキャッシュ管理
// ============================================================

/**
 * @typedef {Object} CacheEntry
 * @property {Object} data - キャッシュされたAPIレスポンスデータ
 * @property {number} timestamp - キャッシュ作成時刻
 */

/**
 * @typedef {Object} ApiCache
 * @property {number} v - キャッシュバージョン
 * @property {Object<string, CacheEntry>} entries - キャッシュエントリ
 * @property {string[]} order - LRU順序（先頭が最古）
 */

/**
 * APIキャッシュを取得
 * @returns {ApiCache} キャッシュオブジェクト
 */
function getApiCache() {
  try {
    const cached = sessionStorage.getItem(CONFIG.API_CACHE_KEY);
    if (!cached) {
      return {v: CONFIG.API_CACHE_VERSION, entries: {}, order: []};
    }

    const parsed = JSON.parse(cached);
    if (parsed && parsed.v === CONFIG.API_CACHE_VERSION && parsed.entries &&
        parsed.order) {
      return parsed;
    }

    // 不正な形式の場合は新規作成
    return {v: CONFIG.API_CACHE_VERSION, entries: {}, order: []};
  } catch (e) {
    console.warn('[Pixiv Anti-Reload] Failed to parse API cache:', e);
    return {v: CONFIG.API_CACHE_VERSION, entries: {}, order: []};
  }
}

/**
 * APIキャッシュをLRU方式で刈り込み
 * @param {ApiCache} cache - キャッシュオブジェクト
 */
function pruneApiCache(cache) {
  while (cache.order.length > CONFIG.API_CACHE_MAX_ENTRIES) {
    const oldest = cache.order.shift();
    if (oldest) delete cache.entries[oldest];
  }
}

/**
 * APIキャッシュのキーをLRU順序で更新（アクセス順に末尾へ移動）
 * @param {ApiCache} cache - キャッシュオブジェクト
 * @param {string} key - 更新するキー
 */
function touchApiCacheKey(cache, key) {
  const idx = cache.order.indexOf(key);
  if (idx >= 0) cache.order.splice(idx, 1);
  cache.order.push(key);
}

/**
 * APIキャッシュをsessionStorageに保存
 * @param {ApiCache} cache - 保存するキャッシュオブジェクト
 */
function setApiCache(cache) {
  try {
    pruneApiCache(cache);
    sessionStorage.setItem(CONFIG.API_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    // 容量超過時のリトライ
    try {
      for (let i = 0; i < 10 && cache.order.length > 0; i++) {
        const oldest = cache.order.shift();
        if (oldest) delete cache.entries[oldest];
      }
      sessionStorage.setItem(CONFIG.API_CACHE_KEY, JSON.stringify(cache));
    } catch (e2) {
      console.warn('[Pixiv Anti-Reload] Failed to save API cache:', e2);
    }
  }
}

// ============================================================
// キャッシュクリア
// ============================================================

/**
 * ページリロード時にキャッシュをクリア
 * @returns {boolean} リロードが検出されクリアされたらtrue
 */
function clearCacheOnReload() {
  if (!isPageReload()) return false;

  console.log('[Pixiv Anti-Reload] Page reload detected, clearing cache');
  sessionStorage.removeItem(CONFIG.API_CACHE_KEY);
  sessionStorage.removeItem(CONFIG.SCROLL_KEY);
  sessionStorage.removeItem(CONFIG.NAVIGATION_FLAG);
  return true;
}

// ============================================================
// ナビゲーション状態管理
// ============================================================

/**
 * ナビゲーションフラグをチェックし、戻り状態を設定
 */
function checkNavigationFlag() {
  try {
    const flag = sessionStorage.getItem(CONFIG.NAVIGATION_FLAG);
    if (flag !== 'true' || !isDiscoveryPage()) return;

    isReturningFromNavigation = true;
    returnTimestamp = Date.now();
    sessionStorage.removeItem(CONFIG.NAVIGATION_FLAG);
    console.log('[Pixiv Anti-Reload] ★ Returning from navigation');

    // RESTORE_WINDOW後にフラグをリセット（無限スクロール復活）
    setTimeout(() => {
      isReturningFromNavigation = false;
      console.log('[Pixiv Anti-Reload] Restore window ended, normal mode');
    }, CONFIG.RESTORE_WINDOW + 500);
  } catch (e) {
    console.warn('[Pixiv Anti-Reload] Failed to check navigation flag:', e);
  }
}

/**
 * ディスカバリーページの状態を保存（スクロール位置とナビゲーションフラグ）
 */
function saveDiscoveryState() {
  if (!isDiscoveryPage()) return;

  try {
    const state = {
      scrollY: window.scrollY,
      scrollHeight: document.documentElement?.scrollHeight ?? 0,
      ts: Date.now(),
    };
    sessionStorage.setItem(CONFIG.SCROLL_KEY, JSON.stringify(state));
    sessionStorage.setItem(CONFIG.NAVIGATION_FLAG, 'true');
  } catch (e) {
    console.warn('[Pixiv Anti-Reload] Failed to save discovery state:', e);
  }
}

// ============================================================
// スクロール復元（requestAnimationFrame使用）
// ============================================================

/**
 * スクロール位置を復元（一度だけ実行）
 * requestAnimationFrameを使用して描画サイクルと同期
 */
function restoreScrollPosition() {
  if (!isDiscoveryPage() || scrollRestored) return;

  try {
    const saved = sessionStorage.getItem(CONFIG.SCROLL_KEY);
    if (!saved) return;

    let targetScrollY = 0;
    try {
      const obj = JSON.parse(saved);
      if (obj && typeof obj.scrollY === 'number') {
        targetScrollY = obj.scrollY;
      }
    } catch (e) {
      // 旧形式（数値文字列）のフォールバック
      targetScrollY = parseInt(saved, 10);
    }

    if (!Number.isFinite(targetScrollY) || targetScrollY <= 0) return;

    scrollRestored = true;
    console.log('[Pixiv Anti-Reload] Restoring scroll to:', targetScrollY);

    const startTime = Date.now();

    /**
     * requestAnimationFrameを使用したスクロール試行
     */
    function attemptScroll() {
      // タイムアウトチェック
      if (Date.now() - startTime > CONFIG.SCROLL_RESTORE_MAX_WAIT) {
        console.log('[Pixiv Anti-Reload] Scroll restore timeout');
        return;
      }

      // スクロール実行
      try {
        window.scrollTo({top: targetScrollY, behavior: 'auto'});
      } catch (e) {
        window.scrollTo(0, targetScrollY);
      }

      // 成功判定
      const delta = Math.abs(window.scrollY - targetScrollY);
      const docHeight = document.documentElement?.scrollHeight ?? 0;
      const heightOk = docHeight >= (targetScrollY + window.innerHeight +
                                     CONFIG.SCROLL_RESTORE_TOLERANCE);

      if (delta > CONFIG.SCROLL_RESTORE_TOLERANCE || !heightOk) {
        // まだ目標位置に到達していない場合、次のフレームで再試行
        requestAnimationFrame(attemptScroll);
      } else {
        console.log('[Pixiv Anti-Reload] Scroll restored successfully');
      }
    }

    // 初回は少し遅延させてからrAFを開始
    requestAnimationFrame(() => {
      requestAnimationFrame(attemptScroll);
    });

  } catch (e) {
    console.warn('[Pixiv Anti-Reload] Failed to restore scroll position:', e);
  }
}

// ============================================================
// イベントフック
// ============================================================

/**
 * リンククリックをフックして状態を保存
 */
function hookLinkClicks() {
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || !isDiscoveryPage()) return;

    const href = link.getAttribute('href');
    if (href && (href.includes('/artworks/') || href.includes('/users/'))) {
      saveDiscoveryState();
      console.log('[Pixiv Anti-Reload] Saved state before navigation');
    }
  }, {capture: true});
}

/**
 * スクロールイベントをフックして位置を保存
 */
function setupScrollSaving() {
  let scrollTimeout;

  window.addEventListener('scroll', () => {
    if (!isDiscoveryPage()) return;

    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      // スクロール復元中は上書きしない
      if (isReturningFromNavigation && !scrollRestored) return;

      try {
        const state = {
          scrollY: window.scrollY,
          scrollHeight: document.documentElement?.scrollHeight ?? 0,
          ts: Date.now(),
        };
        sessionStorage.setItem(CONFIG.SCROLL_KEY, JSON.stringify(state));
      } catch (e) {
        // 書き込み失敗は無視
      }
    }, 500);
  }, {passive: true});
}

/**
 * Fetch APIをフックしてAPIレスポンスをキャッシュ
 */
function hookFetch() {
  const originalFetch = window.fetch;

  window.fetch = async function(url, options) {
    const urlString = getFetchUrlString(url);
    const method =
        options?.method ? String(options.method).toUpperCase() : 'GET';

    // Discovery APIのGETリクエストのみ処理
    const isDiscoveryAPI = urlString.includes('/ajax/discovery');
    if (!isDiscoveryAPI || method !== 'GET') {
      return originalFetch.apply(this, arguments);
    }

    const apiCache = getApiCache();

    // 復元ウィンドウ内はキャッシュから返す
    if (isWithinRestoreWindow()) {
      const cached = apiCache.entries[urlString];
      if (cached && (Date.now() - cached.timestamp < CONFIG.CACHE_DURATION)) {
        console.log('[Pixiv Anti-Reload] ★ USING CACHE:', urlString);
        try {
          return new Response(
              JSON.stringify(cached.data),
              {status: 200, headers: {'Content-Type': 'application/json'}});
        } catch (e) {
          // Response作成失敗時は通常のfetchにフォールバック
        }
      }
    }

    // 新規取得
    const response = await originalFetch.apply(this, arguments);

    // キャッシュに保存
    try {
      const clone = response.clone();
      const data = await clone.json();
      apiCache.entries[urlString] = {data, timestamp: Date.now()};
      touchApiCacheKey(apiCache, urlString);
      setApiCache(apiCache);

      const logType = isPaginationRequest(urlString) ? '(pagination)' : '';
      console.log(`[Pixiv Anti-Reload] Cached ${logType}:`, urlString);
    } catch (e) {
      // キャッシュ保存失敗は無視
    }

    return response;
  };
}

/**
 * ページイベント（pagehide/pageshow）をセットアップ
 */
function setupPageEvents() {
  window.addEventListener('pagehide', () => {
    saveDiscoveryState();
  }, {capture: true});

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      console.log('[Pixiv Anti-Reload] Restored from bfcache');
    }
  }, {capture: true});
}

/**
 * History APIをフックしてSPAナビゲーションを検出
 */
function hookHistoryAPI() {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    saveDiscoveryState();
    return originalPushState.apply(this, args);
  };

  history.replaceState = function(...args) {
    saveDiscoveryState();
    return originalReplaceState.apply(this, args);
  };

  window.addEventListener('popstate', () => {
    isReturningFromNavigation = true;
    returnTimestamp = Date.now();
    scrollRestored = false;
    console.log('[Pixiv Anti-Reload] ★ Popstate detected');

    requestAnimationFrame(() => {
      restoreScrollPosition();
    });

    // RESTORE_WINDOW後に無限スクロール復活
    setTimeout(() => {
      isReturningFromNavigation = false;
      console.log('[Pixiv Anti-Reload] Restore window ended');
    }, CONFIG.RESTORE_WINDOW + 500);
  });
}

// ============================================================
// 初期化
// ============================================================

/**
 * DOMContentLoaded後の初期化処理
 */
function onDOMReady() {
  hookLinkClicks();
  setupScrollSaving();
  if (isReturningFromNavigation) {
    restoreScrollPosition();
  }
}

/**
 * リロード後のフレッシュスタート初期化
 */
function initFreshStart() {
  hookFetch();
  setupPageEvents();
  hookHistoryAPI();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      hookLinkClicks();
      setupScrollSaving();
      scrollRestored = true;
    });
  } else {
    hookLinkClicks();
    setupScrollSaving();
    scrollRestored = true;
  }

  console.log('[Pixiv Anti-Reload] Fresh start initialized');
}

/**
 * メイン初期化関数
 */
function init() {
  console.log('[Pixiv Anti-Reload] v2.0.0 initializing...');

  // ページリロード時はキャッシュをクリア
  if (clearCacheOnReload()) {
    console.log('[Pixiv Anti-Reload] Fresh start (reload detected)');
    initFreshStart();
    return;
  }

  checkNavigationFlag();
  hookFetch();
  setupPageEvents();
  hookHistoryAPI();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDOMReady);
  } else {
    onDOMReady();
  }

  console.log(
      '[Pixiv Anti-Reload] Initialized, returning:', isReturningFromNavigation);
}

init();
})();
