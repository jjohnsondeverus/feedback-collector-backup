# Feedback Collector

A Slack app that analyzes channel discussions using GPT-4o to either create Jira tickets or generate comprehensive summaries.

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

### 1. Jira Ticket Creation
Before creating tickets:
1. Set the Jira project key when prompted
2. Review generated feedback items
3. Include/exclude specific items using checkboxes
4. Click "Create Selected Tickets"

Features:
- Automatic duplicate detection
- Priority assignment (High/Medium/Low)
- Structured ticket format with:
  - User impact
  - Current behavior
  - Expected behavior
  - Additional context

### 2. Channel Summary Generation
Generate concise summaries with:
- Technical Issues & Decisions (prioritized)
- Critical Action Items
- Status indicators

## Status Indicators
### Priority
🔴 High Priority/Blocking
🟡 Medium Priority/Important
🟢 Low Priority/Enhancement

### Status
⏰ Urgent/Time-sensitive
�� Planned/Scheduled
⚠️ Needs Attention
✅ Resolved/Complete

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
