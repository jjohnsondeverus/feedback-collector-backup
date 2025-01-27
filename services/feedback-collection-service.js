const { DynamoDBService } = require('./dynamodb-service');
const { OpenAIService } = require('./openai-service');

class FeedbackCollectionService {
  constructor(config = {}, services = {}) {
    this.dynamoDBService = services.dynamoDBService || new DynamoDBService();
    this.openAIService = services.openAIService || new OpenAIService();
    this.slackClient = services.slackClient;
    this.jira = new (require('jira-client'))({
      protocol: 'https',
      host: process.env.JIRA_HOST?.replace(/^https?:\/\//, ''),
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

  _calculateSimilarity(str1, str2) {
    const s1 = str1.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const s2 = str2.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    
    const words1 = new Set(s1.split(/\s+/));
    const words2 = new Set(s2.split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  async createJiraTickets(selectedItems, projectKey) {
    if (!selectedItems || selectedItems.length === 0) {
      throw new Error('No items selected for ticket creation');
    }

    if (!selectedItems[0].sessionId) {
      throw new Error('Session ID is required for ticket creation');
    }

    if (!process.env.JIRA_HOST || !process.env.JIRA_USERNAME || !process.env.JIRA_API_TOKEN) {
      throw new Error('Missing required Jira configuration. Please check your environment variables.');
    }

    if (!projectKey) {
      throw new Error('Jira Project Key is required');
    }

    const items = await this.dynamoDBService.getFeedbackItems(selectedItems[0].sessionId);
    
    if (!items || items.length === 0) {
      throw new Error('No feedback items found for this session');
    }
    
    // Function to check for duplicate issues
    const checkForDuplicate = async (summary) => {
      try {
        const jql = `project = "${projectKey}" AND created >= -30d`;
        const results = await this.jira.searchJira(jql);
        const threshold = parseFloat(process.env.DUPLICATE_SIMILARITY_THRESHOLD || 0.5);
        
        // Check each issue for similarity
        for (const issue of results.issues) {
          const similarity = this._calculateSimilarity.bind(this)(summary, issue.fields.summary);
          console.log(`Comparing "${summary}" with "${issue.fields.summary}": ${similarity}`);
          if (similarity >= threshold) {
            return issue;
          }
        }
        return null;
      } catch (error) {
        console.error('Error checking for duplicates:', error);
        return null;
      }
    };
    
    const tickets = await Promise.all(selectedItems.map(async (selected) => {
      const item = items.find((_, index) => index === selected.index);
      if (!item) return null;

      try {
        // Check for duplicates
        const duplicate = await checkForDuplicate(selected.title);
        if (duplicate) {
          return {
            skipped: true,
            title: selected.title,
            duplicateKey: duplicate.key
          };
        }
        
        // Create Jira issue
        const issue = await this.jira.addNewIssue({
          fields: {
            project: { key: projectKey },
            summary: selected.title || item.title,
            description: this._createJiraDescription(item),
            issuetype: { name: this._mapTypeToJira(item.type) },
            priority: { name: this._mapPriorityToJira(item.priority) }
          }
        });
        console.log(`Created Jira ticket: ${issue.key}`);
        return {
          ...issue,
          skipped: false,
          title: selected.title || item.title
        };
      } catch (error) {
        console.error('Error creating Jira ticket:', error);
        throw new Error(`Failed to create Jira ticket: ${error.message}`);
      }
    }));

    return tickets.filter(Boolean);
  }

  _mapTypeToJira(type) {
    const typeMap = {
      bug: 'Bug',
      feature: 'New Feature',
      improvement: 'Improvement'
    };
    return typeMap[type.toLowerCase()] || 'Task';
  }

  _mapPriorityToJira(priority) {
    const priorityMap = {
      high: 'High',
      medium: 'Medium',
      low: 'Low'
    };
    return priorityMap[priority.toLowerCase()] || 'Medium';
  }

  _createJiraDescription(item) {
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