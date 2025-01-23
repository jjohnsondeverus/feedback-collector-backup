const TransactionalOperations = require('./transactional-operations');
const dynamoDBService = require('./dynamodb-service');
const cloudwatchService = require('./cloudwatch-service');
const openAIService = require('./openai-service');

class FeedbackCollectionService {
  constructor(jiraClient, config = {}) {
    this.jiraClient = jiraClient;
    this.slackClient = config.slackClient;
    this.transactionalOps = new TransactionalOperations();
    this.config = {
      similarityThreshold: config.similarityThreshold || 0.5,
      duplicateCacheDuration: config.duplicateCacheDuration || 24,
      ...config
    };
  }

  // Start a new feedback collection session
  async startSession({ userId, channels, startDate, endDate }) {
    const startTime = Date.now();
    try {
      this.validateDateRange(startDate, endDate);
      if (!channels || !Array.isArray(channels) || channels.length === 0) {
        throw new Error('At least one channel must be specified');
      }
      const sessionId = await dynamoDBService.createSession(
        userId,
        channels,
        startDate,
        endDate
      );

      await cloudwatchService.recordSessionCreation(userId);
      await cloudwatchService.recordOperationLatency(
        'SessionCreation',
        Date.now() - startTime
      );

      return {
        sessionId,
        status: 'ACTIVE',
        channels,
        startDate,
        endDate
      };
    } catch (error) {
      console.error('Error starting session:', error);
      throw new Error(`Failed to start session: ${error.message}`);
    }
  }

  // Get session with its feedback items
  async getSessionWithItems(sessionId) {
    try {
      const session = await dynamoDBService.getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      const items = await dynamoDBService.getFeedbackItems(sessionId);
      
      // Group items by channel
      const itemsByChannel = items.reduce((acc, item) => {
        const channelId = item.SK.split('#')[1];
        if (!acc[channelId]) {
          acc[channelId] = [];
        }
        acc[channelId].push(item);
        return acc;
      }, {});

      return {
        ...session,
        itemsByChannel
      };
    } catch (error) {
      console.error('Error getting session:', error);
      throw new Error(`Failed to get session: ${error.message}`);
    }
  }

  // Add feedback items to a session
  async addFeedbackItems({ sessionId, channelId, items }) {
    try {
      await dynamoDBService.addFeedbackItems(sessionId, channelId, items);
      return {
        success: true,
        itemCount: items.length
      };
    } catch (error) {
      console.error('Error adding feedback items:', error);
      throw new Error(`Failed to add feedback items: ${error.message}`);
    }
  }

  // Update a feedback item with transactional safety
  async updateFeedbackItem({ sessionId, channelId, itemIndex, updates, userId }) {
    try {
      // Validate updates
      const allowedFields = [
        'title', 'description', 'priority', 'type',
        'user_impact', 'current_behavior', 'expected_behavior',
        'additional_context', 'included', 'status'
      ];

      const invalidFields = Object.keys(updates)
        .filter(field => !allowedFields.includes(field));

      if (invalidFields.length > 0) {
        throw new Error(`Invalid fields: ${invalidFields.join(', ')}`);
      }

      const result = await this.transactionalOps.updateFeedbackItemTransaction({
        sessionId,
        channelId,
        itemIndex,
        updates,
        userId
      });

      return {
        success: true,
        transactionId: result.transactionId,
        updatedAt: result.timestamp
      };
    } catch (error) {
      console.error('Error updating feedback item:', error);
      throw error;
    }
  }

  // Record duplicate detection with transactional safety
  async recordDuplicateCheck({ sessionId, itemId, jiraTicketKey, similarityScore, matchType, userId }) {
    try {
      const result = await this.transactionalOps.recordDuplicateTransaction({
        sessionId,
        itemId,
        jiraTicketKey,
        similarityScore,
        matchType,
        userId
      });

      return {
        success: true,
        transactionId: result.transactionId,
        recordedAt: result.timestamp
      };
    } catch (error) {
      console.error('Error recording duplicate:', error);
      throw new Error(`Failed to record duplicate: ${error.message}`);
    }
  }

  // Create Jira ticket with transactional safety
  async createJiraTicket({ sessionId, itemId, jiraTicketData, userId }) {
    try {
      // First create the Jira ticket
      const createdTicket = await this.jiraClient.addNewIssue(jiraTicketData);
      
      // Then record it in our database transactionally
      const result = await this.transactionalOps.createJiraTicketTransaction({
        sessionId,
        itemId,
        jiraTicketKey: createdTicket.key,
        jiraTicketUrl: `${process.env.JIRA_HOST}/browse/${createdTicket.key}`,
        userId
      });

      return {
        success: true,
        transactionId: result.transactionId,
        jiraTicketKey: createdTicket.key,
        createdAt: result.timestamp
      };
    } catch (error) {
      console.error('Error creating Jira ticket:', error);
      throw new Error(`Failed to create Jira ticket: ${error.message}`);
    }
  }

  // Process feedback items with transactional safety
  async processFeedbackItems({ sessionId, projectKey, userId }) {
    const results = {
      created: [],
      duplicates: [],
      errors: []
    };

    try {
      const session = await this.getSessionWithItems(sessionId);
      if (!session) throw new Error('Session not found');

      for (const [channelId, items] of Object.entries(session.itemsByChannel)) {
        for (const item of items) {
          // Skip excluded items
          if (item.excluded) continue;

          try {
            // Check for duplicates with transactional recording
            const duplicateCheck = await this.checkForDuplicates({
              sessionId,
              item,
              projectKey,
              userId
            });

            if (duplicateCheck.isDuplicate) {
              results.duplicates.push({
                summary: item.title,
                existingIssue: duplicateCheck.existingTicket,
                similarity: duplicateCheck.similarityScore,
                fromCache: duplicateCheck.fromCache
              });
              continue;
            }

            // Create Jira ticket with transactional recording
            const ticketResult = await this.createJiraTicket({
              sessionId,
              itemId: `${channelId}#${item.index}`,
              jiraTicketData: {
                fields: {
                  project: { key: projectKey },
                  summary: item.title,
                  description: this.formatJiraDescription(item),
                  issuetype: { name: this.mapTypeToJira(item.type) },
                  priority: { name: this.mapPriorityToJira(item.priority) },
                  labels: ['feedback-collector']
                }
              },
              userId
            });

            results.created.push({
              key: ticketResult.jiraTicketKey,
              summary: item.title
            });

          } catch (error) {
            results.errors.push({
              summary: item.title,
              error: error.message
            });
          }
        }
      }

      return results;

    } catch (error) {
      console.error('Error processing feedback items:', error);
      throw error;
    }
  }

  // Helper method to format Jira description
  formatJiraDescription(item) {
    return [
      `*Description:*\n${item.summary}`,
      `*User Impact:*\n${item.user_impact || 'Not specified'}`,
      `*Current Behavior:*\n${item.current_behavior || 'Not specified'}`,
      `*Expected Behavior:*\n${item.expected_behavior || 'Not specified'}`,
      `*Additional Context:*\n${item.additional_context || 'N/A'}`,
      `*Reported By:*\n${item.reporter || 'Collected from Slack'}`
    ].join('\n\n');
  }

  // Preserve existing helper methods...
  mapTypeToJira(type) { /* ... */ }
  mapPriorityToJira(priority) { /* ... */ }
  calculateSimilarity(str1, str2) {
    // Normalize strings
    const normalize = str => str.toLowerCase().trim();
    const s1 = normalize(str1);
    const s2 = normalize(str2);

    // Use Levenshtein distance for similarity
    const similarity = this.calculateLevenshteinSimilarity(s1, s2);
    return similarity;
  }
  calculateLevenshteinSimilarity(str1, str2) {
    const matrix = Array(str2.length + 1).fill(null)
      .map(() => Array(str1.length + 1).fill(null));

    // Initialize first row and column
    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

    // Fill matrix
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const substitutionCost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1, // deletion
          matrix[j - 1][i] + 1, // insertion
          matrix[j - 1][i - 1] + substitutionCost // substitution
        );
      }
    }

    // Convert distance to similarity score (0 to 1)
    const maxLength = Math.max(str1.length, str2.length);
    const distance = matrix[str2.length][str1.length];
    return 1 - (distance / maxLength);
  }

  async checkForDuplicates({ sessionId, item, projectKey, userId }) {
    try {
      // Get existing items for comparison
      const existingItems = await dynamoDBService.getFeedbackItems(sessionId);
      
      // Check each item for similarity
      for (const existingItem of existingItems) {
        const titleSimilarity = this.calculateSimilarity(
          item.title,
          existingItem.title
        );
        
        const descSimilarity = this.calculateSimilarity(
          item.description || '',
          existingItem.description || ''
        );

        // Average similarity score
        const avgSimilarity = (titleSimilarity + descSimilarity) / 2;

        if (avgSimilarity >= this.config.similarityThreshold) {
          // Record the duplicate detection
          await this.recordDuplicateCheck({
            sessionId,
            itemId: existingItem.SK,
            similarityScore: avgSimilarity,
            matchType: 'content_similarity',
            userId
          });

          return {
            isDuplicate: true,
            existingItem: existingItem.SK,
            similarityScore: avgSimilarity,
            matchType: 'content_similarity'
          };
        }
      }

      return {
        isDuplicate: false
      };
    } catch (error) {
      console.error('Error checking duplicates:', error);
      throw error;
    }
  }

  async getChannelMessages({ channelId, startDate, endDate }) {
    try {
      // Try to join the channel first
      try {
        await this.slackClient.conversations.join({ channel: channelId });
      } catch (joinError) {
        if (joinError.data?.error !== 'already_in_channel') {
          throw joinError;
        }
      }

      const startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);
      const endTimestamp = Math.floor(new Date(endDate).setHours(23, 59, 59, 999) / 1000);

      const result = await this.slackClient.conversations.history({
        channel: channelId,
        oldest: startTimestamp.toString(),
        latest: endTimestamp.toString(),
        inclusive: true
      });

      return result.messages;
    } catch (error) {
      console.error('Error fetching messages:', error);
      throw error;
    }
  }

  async collectFeedbackFromMessages({ sessionId, channelId, messages }) {
    try {
      // First analyze messages with GPT-4
      const analyzedFeedback = await openAIService.analyzeFeedback(
        messages.map(msg => msg.text)
      );

      // Transform analyzed feedback into our format
      const feedbackItems = analyzedFeedback.items.map((item, index) => ({
        title: item.title,
        description: item.description,
        priority: item.priority,
        type: item.type,
        user_impact: item.user_impact,
        current_behavior: item.current_behavior,
        expected_behavior: item.expected_behavior,
        additional_context: item.additional_context,
        source: {
          timestamp: messages[index].ts,
          user: messages[index].user
        }
      }));

      // Store the feedback items
      await this.addFeedbackItems({
        sessionId,
        channelId,
        items: feedbackItems
      });

      return feedbackItems;
    } catch (error) {
      console.error('Error collecting feedback:', error);
      throw error;
    }
  }

  validateDateRange(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Invalid date format');
    }
    if (end < start) {
      throw new Error('End date must be after start date');
    }
  }

  validateSessionId(sessionId) {
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('SESSION#')) {
      throw new Error('Invalid session ID format');
    }
  }

  async previewFeedbackItems({ sessionId, channelId }) {
    try {
      const items = await dynamoDBService.getFeedbackItems(sessionId, channelId);
      return {
        items: items.map(item => ({
          ...item,
          included: item.status !== 'EXCLUDED',  // Default to included
          editable: true
        }))
      };
    } catch (error) {
      console.error('Error getting feedback preview:', error);
      throw error;
    }
  }

  async excludeFeedbackItem({ sessionId, channelId, itemIndex, userId }) {
    return this.updateFeedbackItem({
      sessionId,
      channelId,
      itemIndex,
      updates: { status: 'EXCLUDED' },
      userId
    });
  }

  async includeFeedbackItem({ sessionId, channelId, itemIndex, userId }) {
    return this.updateFeedbackItem({
      sessionId,
      channelId,
      itemIndex,
      updates: { status: 'INCLUDED' },
      userId
    });
  }

  async setProjectKey({ sessionId, channelId, projectKey, userId }) {
    const startTime = Date.now();
    try {
      // Validate project key format
      if (!this.isValidProjectKey(projectKey)) {
        await cloudwatchService.recordInvalidProjectKey(channelId, userId, projectKey);
        throw new Error('Invalid project key format. Expected format: PROJ-123');
      }

      const result = await this.transactionalOps.updateChannelConfigTransaction({
        sessionId,
        channelId,
        updates: {
          projectKey
        }
      });

      await cloudwatchService.recordProjectKeySet(channelId, userId);
      await cloudwatchService.recordOperationLatency(
        'ProjectKeySet',
        Date.now() - startTime
      );

      return {
        success: true,
        transactionId: result.transactionId,
        updatedAt: result.timestamp
      };
    } catch (error) {
      console.error('Error setting project key:', error);
      throw error;
    }
  }

  async getChannelConfig({ sessionId, channelId }) {
    try {
      const config = await dynamoDBService.getChannelConfig(sessionId, channelId);
      return {
        projectKey: config?.projectKey,
        // Can add other channel-specific settings here
      };
    } catch (error) {
      console.error('Error getting channel config:', error);
      throw error;
    }
  }

  isValidProjectKey(projectKey) {
    // Typical Jira project key format: 2-10 uppercase letters followed by a hyphen and numbers
    const projectKeyRegex = /^[A-Z]{2,10}-\d+$/;
    return projectKeyRegex.test(projectKey);
  }
}

module.exports = FeedbackCollectionService;