import { clerkMiddleware } from "@clerk/nextjs/server";

// Clerk needs its middleware to read the session on every request.
// Access control lives in each page (auth.protect()) and, above all, in the
// database (RLS + RPCs), not in path matching here.
export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
