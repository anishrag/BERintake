// GET /jobs/{token}/slots — available booking slots for the client form.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { listSlots } from "../shared/calendar";
import { heldByOthers } from "../shared/holds";
import { getJobByToken } from "../shared/jobs";

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const token = event.pathParameters?.token;
  if (!token) return { statusCode: 400, body: "missing token" };

  const job = await getJobByToken(token);
  if (!job || job.status === "discarded") {
    return { statusCode: 404, body: "not found" };
  }

  try {
    const [slots, hidden] = await Promise.all([
      listSlots(),
      heldByOthers(job.jobId),
    ]);
    const available = slots.filter((s) => !hidden.has(s.id));
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slots: available }),
    };
  } catch (err) {
    console.error("failed to list slots", err);
    return {
      statusCode: 502,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "calendar-unavailable" }),
    };
  }
};
