#!/usr/bin/env python3
"""Fetch DKIM CNAME record IDs from Cloudflare for SES import."""
import json, os, sys, urllib.request

zone_id = "2681612fabe18dde4f3c2e2084c17a58"
email = os.environ.get("TF_VAR_cloudflare_email", "")
api_key = os.environ.get("TF_VAR_cloudflare_api_key", "")

url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records?type=CNAME&per_page=50"
req = urllib.request.Request(url, headers={
    "X-Auth-Email": email,
    "X-Auth-Key": api_key,
})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read())

recs = [r for r in data["result"] if "domainkey" in r["name"]]
recs.sort(key=lambda x: x["name"])

print(f"Found {len(recs)} DKIM records")
for r in recs:
    print(f'{r["id"]} {r["name"]} -> {r["content"]}')
