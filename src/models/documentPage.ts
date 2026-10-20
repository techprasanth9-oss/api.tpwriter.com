import { Schema, model, type Model, type Types } from "mongoose";

/**
 * One physical page of a document. Mirrors the eSigns pattern where each
 * page's EditorJS `OutputData` lives in its own row, keyed back to the
 * parent document. Keeps a single page's write cost small even when the
 * document has 100+ pages.
 *
 * `layoutOverride` is per-page: null means "inherit document.defaultLayout".
 * Non-null means this specific page uses a different paper size / margins
 * (e.g. a landscape cover sheet in an otherwise portrait doc).
 */

export interface EditorBlock {
  id?: string;
  type: string;
  data: Record<string, unknown>;
  tunes?: Record<string, unknown>;
}

export interface EditorOutput {
  time?: number;
  blocks: EditorBlock[];
  version?: string;
}

export interface PageLayoutOverride {
  paperSize?: "A4" | "LETTER" | "LEGAL" | "A3" | "A5";
  orientation?: "portrait" | "landscape";
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
}

export interface DocumentPageDoc {
  _id: Types.ObjectId;
  documentId: Types.ObjectId;
  // Owner duplicated here for a one-step ownership check on page writes
  // without needing to also fetch the parent document.
  ownerId: Types.ObjectId;
  pageIndex: number;
  content: EditorOutput;
  layoutOverride: PageLayoutOverride | null;
  createdAt: Date;
  updatedAt: Date;
}

const pageSchema = new Schema<DocumentPageDoc>(
  {
    documentId: {
      type: Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true,
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    pageIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    content: {
      type: Schema.Types.Mixed,
      default: () => ({ blocks: [] }),
    },
    layoutOverride: {
      type: Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// A doc's pages are almost always fetched sorted by index.
pageSchema.index({ documentId: 1, pageIndex: 1 });

export const DocumentPage: Model<DocumentPageDoc> = model<DocumentPageDoc>(
  "DocumentPage",
  pageSchema,
);
