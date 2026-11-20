import { Schema, model, type Model, type Types } from "mongoose";
import type { PageLayout } from "./document";

/**
 * A full snapshot of a document (meta + ordered blocks) for version history.
 * Automatic versions are taken after a content save when the newest version
 * is more than 10 minutes old, and before a restore; named versions on
 * request. Retention: every named version, the newest 50 automatic ones.
 */

export interface VersionBlock {
  id: string;
  type: string;
  data: Record<string, unknown>;
  tunes?: Record<string, unknown>;
}

export interface DocumentVersionDoc {
  _id: Types.ObjectId;
  documentId: Types.ObjectId;
  revision: number;
  title: string;
  defaultLayout: PageLayout;
  pageSetup: Record<string, unknown>;
  styles: Record<string, unknown>;
  blocks: VersionBlock[];
  label: string | null;
  auto: boolean;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
}

const versionSchema = new Schema<DocumentVersionDoc>(
  {
    documentId: { type: Schema.Types.ObjectId, ref: "Document", required: true },
    revision: { type: Number, required: true },
    title: { type: String, default: "" },
    defaultLayout: { type: Schema.Types.Mixed },
    pageSetup: { type: Schema.Types.Mixed, default: () => ({}) },
    styles: { type: Schema.Types.Mixed, default: () => ({}) },
    // Ordered {id,type,data,tunes}; opaque, stored as-is.
    blocks: { type: Schema.Types.Mixed, default: () => [] },
    label: { type: String, default: null },
    auto: { type: Boolean, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false, minimize: false },
);

versionSchema.index({ documentId: 1, createdAt: -1 });

export const DocumentVersion: Model<DocumentVersionDoc> = model<DocumentVersionDoc>(
  "DocumentVersion",
  versionSchema,
);
