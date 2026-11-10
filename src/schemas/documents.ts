import * as v from "valibot";

/** Editor.js block ids as stored in v2. The FE generates them; we only
 *  insist they're short and URL/selector-safe. */
export const BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BlockId = v.pipe(v.string(), v.regex(BLOCK_ID_RE));

/** Open shape — any registered EditorJS tool can emit its own data keys.
 *  EditorJS emits `data: null` for freshly-added empty blocks, so we accept
 *  null/undefined and normalise to `{}` before it reaches the model. In v2
 *  the id is required: blocks are stored and addressed by it. */
const EditorBlock = v.object({
  id: BlockId,
  type: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  data: v.nullish(v.record(v.string(), v.unknown()), () => ({})),
  tunes: v.nullish(v.record(v.string(), v.unknown()), () => ({})),
});
export type EditorBlockT = v.InferOutput<typeof EditorBlock>;

export const PageLayout = v.object({
  paperSize: v.optional(
    v.picklist(["A4", "LETTER", "LEGAL", "A3", "A5"] as const),
  ),
  orientation: v.optional(v.picklist(["portrait", "landscape"] as const)),
  marginTop: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(400))),
  marginRight: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(400))),
  marginBottom: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(400))),
  marginLeft: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(400))),
});
export type PageLayoutT = v.InferOutput<typeof PageLayout>;

export const CreateDocumentInput = v.object({
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(255), v.trim()),
  defaultLayout: v.optional(PageLayout),
});

export const UpdateDocumentInput = v.object({
  title: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(255), v.trim()),
  ),
  defaultLayout: v.optional(PageLayout),
  headerBlocks: v.optional(v.array(v.unknown())),
  footerBlocks: v.optional(v.array(v.unknown())),
  // Doc-level named styles; opaque to the server.
  styles: v.optional(v.record(v.string(), v.unknown())),
});

/** Incremental content save. Cross-field rules (unique ids, upsert/delete
 *  overlap, order consistency) are checked in the route so they can return
 *  specific `{ error }` codes. */
export const SaveContentInput = v.object({
  baseRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  upserts: v.array(EditorBlock),
  deletes: v.array(BlockId),
  order: v.optional(v.array(BlockId)),
});
export type SaveContentInputT = v.InferOutput<typeof SaveContentInput>;
