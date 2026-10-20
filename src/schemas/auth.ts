import * as v from "valibot";

/** Email + password + optional display name. */
export const SignupInput = v.object({
  email: v.pipe(v.string(), v.email(), v.maxLength(255), v.toLowerCase()),
  password: v.pipe(v.string(), v.minLength(8), v.maxLength(128)),
  displayName: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(100), v.trim()),
  ),
});
export type SignupInputT = v.InferOutput<typeof SignupInput>;

export const LoginInput = v.object({
  email: v.pipe(v.string(), v.email(), v.maxLength(255), v.toLowerCase()),
  password: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});
export type LoginInputT = v.InferOutput<typeof LoginInput>;
