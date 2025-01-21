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

## Setup

### Prerequisites

- Node.js (v14 or higher)
- Slack Workspace with admin access
- Jira account with API access
- OpenAI API key

### Installation

1. Clone the repository and install dependencies:
```bash
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
DUPLICATE_SIMILARITY_THRESHOLD=0.5
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

- `DUPLICATE_SIMILARITY_THRESHOLD`: (Default: 0.5) Controls duplicate detection sensitivity:
  - Higher values (e.g., 0.7) require tickets to be more similar
  - Lower values (e.g., 0.3) catch more potential duplicates
  - Recommended range: 0.4 - 0.7

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

Choose your own license

## Support

For support, please open an issue for the developer with the label "feedback-collector" in the repository.
