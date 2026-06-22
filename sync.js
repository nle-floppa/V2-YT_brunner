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
console.log('[sync.js] Loading sync.js...');

(function () {
  'use strict';

  console.log('[sync.js] IIFE started');

  // Prefer Vercel env vars (served via /api/config → window.DASH_*),
  // otherwise fall back to these defaults.
  const SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://srajryooffirbroltjmg.supabase.co';
  const SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_5142ZwTLF_DkSVRzciNuRA_bHwRAu4c';
  
  console.log('[sync.js] SUPABASE_URL:', SUPABASE_URL);
  console.log('[sync.js] SUPABASE_KEY set:', !!SUPABASE_KEY);

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    
    console.log('[sync.js] initCloudSync called for appKey:', appKey, { syncedKeys, syncedPrefixes });
    
    if (!appKey) { console.warn('[sync.js] No appKey provided'); return; }
    if (!window.supabase) { console.warn('[sync.js] window.supabase not available'); return; }
    if (!SUPABASE_URL || !SUPABASE_KEY) { console.warn('[sync.js] Missing SUPABASE_URL or SUPABASE_KEY'); return; }
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) { console.warn('[sync.js] SUPABASE credentials need to be configured'); return; }

    console.log('[sync.js] All checks passed, initializing cloud sync for:', appKey);

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

    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      console.log('[sync.js] localStorage.setItem intercepted:', k, 'matches:', matches(k));
      origSet(k, v);
      try { if (!suppressSync && matches(k)) { console.log('[sync.js] scheduling push for setItem'); schedulePush(); } } catch (e) { console.error('[sync.js] setItem error:', e); }
    };
    localStorage.removeItem = function (k) {
      console.log('[sync.js] localStorage.removeItem intercepted:', k, 'matches:', matches(k));
      origRemove(k);
      try { if (!suppressSync && matches(k)) { console.log('[sync.js] scheduling push for removeItem'); schedulePush(); } } catch (e) { console.error('[sync.js] removeItem error:', e); }
    };

    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') { console.log('[sync.js] applyRemote: invalid remote'); return false; }
      console.log('[sync.js] applyRemote called with keys:', Object.keys(remote));
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) { console.log('[sync.js] applyRemote: skipping non-matching key:', k); continue; }
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) {
            console.log('[sync.js] applyRemote: updating key:', k);
            try { origSet(k, incoming); changed = true; } catch (e) { console.error('[sync.js] applyRemote: error setting key:', k, e); }
          }
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) {
            console.log('[sync.js] applyRemote: removing key:', k);
            try { origRemove(k); changed = true; } catch (e) { console.error('[sync.js] applyRemote: error removing key:', k, e); }
          }
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') {
        console.log('[sync.js] applyRemote: calling onApplied callback');
        try { onApplied(); } catch (e) { console.error('[sync.js] applyRemote: onApplied error:', e); }
      }
      return changed;
    }

    async function pushNow() {
      if (!supa) { console.log('[sync.js] pushNow: supa not ready'); return; }
      const state = collect();
      const json = JSON.stringify(state);
      console.log('[sync.js] pushNow: collected state:', Object.keys(state), 'json length:', json.length);
      if (json === lastSyncedJson) { console.log('[sync.js] pushNow: no changes since last sync'); return; }
      try {
        console.log('[sync.js] pushNow: upserting to Supabase appKey:', appKey);
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) {
          console.log('[sync.js] pushNow: upsert successful');
          lastSyncedJson = json;
        } else {
          console.error('[sync.js] pushNow: upsert error:', error);
        }
      } catch (e) { console.error('[sync.js] pushNow: exception:', e); }
    }
    function schedulePush() {
      console.log('[sync.js] schedulePush called');
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
      console.log('[sync.js] init starting for appKey:', appKey);
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      console.log('[sync.js] Supabase client created');
      try {
        console.log('[sync.js] Fetching initial data from Supabase...');
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (error) {
          console.error('[sync.js] init: fetch error:', error);
        } else if (data && data.data && Object.keys(data.data).length > 0) {
          console.log('[sync.js] init: fetched existing data, applying:', Object.keys(data.data));
          lastSyncedJson = JSON.stringify(data.data);
          applyRemote(data.data);
        } else {
          console.log('[sync.js] init: no data in Supabase, pushing local if exists');
          if (Object.keys(collect()).length > 0) {
            schedulePush();
          }
        }
      } catch (e) { console.error('[sync.js] init: exception during fetch:', e); }
      
      console.log('[sync.js] Subscribing to realtime changes...');
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'app_state',
          filter: 'key=eq.' + appKey,
        }, (payload) => {
          console.log('[sync.js] Received postgres_changes event:', payload);
          if (!payload.new || !payload.new.data) { console.log('[sync.js] Ignoring event: no data'); return; }
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) { console.log('[sync.js] Ignoring event: same as last sync'); return; }
          console.log('[sync.js] Applying remote changes from event');
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe((status) => {
          console.log('[sync.js] Subscription status:', status);
        });
    })();

    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => {
      console.log('[sync.js] storage event:', e.key, 'matches:', matches(e.key));
      if (e.key && matches(e.key)) schedulePush();
    });
  };
})();
