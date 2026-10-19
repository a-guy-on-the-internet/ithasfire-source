# Deploy workflow secrets and variables

The workflow files in this directory are the list: every `secrets.*` and `vars.*` they reference.

```bash
grep -ho 'secrets\.[A-Za-z_0-9]*' .github/workflows/*.yml | sort -u
grep -ho 'vars\.[A-Za-z_0-9]*' .github/workflows/*.yml | sort -u
```

How secrets are set, added, rotated and mapped onto `TF_VAR_*`, and their traps: [`docs/deploy.md#secrets`](../../docs/deploy.md#secrets).
