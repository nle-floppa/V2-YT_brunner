// =============================================================
// Shared cloud-sync helper for the dashboard.
// Each page calls initCloudSync({...}) once with its config:
//   appKey         — string row key in the public.app_state table
//   syncedKeys     — exact localStorage keys to mirror
//   syncedPrefixes — localStorage key prefixes to mirror (e.g. 'goals:')
//   onApplied      — optional callback after remote state has been applied
//
// Requires:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="sync.js" defer></script>
// =============================================================

(function () {
  'use strict';

  // Prefer Vercel env vars (served via /api/config → window.DASH_*),
  // otherwise fall back to these defaults.
  const SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://srajryooffirbroltjmg.supabase.co';
  const SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_5142ZwTLF_DkSVRzciNuRA_bHwRAu4c';

  // Global state for all sync handlers
  const syncHandlers = {};
  let globalSuppressSync = false;
  const origSet = localStorage.setItem.bind(localStorage);
  const origRemove = localStorage.removeItem.bind(localStorage);

  // Install global localStorage hooks IMMEDIATELY (synchronously)
  localStorage.setItem = function (k, v) {
    origSet(k, v);
    if (!globalSuppressSync) {
      // Trigger schedulePush on all registered handlers
      for (const handlerId of Object.keys(syncHandlers)) {
        const handler = syncHandlers[handlerId];
        if (handler && handler.matches && handler.matches(k)) {
          if (handler.schedulePush) handler.schedulePush();
        }
      }
    }
  };

  localStorage.removeItem = function (k) {
    origRemove(k);
    if (!globalSuppressSync) {
      for (const handlerId of Object.keys(syncHandlers)) {
        const handler = syncHandlers[handlerId];
        if (handler && handler.matches && handler.matches(k)) {
          if (handler.schedulePush) handler.schedulePush();
        }
      }
    }
  };

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    
    if (!appKey) { console.warn('[sync.js] No appKey provided'); return; }
    if (!window.supabase) { console.warn('[sync.js] window.supabase not available'); return; }
    if (!SUPABASE_URL || !SUPABASE_KEY) { console.warn('[sync.js] Missing SUPABASE_URL or SUPABASE_KEY'); return; }
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) { console.warn('[sync.js] SUPABASE credentials need to be configured'); return; }

    let supa = null;
    let pushTimer = null;
    let suppressSync = false;
    let lastSyncedJson = null;

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }

    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') { return false; }
      suppressSync = true;
      globalSuppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) {
            try { origSet(k, incoming); changed = true; } catch (e) { console.error('[sync.js] applyRemote: error setting key:', k, e); }
          }
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) {
            try { origRemove(k); changed = true; } catch (e) { console.error('[sync.js] applyRemote: error removing key:', k, e); }
          }
        }
      } finally { 
        suppressSync = false;
        globalSuppressSync = false;
      }
      if (changed && typeof onApplied === 'function') {
        try { onApplied(); } catch (e) { console.error('[sync.js] applyRemote: onApplied error:', e); }
      }
      return changed;
    }

    async function pushNow() {
      if (!supa) return;
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) {
          lastSyncedJson = json;
        } else {
          console.error('[sync.js] pushNow: upsert error:', error);
        }
      } catch (e) { console.error('[sync.js] pushNow: exception:', e); }
    }
    function schedulePush() {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushNow, 250);
    }
    function flushOnUnload() {
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
      } catch (e) {}
    }

    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (error) {
          console.error('[sync.js] init: fetch error:', error);
        } else if (data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          applyRemote(data.data);
        } else {
          if (Object.keys(collect()).length > 0) {
            schedulePush();
          }
        }
      } catch (e) { console.error('[sync.js] init: exception during fetch:', e); }
      
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'app_state',
          filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe(() => {});
    })();

    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => {
      if (e.key && matches(e.key)) schedulePush();
    });

    // Register this handler in the global registry so the global hooks can trigger it
    syncHandlers[appKey] = {
      matches: matches,
      schedulePush: schedulePush
    };
  };

  // Expose a global function that pages can call to notify sync about changes
  window.notifySync = function(key) {
    for (const handlerId of Object.keys(syncHandlers)) {
      const handler = syncHandlers[handlerId];
      if (handler && handler.matches && handler.matches(key)) {
        if (handler.schedulePush) handler.schedulePush();
      }
    }
  };
})();
