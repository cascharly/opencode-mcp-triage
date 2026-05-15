---
name: z-audit
description: Comprehensive security audit for vibe-coded projects - 7-phase methodology covering secrets, authentication, API security, infrastructure, headers, dependencies, and data exposure
license: MIT
compatibility: opencode
metadata:
  audience: developers
  severity: tool
---

## Overview
A comprehensive, adaptive security audit that detects your stack and runs targeted checks. Designed for developers who moved fast and need to find vulnerabilities before someone else does.

## Phase 0: Stack Detection (ALWAYS RUN FIRST)
Before auditing, detect what you're working with. This determines which checks to run.

### 0.1 If Given URLs (Remote Audit)
```
curl -s "[FRONTEND_URL]" | grep -oE '(react|vue|svelte|next|nuxt|astro|vite)'
curl -s "[FRONTEND_URL]" | grep -oE '[^"]+\.(js|mjs)"' | head -10
```

### 0.2 If Given Local Codebase
```
ls -la | grep -E "package.json|requirements.txt|go.mod|Cargo.toml|wrangler.toml|vercel.json|netlify.toml|supabase|firebase"
cat package.json | grep -E '"(react|vue|svelte|next|nuxt|hono|express|fastify|elysia)"'
cat package.json | grep -E '"(@supabase|firebase|@clerk|@auth0|better-auth|lucia|next-auth)"'
```

### 0.3 Stack Detection Matrix

| Signal | Stack | Special Checks |
|--------|-------|----------------|
| `wrangler.toml` | Cloudflare Workers | Check secrets, KV, D1 |
| `vercel.json` | Vercel | Check env vars, edge functions |
| `supabase/` dir | Supabase | Check RLS, anon key permissions |
| `firebase.json` | Firebase | Check Firestore rules, Auth |
| `next.config.js` | Next.js | Check API routes, middleware |
| `nuxt.config.ts` | Nuxt | Check server routes, nitro |
| `hono` in deps | Hono API | Check middleware chain |
| `express` in deps | Express | Check middleware order |

## Phase 1: Secrets & Credentials Audit

### 1.1 Frontend Bundle Scan (CRITICAL)
```
# API Keys by provider
grep -oE 'sk-[a-zA-Z0-9]{20,}' /tmp/bundle.js
grep -oE 'sk_live_[a-zA-Z0-9]+' /tmp/bundle.js
grep -oE 'sk_test_[a-zA-Z0-9]+' /tmp/bundle.js
grep -oE 'pk_live_[a-zA-Z0-9]+' /tmp/bundle.js
grep -oE 'AKIA[A-Z0-9]{16}' /tmp/bundle.js
grep -oE 'ghp_[a-zA-Z0-9]{36}' /tmp/bundle.js
grep -oE 'gho_[a-zA-Z0-9]{36}' /tmp/bundle.js
grep -oE 'glpat-[a-zA-Z0-9\-]{20}' /tmp/bundle.js
grep -oE 'xox[baprs]-[a-zA-Z0-9\-]+' /tmp/bundle.js
grep -oE 'ya29\.[a-zA-Z0-9_-]+' /tmp/bundle.js
grep -oE 'AIza[a-zA-Z0-9_-]{35}' /tmp/bundle.js
grep -oE 'eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*' /tmp/bundle.js

# Hardcoded passwords
grep -oiE '(password|passwd|pwd|secret)["\x27\s]*[=:]["\x27\s]*["\x27][^"\x27]{4,}["\x27]' /tmp/bundle.js
```

### 1.2 Local Codebase Secrets Scan
```
find . -name ".env*" -not -path "*/node_modules/*"
git log -p --all -S 'password' --since="1 year ago" -- '*.js' '*.ts' '*.json' | head -50
git log -p --all -S 'secret' --since="1 year ago" -- '*.js' '*.ts' '*.json' | head -50
git log -p --all -S 'sk-' --since="1 year ago" | head -50
grep -rn --include="*.ts" --include="*.js" --include="*.tsx" -E '(api_key|apikey|api-key|secret|password|token)\s*[=:]\s*["\x27][^"\x27]+["\x27]' .
```

## Phase 2: Authentication & Authorization

### 2.1 Client-Side Auth Detection
```
grep -oE 'localStorage\.(get|set)Item\(["\x27][^"\x27]*(auth|session|token|user|login)[^"\x27]*' /tmp/bundle.js
grep -oE 'sessionStorage\.(get|set)Item\(["\x27][^"\x27]*(auth|session|token|user|login)[^"\x27]*' /tmp/bundle.js
grep -oE 'if\s*\([^)]*===\s*["\x27][^"\x27]+["\x27]\s*\)' /tmp/bundle.js | head -10
```

### 2.2 API Authentication Testing
```
ENDPOINTS=("users" "projects" "tasks" "items" "data" "config" "settings" "admin" "me" "profile")
for ep in "${ENDPOINTS[@]}"; do
  curl -s -w "\nHTTP: %{http_code}\n" "$API_URL/api/$ep" | tail -5
done

curl -s "$API_URL/api/users" -H "Authorization: Bearer null"
curl -s "$API_URL/api/users" -H "Authorization: Bearer undefined"
curl -s "$API_URL/api/users" -H "Authorization: Bearer [object Object]"
```

### 2.3 Authorization (Access Control)
```
curl -s "$API_URL/api/users/1" -H "Authorization: Bearer [your-token]"
curl -s "$API_URL/api/users/2" -H "Authorization: Bearer [your-token]"
curl -s "$API_URL/api/admin" -H "Authorization: Bearer [regular-user-token]"
curl -s -X PUT "$API_URL/api/users/me" -H "Authorization: Bearer [token]" -d '{"role":"admin"}'
```

## Phase 3: API Security

### 3.1 CRUD Access Without Auth
```
curl -s -X POST "$API_URL/api/projects" -H "Content-Type: application/json" -d '{"name":"z-audit-test","test":true}'
curl -s -X PUT "$API_URL/api/projects/1" -H "Content-Type: application/json" -d '{"name":"hacked"}'
curl -s -X DELETE "$API_URL/api/projects/1"
```

### 3.2 Input Validation
```
curl -s "$API_URL/api/users?id=1' OR '1'='1"
curl -s "$API_URL/api/users?id=1; DROP TABLE users;--"
curl -s -X POST "$API_URL/api/login" -H "Content-Type: application/json" -d '{"email":{"$gt":""},"password":{"$gt":""}}'
curl -s -X POST "$API_URL/api/projects" -H "Content-Type: application/json" -d '{"name":"<script>alert(1)</script>"}'
```

### 3.3 Rate Limiting
```
for i in {1..100}; do
  curl -s -o /dev/null -w "%{http_code}\n" "$API_URL/api/projects" &
done
wait
```

### 3.4 Error Handling
```
curl -s "$API_URL/api/projects/undefined"
curl -s "$API_URL/api/projects/null"
curl -s "$API_URL/api/projects/NaN"
curl -s -X POST "$API_URL/api/projects" -H "Content-Type: application/json" -d 'invalid-json'
```

## Phase 4: Infrastructure-Specific Checks

### 4.1 Cloudflare Workers
```
wrangler secret list --name $WORKER_NAME
wrangler kv namespace list
wrangler d1 list
```

### 4.2 Vercel
```
curl -s "https://$DOMAIN/.env"
curl -s "https://$DOMAIN/.env.local"
curl -s "https://$DOMAIN/.env.production"
curl -s "https://$DOMAIN/_next/static/chunks/main.js.map"
```

### 4.3 Supabase
```
curl -s "$PROJECT_URL/rest/v1/" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
curl -s "$PROJECT_URL/rest/v1/users?select=*" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
curl -s -X POST "$PROJECT_URL/rest/v1/[table]" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" -d '{"test": "data"}'
curl -s "$PROJECT_URL/storage/v1/bucket" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
```

### 4.4 Firebase
```
curl -s "https://[project].firebaseio.com/.json"
curl -s "https://firebasestorage.googleapis.com/v0/b/[project].appspot.com/o/"
```

## Phase 5: Security Headers & CORS

### 5.1 Security Headers Check
```
curl -sI "[FRONTEND_URL]" | grep -iE '^(strict-transport|content-security|x-frame|x-content-type|x-xss|referrer-policy|permissions-policy):'
```

### 5.2 CORS Check
```
curl -sI "$API_URL/api/projects" -H "Origin: https://evil.com" | grep -i "access-control"
```

## Phase 6: Dependency Audit

### 6.1 NPM/Yarn
```
npm audit --json 2>/dev/null | jq '.metadata.vulnerabilities'
npm outdated
```

### 6.2 Python
```
pip-audit
safety check
```

## Phase 7: Sensitive Data Exposure

### 7.1 API Response Analysis
```
curl -s "$API_URL/api/users" | jq 'if type == "array" then .[0] else . end | keys'
```

### 7.2 Error Message Analysis
```
curl -s "$API_URL/api/users/99999999"
curl -s -X POST "$API_URL/api/users" -d '{}'
```

## Severity Classification

| Level | Criteria | Examples |
|-------|----------|----------|
| **CRITICAL** | Immediate exploitation, data breach possible | Hardcoded passwords, no API auth, exposed secrets |
| **HIGH** | Significant risk, needs quick fix | Exposed API keys, missing auth on some routes, IDOR |
| **MEDIUM** | Should fix soon | Verbose errors, weak rate limiting, missing security headers |
| **LOW** | Best practice improvements | Outdated dependencies (no known exploits), missing CSP |

## Report Template
```
# SECURITY AUDIT REPORT
**Target:** [Project Name / URLs]
**Date:** [Date]
**Stack Detected:** [e.g., Next.js + Supabase + Cloudflare Workers]

## Executive Summary
[2-3 sentences]

## Critical Findings
### C1: [Title]
- **Location:** [File/URL/Endpoint]
- **Issue:** [Description]
- **Impact:** [What an attacker could do]
- **Evidence:** [curl command/code snippet]
- **Remediation:** [How to fix]

## High Findings
[Same format]

## Medium Findings
[Same format]

## Low Findings / Recommendations
[Same format]

## What's Secure
- [Positive finding 1]
- [Positive finding 2]

## Prioritized Action Plan
1. **Immediate (today):** [Critical fixes]
2. **This week:** [High fixes]
3. **This month:** [Medium fixes]
4. **Backlog:** [Low priority improvements]
```

## Stack-Specific Fix Guides

### Supabase Auth Setup
```
ALTER TABLE your_table ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only see own data" ON your_table
  FOR SELECT USING (auth.uid() = user_id);
```

### Cloudflare Workers Auth
```
app.use('/api/*', async (c, next) => {
  const token = c.req.header('Authorization')?.split(' ')[1]
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verify(token, c.env.JWT_SECRET)
    c.set('user', payload)
    await next()
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
})
```
