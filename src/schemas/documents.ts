import * as v from "valibot";

/** Open shape — any registered EditorJS tool can emit its own data keys.
 *  EditorJS emits `data: null` for freshly-added empty blocks, so we accept
 *  null/undefined and normalise to `{}` before it reaches the model. */
const EditorBlock = v.object({
  id: v.optional(v.string()),
  type: v.string(),
  data: v.nullish(v.record(v.string(), v.unknown()), () => ({})),
  tunes: v.nullish(v.record(v.string(), v.unknown()), () => ({})),
});

export const EditorOutput = v.object({
  time: v.optional(v.number()),
  blocks: v.array(EditorBlock),
  version: v.optional(v.string()),
});
export type EditorOutputT = v.InferOutput<typeof EditorOutput>;

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
});

export const UpsertPageInput = v.object({
  content: EditorOutput,
  layoutOverride: v.nullable(PageLayout),
});

export const ReorderPagesInput = v.object({
  pageIds: v.array(v.string()),
});
