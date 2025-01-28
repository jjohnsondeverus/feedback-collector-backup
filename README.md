# Feedback Collector

A Slack app that analyzes channel discussions using GPT-4 to either create Jira tickets or generate comprehensive summaries.

## Features

- 🤖 Two operating modes:
  - Jira ticket creation
  - Discussion summarization

## Usage

1. Use the `/collect-feedback` command in any Slack channel
2. Choose the mode:
   - **Create Jira Tickets**: For actionable feedback
   - **Generate Summary**: For discussion analysis
3. Select target channel and date range
4. Click "Process Feedback"

The bot will:
- Fetch messages from the selected time period
- Analyze the conversations using AI
- Either create Jira tickets or generate a summary
- Send results via DM to the requesting user

### 1. Jira Ticket Creation
Automatically processes Slack conversations and creates Jira tickets based on feedback.

### 2. Channel Summary Generation
Generate concise summaries of Slack channel discussions over a specified time period. The summary includes:

#### Technical Issues & Decisions
- Prioritized list of technical issues and decisions (up to 8 items)
- Each issue includes:
  - Priority indicator (🔴 High, 🟡 Medium, 🟢 Low)
  - Issue title/description
  - First seen date

#### Critical Action Items
- List of action items and next steps (up to 5 items)
- Each action includes:
  - Status indicator (⏰ Urgent, 📋 Planned)
  - Action description
  - Due date or added date

### Using the Summary Feature
1. Type `/collect-feedback` in any channel
2. Select "Generate Summary" from the process type options
3. Choose the channel to analyze
4. Select the date range
5. Click "Process Feedback"

The agent will:
- Fetch all messages from the selected time period
- Analyze the conversations using AI
- Generate a structured summary
- Post the results in a DM to the requesting user

## Setup

### Prerequisites

- Node.js (v14 or higher)
- Slack Workspace with admin access
- Jira account with API access
- OpenAI API key

### Installation

1. Clone the repository and install dependencies:
```bash
git clone [repository-url]
cd feedback-collector
npm install
```

2. Create a `.env` file in the root directory with the following variables:
```env
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
JIRA_HOST=your-domain.atlassian.net
JIRA_USERNAME=your-email@domain.com
JIRA_API_TOKEN=...
OPENAI_API_KEY=...
DUPLICATE_SIMILARITY_THRESHOLD=0.3
OPENAI_MODEL=gpt-4-turbo-preview  # Optional, defaults to latest GPT-4
```

3. Start the application:
```bash
npm start
```

## Configuration

### Environment Variables

- `DUPLICATE_SIMILARITY_THRESHOLD`: (Default: 0.3) Controls duplicate detection sensitivity:
  - Lower values (e.g., 0.2) catch more potential duplicates
  - Higher values (e.g., 0.4) require tickets to be more similar
  - Recommended range: 0.2 - 0.4

## Channel Access

The bot can access channels in two ways:

1. **Public Channels**
   - Bot will automatically join when collecting feedback
   - No additional setup required

2. **Private Channels**
   - Bot must be explicitly invited using `/invite @YourBotName`
   - Must be invited before collecting feedback
   - Channel members with permission can invite the bot

## Deployment

1. SSH into EC2:
```bash
ssh -i feedback-collector-backup-key.pem ec2-user@your-ec2-ip
```

2. Update environment variables:
```bash
cd feedback-collector-backup
nano .env
```

3. Restart the app:
```bash
pm2 restart app --update-env
```

## Support

Contact the development team for support and feature requests.
