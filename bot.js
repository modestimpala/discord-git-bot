const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

const client = new Client({ 
    intents: [GatewayIntentBits.Guilds],
    rest: { timeout: 30000 }
});

const CONFIG = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    CHANNEL_ID: process.env.CHANNEL_ID,
    GITHUB_USERNAME: process.env.GITHUB_USERNAME,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 60000,
    STATE_FILE: process.env.STATE_FILE || './data/last_event.json',
    EVENT_TYPES: (process.env.EVENT_TYPES || 'PushEvent,CreateEvent,ForkEvent,ReleaseEvent,IssuesEvent,IssueCommentEvent,PullRequestEvent').split(','),
    DEBUG: process.env.DEBUG === 'true'
};

function validateConfig() {
    const required = ['DISCORD_TOKEN', 'CHANNEL_ID', 'GITHUB_USERNAME'];
    const missing = required.filter(k => !CONFIG[k]);
    if (missing.length > 0) {
        console.error(`Missing required config: ${missing.join(', ')}`);
        process.exit(1);
    }
    if (!CONFIG.GITHUB_TOKEN) {
        console.warn('No GITHUB_TOKEN set - rate limited to 60 requests/hour');
    }
}

let lastEventId = null;
let rateLimitReset = 0;

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function debug(msg) {
    if (CONFIG.DEBUG) log(`[DEBUG] ${msg}`);
}

function loadLastEventId() {
    try {
        if (fs.existsSync(CONFIG.STATE_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8')).lastEventId;
        }
    } catch (e) {
        log(`Failed to load state: ${e.message}`);
    }
    return null;
}

function saveLastEventId(id) {
    try {
        const dir = path.dirname(CONFIG.STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify({ lastEventId: id }));
    } catch (e) {
        log(`Failed to save state: ${e.message}`);
    }
}

async function fetchGitHub(url) {
    if (Date.now() < rateLimitReset) {
        const wait = Math.ceil((rateLimitReset - Date.now()) / 1000);
        debug(`Rate limited, waiting ${wait}s`);
        return null;
    }

    const headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'github-commit-bot'
    };
    if (CONFIG.GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${CONFIG.GITHUB_TOKEN}`;
    }

    const response = await fetch(url, { headers });
    
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining) debug(`Rate limit remaining: ${remaining}`);
    
    if (response.status === 403 || response.status === 429) {
        const reset = response.headers.get('x-ratelimit-reset');
        rateLimitReset = reset ? parseInt(reset) * 1000 : Date.now() + 60000;
        log(`Rate limited until ${new Date(rateLimitReset).toISOString()}`);
        return null;
    }

    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
    }

    return response.json();
}

async function fetchEvents() {
    return fetchGitHub(`https://api.github.com/users/${CONFIG.GITHUB_USERNAME}/events/public`);
}

async function fetchCommits(repoName, before, head) {
    const data = await fetchGitHub(`https://api.github.com/repos/${repoName}/compare/${before}...${head}`);
    if (!data) return [];
    return (data.commits || []).map(c => ({
        sha: c.sha,
        message: c.commit.message
    }));
}

async function pollGitHub() {
    try {
        const events = await fetchEvents();
        if (!events) return;
        
        debug(`Fetched ${events.length} events`);

        const channel = client.channels.cache.get(CONFIG.CHANNEL_ID);
        if (!channel) {
            log(`Channel not found: ${CONFIG.CHANNEL_ID}`);
            return;
        }

        const newEvents = [];
        for (const event of events) {
            if (event.id === lastEventId) break;
            if (CONFIG.EVENT_TYPES.includes(event.type)) {
                newEvents.push(event);
            }
        }

        if (newEvents.length > 0) {
            if (lastEventId === null) {
                debug('First run - posting latest event only');
                await postEvent(channel, newEvents[0]);
            } else {
                debug(`Posting ${newEvents.length} new events`);
                for (const event of newEvents.reverse()) {
                    await postEvent(channel, event);
                    await sleep(500);
                }
            }
        }

        if (events.length > 0) {
            lastEventId = events[0].id;
            saveLastEventId(lastEventId);
        }
    } catch (err) {
        log(`Poll error: ${err.message}`);
    }
}

const EVENT_COLORS = {
    PushEvent: 0x238636,
    CreateEvent: 0x8957e5,
    ForkEvent: 0x58a6ff,
    WatchEvent: 0xf0b72f,
    ReleaseEvent: 0x1f6feb,
    IssuesEvent: 0x238636,
    IssueCommentEvent: 0x768390,
    PullRequestEvent: 0x8957e5,
};

async function postEvent(channel, event) {
    const { type, repo, actor, payload, created_at } = event;
    const repoName = repo.name.split('/')[1];
    const repoUrl = `https://github.com/${repo.name}`;

    const embed = new EmbedBuilder()
        .setColor(EVENT_COLORS[type] || 0x768390)
        .setAuthor({
            name: actor.login,
            iconURL: actor.avatar_url,
            url: `https://github.com/${actor.login}`
        })
        .setTimestamp(new Date(created_at))
        .setFooter({ text: repo.name });

    try {
        switch (type) {
            case 'PushEvent': {
                const branch = payload.ref.replace('refs/heads/', '');
                let commits = payload.commits || [];

                if (commits.length === 0 && payload.before && payload.head) {
                    commits = await fetchCommits(repo.name, payload.before, payload.head);
                }

                const commitCount = payload.size || commits.length || 1;

                if (commits.length > 0) {
                    const commitList = commits.slice(0, 5).map(c => {
                        const sha = c.sha.substring(0, 7);
                        const msg = truncate(c.message.split('\n')[0], 50);
                        return `[\`${sha}\`](https://github.com/${repo.name}/commit/${c.sha}) ${msg}`;
                    }).join('\n');
                    embed.setDescription(commitList + (commits.length > 5 ? `\n... and ${commits.length - 5} more` : ''));
                } else {
                    const shortHead = payload.head ? payload.head.substring(0, 7) : '';
                    embed.setDescription(`[\`${shortHead}\`](https://github.com/${repo.name}/commit/${payload.head})`);
                }

                embed.setTitle(`Pushed ${commitCount} commit${commitCount > 1 ? 's' : ''} to ${repoName}/${branch}`)
                    .setURL(`https://github.com/${repo.name}/tree/${branch}`);
                break;
            }
            case 'CreateEvent': {
                const target = payload.ref ? `\`${payload.ref}\`` : repoName;
                embed.setTitle(`Created ${payload.ref_type} ${target}`)
                    .setURL(payload.ref ? `https://github.com/${repo.name}/tree/${payload.ref}` : repoUrl);
                if (payload.description) embed.setDescription(payload.description);
                break;
            }
            case 'ForkEvent': {
                embed.setTitle(`Forked to ${payload.forkee.full_name}`)
                    .setURL(payload.forkee.html_url);
                if (payload.forkee.description) embed.setDescription(payload.forkee.description);
                break;
            }
            case 'WatchEvent': {
                embed.setTitle(`Starred ${repo.name}`)
                    .setURL(repoUrl);
                break;
            }
            case 'ReleaseEvent': {
                const rel = payload.release;
                embed.setTitle(`Released ${rel.tag_name}${rel.name && rel.name !== rel.tag_name ? `: ${rel.name}` : ''}`)
                    .setURL(rel.html_url);
                if (rel.body) embed.setDescription(truncate(rel.body, 200));
                break;
            }
            case 'IssuesEvent': {
                embed.setTitle(`${capitalize(payload.action)} issue #${payload.issue.number}`)
                    .setURL(payload.issue.html_url)
                    .setDescription(truncate(payload.issue.title, 100));
                break;
            }
            case 'IssueCommentEvent': {
                embed.setTitle(`Commented on #${payload.issue.number}`)
                    .setURL(payload.comment.html_url)
                    .setDescription(truncate(payload.comment.body, 150));
                break;
            }
            case 'PullRequestEvent': {
                const pr = payload.pull_request;
                const merged = pr.merged ? ' (merged)' : '';
                embed.setTitle(`${capitalize(payload.action)} PR #${pr.number}${merged}`)
                    .setURL(pr.html_url)
                    .setDescription(truncate(pr.title, 100));
                break;
            }
            default:
                return;
        }

        await channel.send({ embeds: [embed] });
        log(`Posted ${type} for ${repo.name}`);
    } catch (err) {
        log(`Error posting ${type}: ${err.message}`);
    }
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function truncate(str, len) {
    if (!str) return '';
    if (str.length <= len) return str;
    return str.substring(0, len - 3) + '...';
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

let pollInterval;

client.once('clientReady', () => {
    log(`Logged in as ${client.user.tag}`);
    log(`Polling ${CONFIG.GITHUB_USERNAME} every ${CONFIG.POLL_INTERVAL / 1000}s`);
    log(`Event types: ${CONFIG.EVENT_TYPES.join(', ')}`);

    lastEventId = loadLastEventId();
    pollGitHub();
    pollInterval = setInterval(pollGitHub, CONFIG.POLL_INTERVAL);
});

client.on('error', err => log(`Discord error: ${err.message}`));

async function shutdown() {
    log('Shutting down...');
    clearInterval(pollInterval);
    client.destroy();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

validateConfig();
client.login(CONFIG.DISCORD_TOKEN);
