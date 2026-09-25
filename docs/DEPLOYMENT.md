# Production Deployment

This is the path for a real client website. The app must be deployed to a
hosting provider so it has a permanent HTTPS URL and keeps running when your
computer is off.

## Recommended Host: Render

The project includes:

- `Dockerfile` - builds the production app with Node.js 24.
- `render.yaml` - Render Blueprint for a web service.
- Persistent data path: `/var/data` for uploads and email-outbox records.
- PostgreSQL connection supplied through `DATABASE_URL`.
- Health check path: `/healthz`.

Render should attach a persistent disk at `/var/data` for uploads and email-outbox records. Users, sessions, carts, orders, and inventory require a separately provisioned PostgreSQL database.

## Steps

1. Upload this folder to GitHub.
2. Sign in to Render.
3. Create a new Blueprint or Web Service from the GitHub repository.
4. Confirm the service uses the included `render.yaml`.
5. Deploy.
6. Render will provide a URL like:

```text
https://printoasis.onrender.com
```

That is the client-ready website URL. It is not localhost and does not depend
on your laptop staying on.

## Required Environment Variables

Set these before sharing the production admin link. `DATABASE_URL` is required and must point to the managed PostgreSQL database:

```text
DATABASE_URL=postgresql://user:password@host:5432/printoasis
PGSSL=true
```

```text
ADMIN_EMAIL=owner-or-admin@example.com
ADMIN_PASSWORD=a-strong-private-password
```

For email notifications through Nodemailer:

```text
EMAIL_FROM=orders@your-domain.com
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
```

Uploaded artwork, product images, and local email-outbox files live under the persistent disk path `/var/data`. PostgreSQL remains external to that disk.

## Custom Domain

After deployment, add the client's domain in Render's Custom Domains settings,
then update DNS at the domain provider. When the domain is verified, Render
automatically serves it over HTTPS.

## Google Sign-In

After the final URL is known, create or update the Google OAuth Web Client:

- Authorized JavaScript origin: `https://your-final-domain.com`
- Authorized redirect URI: `https://your-final-domain.com/auth/google`

Then set this environment variable in Render:

```text
GOOGLE_CLIENT_ID=your-google-client-id
```

If you use a custom domain, also set:

```text
BASE_URL=https://your-final-domain.com
```

## Razorpay

After the client has a Razorpay account and approved keys, set these Render
environment variables:

```text
RAZORPAY_KEY_ID=your-key-id
RAZORPAY_KEY_SECRET=your-key-secret
```

Do not commit these keys to GitHub.
