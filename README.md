# Feedback Collector

A Slack app that collects user feedback from channels, analyzes it using GPT-4, and creates either structured Jira tickets or comprehensive summaries.

## Features

- 🤖 Two operating modes:
  - Jira ticket creation
  - Discussion summarization
- 📅 Date range selection for feedback gathering
- 🧠 Context-aware AI analysis using GPT-4
- 🎫 Automatic Jira ticket creation with:
  - Structured formatting
  - Duplicate detection
  - Channel-specific project keys
  - Custom labels
- 📊 Smart summaries with channel-specific focus:
  - Expense discussions (tools, costs, pros/cons)
  - Technical discussions (bugs, solutions, impacts)
  - General discussions (decisions, actions, updates)
- ✏️ Interactive preview and editing of tickets
- 🔄 Ticket exclusion and inclusion
- ⚡ Real-time processing and updates
- Collect feedback from specified Slack channels
- Support for both public and private channels

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

For development with auto-reload:
```bash
npm run dev
```

## Usage

1. Use the `/collect-feedback` command in any Slack channel
2. Choose the mode:
   - **Create Jira Tickets**: For actionable feedback
   - **Generate Summary**: For discussion analysis
3. Select target channels and date range
4. For Jira tickets:
   - Review AI-analyzed feedback
   - Edit tickets if needed
   - Exclude unwanted tickets
   - Select project key for each channel
   - Create tickets
5. For Summaries:
   - Get a structured analysis based on channel type
   - View key points, decisions, and action items
   - Share with team members

## Configuration

### Environment Variables

- `DUPLICATE_SIMILARITY_THRESHOLD`: (Default: 0.3) Controls duplicate detection sensitivity:
  - Lower values (e.g., 0.2) catch more potential duplicates
  - Higher values (e.g., 0.4) require tickets to be more similar
  - Recommended range: 0.2 - 0.4

### Channel Types

The app recognizes different channel types and adjusts analysis accordingly:
- **Expense channels**: Focus on software tools, costs, and ROI
- **Technical channels**: Focus on bugs, features, and improvements
- **General channels**: Focus on decisions and action items

## Technical Details

### Core Functionality

1. **Dual-Mode Operation**
   - Ticket creation with duplicate detection
   - Smart summarization with context awareness

2. **AI Analysis**
   - Channel-specific prompts
   - Structured output formatting
   - Enhanced similarity detection

3. **Jira Integration**
   - Multi-project support
   - Custom field mapping
   - Label management

### Error Handling

- Validates all user inputs
- Handles API rate limits
- Provides clear error messages
- Maintains data consistency

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Submit a pull request

## License

MIT License

## Support

For support, please open an issue for the developer with the label "feedback-collector" in the repository.

## Duplicate Detection Configuration

The app uses a similarity-based approach to detect duplicate tickets:

### How it works

1. **Title Similarity (60% weight)**
   - Compares the titles of tickets using word overlap
   - Case-insensitive comparison
   - Ignores special characters

2. **Content Similarity (40% weight)**
   - Compares ticket content including:
     - User Impact
     - Current Behavior
     - Expected Behavior

3. **Threshold**
   - Default: 0.3 (30% similarity)
   - Adjustable via DUPLICATE_SIMILARITY_THRESHOLD
   - Range: 0.0 to 1.0 (0% to 100%)

### Adjusting Settings

1. **Change Similarity Threshold**
   - Lower value (e.g., 0.2): More likely to mark as duplicate
   - Higher value (e.g., 0.4): Stricter duplicate detection
   - Update in .env file:
   ```env
   DUPLICATE_SIMILARITY_THRESHOLD=0.3
   ```

2. **View Similarity Scores**
   - Check logs for detailed comparison:
   ```bash
   pm2 logs
   ```
   - Shows title, content, and overall similarity scores

## Development

1. Start the app:
```bash
npm start
```

2. Run tests:
```bash
npm test
```

3. Update the app:
```bash
pm2 restart app --update-env
```

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

## Troubleshooting

1. **Duplicate Detection Issues**
   - Check similarity scores in logs
   - Adjust threshold if needed
   - Verify content being compared

2. **App Restart Required**
   - After changing .env variables
   - After updating duplicate detection settings

## Support

Contact the development team for support and feature requests.

## Channel Access

The bot can access channels in two ways:

1. **Public Channels**
   - Bot will automatically join when collecting feedback
   - No additional setup required

2. **Private Channels**
   - Bot must be explicitly invited using `/invite @YourBotName`
   - Must be invited before collecting feedback
   - Channel members with permission can invite the bot
