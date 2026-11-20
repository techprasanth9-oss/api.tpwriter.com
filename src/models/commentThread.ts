import { Schema, model, type Model, type Types } from "mongoose";

/**
 * A comment thread anchored to a quote inside one block (W3C text-quote
 * style: the quote plus a little context either side, so the FE can re-find
 * it after edits). Comments are embedded — threads are small (capped at
 * MAX_COMMENTS_PER_THREAD) and every change is then one atomic write.
 *
 * Deleting a thread's first comment deletes the whole thread.
 */

export const MAX_COMMENTS_PER_THREAD = 500;

export interface CommentAnchorDoc {
  blockId: string;
  quote: string;
  prefix: string;
  suffix: string;
}

export interface CommentDoc {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  // Plain text; mentions are written inline as @[Display Name](userId).
  body: string;
  // User ids mentioned in `body` that had access to the document.
  mentions: Types.ObjectId[];
  createdAt: Date;
  editedAt: Date | null;
}

export interface CommentThreadDoc {
  _id: Types.ObjectId;
  documentId: Types.ObjectId;
  anchor: CommentAnchorDoc;
  resolved: boolean;
  resolvedBy: Types.ObjectId | null;
  comments: CommentDoc[];
  createdAt: Date;
  updatedAt: Date;
}

const commentSchema = new Schema<CommentDoc>(
  {
    authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true },
    mentions: { type: [Schema.Types.ObjectId], default: [] },
    createdAt: { type: Date, default: () => new Date() },
    editedAt: { type: Date, default: null },
  },
  { versionKey: false },
);

const threadSchema = new Schema<CommentThreadDoc>(
  {
    documentId: { type: Schema.Types.ObjectId, ref: "Document", required: true },
    anchor: {
      type: new Schema<CommentAnchorDoc>(
        {
          blockId: { type: String, required: true },
          quote: { type: String, default: "" },
          prefix: { type: String, default: "" },
          suffix: { type: String, default: "" },
        },
        { _id: false },
      ),
      required: true,
    },
    resolved: { type: Boolean, default: false },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    comments: { type: [commentSchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);

threadSchema.index({ documentId: 1, createdAt: 1 });

export const CommentThread: Model<CommentThreadDoc> = model<CommentThreadDoc>(
  "CommentThread",
  threadSchema,
);
