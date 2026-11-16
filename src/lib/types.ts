export type Role = "student" | "instructor" | "staff";
export type Kind = "class" | "recurring" | "reservation" | "walkin";

export type Profile = {
  id: string;
  email: string;
  display_name: string | null;
  role: Role;
};

export type Space = {
  id: number;
  name: string;
  kind: "room" | "pod";
  capacity: number;
  bookable_by: Role[];
  photo_url?: string | null;
};

export type Person = { id?: string; email: string; display_name: string | null };

/** One booking as shown on the calendar. The staff-only fields are absent for everyone else. */
export type Slot = {
  id: string;
  space_id: number;
  starts_at: string;
  ends_at: string;
  kind: Kind;
  title: string | null;
  is_mine: boolean;
  booked_for?: Person | null;
  booked_by?: Person | null;
  created_at?: string;
  series_id?: string | null;
};
