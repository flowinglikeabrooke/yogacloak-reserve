# yogacloak Admin Deploy Troubleshooting

Use this when `https://www.yogacloak.com/yogacloak-admin.html` shows:

```json
{"error":"Not found"}
```

That message means the live site is not serving the admin backend route yet. It is not an admin password problem.

## What Should Happen

This URL:

```text
https://www.yogacloak.com/yogacloak-admin.html
```

is routed by Vercel to:

```text
/api/admin-page
```

The real private admin file is:

```text
private/admin-hub.html
```

That file is only shown after the secure admin session is verified.

## Correct Project

The working project folder is:

```text
/Users/brookebein/COMMON ORBIT/yogacloak-repo
```

This folder has all required admin backend files:

```text
api/[...path].js
server/api/admin-page.js
private/admin-hub.html
vercel.json
```

The other local yogacloak folders do not have the admin hub route.

## Vercel Checks

In Vercel, check these in order:

1. Open the yogacloak project.
2. Go to Deployments.
3. Open the latest Production deployment.
4. Confirm the deployment status is Ready or Success.
5. Confirm the source commit is `4487067` or newer.
6. Go to Settings, then Git.
7. Confirm the Production Branch is `main`.
8. Confirm the Root Directory is blank unless Vercel specifically points to `yogacloak-repo`.
9. Go to Settings, then Domains.
10. Confirm `yogacloak.com` and `www.yogacloak.com` are attached to this same project.

## Quick Live Tests

Open:

```text
https://www.yogacloak.com/api/admin-session
```

Expected result when logged out:

```json
{"ok":true,"authenticated":false}
```

If you see that, the API backend is live. `authenticated:false` only means you have not logged in yet.

If it says `{"error":"Not found"}`, the API backend is not live on that domain.

Open the direct admin page:

```text
https://www.yogacloak.com/api/admin-page
```

Expected result:

- Login page means the admin backend is working.
- `Invalid admin token` means the page works, but the value pasted does not match Vercel's Production `ADMIN_TOKEN`.
- After changing `ADMIN_TOKEN`, redeploy Production before trying again.

Open:

```text
https://www.yogacloak.com/yogacloak-admin.html
```

Expected result:

- Login page means the route works.
- `{"error":"Not found"}` means Vercel is deploying the wrong source, wrong root, wrong branch, or wrong project/domain.

## Environment Variable

The login page also needs this Vercel environment variable:

```text
ADMIN_TOKEN
```

After changing `ADMIN_TOKEN`, redeploy Production before trying to log in.
