// Loads the Supabase adapter when config.js is filled in, then starts the app.
(function () {
  const c = window.SCA_CONFIG || {};
  const add = src => new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => no(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
  const msg = html => { document.getElementById('app').innerHTML = '<div style="max-width:560px;margin:12vh auto;padding:0 16px;font:14px/1.5 Arial,sans-serif">' + html + '</div>'; };
  (async () => {
    try {
      if (c.SUPABASE_URL && c.SUPABASE_ANON_KEY) {
        await add('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js');
        await add('supa-api.js');
        window.SCA = window.SCAApi.create(window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } }));
      } else if (/github\.io$/.test(location.hostname)) {
        return msg('<h2>SCAdmin is deployed but not connected yet</h2><p>The owner still needs to add the Supabase URL and anon key to <code>docs/config.js</code>.</p>');
      }
      await add('app.js');
    } catch (e) { msg('<h2>Failed to load</h2><p>' + e.message + '</p>'); }
  })();
})();
