import { randomBytes, randomUUID } from "node:crypto";

export const newJobId = (): string => randomUUID();

// URL-safe, unguessable token for the client-facing quote link.
export const newToken = (): string => randomBytes(18).toString("base64url");
