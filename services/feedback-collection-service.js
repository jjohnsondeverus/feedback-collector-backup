const { DynamoDBService } = require('./dynamodb-service');
const { OpenAIService } = require('./openai-service');
const { JiraApi } = require('./jira-api');

class FeedbackCollectionService {
  constructor(config = {}, services = {}) {
    this.dynamoDBService = services.dynamoDBService || new DynamoDBService();
    this.openAIService = services.openAIService || new OpenAIService();
    this.slackClient = services.slackClient;
    this.jira = new JiraApi({
      protocol: 'https',
      host: process.env.JIRA_HOST,
      username: process.env.JIRA_USERNAME,
      password: process.env.JIRA_API_TOKEN,
      apiVersion: '2',
      strictSSL: true
    });
  }

  async startSession({ userId, channels, startDate, endDate }) {
    const sessionId = `SESSION#${Date.now()}`;
    await this.dynamoDBService.createSession({
      sessionId,
      userId,
      channels,
      startDate,
      endDate,
      status: 'ACTIVE'
    });
    return { sessionId };
  }

  async collectFeedbackFromMessages({ sessionId, channelId, messages }) {
    const feedback = await this.openAIService.analyzeFeedback(messages);
    await this.dynamoDBService.addFeedbackItems({
      sessionId,
      channelId,
      items: feedback.feedback
    });
    return feedback;
  }

  async previewFeedbackItems({ sessionId, channelId }) {
    const items = await this.dynamoDBService.getFeedbackItems(sessionId, channelId);
    return { items };
  }

  async createJiraTickets(selectedItems) {
    const items = await this.dynamoDBService.getFeedbackItems(selectedItems[0].sessionId);
    
    const tickets = await Promise.all(selectedItems.map(async (selected) => {
      const item = items.find((_, index) => index === selected.index);
      if (!item) return null;

      // Create Jira issue
      const issue = await this.jira.addNewIssue({
        fields: {
          project: { key: process.env.JIRA_PROJECT_KEY },
          summary: selected.title || item.title,
          description: this.createJiraDescription(item),
          issuetype: { name: this.mapTypeToJira(item.type) },
          priority: { name: this.mapPriorityToJira(item.priority) }
        }
      });

      return issue;
    }));

    return tickets.filter(t => t);
  }

  private mapTypeToJira(type) {
    const typeMap = {
      bug: 'Bug',
      feature: 'New Feature',
      improvement: 'Improvement'
    };
    return typeMap[type.toLowerCase()] || 'Task';
  }

  private mapPriorityToJira(priority) {
    const priorityMap = {
      high: 'High',
      medium: 'Medium',
      low: 'Low'
    };
    return priorityMap[priority.toLowerCase()] || 'Medium';
  }

  private createJiraDescription(item) {
    return `
h2. User Impact
${item.user_impact}

h2. Current Behavior
${item.current_behavior || 'N/A'}

h2. Expected Behavior
${item.expected_behavior || 'N/A'}

h2. Additional Context
${item.additional_context || 'N/A'}
    `.trim();
  }
}

module.exports = { FeedbackCollectionService }; 