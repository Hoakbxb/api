# Deploying this API to Vercel

## 1. Connect repository

- Push this project to GitHub (already done).
- Go to [vercel.com/new](https://vercel.com/new), import the `Hoakbxb/api` repo.
- Set **Root Directory** to the repo root (this `api` folder is the repo).
- Framework Preset: **Other** (or leave as auto-detected).

## 2. Environment variables

In the Vercel project: **Settings → Environment Variables**, add:

| Variable | Description | Required |
|----------|-------------|----------|
| `MONGO_DB_PASSWORD` | MongoDB Atlas password (if not using full URI) | Yes* |
| `MONGO_URI` | Full MongoDB connection string (alternative to user/password) | Yes* |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 access key (for file uploads) | Optional |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 secret key | Optional |
| `R2_ENDPOINT` | R2 endpoint URL | Optional |
| `R2_BUCKET` | R2 bucket name (default: `files-upload`) | Optional |

\* Use either `MONGO_URI` or `MONGO_DB_PASSWORD` for MongoDB.

## 3. Deploy

- Click **Deploy** (or push to `main` if Git integration is connected).
- Your API will be available at `https://<your-project>.vercel.app`.

## 4. Local preview

```bash
npm install
vercel dev
```

## Notes

- **Static files**: `express.static()` does not serve files on Vercel. Profile images should be served via your R2/upload flow.
- **CORS**: If your frontend is on another domain, ensure CORS is configured in the app (already using `cors()` with default options; tighten in production if needed).
