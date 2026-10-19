# Vulnerable & High-Risk Package Watchlist

Load this during Step 2 (Dependency Changes). Check the versions of the dependencies the scope adds or bumps.

---

## npm / Node.js

| Package | Vulnerable Versions | Issue | Safe Version |
|---------|-------------------|-------|--------------|
| lodash | < 4.17.21 | Prototype pollution (CVE-2021-23337) | >= 4.17.21 |
| axios | < 1.6.0 | SSRF, open redirect | >= 1.6.0 |
| jsonwebtoken | < 9.0.0 | Algorithm confusion bypass | >= 9.0.0 |
| node-jose | < 2.2.0 | Key confusion | >= 2.2.0 |
| shelljs | < 0.8.5 | ReDoS | >= 0.8.5 |
| tar | < 6.1.9 | Path traversal | >= 6.1.9 |
| minimist | < 1.2.6 | Prototype pollution | >= 1.2.6 |
| qs | < 6.7.3 | Prototype pollution | >= 6.7.3 |
| express | < 4.19.2 | Open redirect | >= 4.19.2 |
| multer | < 1.4.4 | DoS | >= 1.4.4-lts.1 |
| xml2js | < 0.5.0 | Prototype pollution | >= 0.5.0 |
| fast-xml-parser | < 4.2.4 | ReDoS | >= 4.2.4 |
| semver | < 7.5.2 | ReDoS | >= 7.5.2 |
| tough-cookie | < 4.1.3 | Prototype pollution | >= 4.1.3 |
| word-wrap | < 1.2.4 | ReDoS | >= 1.2.4 |
| vm2 | ANY | Sandbox escape (deprecated) | Use isolated-vm instead |
| serialize-javascript | < 3.1.0 | XSS | >= 3.1.0 |
| node-fetch | < 2.6.7 | Open redirect | >= 2.6.7 or 3.x |

### Patterns to flag (regardless of version):
- `eval` or `vm.runInContext` in dependencies
- Any package pulling in `node-gyp` native addons from unknown publishers
- Packages with < 1000 weekly downloads but required in production code (supply chain risk)

---

## General Red Flags (Any Ecosystem)

Flag any dependency that:
1. Has not been updated in > 2 years AND has > 10 open security issues
2. Has been deprecated by its maintainer with a security advisory
3. Is a fork of a known package from an unknown publisher (typosquatting)
4. Has a name that's one character off from a popular package (e.g., `lodash` vs `1odash`)
5. Was recently transferred to a new owner (check git history / npm transfer notices)
