#!/usr/bin/env python3
"""At-home triage tool for tablet-uploaded bug reports.

Uses boto3 directly with your home AWS credentials. Resolves the DynamoDB table
and S3 bucket physical names from the ber-intake stack's CloudFormation outputs
(BugReportsTableName / BerArtifactsBucketName), so nothing is hard-coded.

Subcommands:
  list            List open bug reports; for each, print id/createdAt/note/
                  address and presigned S3 GET URLs to download the audio + state.
  fix <id>        Mark a report fixed (status="fixed", fixedAt=now).

Env toggles (match scripts/deploy.py):
  STACK_NAME   default "ber-intake"
  AWS_REGION   default "us-east-1"
"""
import argparse
import datetime
import os
import sys

import boto3

STACK_NAME = os.environ.get("STACK_NAME", "ber-intake")
REGION = os.environ.get("AWS_REGION", "us-east-1")

# Short-lived download URLs (1 hour).
PRESIGN_EXPIRES = 3600


def stack_outputs() -> dict[str, str]:
    """Physical resource names from the stack's CloudFormation outputs."""
    cf = boto3.client("cloudformation", region_name=REGION)
    stacks = cf.describe_stacks(StackName=STACK_NAME)["Stacks"]
    outs = stacks[0].get("Outputs", [])
    return {o["OutputKey"]: o["OutputValue"] for o in outs}


def cmd_list() -> int:
    outs = stack_outputs()
    table_name = outs["BugReportsTableName"]
    bucket = outs["BerArtifactsBucketName"]

    ddb = boto3.client("dynamodb", region_name=REGION)
    s3 = boto3.client("s3", region_name=REGION)

    res = ddb.query(
        TableName=table_name,
        IndexName="status-index",
        KeyConditionExpression="#s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": {"S": "open"}},
    )
    items = res.get("Items", [])
    if not items:
        print("No open bug reports.")
        return 0

    def g(item: dict, key: str) -> str | None:
        return item.get(key, {}).get("S")

    def presign(key: str) -> str:
        return s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=PRESIGN_EXPIRES,
        )

    print(f"{len(items)} open bug report(s):\n")
    for it in sorted(items, key=lambda i: g(i, "createdAt") or ""):
        bug_id = g(it, "bugReportId")
        print(f"bugReportId : {bug_id}")
        print(f"  createdAt : {g(it, 'createdAt')}")
        print(f"  note      : {g(it, 'note') or '-'}")
        print(f"  address   : {g(it, 'address') or '-'}")
        state_key = g(it, "stateKey")
        if state_key:
            print(f"  state URL : {presign(state_key)}")
        has_audio = it.get("hasAudio", {}).get("BOOL", False)
        audio_key = g(it, "audioKey")
        if has_audio and audio_key:
            print(f"  audio URL : {presign(audio_key)}")
        print()
    return 0


def cmd_fix(bug_report_id: str) -> int:
    outs = stack_outputs()
    table_name = outs["BugReportsTableName"]
    ddb = boto3.client("dynamodb", region_name=REGION)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    ddb.update_item(
        TableName=table_name,
        Key={"bugReportId": {"S": bug_report_id}},
        UpdateExpression="SET #s = :s, fixedAt = :f",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": {"S": "fixed"}, ":f": {"S": now}},
    )
    print(f"Marked {bug_report_id} fixed at {now}.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="list open bug reports with download URLs")
    p_fix = sub.add_parser("fix", help="mark a bug report fixed")
    p_fix.add_argument("bugReportId")

    args = parser.parse_args()
    if args.cmd == "list":
        return cmd_list()
    if args.cmd == "fix":
        return cmd_fix(args.bugReportId)
    return 2


if __name__ == "__main__":
    sys.exit(main())
