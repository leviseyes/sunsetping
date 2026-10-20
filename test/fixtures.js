export const PERFECT = { low: 10, mid: 40, high: 25, humidity: 40, visibility: 25000, precipitation: 0 };
export const CLEAR = { low: 0, mid: 0, high: 0, humidity: 50, visibility: 25000, precipitation: 0 };
export const WASHED = { low: 80, mid: 90, high: 95, humidity: 90, visibility: 4000, precipitation: 1 };

export function flatForecast(days, timezone = "America/Denver") {
  const time = [];
  const cols = { low: [], mid: [], high: [], humidity: [], visibility: [], precipitation: [] };
  for (const day of days) {
    const date = day.sunset.slice(0, 10);
    for (let h = 0; h < 24; h++) {
      time.push(`${date}T${String(h).padStart(2, "0")}:00`);
      for (const key of Object.keys(cols)) cols[key].push(day[key]);
    }
  }
  return {
    timezone,
    daily: { sunset: days.map((d) => d.sunset), sunrise: days.map((d) => d.sunrise || null) },
    hourly: {
      time,
      cloud_cover_low: cols.low,
      cloud_cover_mid: cols.mid,
      cloud_cover_high: cols.high,
      relative_humidity_2m: cols.humidity,
      visibility: cols.visibility,
      precipitation: cols.precipitation,
    },
  };
}

export function day(sunset, weather, sunrise) {
  return { sunset, sunrise: sunrise || sunset.slice(0, 10) + "T07:10", ...weather };
}

export function geocodeBody({ name = "Denver", admin1 = "Colorado", latitude = 39.7392, longitude = -104.9847, timezone = "America/Denver" } = {}) {
  return { results: [{ name, admin1, country: "United States", latitude, longitude, timezone }] };
}

export function createDb(initial = {}) {
  const state = {
    subscribers: (initial.subscribers || []).map((s) => ({ ...s })),
    saved: (initial.saved || []).map((s) => ({ ...s })),
    sends: (initial.sends || []).map((s) => ({ ...s })),
    stripeEvents: (initial.stripeEvents || []).map((s) => ({ ...s })),
    checkoutAttempts: (initial.checkoutAttempts || []).map((s) => ({ ...s })),
    nextId: initial.nextId || 100,
  };
  const query = (sql, args, mode) => {
    if (sql.includes("INSERT INTO checkout_attempts")) {
      state.checkoutAttempts.push({
        plan: args[0],
        outcome: args[1],
        confirm: args[2],
        ua: args[3],
        sec_fetch_mode: args[4],
        sec_fetch_site: args[5],
        sec_fetch_user: args[6],
        sec_fetch_dest: args[7],
        has_accept_language: args[8],
        referer_host: args[9],
        country: args[10],
        asn: args[11],
        as_org: args[12],
        session_id_suffix: args[13],
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO stripe_events")) {
      if (state.stripeEvents.some((e) => e.id === args[0])) return { success: true, meta: { changes: 0 } };
      state.stripeEvents.push({ id: args[0], type: args[1] });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("FROM stripe_events")) {
      const row = state.stripeEvents.find((e) => e.id === args[0]) || null;
      return mode === "first" ? row : row ? [row] : [];
    }
    if (sql.includes("INSERT INTO subscribers") && sql.includes("stripe_customer_id")) {
      state.subscribers.push({
        id: ++state.nextId,
        email: args[0],
        location: args[1],
        lat: null,
        lon: null,
        tz: null,
        unsubscribe_token: args[2],
        status: "active",
        plan: "pro",
        stripe_customer_id: args[3],
        stripe_subscription_id: args[4],
        score_threshold: null,
        sunrise_alerts: 0,
        day_before: 0,
        lead_minutes: 180,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("SET plan='pro'")) {
      const row = state.subscribers.find((s) => s.id === args[2]);
      if (!row) return { success: true, meta: { changes: 0 } };
      row.plan = "pro";
      row.stripe_customer_id = args[0];
      row.stripe_subscription_id = args[1];
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("SET plan='free'")) {
      let changes = 0;
      for (const row of state.subscribers) {
        if ((args[0] && row.stripe_customer_id === args[0]) || (args[1] && row.stripe_subscription_id === args[1])) {
          row.plan = "free";
          changes++;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("INSERT INTO subscribers")) {
      const existing = state.subscribers.find((s) => s.email === args[0]);
      if (existing) {
        existing.location = args[1];
        existing.lat = args[2];
        existing.lon = args[3];
        existing.tz = args[4];
        existing.status = "active";
        if (args.length > 6) existing.score_threshold = args[6];
      } else {
        state.subscribers.push({
          id: ++state.nextId,
          email: args[0],
          location: args[1],
          lat: args[2],
          lon: args[3],
          tz: args[4],
          unsubscribe_token: args[5],
          status: "active",
          plan: "free",
          score_threshold: args.length > 6 ? args[6] : null,
          sunrise_alerts: 0,
          day_before: 0,
          lead_minutes: 180,
        });
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO saved_locations")) {
      state.saved.push({ id: ++state.nextId, subscriber_id: args[0], label: args[1], lat: args[2], lon: args[3], tz: args[4] });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO alert_sends")) {
      if (state.sends.some((s) => s.subscriber_id === args[0] && s.kind === args[1] && s.local_date === args[2])) {
        throw new Error("UNIQUE constraint failed: alert_sends");
      }
      state.sends.push({ subscriber_id: args[0], kind: args[1], local_date: args[2] });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM saved_locations")) {
      const before = state.saved.length;
      state.saved = state.saved.filter((s) => !(s.id === args[0] && s.subscriber_id === args[1]));
      return { success: true, meta: { changes: before - state.saved.length } };
    }
    if (sql.includes("SET status='unsubscribed'")) {
      const row = state.subscribers.find((s) => s.unsubscribe_token === args[0]);
      if (!row || row.status === "unsubscribed") return { success: true, meta: { changes: 0 } };
      row.status = "unsubscribed";
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("SET score_threshold")) {
      const row = state.subscribers.find((s) => s.id === args[4]);
      if (!row) return { success: true, meta: { changes: 0 } };
      row.score_threshold = args[0];
      row.sunrise_alerts = args[1];
      row.day_before = args[2];
      row.lead_minutes = args[3];
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("FROM subscribers") && sql.includes("status = 'active'")) {
      const rows = state.subscribers.filter((s) => s.status === "active");
      return mode === "first" ? rows[0] || null : rows;
    }
    if (sql.includes("FROM subscribers") && sql.includes("stripe_customer_id =")) {
      const rows = state.subscribers.filter((s) => (args[0] && s.stripe_customer_id === args[0]) || (args[1] && s.stripe_subscription_id === args[1]));
      return mode === "first" ? rows[0] || null : rows;
    }
    if (sql.includes("FROM subscribers") && sql.includes("WHERE email")) {
      const rows = state.subscribers.filter((s) => s.email === args[0]);
      return mode === "first" ? rows[0] || null : rows;
    }
    if (sql.includes("FROM saved_locations")) {
      const rows = state.saved.filter((s) => s.subscriber_id === args[0]);
      return mode === "first" ? rows[0] || null : rows;
    }
    if (sql.includes("FROM alert_sends")) {
      const rows = state.sends.filter((s) => s.subscriber_id === args[0]);
      return mode === "first" ? rows[0] || null : rows;
    }
    throw new Error(`Unhandled SQL: ${sql}`);
  };
  return {
    state,
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        all() {
          return Promise.resolve({ results: query(sql, this.args, "all") });
        },
        first() {
          return Promise.resolve(query(sql, this.args, "first"));
        },
        run() {
          return Promise.resolve(query(sql, this.args, "run"));
        },
      };
      return stmt;
    },
  };
}

export function testEnv(db, extra = {}) {
  return {
    DB: db,
    ASSETS: {
      async fetch(req) {
        return new Response(new URL(req.url).pathname, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    },
    ...extra,
  };
}

export async function withFetch(impl, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}
