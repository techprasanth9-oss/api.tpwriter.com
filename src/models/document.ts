import { Schema, model, type Model, type Types } from "mongoose";

/**
 * Metadata record for a document.
 *
 * v2 (`schemaVersion: 2`): content is one Editor.js block list. Each block is
 * a row in the `DocumentBlock` collection (keeps every write small and stays
 * far from the 16 MB BSON limit); `blockOrder` holds their ids in display
 * order. Pagination is purely visual on the FE — pages are not stored.
 * `revision` is bumped on every content save and used for optimistic
 * concurrency (PUT /documents/:id/content carries a `baseRevision`).
 *
 * v1 / legacy (`schemaVersion` missing or 1): content lived in N
 * `DocumentPage` rows referenced by `pageIds`. Those docs are migrated lazily
 * on first read — see src/migrations/v2.ts. `pageIds` stays in the schema only
 * so legacy docs still load; v2 code never reads or writes it.
 */

export type PaperSize = "A4" | "LETTER" | "LEGAL" | "A3" | "A5";
export type Orientation = "portrait" | "landscape";

export interface PageLayout {
  paperSize: PaperSize;
  orientation: Orientation;
  // All margins in CSS pixels at 96 DPI. 96 = 1 inch default.
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
}

export const DEFAULT_LAYOUT: PageLayout = {
  paperSize: "A4",
  orientation: "portrait",
  marginTop: 96,
  marginRight: 96,
  marginBottom: 96,
  marginLeft: 96,
};

const layoutSchema = new Schema<PageLayout>(
  {
    paperSize: {
      type: String,
      enum: ["A4", "LETTER", "LEGAL", "A3", "A5"],
      default: "A4",
    },
    orientation: {
      type: String,
      enum: ["portrait", "landscape"],
      default: "portrait",
    },
    marginTop: { type: Number, default: 96 },
    marginRight: { type: Number, default: 96 },
    marginBottom: { type: Number, default: 96 },
    marginLeft: { type: Number, default: 96 },
  },
  { _id: false },
);

export interface DocumentDoc {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  title: string;
  // 2 for v2 docs. Missing (or 1) = legacy, not yet migrated. Deliberately
  // has no schema default, otherwise hydrating a legacy doc would report 2.
  schemaVersion?: number;
  // Starts at 1, +1 on every content save. Missing on legacy docs.
  revision?: number;
  // Ordered DocumentBlock.blockId values — the document's block order.
  blockOrder: string[];
  // Doc-level named styles. Opaque to the server; the FE owns the shape.
  styles: Record<string, unknown>;
  // Headers/footers, page decoration and footnote texts. Opaque to the
  // server; the FE validates and owns the shape.
  pageSetup: Record<string, unknown>;
  // Legacy (v1) only: ordered DocumentPage ids. Unused for v2 docs.
  pageIds: Types.ObjectId[];
  defaultLayout: PageLayout;
  // Optional per-doc header/footer applied to every page unless a page
  // overrides it. EditorJS block arrays — the FE renders them on top of
  // and below each page canvas.
  headerBlocks: unknown[];
  footerBlocks: unknown[];
  createdAt: Date;
  updatedAt: Date;
}

const documentSchema = new Schema<DocumentDoc>(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      default: "Untitled document",
    },
    schemaVersion: { type: Number },
    revision: { type: Number },
    blockOrder: { type: [String], default: [] },
    styles: { type: Schema.Types.Mixed, default: () => ({}) },
    pageSetup: { type: Schema.Types.Mixed, default: () => ({}) },
    pageIds: [
      {
        type: Schema.Types.ObjectId,
        ref: "DocumentPage",
      },
    ],
    defaultLayout: {
      type: layoutSchema,
      default: () => DEFAULT_LAYOUT,
    },
    // Mixed because EditorJS block shape is open — any registered tool
    // can add new block types without a schema migration here.
    headerBlocks: {
      type: [Schema.Types.Mixed],
      default: [],
    },
    footerBlocks: {
      type: [Schema.Types.Mixed],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
    // Keep `styles: {}` on disk instead of dropping the empty object.
    minimize: false,
  },
);

// Common query: "list this user's docs by most recently updated".
documentSchema.index({ ownerId: 1, updatedAt: -1 });

export const DocumentModel: Model<DocumentDoc> = model<DocumentDoc>(
  "Document",
  documentSchema,
);
