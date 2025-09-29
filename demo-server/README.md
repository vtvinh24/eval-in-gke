# Demo Judge Server

A simple web-based judge server for the Database Evaluation System prototype. This server allows teams to submit repositories for evaluation and judges to score submissions.

## Features

### For Teams

- Submit GitHub repositories for evaluation
- View submission status and metrics
- Track evaluation progress

### For Judges

- Review completed submissions
- Score submissions based on three criteria:
  - Code Quality (0-100)
  - Optimization (0-100)
  - Innovation (0-100)
- View performance metrics and baseline comparisons

### General Features

- Real-time leaderboard
- Automatic scoring based on performance vs baseline
- Simple file-based data persistence
- Auto-refresh dashboard
- Responsive web interface

## Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Configure environment:**

   ```bash
   cp .env.example .env
   # Edit .env with your Cloud Run API URL
   ```

3. **Start the server:**

   ```bash
   npm start
   ```

4. **Access the interface:**
   Open http://localhost:3000 in your browser

## Default Credentials

### Judges

- `judge1` / `judge123`
- `judge2` / `judge123`

### Teams

- `team1` / `team123`
- `team2` / `team123`
- `team3` / `team123`

## API Endpoints

### Authentication

- `POST /api/auth` - Login with username/password

### Submissions

- `POST /api/submissions` - Submit repository (teams only)
- `GET /api/submissions` - Get all submissions
- `GET /api/submissions?team=<teamId>` - Get submissions by team
- `GET /api/submissions/:id` - Get specific submission

### Judging

- `POST /api/submissions/:id/judge` - Submit judge scores (judges only)

### Data

- `GET /api/leaderboard` - Get current leaderboard
- `GET /api/baseline` - Get baseline metrics
- `GET /api/users` - Get users list (judges only)

## Auto-Scoring Algorithm

The system automatically scores submissions by comparing them to baseline metrics:

1. **Performance Score (0-40 points per query):**

   - Based on execution time vs baseline
   - Better performance = higher score

2. **Correctness Score (0-60 points per query):**

   - Based on query correctness validation
   - Pass/fail basis

3. **Final Score:**
   - Average across all queries (0-100)
   - Combined with manual judge scores

## Data Persistence

All data is stored in `data.json` for easy inspection and modification. The file includes:

- User accounts
- Submissions with metadata
- Judge evaluations
- Cached baseline metrics
- Job status tracking

## Integration with GKE/Cloud Run

The server integrates with the evaluation system using multiple approaches for robustness:

### Metrics Fetching

1. **Baseline Metrics** (Primary approach):

   - Uses `get-latest-baseline.sh` script to fetch latest baseline dump from GCS
   - Automatically downloads corresponding `summary.json` with performance metrics
   - Falls back to Cloud Run API if script-based approach fails

2. **Submission Results** (Hybrid approach):
   - First checks GCS buckets directly for completed job results
   - Falls back to Cloud Run API for status monitoring if results not found
   - Reduces API load and improves response time

### Job Creation

1. **Submission Jobs**:

   - Primary: Uses `create-job.sh` script for direct Kubernetes job creation
   - Fallback: Cloud Run API for job submission
   - Provides better integration with existing infrastructure scripts

2. **Baseline Jobs**:
   - Script-based creation when generating new baselines
   - API fallback ensures compatibility

### Configuration

Key environment variables for the updated approach:

- `GET_LATEST_BASELINE_SCRIPT`: Path to baseline fetching script
- `CREATE_JOB_SCRIPT`: Path to job creation script
- `BASELINE_BUCKET`: GCS bucket for baseline artifacts
- `SUBMISSION_RESULTS_BUCKET`: GCS bucket for submission results
- `GCP_CREDENTIALS_JSON_PATH`: Service account for GCS access

## Monitoring

The server periodically checks job statuses and updates submission data automatically. Check the console for monitoring logs:

```
Baseline job created: eval-baseline-20240928-143022-abc123
Baseline job status: running
Job eval-submission-20240928-144500-def456 completed and results updated
```

## Development

### File Structure

```
demo-server/
├── server.js          # Main server application
├── package.json       # Dependencies and scripts
├── data.json         # Persistent data storage
├── .env              # Environment configuration
└── public/           # Web interface
    ├── index.html    # Main HTML page
    └── app.js        # Client-side JavaScript
```

### Extending Functionality

To add new features:

1. **Add API endpoints** in `server.js`
2. **Update UI** in `public/index.html` and `public/app.js`
3. **Modify data structure** in the `initData` object
4. **Update scoring algorithm** in the `calculateScore` function

### Testing

1. Start the server: `npm start`
2. Login with demo credentials
3. Submit a test repository
4. Monitor job status in console
5. Score submissions as a judge
6. Check leaderboard updates

## Troubleshooting

### Common Issues

1. **Connection to Cloud Run fails:**

   - Check `CLOUD_RUN_API_URL` in `.env`
   - Verify Cloud Run service is deployed and accessible

2. **Baseline metrics not loading:**

   - Check server console for error messages
   - Baseline job may take 10-30 minutes to complete

3. **Jobs stuck in "evaluating" status:**

   - Check GKE cluster and job status
   - Review Cloud Run API logs

4. **Data not persisting:**
   - Ensure write permissions for `data.json`
   - Check server console for file system errors

### Debug Mode

Set environment variable for more verbose logging:

```bash
DEBUG=true npm start
```

## Production Considerations

For production use, consider:

1. **Database:** Replace file-based storage with proper database
2. **Authentication:** Implement proper user management and JWT tokens
3. **Security:** Add HTTPS, input validation, and rate limiting
4. **Monitoring:** Add proper logging and health checks
5. **Scalability:** Add load balancing and session management
