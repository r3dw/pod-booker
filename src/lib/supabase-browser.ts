"use client";

import { useAuth } from "@clerk/nextjs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useEffect } from "react";

// One browser client for the whole app. Every request (and the Realtime
// connection) asks Clerk for the current session token at the moment it runs.
type TokenGetter = (opts?: { skipCache?: boolean }) => Promise<string | null>;
let getClerkToken: TokenGetter | null = null;
// supabase-js asks for a token as soon as the client is created (for Realtime).
// Make that first request wait for Clerk instead of sending no token, which
// would get the private channel join refused and retried with back-off.
let resolveClerkReady: (get: TokenGetter) => void;
const clerkReady = new Promise<TokenGetter>((resolve) => (resolveClerkReady = resolve));
let client: SupabaseClient | null = null;

function browserClient() {
  client ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      accessToken: async () => {
        const get = getClerkToken ?? (await clerkReady);
        let token = await get();
        // Clerk hands back its cached token until it's nearly expired. Realtime
        // only swaps tokens on its heartbeat, so insist on one with some life
        // left, or the server kicks the channel when it expires.
        if (!token || secondsLeft(token) < MIN_TOKEN_LIFE_S) token = await get({ skipCache: true });
        if (!token) {
          // Never hand supabase-js an empty token: Realtime would switch the
          // channel to anonymous and get kicked. Throwing makes it keep the
          // last good token instead.
          console.warn("[auth] Clerk returned no session token");
          throw new Error("No Clerk session token");
        }
        return token;
      },
      auth: { persistSession: false },
      // Clerk tokens last 60 s; refresh on a 15 s heartbeat so each token is
      // replaced well before it expires. The heartbeat runs in a Web Worker so
      // background-tab timer throttling doesn't delay it.
      realtime: { heartbeatIntervalMs: 15_000, worker: true },
    },
  );
  return client;
}

const MIN_TOKEN_LIFE_S = 20;

/** Seconds until a JWT's `exp` (reads the payload only; no verification). */
function secondsLeft(jwt: string): number {
  try {
    const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const { exp } = JSON.parse(atob(payload));
    return typeof exp === "number" ? exp - Date.now() / 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * `ready` is false until Clerk has a signed-in session to authenticate with.
 * Call this before any effect that queries Supabase: effects run in order, so
 * the token getter below is always set before those effects run.
 */
export function useSupabase(): { supabase: SupabaseClient; ready: boolean } {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    getClerkToken = (opts) => getToken(opts);
    resolveClerkReady(getClerkToken);
  }, [getToken, isLoaded, isSignedIn]);

  return { supabase: browserClient(), ready: isLoaded && !!isSignedIn };
}
