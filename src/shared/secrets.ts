// Loads the stack's secrets from SSM Parameter Store into process.env once per
// container (cold start), so the rest of the code can keep reading them via
// `process.env.X`. Secrets live as SecureStrings under SECRETS_PREFIX (e.g.
// `/ber-intake/SIGNWELL_API_KEY`) and are NOT passed as Lambda env vars or
// CloudFormation params — so they never appear in the function configuration
// or the stack. Call `await hydrateSecrets()` at the top of every handler.

import {
  GetParametersByPathCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";

// e.g. "/ber-intake/". Unset locally / in tests, where secrets come straight
// from the environment and hydration is a no-op.
const PREFIX = process.env.SECRETS_PREFIX;
const ssm = new SSMClient({});

let inflight: Promise<void> | null = null;

async function load(): Promise<void> {
  if (!PREFIX) return; // local dev / tests: secrets already in the environment
  let next: string | undefined;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({
        Path: PREFIX,
        WithDecryption: true,
        MaxResults: 10, // API max; loop over NextToken for the rest
        NextToken: next,
      }),
    );
    for (const p of res.Parameters ?? []) {
      const name = p.Name?.slice(PREFIX.length);
      // Never clobber an explicit env override (handy for local dev / tests).
      if (name && p.Value != null && !process.env[name]) {
        process.env[name] = p.Value;
      }
    }
    next = res.NextToken;
  } while (next);
}

/**
 * Populate process.env from SSM SecureStrings under SECRETS_PREFIX. Runs the
 * fetch at most once per container; a failed fetch is not cached, so the next
 * invocation retries rather than staying permanently broken.
 */
export function hydrateSecrets(): Promise<void> {
  if (!inflight) {
    inflight = load().catch((err) => {
      inflight = null;
      throw err;
    });
  }
  return inflight;
}
