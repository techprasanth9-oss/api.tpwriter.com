import { Schema, model, type Model, type Types } from "mongoose";

/** "Someone mentioned you in a comment." One row per mentioned user per
 *  comment (never for mentioning yourself). */
export interface NotificationDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  documentId: Types.ObjectId;
  threadId: Types.ObjectId;
  commentId: Types.ObjectId;
  fromUserId: Types.ObjectId;
  // First characters of the comment, mentions rendered as @Name.
  excerpt: string;
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    documentId: { type: Schema.Types.ObjectId, ref: "Document", required: true, index: true },
    threadId: { type: Schema.Types.ObjectId, ref: "CommentThread", required: true, index: true },
    commentId: { type: Schema.Types.ObjectId, required: true },
    fromUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    excerpt: { type: String, default: "" },
    read: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);

notificationSchema.index({ userId: 1, createdAt: -1 });

export const Notification: Model<NotificationDoc> = model<NotificationDoc>(
  "Notification",
  notificationSchema,
);
