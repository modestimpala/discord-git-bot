# GitHub Activity Discord Bot

Posts your public GitHub activity to a Discord channel. Tracks all repos automatically via the GitHub Events API.

## Features

- Polls GitHub Events API for all public activity
- Supports: pushes, releases, issues, comments, PRs, forks, stars, branch/repo creation
- Fetches commit messages from compare API
- Rate limit handling with automatic backoff
- Configurable event type filtering
- Persistent state survives restarts
- Graceful shutdown
- No incoming connections needed

## Setup

### 1. Discord Bot
1. Go to https://discord.com/developers/applications
2. Create application, add bot, copy token
3. Invite: `https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2048&scope=bot`
4. Get channel ID (Developer Mode > right-click channel > Copy ID)

### 2. GitHub Token (recommended)
1. https://github.com/settings/tokens
2. Generate new token (classic)
3. Scope: `public_repo` only
4. Without token: 60 requests/hour. With token: 5000/hour.

### 3. Configure
```bash
cp .env.example .env
# edit .env
```

### 4. Run
```bash
npm install
npm start
```

Or with Docker:
```bash
docker compose up -d
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| DISCORD_TOKEN | yes | - | Bot token |
| CHANNEL_ID | yes | - | Channel to post in |
| GITHUB_USERNAME | yes | - | GitHub username to track |
| GITHUB_TOKEN | no | - | GitHub PAT for higher rate limits |
| POLL_INTERVAL | no | 60000 | Poll interval in ms |
| EVENT_TYPES | no | (all) | Comma-separated event types to post |
| DEBUG | no | false | Enable debug logging |

### Event Types
`PushEvent,CreateEvent,ForkEvent,WatchEvent,ReleaseEvent,IssuesEvent,IssueCommentEvent,PullRequestEvent`

Example to only track pushes and releases:
```
EVENT_TYPES=PushEvent,ReleaseEvent
```
