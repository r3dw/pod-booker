import "server-only";
import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client that authenticates as the signed-in Clerk user.
 * Supabase's Clerk third-party auth verifies the token, so RLS sees
 * auth.jwt()->>'sub' = the Clerk user id.
 */
export function createServerSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      accessToken: async () => (await auth()).getToken(),
      auth: { persistSession: false },
    },
  );
}
