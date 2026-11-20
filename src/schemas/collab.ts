import * as v from "valibot";
import { SHARE_ROLES } from "../models/document";
import { BLOCK_ID_RE } from "./documents";

const BlockId = v.pipe(v.string(), v.regex(BLOCK_ID_RE));
const ShareRole = v.picklist(SHARE_ROLES);

// ── Sharing ─────────────────────────────────────────────────────────────

export const ShareInput = v.object({
  email: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(255), v.toLowerCase()),
  role: ShareRole,
});

export const LinkInput = v.object({
  enabled: v.boolean(),
  role: ShareRole,
});

// ── Presence ────────────────────────────────────────────────────────────

export const PresenceInput = v.object({
  state: v.picklist(["viewing", "editing"] as const),
  blockId: v.nullish(BlockId, null),
});

// ── Comments ────────────────────────────────────────────────────────────

export const COMMENT_MAX = 5000;

const CommentBody = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(COMMENT_MAX));

export const CommentAnchorInput = v.object({
  blockId: BlockId,
  quote: v.pipe(v.string(), v.maxLength(1000)),
  prefix: v.optional(v.pipe(v.string(), v.maxLength(64)), ""),
  suffix: v.optional(v.pipe(v.string(), v.maxLength(64)), ""),
});

export const CreateThreadInput = v.object({
  anchor: CommentAnchorInput,
  body: CommentBody,
});

export const CommentBodyInput = v.object({ body: CommentBody });

export const ResolveInput = v.object({ resolved: v.boolean() });

export const MarkReadInput = v.object({
  ids: v.pipe(v.array(v.pipe(v.string(), v.maxLength(64))), v.maxLength(500)),
});

// ── Versions ────────────────────────────────────────────────────────────

export const NamedVersionInput = v.object({
  label: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
});
