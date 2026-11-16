import { UserButton } from "@clerk/nextjs";
import type { ReactNode } from "react";

/** Top row on every page: title on the left; page extras and the avatar on the right. */
export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="mb-4 flex items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">Pod Booker</h1>
      <div className="flex items-center gap-3 text-sm">
        {children}
        <UserButton />
      </div>
    </header>
  );
}
