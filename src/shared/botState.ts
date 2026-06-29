// Transient conversation state for the Telegram /newclient wizard, keyed by
// chat id with a DynamoDB TTL so abandoned conversations clean themselves up.

import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { BOT_STATE_TABLE, ddb } from "./db";

export type BotStep = "name" | "email" | "phone" | "eircode";

export interface BotState {
  chatId: string;
  step: BotStep;
  draft: { name?: string; email?: string; phone?: string; eircode?: string };
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
