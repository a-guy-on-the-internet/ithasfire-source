# Language-Specific Vulnerability Patterns

Load the relevant section during Step 1 (Scope Resolution) for the files in scope.

---

## TypeScript (Node/Fastify, React, Next.js)

### Critical APIs/calls to flag
```js
eval()                    // arbitrary code execution
Function('return ...')    // same as eval
child_process.exec()      // command injection if user input reaches it
fs.readFile               // path traversal if user controls path
fs.writeFile              // path traversal if user controls path
```

### React specific
```jsx
<div dangerouslySetInnerHTML={{ __html: userContent }} />  // XSS
<a href={userUrl}>link</a>  // javascript: URL injection
```

### Next.js specific
```js
// Server Actions without auth
export async function deleteUser(id) {  // missing: auth check
  await db.users.delete(id)
}

// API Routes missing method validation
export default function handler(req, res) {
  // Should check: if (req.method !== 'POST') return res.status(405)
  doSensitiveAction()
}
```

---
