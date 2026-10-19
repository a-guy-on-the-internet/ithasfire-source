#!/usr/bin/env python3
"""Fetch Cloudflare rulesets and find cache-related ones."""
import json, os, urllib.request

zone_id = "2681612fabe18dde4f3c2e2084c17a58"
email = os.environ.get("TF_VAR_cloudflare_email", "")
api_key = os.environ.get("TF_VAR_cloudflare_api_key", "")

url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/rulesets"
req = urllib.request.Request(url, headers={
    "X-Auth-Email": email,
    "X-Auth-Key": api_key,
})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read())

for r in data.get("result", []):
    phase = r.get("phase", "?")
    name = r.get("name", "?")
    rid = r["id"]
    print(f"{rid}  phase={phase}  name={name}")
