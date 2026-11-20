import { Types, isValidObjectId } from "mongoose";
import { User } from "../models/user";

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
}

/** Public profile per user id. Ids without a User row (deleted accounts)
 *  are filled in by `publicUser` with an empty email. */
export async function publicUsers(
  ids: Iterable<string | Types.ObjectId | null | undefined>,
): Promise<Map<string, PublicUser>> {
  const unique = [
    ...new Set(
      [...ids].flatMap((id) => (id && isValidObjectId(id) ? [id.toString()] : [])),
    ),
  ];
  const map = new Map<string, PublicUser>();
  if (unique.length === 0) return map;
  const rows = await User.find(
    { _id: { $in: unique.map((id) => new Types.ObjectId(id)) } },
    { email: 1, displayName: 1 },
  ).lean();
  for (const u of rows) {
    map.set(u._id.toString(), {
      id: u._id.toString(),
      email: u.email,
      displayName: u.displayName ?? null,
    });
  }
  return map;
}

export function publicUser(
  map: Map<string, PublicUser>,
  id: string | Types.ObjectId,
): PublicUser {
  const key = id.toString();
  return map.get(key) ?? { id: key, email: "", displayName: null };
}
