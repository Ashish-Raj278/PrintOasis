# GitHub And Client Approval

## Run Locally

```powershell
cd "C:\Users\Ashish\Documents\Codex\2026-06-09\need-to-create-a-print-services\outputs\PrintOasis-GitHub-Source"
npm.cmd start
```

Open `http://localhost:3000`.

## Share With Client

Double-click:

```text
SHARE-WITH-CLIENT.cmd
```

It starts the website and prints a public HTTPS preview URL. Send that URL to
the client and keep the window open while they review.

## Upload To GitHub

Upload the `PrintOasis-GitHub-Source` folder as the repository source.

Recommended steps:

```powershell
cd "C:\Users\Ashish\Documents\Codex\2026-06-09\need-to-create-a-print-services\outputs\PrintOasis-GitHub-Source"
git init
git add .
git commit -m "Initial PrintOasis website"
```

Then create an empty GitHub repository and follow GitHub's "push an existing
repository" commands.

## Live Google And Razorpay

Google Sign-In and Razorpay are implemented, but they need the client's real
approved credentials in a private `.env` file or hosting environment variables.

Use `.env.example` as the template. Do not commit `.env`.

## Permanent Website

For a proper client website that is not localhost, deploy the GitHub repository
to a hosting provider. This project includes `Dockerfile`, `render.yaml`, and
`docs/DEPLOYMENT.md` for that path.
