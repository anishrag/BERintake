// Transient conversation state for the Telegram wizards (/newquote and
// /newclient), keyed by chat id with a DynamoDB TTL so abandoned conversations
// clean themselves up.

import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { BOT_STATE_TABLE, ddb } from "./db";

// /newquote: name → email → phone → eircode (client does the rest online).
// /newclient: also size → datetime → price (pre-agreed on the phone).
export type BotStep =
  | "name"
  | "email"
  | "phone"
  | "eircode"
  | "size"
  | "datetime"
  | "price";

export type BotFlow = "quote" | "client";

export interface BotDraft {
  name?: string;
  email?: string;
  phone?: string;
  eircode?: string;
  size?: string; // apt | lt200 | mt200
  datetime?: string; // YYYY-MM-DD HH:MM
  price?: number;
}

export interface BotState {
  chatId: string;
  flow: BotFlow;
  step: BotStep;
  draft: BotDraft;
  expiresAt: number; // unix seconds — DynamoDB TTL attribute
}

const TTL_SECONDS = 60 * 30;

export async function getState(chatId: string): Promise<BotState | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: BOT_STATE_TABLE, Key: { chatId } }),
  );
  return res.Item as BotState | undefined;
}

export async function setState(
  state: Omit<BotState, "expiresAt">,
): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  await ddb.send(
    new PutCommand({ TableName: BOT_STATE_TABLE, Item: { ...state, expiresAt } }),
  );
}

export async function clearState(chatId: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({ TableName: BOT_STATE_TABLE, Key: { chatId } }),
  );
}

/**
 * Record a Telegram update_id once. Returns true the first time, false if it
 * was already processed (Telegram retried a slow webhook) — so callers skip
 * duplicates. Stored in the same table under an `upd#` key with a 1h TTL.
 */
export async function markUpdateProcessed(updateId: number): Promise<boolean> {
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
  try {
    await ddb.send(
      new PutCommand({
        TableName: BOT_STATE_TABLE,
        Item: { chatId: `upd#${updateId}`, expiresAt },
        ConditionExpression: "attribute_not_exists(chatId)",
      }),
    );
    return true;
  } catch (e: any) {
    if (e.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}
