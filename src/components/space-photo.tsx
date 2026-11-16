"use client";

import Image from "next/image";
import { useEffect } from "react";
import type { Space } from "@/lib/types";

/** Who can book, in plain words. */
export function bookableText(s: Space) {
  if (s.bookable_by.includes("student")) return "Anyone can book";
  if (s.bookable_by.includes("instructor")) return "Instructors and staff";
  return "Staff only";
}

/** The photo shows another space (e.g. pods sharing the Pod 216 photo until each has its own). */
function photoNote(s: Space) {
  const number = s.name.match(/\d+/)?.[0];
  const shown = s.photo_url?.match(/(\d+)\.\w+$/)?.[1];
  return number && shown && number !== shown ? `Photo shows ${s.kind === "pod" ? "Pod" : "Room"} ${shown}; the ${s.kind}s are alike.` : null;
}

export function SpacePhotoDialog({ space, onClose }: { space: Space; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const note = photoNote(space);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={space.name}
        className="max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-t-xl bg-white shadow-xl sm:rounded-xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        {space.photo_url && (
          <Image
            src={space.photo_url}
            alt={`${space.name}`}
            width={600}
            height={800}
            className="max-h-[60dvh] w-full rounded-t-xl object-cover"
            priority
          />
        )}
        <div className="flex items-start justify-between gap-4 p-4">
          <div>
            <h3 className="text-lg font-semibold">{space.name}</h3>
            <p className="text-sm text-zinc-500">
              {space.kind === "room" ? "Room" : "Pod"} · seats about {space.capacity} · {bookableText(space)}
            </p>
            {note && <p className="mt-1 text-xs text-zinc-500">{note}</p>}
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" aria-label="Close">
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
