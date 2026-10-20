import { Schema, model, type Model, type Types } from "mongoose";

/**
 * Metadata record for a document. The actual page content lives in the
 * `DocumentPage` collection (one row per page), keyed back to this document
 * via `documentId`. Matches the eSigns `clm_contract_documents` /
 * `document_pages` split so a large multi-page doc doesn't blow past the
 * 16 MB BSON limit on a single document.
 *
 * `pageIds` is kept in order so page add / remove / reorder is a single
 * document-level write + per-page writes, without needing a sort query.
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
  // Ordered list of page ids. The actual page content is in DocumentPage.
  // Order here is the display order; reorder = reorder this array.
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
  },
);

// Common query: "list this user's docs by most recently updated".
documentSchema.index({ ownerId: 1, updatedAt: -1 });

export const DocumentModel: Model<DocumentDoc> = model<DocumentDoc>(
  "Document",
  documentSchema,
);
